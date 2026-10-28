import type {
  CreateFieldKind,
  CreateFieldSpec,
  CreateFieldType,
  CreateSchemaFieldsPlan,
  CreateTableSpec,
  FieldMappingNote,
  ForeignKeyTarget,
  NameCharacterRules,
  NameLengthUnit,
  NativeFieldType,
  Service,
  TableMappingNote,
  TablePropertyType,
  TransformerConfig,
} from '@spinner/shared-types';
import { TIME_BEARING_DATE_FORMATS } from '@spinner/shared-types';
import { transformerOutputCardinality } from 'src/sync/resolve-column-transform-input';
import { assertUnreachable } from 'src/utils/asserts';
import { schemaFieldPropertyKey, type SchemaField } from 'src/utils/schema-helpers';
import {
  firstIndexedValueForLookupKeys,
  linkedTableIdLookupKeysForConnectorForeignKey,
} from './foreign-key-linked-table-id';
import {
  allocateUniqueName,
  elideNameToMaxLength,
  fitNameToCharacterRules,
  normalizeNameForUniqueness,
} from './schema-builder-unique-names';

/** The name a field gets when removing the characters its destination can't hold leaves nothing. */
const FALLBACK_FIELD_NAME = 'Field';
/** The name a table gets when removing the characters its destination can't hold leaves nothing. */
const FALLBACK_TABLE_NAME = 'Table';

/**
 * Plan generation for create-schema (DEV-10378): turn one or more existing
 * source tables into an editable create-tables plan for a destination connector.
 *
 * Pure and connector-agnostic — it reads only generic signals (the JSON-Schema
 * primitive type, generic `x-scratch-*` annotations surfaced by
 * `extractSchemaFields`, and, when available, a column's `TablePropertyType`
 * display hint). No per-connector native-type knowledge enters here: a source
 * column's exact native type (`x-scratch-native-column-type`) is passed through
 * OPAQUELY as `nativeFieldType` when the destination declares the same native
 * type system, never interpreted (DEV-11903). When a field can't be mapped
 * confidently it is downgraded to `text` with a note; foreign keys that can't be
 * resolved are flagged `unsupported` and omitted.
 */

/** One source table feeding the generated plan. */
export interface PlanGeneratorSource {
  /** Caller-assigned ref for this table within the generated plan. */
  ref: string;
  dataFolderId: string;
  /** Table name to use in the generated plan. */
  tableName: string;
  /** Fields extracted from the source schema via `extractSchemaFields`. */
  schemaFields: SchemaField[];
  /** Dot path of the field to mark `isPrimary` (the source's title column), if any. */
  primaryFieldPath?: string;
  /** Dot path of the id/PK column to skip (the destination creates its own id). */
  idFieldPath?: string;
  /**
   * The source folder's connector service (e.g. 'POSTGRES'). Used to name the
   * injected source-record-id field (`postgres_record_id`). When absent the
   * field falls back to a generic `source_record_id` name.
   */
  connectorService?: Service;
  /**
   * Human-readable name of this source's connector service (e.g. 'Notion'),
   * resolved by the caller via `getServiceDisplayName`. Used only to name the
   * service in field-mapping notes (e.g. "Don't recognize this Notion field
   * type …"). Absent ⇒ notes fall back to service-agnostic wording.
   */
  serviceDisplayName?: string;
  /**
   * Remote table identifiers for THIS source. A sibling source's foreignKey that names one of these
   * resolves to an in-plan `{ ref }`. The caller supplies every key the folder's compound `tableId` can
   * be named by (see `linkedTableIdIndexKeysForRemoteTableId`): the exact-identity key of the full
   * segment array (what a connector's `linkedTableRemoteId` binds by), plus the legacy tokens — the bare
   * table-name segment and the dot-qualified `<schema>.<table>` the pg connectors emit for a
   * non-`public` schema — so every spelling binds.
   */
  remoteTableIds: string[];
  /** Optional `TablePropertyType` per field path (from the source's TableView). */
  viewTypeByPath?: Record<string, TablePropertyType>;
  /**
   * Optional view-declared unpack transform per field path (a view column's `codec.toCore` / jsonpath
   * `displayTransformer`). The sync applies it ahead of the schema's `suggestedTransformer`, so the created
   * column is typed for its output (DEV-11903). See `PlanFieldSelection.viewUnpackTransformerByPath`.
   */
  viewUnpackTransformerByPath?: Record<string, TransformerConfig>;
  /**
   * Set when this source's destination table ALREADY EXISTS. The generator then
   * emits an add-fields plan (the source fields diffed against this destination's
   * current fields) instead of a create-table spec. Absent ⇒ create a new table.
   */
  existingDestination?: ExistingDestinationTable;
}

/** An existing destination field the add-fields diff can reuse instead of recreating. */
export interface ExistingDestinationField {
  /**
   * Name on the SAME basis the generator names fields (`displayLabel ??
   * schemaFieldPropertyKey`), so a source field's requested name matches it.
   */
  name: string;
  /** Column path id in the destination schema — the mapping target when adopted. */
  columnPath: string;
  /** Inferred logical kind, so a field is adopted only when the source field's kind matches. */
  kind: CreateFieldKind;
}

/** An existing, materialized destination folder a source is diffed against. */
export interface ExistingDestinationTable {
  /** The destination folder's id (echoed back so the client can target it). */
  dataFolderId: string;
  /** The destination folder's remote table id (target of the /schema/fields POST). */
  remoteTableId: string[];
  /** The destination table's current fields (name + column path + inferred kind). */
  existingFields: ExistingDestinationField[];
}

/** Maps a source `linkedTableId` to an already-existing destination table. */
export interface PlanGeneratorLinkedTableMapping {
  sourceLinkedTableId: string;
  destinationRemoteTableId: string[];
}

export interface GeneratedPlan {
  /** Create-table specs for sources whose destination doesn't exist yet. */
  tables: CreateTableSpec[];
  /** Add-fields plans for sources whose destination table already exists. */
  fieldPlans: CreateSchemaFieldsPlan[];
  notes: FieldMappingNote[];
  /** One entry per new table renamed (suffixed) to avoid a name collision. */
  tableNotes: TableMappingNote[];
}

/**
 * What the destination can create beyond the base logical kinds (DEV-11903): the structured kinds and list
 * columns that let a source value keep its shape, and the native type system it can recreate exact source
 * types in. Taken from the destination's `SchemaCreationCapabilities`. Absent (or an absent member) ⇒ that
 * capability is off, and the generator flattens structured values to text exactly as before.
 */
export interface DestinationFieldTypeSupport {
  /** Logical kinds the destination can create; `json` among them lets an object/array source stay JSON. */
  supportedFieldKinds?: CreateFieldKind[];
  /** Element kinds the destination can create as a list column (`fieldType.isArray`). */
  supportedArrayElementKinds?: CreateFieldKind[];
  /** The native type system the destination creates columns in (e.g. `'postgres'`). */
  nativeTypeSystem?: string;
}

export function generateCreatePlanFromSources(args: {
  sources: PlanGeneratorSource[];
  /** The single destination connector account every source targets. */
  destinationConnectorAccountId: string;
  /**
   * The destination connector's service. Used only to name the injected
   * source-record-id field: when source and destination are the same service the
   * name is disambiguated (`postgres_source_record_id` rather than `postgres_record_id`).
   */
  destinationConnectorService?: Service;
  /**
   * Human-readable name of the destination connector service (e.g. 'Airtable'),
   * resolved by the caller via `getServiceDisplayName`. Used only to name the
   * destination in field-mapping notes (e.g. "…already exists in Airtable…").
   * Absent ⇒ notes fall back to service-agnostic wording ("on the destination").
   */
  destinationServiceDisplayName?: string;
  linkedTableMappings?: PlanGeneratorLinkedTableMapping[];
  /**
   * Display names of tables that already exist on the destination under the
   * create parent (e.g. an Airtable base). A new table whose name collides with
   * one of these — or with another new table in this plan — is given a numeric
   * suffix and recorded in `tableNotes`. The service supplies these from
   * `connector.listTables()`; absent ⇒ only in-plan collisions are resolved.
   */
  existingDestinationTableNames?: string[];
  /**
   * Whether the destination connector requires every new table to designate a
   * primary field. When true and a source named no title column (so no field was
   * marked `isPrimary`), the generator promotes a fallback primary — see
   * `designateFallbackPrimaryFieldIfMissing` — so the plan is valid out of the box
   * for connectors like Airtable and Notion instead of failing create-time
   * validation. Defaults to false (no primary needed; nothing is promoted).
   */
  destinationRequiresPrimaryField?: boolean;
  /**
   * The field kinds the destination allows for a primary field, if constrained
   * (e.g. Notion's `['text', 'longText']`). The fallback primary is chosen only
   * among fields of an allowed kind. Absent ⇒ any non-foreignKey data field is
   * eligible.
   */
  destinationPrimaryFieldKinds?: CreateFieldKind[];
  /**
   * Field names the destination connector reserves (e.g. Postgres's auto-injected `id` primary key). A
   * source field whose name collides is renamed like a duplicate, so it isn't silently dropped at create
   * and then unresolvable at apply (`SchemaCreationCapabilities.reservedFieldNames`).
   */
  destinationReservedFieldNames?: string[];
  /**
   * The destination connector's maximum table-name length, if it caps one
   * (`SchemaCreationCapabilities.maxTableNameLength`). A generated table name longer
   * than this is middle-elided to fit (DEV-10816), reserving room for any numeric
   * dedup suffix, so the plan never trips the connector's `TABLE_NAME_TOO_LONG` check.
   * Absent ⇒ no limit; names pass through at full length.
   */
  destinationMaxTableNameLength?: number;
  /**
   * The destination connector's maximum field-name length, if it caps one
   * (`SchemaCreationCapabilities.maxFieldNameLength`). Generated field names longer
   * than this are middle-elided to fit (DEV-10816), reserving room for any numeric
   * dedup suffix, so the plan never trips the connector's `FIELD_NAME_TOO_LONG` check.
   * Absent ⇒ no limit.
   */
  destinationMaxFieldNameLength?: number;
  /**
   * The unit both name limits above are measured in (`SchemaCreationCapabilities.nameLengthUnit`):
   * `'utf8Bytes'` for Postgres, whose 63-byte identifier limit a character-counted `…` would overflow
   * and be silently truncated by. Absent ⇒ `'characters'`.
   */
  destinationNameLengthUnit?: NameLengthUnit;
  /**
   * Characters the destination can't hold in a table or field name (`SchemaCreationCapabilities.nameCharacterRules`),
   * e.g. MySQL's emoji, control characters, and trailing spaces. Generated names have them removed before they are
   * shortened and deduplicated, with a note, so the connector never has to refuse the name at create (DEV-12413).
   * Absent ⇒ any character is allowed.
   */
  destinationNameCharacterRules?: NameCharacterRules;
  /**
   * The destination connector's maximum number of fields per table, if it caps one
   * (`SchemaCreationCapabilities.maxFieldsPerTable`). A new table whose final field list
   * is longer keeps every field in the plan, but the ones past the cap get an
   * `over_field_limit` note so a client leaves them unselected — see
   * `markFieldsBeyondDestinationFieldLimit` (DEV-12414). Absent ⇒ no limit.
   */
  destinationMaxFieldsPerTable?: number;
  /**
   * Whether the destination can represent a many-to-many link — a link field on each side holding a
   * list of linked records (`SchemaCreationCapabilities.supportsManyToManyForeignKeys`). Used only to
   * decide a reciprocal N→N pair from a symmetric source (Airtable/Notion): when false (e.g.
   * Postgres/Supabase, whose FK is a single scalar column) neither side is suggested; otherwise one is.
   * Absent ⇒ treated as true (no special N→N handling). See DEV-10753.
   */
  destinationSupportsManyToManyForeignKeys?: boolean;
  /**
   * The richer field types the destination can create — JSON and list columns, and the native type system
   * whose exact source types it recreates verbatim. Absent ⇒ structured values flatten to text. (DEV-11903)
   */
  destinationFieldTypeSupport?: DestinationFieldTypeSupport;
}): GeneratedPlan {
  const destinationNameLengthUnit = args.destinationNameLengthUnit ?? 'characters';
  // linkedTableId → in-plan table ref (for resolving sibling foreign keys).
  const linkedIdToRef = new Map<string, string>();
  for (const source of args.sources) {
    for (const remoteTableId of source.remoteTableIds) {
      if (!linkedIdToRef.has(remoteTableId)) linkedIdToRef.set(remoteTableId, source.ref);
    }
  }
  const mappingByLinkedId = new Map<string, string[]>();
  for (const mapping of args.linkedTableMappings ?? []) {
    mappingByLinkedId.set(mapping.sourceLinkedTableId, mapping.destinationRemoteTableId);
  }

  // Symmetric-service (Airtable/Notion) relationships surface a link field on BOTH tables. When both
  // tables are in this plan, suggest only one side of each reciprocal pair (DEV-10753). This map holds,
  // per SUPPRESSED source field, the note message explaining its omission; fields not in it are emitted.
  const reciprocalSuppressionMessageByFieldKey = computeReciprocalForeignKeySuppressions(
    args.sources,
    args.destinationSupportsManyToManyForeignKeys ?? true,
  );

  const notes: FieldMappingNote[] = [];
  const tableNotes: TableMappingNote[] = [];
  const tables: CreateTableSpec[] = [];
  const fieldPlans: CreateSchemaFieldsPlan[] = [];

  // Table names already taken in the destination's create namespace: tables that
  // already exist under the create parent (frozen) plus every table this plan adds
  // (grows as we go). A new table whose name collides gets a numeric suffix.
  const existingDestinationTableNames = new Set(
    (args.existingDestinationTableNames ?? []).map(normalizeNameForUniqueness),
  );
  const takenTableNames = new Set(existingDestinationTableNames);

  for (const source of args.sources) {
    if (source.existingDestination) {
      fieldPlans.push(
        buildAddFieldsPlanForSource(
          source,
          source.existingDestination,
          args.destinationConnectorAccountId,
          linkedIdToRef,
          mappingByLinkedId,
          reciprocalSuppressionMessageByFieldKey,
          notes,
          args.destinationReservedFieldNames,
          args.destinationMaxFieldNameLength,
          destinationNameLengthUnit,
          args.destinationNameCharacterRules,
          args.destinationSupportsManyToManyForeignKeys ?? true,
          args.destinationServiceDisplayName,
          args.destinationFieldTypeSupport,
        ),
      );
    } else {
      const fields = collectCreateFieldSpecsForSource(
        source,
        {
          allowSiblingRefForeignKeys: true,
          markPrimaryField: true,
          destinationServiceDisplayName: args.destinationServiceDisplayName,
          reservedFieldNames: args.destinationReservedFieldNames,
          maxFieldNameLength: args.destinationMaxFieldNameLength,
          nameLengthUnit: destinationNameLengthUnit,
          nameCharacterRules: args.destinationNameCharacterRules,
          destinationSupportsManyToManyForeignKeys: args.destinationSupportsManyToManyForeignKeys ?? true,
          destinationFieldTypeSupport: args.destinationFieldTypeSupport,
        },
        linkedIdToRef,
        mappingByLinkedId,
        reciprocalSuppressionMessageByFieldKey,
        notes,
      );
      // Give the destination table a column to sync the source record's remote id
      // into, so a synced row always knows where it came from. Skipped when a
      // same-named field already exists (the source already has one) or when the
      // source has no known remote-id path to map from (see buildSourceRecordIdField).
      const sourceRecordIdField = buildSourceRecordIdField(
        source,
        fields,
        args.destinationConnectorService,
        args.destinationMaxFieldNameLength,
        destinationNameLengthUnit,
      );
      if (sourceRecordIdField && source.idFieldPath !== undefined) {
        fields.push(sourceRecordIdField);
        // Record where this injected field is fed from: the source's remote-id
        // path (`idPath`). The client/sync reads `sourceFieldPath ->
        // fieldName` from notes to wire the source identity into this column.
        notes.push({
          sourceDataFolderId: source.dataFolderId,
          sourceFieldPath: source.idFieldPath,
          fieldName: sourceRecordIdField.name,
          status: 'mapped',
          mappedKind: 'text',
        });
      }
      // If the destination requires a primary field but the source designated none
      // (its title column wasn't recognized — e.g. a Postgres table whose headline
      // column isn't named `name`/`title`/…), promote one now so the plan is valid
      // for connectors like Airtable and Notion rather than failing validation.
      if (args.destinationRequiresPrimaryField) {
        designateFallbackPrimaryFieldIfMissing(fields, args.destinationPrimaryFieldKinds);
      }
      // Counted on the FINAL field list (injected source-record-id and promoted primary
      // included), which is exactly what the destination's field cap is checked against.
      if (args.destinationMaxFieldsPerTable !== undefined) {
        markFieldsBeyondDestinationFieldLimit({
          source,
          fields,
          maxFieldsPerTable: args.destinationMaxFieldsPerTable,
          destinationServiceDisplayName: args.destinationServiceDisplayName,
          notes,
        });
      }
      // Characters the destination can't hold are removed first, then a name over the
      // destination's limit is middle-elided to fit; the elided name is what collision
      // detection and dedup then work against.
      const fittedTableName = fitNameToCharacterRules(
        source.tableName,
        args.destinationNameCharacterRules,
        FALLBACK_TABLE_NAME,
      );
      const elidedTableName = elideNameToMaxLength(
        fittedTableName,
        args.destinationMaxTableNameLength,
        destinationNameLengthUnit,
      );
      const wereTableNameCharactersRemoved = fittedTableName !== source.tableName;
      const wasTableNameShortenedToFit = elidedTableName !== fittedTableName;
      // Classify the collision BEFORE allocating: `takenTableNames` merges existing
      // and in-plan names, so the distinction must be read off the frozen set first.
      // Compared on the elided name, since that's the name that actually collides.
      const conflictsWithExistingTable = existingDestinationTableNames.has(normalizeNameForUniqueness(elidedTableName));
      const tableName = allocateUniqueName(
        fittedTableName,
        takenTableNames,
        args.destinationMaxTableNameLength,
        destinationNameLengthUnit,
      );
      const wasTableNameDeduplicated = tableName !== elidedTableName;
      if (wereTableNameCharactersRemoved || wasTableNameShortenedToFit || wasTableNameDeduplicated) {
        tableNotes.push({
          sourceDataFolderId: source.dataFolderId,
          ref: source.ref,
          tableName,
          renamedFromName: source.tableName,
          reason: wasTableNameDeduplicated
            ? conflictsWithExistingTable
              ? 'conflicts_with_existing_table'
              : 'duplicate_in_plan'
            : wereTableNameCharactersRemoved
              ? 'unsupported_characters'
              : 'truncated_to_length_limit',
          message: tableRenameMessage({
            requestedName: fittedTableName,
            finalName: tableName,
            wereCharactersRemoved: wereTableNameCharactersRemoved,
            wasShortenedToFit: wasTableNameShortenedToFit,
            wasDeduplicated: wasTableNameDeduplicated,
            conflictsWithExistingTable,
            maxTableNameLength: args.destinationMaxTableNameLength,
            nameLengthUnit: destinationNameLengthUnit,
          }),
        });
      }
      // `ref` is unchanged by the rename, so cross-table foreign keys (resolved by
      // ref, not name) still wire up correctly.
      tables.push({ name: tableName, fields, ref: source.ref });
    }
  }

  return { tables, fieldPlans, notes, tableNotes };
}

/** Key identifying a source field within the plan (data folder + dot path), for suppression lookup. */
function reciprocalSuppressionKey(dataFolderId: string, fieldPath: string): string {
  return `${dataFolderId}\u0000${fieldPath}`;
}

/** One in-plan foreign-key field, with the pre-computed keys the reciprocal-pair logic needs. */
interface ReciprocalForeignKeyFieldEntry {
  source: PlanGeneratorSource;
  field: SchemaField;
  /** Stable, deterministic sort key for the "keep the smaller side" tiebreak (N→N and 1→1). */
  sortKey: string;
  /** Key under which this field's suppression (if chosen) is recorded and later looked up. */
  suppressionKey: string;
}

/**
 * Identify reciprocal foreign-key pairs among the plan's sources and choose which side to SUPPRESS
 * (DEV-10753). Symmetric-link services (Airtable, and Notion `dual_property` relations) expose one
 * relationship from BOTH tables — a link field on each side that mutually reference each other's remote
 * field id. When both tables are in the plan, suggesting both sides recreates the two-way link twice, so
 * only one side is kept:
 *
 *  - 1→N (exactly one side single-valued): keep the single-valued side — the foreign key on the many-side
 *    row, the more-normalized choice — and drop the multi-valued list side.
 *  - N→N (neither side single-valued): if the destination can't hold a two-way link
 *    (`destinationSupportsManyToManyForeignKeys` false, e.g. Postgres/Supabase) drop BOTH; otherwise keep
 *    one side deterministically (the smaller sort key) and drop the other.
 *  - 1→1 (both single-valued, rare): keep one side deterministically; a single scalar FK is representable
 *    everywhere, so it is never dropped entirely.
 *
 * Returns a map from each suppressed field's key (see {@link reciprocalSuppressionKey}) to the note
 * message explaining its omission. A field absent from the map is emitted normally. Only fields carrying
 * both a `remoteFieldId` and a `foreignKey.inverseFieldId` participate; one-way links (no inverse — every
 * other connector) are never touched.
 */
function computeReciprocalForeignKeySuppressions(
  sources: PlanGeneratorSource[],
  destinationSupportsManyToManyForeignKeys: boolean,
): Map<string, string> {
  const foreignKeyFieldEntries: ReciprocalForeignKeyFieldEntry[] = [];
  for (const source of sources) {
    for (const field of source.schemaFields) {
      if (field.foreignKey && field.remoteFieldId) {
        foreignKeyFieldEntries.push({
          source,
          field,
          sortKey: `${source.ref}\u0000${field.path}`,
          suppressionKey: reciprocalSuppressionKey(source.dataFolderId, field.path),
        });
      }
    }
  }

  // Index by each field's own remote id so a candidate reciprocal partner is found in O(1).
  const entriesByRemoteFieldId = new Map<string, ReciprocalForeignKeyFieldEntry[]>();
  for (const entry of foreignKeyFieldEntries) {
    const remoteFieldId = entry.field.remoteFieldId;
    if (remoteFieldId === undefined) continue;
    const entriesForThisRemoteFieldId = entriesByRemoteFieldId.get(remoteFieldId);
    if (entriesForThisRemoteFieldId) entriesForThisRemoteFieldId.push(entry);
    else entriesByRemoteFieldId.set(remoteFieldId, [entry]);
  }

  const suppressionMessageByFieldKey = new Map<string, string>();
  const alreadyPairedSuppressionKeys = new Set<string>();

  for (const sideA of foreignKeyFieldEntries) {
    if (alreadyPairedSuppressionKeys.has(sideA.suppressionKey)) continue;
    const inverseFieldId = sideA.field.foreignKey?.inverseFieldId;
    if (!inverseFieldId) continue;

    const sideB = (entriesByRemoteFieldId.get(inverseFieldId) ?? []).find((candidate) =>
      areReciprocalForeignKeyFields(sideA, candidate),
    );
    if (!sideB) continue;

    alreadyPairedSuppressionKeys.add(sideA.suppressionKey);
    alreadyPairedSuppressionKeys.add(sideB.suppressionKey);

    const sideAIsSingleValued = sideA.field.foreignKey?.isSingleValued === true;
    const sideBIsSingleValued = sideB.field.foreignKey?.isSingleValued === true;

    // 1→N: keep the single-valued side (the FK on the many-side row), drop the multi-valued list side.
    if (sideAIsSingleValued !== sideBIsSingleValued) {
      const keptSide = sideAIsSingleValued ? sideA : sideB;
      const droppedSide = sideAIsSingleValued ? sideB : sideA;
      suppressionMessageByFieldKey.set(droppedSide.suppressionKey, reciprocalOtherSideKeptMessage(keptSide));
      continue;
    }

    // N→N whose destination can't hold a two-way link: drop BOTH sides.
    if (!sideAIsSingleValued && !destinationSupportsManyToManyForeignKeys) {
      const message = manyToManyUnsupportedByDestinationMessage();
      suppressionMessageByFieldKey.set(sideA.suppressionKey, message);
      suppressionMessageByFieldKey.set(sideB.suppressionKey, message);
      continue;
    }

    // N→N (destination supports it) or 1→1: keep one side deterministically, drop the other.
    const [keptSide, droppedSide] = sideA.sortKey <= sideB.sortKey ? [sideA, sideB] : [sideB, sideA];
    suppressionMessageByFieldKey.set(droppedSide.suppressionKey, reciprocalOtherSideKeptMessage(keptSide));
  }

  return suppressionMessageByFieldKey;
}

/**
 * Whether two foreign-key fields are the two sides of ONE symmetric relationship: they mutually reference
 * each other's remote field id, AND each links to the table the other lives on. The table cross-check
 * guards against a remote-field-id collision between two unrelated links.
 */
function areReciprocalForeignKeyFields(
  sideA: ReciprocalForeignKeyFieldEntry,
  sideB: ReciprocalForeignKeyFieldEntry,
): boolean {
  if (sideA.suppressionKey === sideB.suppressionKey) return false;
  const sideAForeignKey = sideA.field.foreignKey;
  const sideBForeignKey = sideB.field.foreignKey;
  if (!sideAForeignKey || !sideBForeignKey) return false;
  return (
    sideAForeignKey.inverseFieldId === sideB.field.remoteFieldId &&
    sideBForeignKey.inverseFieldId === sideA.field.remoteFieldId &&
    foreignKeyNamesSourceTable(sideAForeignKey, sideB.source) &&
    foreignKeyNamesSourceTable(sideBForeignKey, sideA.source)
  );
}

/** Whether a foreign key points at the given plan source's table, by EITHER form its target can be named by. */
function foreignKeyNamesSourceTable(
  foreignKey: { linkedTableId: string; linkedTableRemoteId?: string[] },
  source: PlanGeneratorSource,
): boolean {
  const sourceRemoteTableIdKeys = new Set(source.remoteTableIds);
  return linkedTableIdLookupKeysForConnectorForeignKey(foreignKey).some((lookupKey) =>
    sourceRemoteTableIdKeys.has(lookupKey),
  );
}

/** Note message for a reciprocal side omitted because the OTHER side is being suggested instead. */
function reciprocalOtherSideKeptMessage(keptSide: ReciprocalForeignKeyFieldEntry): string {
  const keptFieldName = keptSide.field.displayLabel ?? schemaFieldPropertyKey(keptSide.field);
  return `reciprocal link — the other side of this relationship is suggested on table "${keptSide.source.tableName}" as "${keptFieldName}", so this side is omitted to avoid creating the two-way link twice`;
}

/** Note message for BOTH sides of an N→N relationship the destination can't represent. */
function manyToManyUnsupportedByDestinationMessage(): string {
  return "many-to-many link — the destination can't represent a two-way relationship, so neither side is suggested";
}

/**
 * Note message for a multi-valued source foreign key narrowed to a single value because the destination
 * stores a foreign key as one scalar column (Postgres/Supabase) rather than a list of linked ids.
 */
function foreignKeyNarrowedToSingleValueMessage(): string {
  return 'only the first linked record will sync — this destination stores a foreign key as a single value, not a list, so any additional links are dropped';
}

/**
 * Build an add-fields plan for a source whose destination table exists: the
 * source's create-field specs minus any field the destination already has (by
 * name, case-insensitive). A name match whose existing kind matches the source is
 * surfaced as an `adopted` note (mapped to the existing column, not recreated); an
 * incompatible match (different kind, or a foreign key) is skipped with an `exists`
 * note. The primary field is not re-designated. A foreign key whose target isn't an
 * existing remote table (a sibling `{ ref }`, which /schema/fields can't express, or
 * an unmapped link) is emitted with a pending `{ unresolvedLinkedTableId }` target
 * and a `needs_target` note — to be bound to an existing table before it is added.
 */
function buildAddFieldsPlanForSource(
  source: PlanGeneratorSource,
  existingDestination: ExistingDestinationTable,
  connectorAccountId: string,
  linkedIdToRef: Map<string, string>,
  mappingByLinkedId: Map<string, string[]>,
  reciprocalSuppressionMessageByFieldKey: Map<string, string>,
  notes: FieldMappingNote[],
  reservedFieldNames: string[] | undefined,
  maxFieldNameLength: number | undefined,
  nameLengthUnit: NameLengthUnit,
  nameCharacterRules: NameCharacterRules | undefined,
  destinationSupportsManyToManyForeignKeys: boolean,
  destinationServiceDisplayName: string | undefined,
  destinationFieldTypeSupport: DestinationFieldTypeSupport | undefined,
): CreateSchemaFieldsPlan {
  const existingDestinationFieldsByName = new Map(
    existingDestination.existingFields.map((field) => [normalizeNameForUniqueness(field.name), field] as const),
  );
  const fields = collectCreateFieldSpecsForSource(
    source,
    {
      allowSiblingRefForeignKeys: false,
      markPrimaryField: false,
      existingDestinationFieldsByName,
      destinationServiceDisplayName,
      reservedFieldNames,
      maxFieldNameLength,
      nameLengthUnit,
      nameCharacterRules,
      destinationSupportsManyToManyForeignKeys,
      destinationFieldTypeSupport,
    },
    linkedIdToRef,
    mappingByLinkedId,
    reciprocalSuppressionMessageByFieldKey,
    notes,
  );
  return {
    sourceDataFolderId: source.dataFolderId,
    destinationDataFolderId: existingDestination.dataFolderId,
    connectorAccountId,
    remoteTableId: existingDestination.remoteTableId,
    fields,
  };
}

interface CreateFieldSpecOptions {
  /** Whether a foreignKey may resolve to an in-plan sibling `{ ref }` (create-table only). */
  allowSiblingRefForeignKeys: boolean;
  /** Whether to mark the source's title column `isPrimary` (create-table only). */
  markPrimaryField: boolean;
  /**
   * Existing destination fields keyed by normalized name (add-fields only). A
   * source field whose name matches one is adopted (mapped to it) when the kinds
   * match, or otherwise skipped — never recreated.
   */
  existingDestinationFieldsByName?: Map<string, ExistingDestinationField>;
  /**
   * Human-readable name of the destination connector service (e.g. 'Airtable'), used only to name the
   * destination in the `exists` skip note. Absent ⇒ the note falls back to "on the destination".
   */
  destinationServiceDisplayName?: string;
  /** Field names the destination connector reserves (e.g. Postgres `id`) — seeded into the taken-names
   *  set so a colliding source field is renamed rather than dropped at create. Compared case-insensitively. */
  reservedFieldNames?: string[];
  /** The destination's maximum field-name length, if capped. A longer requested name is middle-elided to
   *  fit (reserving room for any dedup suffix), so the plan never trips `FIELD_NAME_TOO_LONG` (DEV-10816). */
  maxFieldNameLength?: number;
  /** The unit `maxFieldNameLength` is measured in (UTF-8 bytes for Postgres). Absent ⇒ characters. */
  nameLengthUnit?: NameLengthUnit;
  /** Characters the destination can't hold in a field name, removed before eliding and dedup (DEV-12413). */
  nameCharacterRules?: NameCharacterRules;
  /**
   * Whether the destination can represent a many-to-many foreign key (a link field holding a list of ids).
   * When false (Postgres/Supabase, whose FK is a single scalar column), a multi-valued source foreign key is
   * still emitted — but narrowed to a single value — and its note is `downgraded` to warn that only the first
   * linked record syncs. Absent ⇒ true (no narrowing). See DEV-10753.
   */
  destinationSupportsManyToManyForeignKeys?: boolean;
  /** Richer field types the destination can create (JSON, lists, native types). See {@link DestinationFieldTypeSupport}. */
  destinationFieldTypeSupport?: DestinationFieldTypeSupport;
}

/** Map every field of a source to a create-field spec, pushing a note per field. */
function collectCreateFieldSpecsForSource(
  source: PlanGeneratorSource,
  options: CreateFieldSpecOptions,
  linkedIdToRef: Map<string, string>,
  mappingByLinkedId: Map<string, string[]>,
  reciprocalSuppressionMessageByFieldKey: Map<string, string>,
  notes: FieldMappingNote[],
): CreateFieldSpec[] {
  const fields: CreateFieldSpec[] = [];
  // Field names already taken in this table's namespace: the destination's current
  // fields (add-fields case) plus every field we emit here. An emitted field whose
  // name collides gets a numeric suffix + a 'renamed' note. A COPY of the
  // existing-destination names, so the frozen original still drives the adopt/skip.
  const takenFieldNames = new Set<string>([
    ...(options.existingDestinationFieldsByName?.keys() ?? []),
    // Reserved destination names (e.g. Postgres's auto `id`) are already taken, so a source field that
    // folds to one is renamed by `allocateUniqueName` instead of being silently dropped at create.
    ...(options.reservedFieldNames?.map(normalizeNameForUniqueness) ?? []),
  ]);
  // Existing destination columns already adopted by an earlier source field of this table (add-fields only).
  const existingColumnPathsAdoptedInThisTable = new Set<string>();
  for (const schemaField of source.schemaFields) {
    const spec = mapSchemaFieldToCreateFieldSpec(
      source,
      schemaField,
      options,
      takenFieldNames,
      existingColumnPathsAdoptedInThisTable,
      linkedIdToRef,
      mappingByLinkedId,
      reciprocalSuppressionMessageByFieldKey,
      notes,
    );
    if (spec) fields.push(spec);
  }
  return fields;
}

/**
 * Map one source field to a create-field spec, or return null (with an
 * explanatory note) when it should be omitted: the id column, or a field the
 * destination already has. A foreign key whose target can't be bound yet is NOT
 * omitted — it is emitted with a pending `{ unresolvedLinkedTableId }` target and a
 * `needs_target` note so it survives into the plan/draft to be resolved later.
 *
 * A field that IS emitted is given a name the destination can hold and unique
 * within the table (via `takenFieldNames`): characters the destination can't use
 * are removed, a name over the limit is elided, and a colliding name gets a numeric
 * suffix. Any change is recorded in the note's `renamedFromName`.
 */
function mapSchemaFieldToCreateFieldSpec(
  source: PlanGeneratorSource,
  schemaField: SchemaField,
  options: CreateFieldSpecOptions,
  takenFieldNames: Set<string>,
  existingColumnPathsAdoptedInThisTable: Set<string>,
  linkedIdToRef: Map<string, string>,
  mappingByLinkedId: Map<string, string[]>,
  reciprocalSuppressionMessageByFieldKey: Map<string, string>,
  notes: FieldMappingNote[],
): CreateFieldSpec | null {
  // The destination auto-creates its own id column — never recreate it.
  if (source.idFieldPath !== undefined && schemaField.path === source.idFieldPath) return null;

  // Infer the created column's type from the value the sync will actually copy: a view-declared unpack
  // transform takes precedence over the schema's own `suggestedTransformer`, exactly as it does when the
  // sync resolves the column's `toCore` (DEV-11903).
  const viewUnpackTransformer = source.viewUnpackTransformerByPath?.[schemaField.path];
  const schemaFieldAsSynced: SchemaField = viewUnpackTransformer
    ? { ...schemaField, suggestedTransformer: viewUnpackTransformer }
    : schemaField;

  // A column copied within ONE native type system (Supabase → Postgres) keeps the source's own column name
  // (`pharmacies_desired`, not the view's display label "Pharmacies Desired") — the destination is the same
  // kind of database, so its columns should read exactly like the source's (DEV-11903). The column name is
  // the field's full path: a native-typed column is a top-level column, and its name may itself contain dots.
  const displayFieldName = schemaField.displayLabel ?? schemaFieldPropertyKey(schemaField);
  const nativeColumnTypeInDestinationTypeSystem = nativeColumnTypeSharedWithDestination(
    schemaField,
    options.destinationFieldTypeSupport,
  );
  const requestedFieldName = nativeColumnTypeInDestinationTypeSystem ? schemaField.path : displayFieldName;

  // This side of a symmetric relationship was chosen for suppression (DEV-10753): the other side is
  // suggested instead, or — for a many-to-many the destination can't hold — neither side is. Record a
  // `skipped_reciprocal` note and omit the field, so it never lands as a duplicate two-way link.
  const reciprocalSuppressionMessage = reciprocalSuppressionMessageByFieldKey.get(
    reciprocalSuppressionKey(source.dataFolderId, schemaField.path),
  );
  if (reciprocalSuppressionMessage !== undefined) {
    notes.push({
      sourceDataFolderId: source.dataFolderId,
      sourceFieldPath: schemaField.path,
      fieldName: requestedFieldName,
      status: 'skipped_reciprocal',
      mappedKind: 'foreignKey',
      message: reciprocalSuppressionMessage,
    });
    return null;
  }

  // Add-fields diff: a field the destination already has is never recreated.
  // Checked against the FROZEN existing-destination map (not the growing taken set)
  // so a second NEW field of the same name is renamed rather than mistaken for it.
  // When it's a plain field whose kind matches the source, ADOPT it — map to the
  // existing column — so re-adding a previously-unmapped field reuses it instead of
  // failing to recreate it. Otherwise (a foreign key, or a different kind) skip it.
  // See `findExistingDestinationFieldMatchingSourceField` for the names tried.
  const existingFieldMatch = findExistingDestinationFieldMatchingSourceField({
    existingDestinationFieldsByName: options.existingDestinationFieldsByName,
    requestedFieldName,
    displayFieldName,
    maxFieldNameLength: options.maxFieldNameLength,
    nameLengthUnit: options.nameLengthUnit ?? 'characters',
    nameCharacterRules: options.nameCharacterRules,
    existingColumnPathsAdoptedInThisTable,
  });
  if (existingFieldMatch) {
    const { existingField, fullNameChangedToMatch } = existingFieldMatch;
    const renamedFromFullNameIfChanged =
      fullNameChangedToMatch !== undefined ? { renamedFromName: fullNameChangedToMatch } : {};
    if (!schemaField.foreignKey) {
      // Compatible when the existing column's kind matches what this field maps to now OR what it mapped to
      // before the destination's richer types were considered — a column created back when a `text[]`/JSON
      // source flattened to text is still the right column to map that source into.
      const viewType = source.viewTypeByPath?.[schemaField.path];
      const sourceKindWithDestinationSupport = inferLogicalFieldType(
        schemaFieldAsSynced,
        viewType,
        source.serviceDisplayName,
        options.destinationFieldTypeSupport,
      ).fieldType.kind;
      const sourceKindWithBaseLogicalTypes = inferLogicalFieldType(schemaField, viewType, source.serviceDisplayName)
        .fieldType.kind;
      if (
        sourceKindWithDestinationSupport === existingField.kind ||
        sourceKindWithBaseLogicalTypes === existingField.kind
      ) {
        existingColumnPathsAdoptedInThisTable.add(existingField.columnPath);
        notes.push({
          sourceDataFolderId: source.dataFolderId,
          sourceFieldPath: schemaField.path,
          fieldName: existingField.name,
          status: 'adopted',
          mappedKind: existingField.kind,
          existingDestinationColumnId: existingField.columnPath,
          message: `a "${existingField.kind}" field named "${existingField.name}" already exists on the destination; mapping to it`,
          ...renamedFromFullNameIfChanged,
        });
        return null;
      }
    }
    notes.push({
      sourceDataFolderId: source.dataFolderId,
      sourceFieldPath: schemaField.path,
      fieldName: existingField.name,
      status: 'exists',
      message: `Skipping "${existingField.name}", a field with that name already exists in ${
        options.destinationServiceDisplayName ?? 'the destination'
      } with an incompatible type`,
      ...renamedFromFullNameIfChanged,
    });
    return null;
  }

  const isPrimary =
    options.markPrimaryField && source.primaryFieldPath !== undefined && schemaField.path === source.primaryFieldPath;

  // Resolve a foreignKey up front. A target that can't be bound yet — no sibling in
  // the plan and no `linkedTableMappings` entry, or a sibling `{ ref }` that the
  // /schema/fields endpoint can't express — is NOT dropped. The field is emitted with
  // a pending `{ unresolvedLinkedTableId }` target and a `needs_target` note, so it
  // survives the plan → draft roundtrip as an AVAILABLE field with an unmet
  // requirement; the consumer binds it to a destination (co-create the linked table,
  // or map it to an existing one) before create, which validation enforces.
  let foreignKeyType: CreateFieldType | null = null;
  let foreignKeyNeedsTargetLinkedTableId: string | null = null;
  if (schemaField.foreignKey) {
    const linkedTableId = schemaField.foreignKey.linkedTableId;
    const resolution = resolveForeignKey(schemaField.foreignKey, linkedIdToRef, mappingByLinkedId);
    const isSiblingRefTarget = resolution !== null && 'ref' in resolution;
    const targetIsUsable = resolution !== null && !(isSiblingRefTarget && !options.allowSiblingRefForeignKeys);
    if (targetIsUsable) {
      foreignKeyType = { kind: 'foreignKey', target: resolution };
    } else {
      // Carry the source linked table's FULL remote id alongside the string token when the
      // connector emits one: it deep-equals the target folder's `DataFolder.tableId`, so a
      // consumer can bind the pending target by array equality instead of parsing the token.
      foreignKeyType = {
        kind: 'foreignKey',
        target: {
          unresolvedLinkedTableId: linkedTableId,
          ...(schemaField.foreignKey.linkedTableRemoteId
            ? { unresolvedLinkedTableRemoteId: schemaField.foreignKey.linkedTableRemoteId }
            : {}),
        },
      };
      foreignKeyNeedsTargetLinkedTableId = linkedTableId;
    }
  }

  // This field will be emitted — give it a name the destination can hold (characters it can't use
  // removed), elided to the destination's field-name limit when it has one, and unique within the table.
  const nameLengthUnit = options.nameLengthUnit ?? 'characters';
  const fittedFieldName = fitNameToCharacterRules(requestedFieldName, options.nameCharacterRules, FALLBACK_FIELD_NAME);
  const elidedFittedFieldName = elideNameToMaxLength(fittedFieldName, options.maxFieldNameLength, nameLengthUnit);
  const fieldName = allocateUniqueName(fittedFieldName, takenFieldNames, options.maxFieldNameLength, nameLengthUnit);
  const wereFieldNameCharactersRemoved = fittedFieldName !== requestedFieldName;
  const wasFieldNameShortenedToFit = elidedFittedFieldName !== fittedFieldName;
  const wasFieldNameDeduplicated = fieldName !== elidedFittedFieldName;
  const renamedFromName =
    wereFieldNameCharactersRemoved || wasFieldNameShortenedToFit || wasFieldNameDeduplicated
      ? requestedFieldName
      : undefined;
  const renamedForReservedName =
    wasFieldNameDeduplicated &&
    (options.reservedFieldNames ?? []).some(
      (reserved) => normalizeNameForUniqueness(reserved) === normalizeNameForUniqueness(fittedFieldName),
    );
  const charactersClause = wereFieldNameCharactersRemoved
    ? `removed characters the destination can't use in a field name`
    : undefined;
  const dedupClause = wasFieldNameDeduplicated
    ? renamedForReservedName
      ? `renamed from "${requestedFieldName}" — "${fittedFieldName}" is reserved by the destination`
      : `renamed from "${requestedFieldName}" to keep field names unique`
    : undefined;
  const shortenClause =
    wasFieldNameShortenedToFit && options.maxFieldNameLength !== undefined
      ? `shortened to fit the destination's ${options.maxFieldNameLength}-${nameLengthUnitLabel(nameLengthUnit)} field-name limit`
      : undefined;
  const renameClause = composeNoteMessage(charactersClause, shortenClause, dedupClause);

  if (foreignKeyType) {
    if (foreignKeyNeedsTargetLinkedTableId !== null) {
      const needsTargetClause = `links to "${foreignKeyNeedsTargetLinkedTableId}", which isn't in this plan — create that table alongside this one, or map it to an existing destination table, to enable this field`;
      notes.push({
        sourceDataFolderId: source.dataFolderId,
        sourceFieldPath: schemaField.path,
        fieldName,
        status: 'needs_target',
        mappedKind: 'foreignKey',
        sourceLinkedTableId: foreignKeyNeedsTargetLinkedTableId,
        message: composeNoteMessage(renameClause, needsTargetClause),
        ...(renamedFromName ? { renamedFromName } : {}),
      });
    } else {
      // A multi-valued source foreign key (e.g. a HubSpot association, which links many records) mapped
      // onto a destination whose foreign key is a single scalar column (Postgres/Supabase) is NARROWED:
      // only the first linked record can be stored. Emit the field, but downgrade the note so the plan UI
      // warns that the rest are dropped. A genuinely single-valued source (isSingleValued) loses nothing.
      const sourceForeignKeyIsMultiValued = schemaField.foreignKey?.isSingleValued !== true;
      const narrowedToSingleValue =
        sourceForeignKeyIsMultiValued && options.destinationSupportsManyToManyForeignKeys === false;
      const narrowingClause = narrowedToSingleValue ? foreignKeyNarrowedToSingleValueMessage() : undefined;
      notes.push({
        sourceDataFolderId: source.dataFolderId,
        sourceFieldPath: schemaField.path,
        fieldName,
        status: narrowedToSingleValue ? 'downgraded' : 'mapped',
        mappedKind: 'foreignKey',
        ...(composeNoteMessage(renameClause, narrowingClause)
          ? { message: composeNoteMessage(renameClause, narrowingClause) }
          : {}),
        ...(renamedFromName ? { renamedFromName } : {}),
      });
    }
    return buildFieldSpec(fieldName, foreignKeyType, isPrimary, schemaField.description);
  }

  const inferred = inferLogicalFieldType(
    schemaFieldAsSynced,
    source.viewTypeByPath?.[schemaField.path],
    source.serviceDisplayName,
    options.destinationFieldTypeSupport,
  );
  // Same native type system and a type the destination can recreate verbatim: create the source's exact
  // column type. Nothing is lost, so any flattening note from the logical inference no longer applies; the
  // inferred logical type stays on the spec as the fallback for a consumer that doesn't use native types.
  const nativeFieldType: NativeFieldType | undefined = nativeColumnTypeInDestinationTypeSystem?.isRecreatableVerbatim
    ? {
        typeSystem: nativeColumnTypeInDestinationTypeSystem.typeSystem,
        type: nativeColumnTypeInDestinationTypeSystem.type,
      }
    : undefined;
  const status = nativeFieldType ? 'mapped' : inferred.status;
  const message = composeNoteMessage(renameClause, nativeFieldType ? undefined : inferred.message);
  notes.push({
    sourceDataFolderId: source.dataFolderId,
    sourceFieldPath: schemaField.path,
    fieldName,
    status,
    mappedKind: inferred.fieldType.kind,
    ...(message ? { message } : {}),
    ...(renamedFromName ? { renamedFromName } : {}),
  });
  return buildFieldSpec(fieldName, inferred.fieldType, isPrimary, schemaField.description, nativeFieldType);
}

/** An existing destination field a source field matched in the add-fields diff. */
interface ExistingDestinationFieldMatch {
  existingField: ExistingDestinationField;
  /**
   * Set when the match was on the name the source field is created under — characters the destination
   * can't use removed, then middle-elided to its field-name limit — not on its full name: the full name.
   */
  fullNameChangedToMatch?: string;
}

/**
 * Find the existing destination field (add-fields only) that a source field is already on the destination
 * as, so it is adopted or skipped instead of recreated. Names are compared case-insensitively, in order:
 *
 *  1. the name this field would be created under (`requestedFieldName`);
 *  2. its display label — a destination table created before same-type-system columns kept their source
 *     names holds the display-labelled column ("Pharmacies Desired"), and re-planning against it must still
 *     find that column rather than propose a duplicate under the new name (DEV-11903);
 *  3. either of those as it was actually created: characters the destination can't use removed (DEV-12413),
 *     then middle-elided to its field-name limit (DEV-10816). Without this a re-plan misses the changed
 *     column and proposes a second, suffixed one beside it (DEV-10906).
 *
 * A changed-name match skips a column an earlier field of this table already adopted: two long names
 * can elide to the same `head…tail` (or two names lose their emoji to the same name), and only the first
 * was created under it, so mapping both to that column would silently merge two source fields into one.
 */
function findExistingDestinationFieldMatchingSourceField(args: {
  existingDestinationFieldsByName: Map<string, ExistingDestinationField> | undefined;
  requestedFieldName: string;
  displayFieldName: string;
  maxFieldNameLength: number | undefined;
  nameLengthUnit: NameLengthUnit;
  nameCharacterRules: NameCharacterRules | undefined;
  existingColumnPathsAdoptedInThisTable: Set<string>;
}): ExistingDestinationFieldMatch | undefined {
  const { existingDestinationFieldsByName } = args;
  if (!existingDestinationFieldsByName) return undefined;
  const fullNamesInLookupOrder = [args.requestedFieldName, args.displayFieldName];
  for (const fullName of fullNamesInLookupOrder) {
    const existingField = existingDestinationFieldsByName.get(normalizeNameForUniqueness(fullName));
    if (existingField) return { existingField };
  }
  for (const fullName of fullNamesInLookupOrder) {
    const createdName = elideNameToMaxLength(
      fitNameToCharacterRules(fullName, args.nameCharacterRules, FALLBACK_FIELD_NAME),
      args.maxFieldNameLength,
      args.nameLengthUnit,
    );
    if (createdName === fullName) continue;
    const existingField = existingDestinationFieldsByName.get(normalizeNameForUniqueness(createdName));
    if (existingField && !args.existingColumnPathsAdoptedInThisTable.has(existingField.columnPath)) {
      return { existingField, fullNameChangedToMatch: fullName };
    }
  }
  return undefined;
}

/**
 * The field's native column type when it belongs to the destination's native type system (Supabase →
 * Postgres), else undefined. Recreatable or not, a match means the source and destination are the same
 * kind of database — which is what keeps the source's column names verbatim; recreatability separately
 * decides whether the exact TYPE is copied.
 */
function nativeColumnTypeSharedWithDestination(
  schemaField: SchemaField,
  destinationFieldTypeSupport: DestinationFieldTypeSupport | undefined,
): SchemaField['nativeColumnType'] {
  const destinationNativeTypeSystem = destinationFieldTypeSupport?.nativeTypeSystem;
  if (destinationNativeTypeSystem === undefined) return undefined;
  return schemaField.nativeColumnType?.typeSystem === destinationNativeTypeSystem
    ? schemaField.nativeColumnType
    : undefined;
}

/**
 * Compose the human-readable message for a `TableMappingNote` covering any mix of
 * removed characters the destination can't use, a dedup rename (collision with an
 * existing or in-plan table), and a length-limit elision. The dedup-only wording is
 * unchanged from before the elision feature, so a plain collision reads exactly as it
 * always did. `requestedName` is the name after removing characters, the one that collided.
 */
function tableRenameMessage(args: {
  requestedName: string;
  finalName: string;
  wereCharactersRemoved: boolean;
  wasShortenedToFit: boolean;
  wasDeduplicated: boolean;
  conflictsWithExistingTable: boolean;
  maxTableNameLength: number | undefined;
  nameLengthUnit: NameLengthUnit;
}): string {
  const clauses: string[] = [];
  if (args.wereCharactersRemoved) {
    clauses.push(`the name had characters the destination can't use`);
  }
  if (args.wasDeduplicated) {
    clauses.push(
      args.conflictsWithExistingTable
        ? `a table named "${args.requestedName}" already exists on the destination`
        : `another table named "${args.requestedName}" is being created in this plan`,
    );
  }
  if (args.wasShortenedToFit && args.maxTableNameLength !== undefined) {
    clauses.push(
      `the name exceeded the destination's ${args.maxTableNameLength}-${nameLengthUnitLabel(args.nameLengthUnit)} table-name limit`,
    );
  }
  return `${clauses.join('; ')}; renamed to "${args.finalName}"`;
}

/** The unit word for a name-limit note ("63-character" / "63-byte"). */
function nameLengthUnitLabel(nameLengthUnit: NameLengthUnit): string {
  switch (nameLengthUnit) {
    case 'characters':
      return 'character';
    case 'utf8Bytes':
      return 'byte';
    default:
      return assertUnreachable(nameLengthUnit);
  }
}

/** Join the non-empty note clauses (e.g. a rename clause and a type-mapping clause) with "; ". */
function composeNoteMessage(...clauses: (string | undefined)[]): string | undefined {
  const present = clauses.filter((clause): clause is string => Boolean(clause));
  return present.length > 0 ? present.join('; ') : undefined;
}

export interface InferredFieldType {
  status: 'mapped' | 'downgraded';
  fieldType: CreateFieldType;
  message?: string;
}

/**
 * Map a non-foreignKey source field to a logical create field type using only
 * generic signals. Prefers a `TablePropertyType` display hint when available,
 * otherwise falls back to the JSON-Schema primitive. Structurally complex
 * values keep their shape — an array of primitives as a list, an object as
 * `json` — when `destinationFieldTypeSupport` says the destination can hold it, and are
 * downgraded to `text` otherwise (always, when it is omitted — e.g. when inferring
 * an existing destination column's kind).
 *
 * Read-only/computed source fields are NOT downgraded: this tool copies a table
 * for use in a sync, so a read-only source date should become a real `date`
 * column in the destination (which has no read-only concept) rather than collapse
 * to text. The field's logical type comes from its view hint / primitive like any
 * other field.
 *
 * A multi-valued source (Postgres `text[]`, an Airtable multi-select) mapped onto a created text field
 * once carried an extra `downgraded` note warning that only its FIRST value would sync (DEV-10956). That
 * warning was false: the picker comma-joins every element into any destination slot that consumes a
 * string, which since DEV-10952 includes Notion `rich_text` / `title` (their packs declare
 * `fromCoreInputType: 'string'`, overriding the envelope's `object` logical type — see
 * `transform-picker.ts`). It has been removed; the base mapping's own "syncing as plain text" wording is
 * the accurate one, and matches what every other destination already showed (DEV-11076).
 */
export function inferLogicalFieldType(
  field: SchemaField,
  viewType?: TablePropertyType,
  sourceServiceDisplayName?: string,
  destinationFieldTypeSupport?: DestinationFieldTypeSupport,
): InferredFieldType {
  // "this Notion object field" when we know the source service, "this object field" otherwise.
  const sourceServiceQualifier = sourceServiceDisplayName ? `${sourceServiceDisplayName} ` : '';
  // A structured value keeps its shape when the destination can hold it: a list column for an array of
  // primitives, a JSON column for an object. Otherwise it is flattened to text, with a note (DEV-11903).
  const structuredValueFieldType = fieldTypeKeepingStructuredValue(field, destinationFieldTypeSupport);
  if (viewType) {
    switch (viewType) {
      case 'checkbox':
        return { status: 'mapped', fieldType: { kind: 'boolean' } };
      case 'number':
        return { status: 'mapped', fieldType: { kind: 'number' } };
      case 'date':
        return { status: 'mapped', fieldType: dateCreateFieldType(field) };
      // An explicitly time-bearing column. `dateCreateFieldType` normally learns that from the
      // value's JSON-Schema `format`, but some columns can't hand it one, so the view declares it
      // directly: a raw Unix epoch NUMBER has no string format (Stripe's `created`, flattened to a
      // date by an `epoch_to_iso` codec), and a format below an opaque envelope or an annotated
      // table root never reaches `field` at all — `field` is then a bare `{ path, type: 'unknown' }`
      // (Gong's `metaData.started`, Notion `created_time` properties; DEV-12085). Without this it
      // would land as a date-only column and drop the time-of-day for the life of the export.
      case 'datetime':
        return { status: 'mapped', fieldType: { kind: 'date', includesTime: true } };
      // A column whose value set is CLOSED and declared by the schema (Intercom's article `state`
      // is exactly `published | draft`). The view opts in with `'select'`; the choices come from
      // the schema's own enum / literal union, so the destination gets a native select with the
      // real options instead of free text (DEV-11288). A view that asks for a select over a field
      // with no declared option set gets no choices to create the column from, so it falls through
      // to the primitive mapping below — text, exactly as before.
      case 'select': {
        const choices = buildSelectChoices(field.enumValues ?? []);
        if (choices.length > 0) return { status: 'mapped', fieldType: { kind: 'select', options: choices } };
        break;
      }
      case 'url':
        return { status: 'mapped', fieldType: { kind: 'url' } };
      // A connector that knows a flattened string is an address / number says so
      // (QuickBooks unwraps `PrimaryEmailAddr` → `{ Address }`, `PrimaryPhone` →
      // `{ FreeFormNumber }`); `email` and `phone` are already in the create-field
      // vocabulary and every destination pack maps them, so honor the hint rather
      // than falling through to plain text.
      case 'email':
        return { status: 'mapped', fieldType: { kind: 'email' } };
      case 'phone':
        return { status: 'mapped', fieldType: { kind: 'phone' } };
      case 'richtext':
        return { status: 'mapped', fieldType: { kind: 'longText' } };
      case 'string':
        return { status: 'mapped', fieldType: { kind: 'text' } };
      case 'object':
        if (structuredValueFieldType && STRUCTURED_JSON_TYPES_UNDER_OBJECT_VIEW_HINT.has(field.type)) {
          return { status: 'mapped', fieldType: structuredValueFieldType };
        }
        return {
          status: 'downgraded',
          fieldType: { kind: 'text' },
          message: `Can't unpack this ${sourceServiceQualifier}object field, syncing as plain text`,
        };
      default:
        // Open union (connector-specific hint) — fall through to type inference.
        break;
    }
  }

  switch (field.type) {
    case 'boolean':
      return { status: 'mapped', fieldType: { kind: 'boolean' } };
    case 'integer':
      return { status: 'mapped', fieldType: { kind: 'number', format: 'integer' } };
    case 'number':
      return { status: 'mapped', fieldType: { kind: 'number' } };
    case 'string':
      return { status: 'mapped', fieldType: { kind: 'text' } };
    case 'object':
    case 'array':
      if (structuredValueFieldType) return { status: 'mapped', fieldType: structuredValueFieldType };
      return {
        status: 'downgraded',
        fieldType: { kind: 'text' },
        message: `Can't unpack this ${sourceServiceQualifier}${field.type} field, syncing as plain text`,
      };
    default:
      return {
        status: 'downgraded',
        fieldType: { kind: 'text' },
        message: `Don't recognize ${
          sourceServiceDisplayName ? `${sourceServiceDisplayName} ` : 'this '
        }field type "${field.type}", syncing as plain text`,
      };
  }
}

/**
 * JSON types a column the view hints as `'object'` must actually carry to be kept structured. A primitive
 * under an `'object'` hint isn't a structured value, and an `'unknown'` one may be a view column with no
 * backing schema field at all (whose value a codec may already have flattened) — both stay text. A Postgres
 * `jsonb` column (schema type `unknown`) keeps its type through `nativeFieldType` instead.
 */
const STRUCTURED_JSON_TYPES_UNDER_OBJECT_VIEW_HINT: ReadonlySet<string> = new Set(['object', 'array']);

/** The list-column element kind for an array's JSON element type, when it is a primitive a list can hold. */
function arrayElementFieldType(arrayItemType: string | undefined): CreateFieldType | undefined {
  switch (arrayItemType) {
    case 'string':
      return { kind: 'text', isArray: true };
    case 'integer':
      return { kind: 'number', format: 'integer', isArray: true };
    case 'number':
      return { kind: 'number', isArray: true };
    case 'boolean':
      return { kind: 'boolean', isArray: true };
    default:
      return undefined;
  }
}

/**
 * The field type that keeps a structured source value's shape on this destination, or undefined when the
 * destination can't hold it (the caller then flattens to text). An array of primitives becomes a list
 * column of that element kind when the destination supports one; an object becomes `json` when supported.
 *
 * Any other array — of objects, or of an element kind the destination has no list for — is NOT given a
 * `json` column: a JSON destination column declares no shape, so the sync's transform picker reads it as
 * single-valued and would join the array into one string before writing it (DEV-11903 review). Such an
 * array keeps flattening to text, where that join is the intended, honest result.
 */
function fieldTypeKeepingStructuredValue(
  field: SchemaField,
  destinationFieldTypeSupport: DestinationFieldTypeSupport | undefined,
): CreateFieldType | undefined {
  if (!destinationFieldTypeSupport) return undefined;
  // A field with an unpack codec doesn't sync its raw structure: the sync copies the codec's CoreValue — a
  // string, or a list of strings. So the created column follows the codec's output: a text list when it
  // emits a list (and the destination has one), else the base text mapping.
  if (field.suggestedTransformer) {
    const codecEmitsList = transformerOutputCardinality(field.suggestedTransformer) === 'multi';
    return codecEmitsList && (destinationFieldTypeSupport.supportedArrayElementKinds ?? []).includes('text')
      ? { kind: 'text', isArray: true }
      : undefined;
  }
  if (field.type === 'array') {
    const listFieldType = arrayElementFieldType(field.arrayItemType);
    const destinationHasThisListKind =
      listFieldType !== undefined &&
      (destinationFieldTypeSupport.supportedArrayElementKinds ?? []).includes(listFieldType.kind);
    return destinationHasThisListKind ? listFieldType : undefined;
  }
  return (destinationFieldTypeSupport.supportedFieldKinds ?? []).includes('json') ? { kind: 'json' } : undefined;
}

/**
 * Turn a field's declared enum values into select choices, dropping the ones a destination could
 * not hold: an empty name, and any that repeats an earlier one case-insensitively.
 *
 * `CreateFieldType`'s select variant rejects both outright, so a source whose declared option set
 * contains one would fail VALIDATION of the whole plan rather than just that field. A destination
 * select can't hold two case-variant spellings anyway (Airtable's choice names are
 * case-insensitively unique), so keeping the first is the only outcome available — and it keeps a
 * quirky source schema from taking down an otherwise-good plan. An empty result means there is no
 * select to build; the caller falls back to text.
 */
function buildSelectChoices(declaredEnumValues: string[]): { name: string }[] {
  const seenLowercasedNames = new Set<string>();
  const choices: { name: string }[] = [];
  for (const name of declaredEnumValues) {
    if (name.length === 0) continue;
    const lowercasedName = name.toLowerCase();
    if (seenLowercasedNames.has(lowercasedName)) continue;
    seenLowercasedNames.add(lowercasedName);
    choices.push({ name });
  }
  return choices;
}

/**
 * Build a `date` create field, preserving time-of-day when the source is a datetime.
 *
 * The three source connectors that flatten datetimes to the coarse `'date'` display
 * hint (Webflow `published-on`, Shopify `createdAt`, HubSpot `closedate`) still emit
 * the JSON-Schema `format: 'date-time'` annotation on the value — the generic signal
 * that it carries a wall-clock time. We promote those to `includesTime: true` so the
 * destination gets a real datetime column (Airtable `dateTime` / Postgres
 * `timestamptz`) instead of dropping the time-of-day for the life of the export
 * (DEV-10788). A `format: 'date'` (or no format) value is a plain calendar date and
 * stays date-only.
 *
 * `'date-time-local'` counts too (DEV-11091): a service that serializes a wall-clock
 * timestamp WITHOUT a UTC offset (WordPress's `"2026-07-28T20:20:00"`) can't honestly
 * claim RFC 3339 `'date-time'` — the validator would warn on every record — but the
 * value is every bit as time-bearing, and under-typing it as a date-only column drops
 * the time permanently. See `JSON_SCHEMA_LOCAL_DATE_TIME_FORMAT`.
 */
function dateCreateFieldType(field: SchemaField): CreateFieldType {
  return field.format !== undefined && TIME_BEARING_DATE_FORMATS.has(field.format)
    ? { kind: 'date', includesTime: true }
    : { kind: 'date' };
}

/** Resolve a source foreignKey's linked table to a create-side target, or null if unresolvable. */
function resolveForeignKey(
  foreignKey: { linkedTableId: string; linkedTableRemoteId?: string[] },
  linkedIdToRef: Map<string, string>,
  mappingByLinkedId: Map<string, string[]>,
): ForeignKeyTarget | null {
  // Try the linked table's full remote id before the connector-specific string: the string is only that
  // connector's own name for the table and need not appear in the target's remote id at all (QuickBooks
  // annotates `'account'` for the table whose remote id is `['Account']`).
  const lookupKeys = linkedTableIdLookupKeysForConnectorForeignKey(foreignKey);
  const siblingRef = firstIndexedValueForLookupKeys(linkedIdToRef, lookupKeys);
  if (siblingRef !== undefined) return { ref: siblingRef };
  const existingRemoteTableId = firstIndexedValueForLookupKeys(mappingByLinkedId, lookupKeys);
  if (existingRemoteTableId !== undefined) return { existingRemoteTableId };
  return null;
}

/**
 * Build the injected source-record-id field for a create-table plan: a `text`
 * column named for the source service (`postgres_record_id`, `airtable_record_id`,
 * …, or `source_record_id` when the service is unknown), marked `isSourceRecordId`
 * so clients render it as a mandatory, non-removable field. Remote ids are read as
 * strings (see `readRecordIdAsString`), so `text` is the right logical type.
 *
 * When source and destination are the SAME service, the name is disambiguated with
 * a `_source_` infix (`postgres_source_record_id`) so it doesn't read like the
 * destination's own record id.
 *
 * Returns null when:
 *  - the source has no known remote-id path (`idFieldPath`): the whole point of
 *    the field is to store the source's identity on the destination row for
 *    record matching, which is impossible without a source id to copy, so there
 *    is nothing to put in it; or
 *  - a field of the same name already exists on the source (the destination would
 *    otherwise get a duplicate), in which case the existing field already serves
 *    the purpose.
 */
function buildSourceRecordIdField(
  source: PlanGeneratorSource,
  existingFields: CreateFieldSpec[],
  destinationConnectorService: Service | undefined,
  maxFieldNameLength: number | undefined,
  nameLengthUnit: NameLengthUnit,
): CreateFieldSpec | null {
  if (source.idFieldPath === undefined) return null;
  const servicePrefix = source.connectorService ? source.connectorService.toLowerCase() : 'source';
  const sourceAndDestinationAreSameService =
    source.connectorService !== undefined && source.connectorService === destinationConnectorService;
  const fieldName = elideNameToMaxLength(
    sourceAndDestinationAreSameService ? `${servicePrefix}_source_record_id` : `${servicePrefix}_record_id`,
    maxFieldNameLength,
    nameLengthUnit,
  );
  const existingFieldNames = new Set(existingFields.map((field) => normalizeNameForUniqueness(field.name)));
  if (existingFieldNames.has(normalizeNameForUniqueness(fieldName))) return null;
  return {
    name: fieldName,
    fieldType: { kind: 'text' },
    description: 'Remote id of the source record this row was synced from.',
    isSourceRecordId: true,
  };
}

/**
 * Field names — normalized (lowercased, separators stripped) — that read like a
 * record's human title, in descending priority. Used to pick a fallback primary
 * field when the destination requires one but the source named no title column.
 * The first entries are the strongest, conventional title columns; the later
 * entries are human handles and stable identifiers that still read as a title. A
 * field matching an earlier entry wins; with no match the generator falls back to
 * the source-record-id field, then the first eligible field in column order (see
 * {@link designateFallbackPrimaryFieldIfMissing}).
 *
 * Matching is exact on the normalized name — a compound name like "Customer Name"
 * (→ "customername") deliberately does NOT match "name", so a table with no true
 * title column (e.g. an order with only "Customer Name"/"Status") falls through to
 * the stable source-record-id rather than latching onto an incidental column.
 */
const PRIMARY_FIELD_NAME_CANDIDATES_IN_PRIORITY_ORDER = [
  // Canonical record titles (strongest).
  'name',
  'title',
  'fullname',
  'displayname',
  'displaytitle',
  'label',
  'heading',
  'headline',
  'subject',
  'summary',
  // Human handles / identifiers.
  'username',
  'handle',
  'nickname',
  'screenname',
  // Stable, unique-ish identifiers that still read as a title.
  'slug',
  'code',
  'reference',
  'key',
  'identifier',
  'email',
];

/** Lowercase and strip non-alphanumerics so "Display Name", "display_name", and "displayName" all match. */
function normalizeFieldNameForPrimaryMatch(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Priority of a field's name as a title (lower is better); non-candidates sort last. */
function primaryNamePriorityOf(field: CreateFieldSpec): number {
  const index = PRIMARY_FIELD_NAME_CANDIDATES_IN_PRIORITY_ORDER.indexOf(normalizeFieldNameForPrimaryMatch(field.name));
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

/**
 * Whether a field's logical KIND can back a primary field: not a foreign key (a
 * link can't be a title) and — when the destination constrains primary kinds — of
 * an allowed kind. Says nothing about the field's role; see the two callers.
 */
function isKindPrimaryEligible(
  field: CreateFieldSpec,
  destinationPrimaryFieldKinds: CreateFieldKind[] | undefined,
): boolean {
  if (field.fieldType.kind === 'foreignKey') return false;
  if (destinationPrimaryFieldKinds && !destinationPrimaryFieldKinds.includes(field.fieldType.kind)) return false;
  return true;
}

/**
 * Whether a real DATA column may serve as the primary/title field: kind-eligible
 * AND not the injected source-record-id. The source-record-id is excluded here
 * because it is handled as an explicit fallback (see
 * {@link designateFallbackPrimaryFieldIfMissing}), never treated as a title column.
 */
function isDataFieldEligibleAsPrimary(
  field: CreateFieldSpec,
  destinationPrimaryFieldKinds: CreateFieldKind[] | undefined,
): boolean {
  if (field.isSourceRecordId) return false;
  return isKindPrimaryEligible(field, destinationPrimaryFieldKinds);
}

/**
 * Among `fields`, the data column whose name best matches a known title name
 * (`name`, `title`, …), or `undefined` when none matches. A non-title name never
 * wins — an arbitrary column is not a title — so the caller can distinguish "found
 * a real title column" from "no title column at all".
 */
function pickBestTitleNamedField(fields: CreateFieldSpec[]): CreateFieldSpec | undefined {
  let bestField: CreateFieldSpec | undefined;
  let bestPriority = Number.MAX_SAFE_INTEGER;
  for (const field of fields) {
    const priority = primaryNamePriorityOf(field);
    if (priority < bestPriority) {
      bestField = field;
      bestPriority = priority;
    }
  }
  return bestField;
}

/**
 * Promote a primary field in place when the destination requires one and none was
 * designated from the source's title column. Preference order:
 *
 *   1. the data column whose name reads most like a title (`name`, `title`, …);
 *   2. the injected source-record-id ("ID") field — guaranteed present per row,
 *      unique, and stable, so a far better primary than an arbitrary data column
 *      when the source has no title (e.g. a Webflow order whose only text columns
 *      are "Status"/"Customer Name");
 *   3. as a last resort, the first primary-eligible data column in source order.
 *
 * Leaves the table without a primary only when nothing at all is eligible (a
 * degenerate table of just links, with no source-record-id) — which the create-time
 * validator then reports rather than this guessing wrongly.
 */
function designateFallbackPrimaryFieldIfMissing(
  fields: CreateFieldSpec[],
  destinationPrimaryFieldKinds: CreateFieldKind[] | undefined,
): void {
  if (fields.some((field) => field.isPrimary)) return;

  // 1. A real data column that actually reads like a title wins outright.
  const dataFieldsEligibleAsPrimary = fields.filter((field) =>
    isDataFieldEligibleAsPrimary(field, destinationPrimaryFieldKinds),
  );
  const bestTitleNamedField = pickBestTitleNamedField(dataFieldsEligibleAsPrimary);
  if (bestTitleNamedField) {
    bestTitleNamedField.isPrimary = true;
    return;
  }

  // 2. No title-like column: fall back to the stable source-record-id, not an
  //    arbitrary data column.
  const sourceRecordIdField = fields.find(
    (field) => field.isSourceRecordId && isKindPrimaryEligible(field, destinationPrimaryFieldKinds),
  );
  if (sourceRecordIdField) {
    sourceRecordIdField.isPrimary = true;
    return;
  }

  // 3. Last resort: the first primary-eligible data column in source order.
  if (dataFieldsEligibleAsPrimary.length > 0) {
    dataFieldsEligibleAsPrimary[0].isPrimary = true;
  }
}

/** Note statuses the generator gives a field it EMITS into the plan (as opposed to one it omits, e.g. `exists`). */
const EMITTED_FIELD_NOTE_STATUSES: ReadonlySet<FieldMappingNote['status']> = new Set([
  'mapped',
  'downgraded',
  'needs_target',
]);

/**
 * Whether a field always survives the destination's field cap: the primary field and the injected
 * source-record-id are created no matter what the user selects (clients force-add both), so they are
 * never the ones left out.
 */
function isFieldAlwaysKeptUnderFieldLimit(field: CreateFieldSpec): boolean {
  return field.isPrimary === true || field.isSourceRecordId === true;
}

/**
 * Mark the fields of a new table that lie past the destination's `maxFieldsPerTable` (DEV-12414). Without
 * this a source wider than the cap (185 columns into MySQL's 180) is planned in full, selected in full, and
 * only rejected at save. The primary and source-record-id fields are always kept; the remaining slots go to
 * the other fields in source order, and every field after that is beyond the limit.
 *
 * A field beyond the limit STAYS in `fields`, in place — so the user can still pick it in place of another —
 * but its note becomes `over_field_limit`, telling a client to leave it unselected by default, with a message
 * saying how many fields were left out and why. Any earlier explanation (a downgrade, a link still needing a
 * target) is kept after it.
 */
function markFieldsBeyondDestinationFieldLimit(args: {
  source: PlanGeneratorSource;
  fields: CreateFieldSpec[];
  maxFieldsPerTable: number;
  destinationServiceDisplayName: string | undefined;
  notes: FieldMappingNote[];
}): void {
  const { source, fields, maxFieldsPerTable } = args;
  if (fields.length <= maxFieldsPerTable) return;

  const alwaysKeptFieldCount = fields.filter(isFieldAlwaysKeptUnderFieldLimit).length;
  const slotsForOtherFields = Math.max(0, maxFieldsPerTable - alwaysKeptFieldCount);
  const fieldNamesBeyondLimit = new Set<string>();
  let otherFieldsKeptCount = 0;
  for (const field of fields) {
    if (isFieldAlwaysKeptUnderFieldLimit(field)) continue;
    if (otherFieldsKeptCount < slotsForOtherFields) {
      otherFieldsKeptCount += 1;
      continue;
    }
    fieldNamesBeyondLimit.add(field.name);
  }
  if (fieldNamesBeyondLimit.size === 0) return;

  const destinationName = args.destinationServiceDisplayName ?? 'the destination';
  const leftOutFieldCount = fieldNamesBeyondLimit.size;
  const overLimitClause =
    `left unselected — ${destinationName} allows at most ${maxFieldsPerTable} fields per table and this table has ` +
    `${fields.length}, so ${leftOutFieldCount} field${leftOutFieldCount === 1 ? ' was' : 's were'} left out; ` +
    'select it in place of another field to include it';

  // Field names are unique within the table (deduped above), so a field's emitted note is the one from this
  // source carrying its name.
  for (const note of args.notes) {
    if (note.sourceDataFolderId !== source.dataFolderId) continue;
    if (!EMITTED_FIELD_NOTE_STATUSES.has(note.status)) continue;
    if (!fieldNamesBeyondLimit.has(note.fieldName)) continue;
    note.status = 'over_field_limit';
    note.message = composeNoteMessage(overLimitClause, note.message);
  }
}

function buildFieldSpec(
  name: string,
  fieldType: CreateFieldType,
  isPrimary: boolean,
  description?: string,
  nativeFieldType?: NativeFieldType,
): CreateFieldSpec {
  return {
    name,
    fieldType,
    ...(nativeFieldType ? { nativeFieldType } : {}),
    ...(isPrimary ? { isPrimary: true } : {}),
    ...(description ? { description } : {}),
  };
}
