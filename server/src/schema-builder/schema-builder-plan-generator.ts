import type {
  CreateFieldKind,
  CreateFieldSpec,
  CreateFieldType,
  CreateSchemaFieldsPlan,
  CreateTableSpec,
  FieldMappingNote,
  ForeignKeyTarget,
  Service,
  TableMappingNote,
  TablePropertyType,
} from '@spinner/shared-types';
import { TIME_BEARING_DATE_FORMATS } from '@spinner/shared-types';
import type { SchemaField } from 'src/utils/schema-helpers';
import {
  firstIndexedValueForLookupKeys,
  linkedTableIdLookupKeysForConnectorForeignKey,
} from './foreign-key-linked-table-id';
import { allocateUniqueName, elideNameToMaxLength, normalizeNameForUniqueness } from './schema-builder-unique-names';

/**
 * Plan generation for create-schema (DEV-10378): turn one or more existing
 * source tables into an editable create-tables plan for a destination connector.
 *
 * Pure and connector-agnostic — it reads only generic signals (the JSON-Schema
 * primitive type, generic `x-scratch-*` annotations surfaced by
 * `extractSchemaFields`, and, when available, a column's `TablePropertyType`
 * display hint). No per-connector native-type knowledge enters here. When a
 * field can't be mapped confidently it is downgraded to `text` with a note;
 * foreign keys that can't be resolved are flagged `unsupported` and omitted.
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
   * lastPathSegment`), so a source field's requested name matches it.
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
   * Whether the destination can represent a many-to-many link — a link field on each side holding a
   * list of linked records (`SchemaCreationCapabilities.supportsManyToManyForeignKeys`). Used only to
   * decide a reciprocal N→N pair from a symmetric source (Airtable/Notion): when false (e.g.
   * Postgres/Supabase, whose FK is a single scalar column) neither side is suggested; otherwise one is.
   * Absent ⇒ treated as true (no special N→N handling). See DEV-10753.
   */
  destinationSupportsManyToManyForeignKeys?: boolean;
}): GeneratedPlan {
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
          args.destinationSupportsManyToManyForeignKeys ?? true,
          args.destinationServiceDisplayName,
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
          destinationSupportsManyToManyForeignKeys: args.destinationSupportsManyToManyForeignKeys ?? true,
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
      // A table name over the destination's limit is middle-elided to fit; the
      // elided name is what collision detection and dedup then work against.
      const elidedTableName = elideNameToMaxLength(source.tableName, args.destinationMaxTableNameLength);
      const wasTableNameShortenedToFit = elidedTableName !== source.tableName;
      // Classify the collision BEFORE allocating: `takenTableNames` merges existing
      // and in-plan names, so the distinction must be read off the frozen set first.
      // Compared on the elided name, since that's the name that actually collides.
      const conflictsWithExistingTable = existingDestinationTableNames.has(normalizeNameForUniqueness(elidedTableName));
      const tableName = allocateUniqueName(source.tableName, takenTableNames, args.destinationMaxTableNameLength);
      const wasTableNameDeduplicated = tableName !== elidedTableName;
      if (wasTableNameShortenedToFit || wasTableNameDeduplicated) {
        tableNotes.push({
          sourceDataFolderId: source.dataFolderId,
          ref: source.ref,
          tableName,
          renamedFromName: source.tableName,
          reason: wasTableNameDeduplicated
            ? conflictsWithExistingTable
              ? 'conflicts_with_existing_table'
              : 'duplicate_in_plan'
            : 'truncated_to_length_limit',
          message: tableRenameMessage({
            requestedName: source.tableName,
            finalName: tableName,
            wasShortenedToFit: wasTableNameShortenedToFit,
            wasDeduplicated: wasTableNameDeduplicated,
            conflictsWithExistingTable,
            maxTableNameLength: args.destinationMaxTableNameLength,
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
  const keptFieldName = keptSide.field.displayLabel ?? lastPathSegment(keptSide.field.path);
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
  destinationSupportsManyToManyForeignKeys: boolean,
  destinationServiceDisplayName: string | undefined,
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
      destinationSupportsManyToManyForeignKeys,
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
  /**
   * Whether the destination can represent a many-to-many foreign key (a link field holding a list of ids).
   * When false (Postgres/Supabase, whose FK is a single scalar column), a multi-valued source foreign key is
   * still emitted — but narrowed to a single value — and its note is `downgraded` to warn that only the first
   * linked record syncs. Absent ⇒ true (no narrowing). See DEV-10753.
   */
  destinationSupportsManyToManyForeignKeys?: boolean;
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
  for (const schemaField of source.schemaFields) {
    const spec = mapSchemaFieldToCreateFieldSpec(
      source,
      schemaField,
      options,
      takenFieldNames,
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
 * A field that IS emitted is given a name unique within the table (via
 * `takenFieldNames`): if its requested name collides, a numeric suffix is
 * appended and the note records `renamedFromName`.
 */
function mapSchemaFieldToCreateFieldSpec(
  source: PlanGeneratorSource,
  schemaField: SchemaField,
  options: CreateFieldSpecOptions,
  takenFieldNames: Set<string>,
  linkedIdToRef: Map<string, string>,
  mappingByLinkedId: Map<string, string[]>,
  reciprocalSuppressionMessageByFieldKey: Map<string, string>,
  notes: FieldMappingNote[],
): CreateFieldSpec | null {
  // The destination auto-creates its own id column — never recreate it.
  if (source.idFieldPath !== undefined && schemaField.path === source.idFieldPath) return null;

  const requestedFieldName = schemaField.displayLabel ?? lastPathSegment(schemaField.path);

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
  const existingField = options.existingDestinationFieldsByName?.get(normalizeNameForUniqueness(requestedFieldName));
  if (existingField) {
    if (!schemaField.foreignKey) {
      const sourceKind = inferLogicalFieldType(
        schemaField,
        source.viewTypeByPath?.[schemaField.path],
        source.serviceDisplayName,
      ).fieldType.kind;
      if (sourceKind === existingField.kind) {
        notes.push({
          sourceDataFolderId: source.dataFolderId,
          sourceFieldPath: schemaField.path,
          fieldName: requestedFieldName,
          status: 'adopted',
          mappedKind: existingField.kind,
          existingDestinationColumnId: existingField.columnPath,
          message: `a "${existingField.kind}" field named "${requestedFieldName}" already exists on the destination; mapping to it`,
        });
        return null;
      }
    }
    notes.push({
      sourceDataFolderId: source.dataFolderId,
      sourceFieldPath: schemaField.path,
      fieldName: requestedFieldName,
      status: 'exists',
      message: `Skipping "${requestedFieldName}", a field with that name already exists in ${
        options.destinationServiceDisplayName ?? 'the destination'
      } with an incompatible type`,
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

  // This field will be emitted — give it a name unique within the table, elided to
  // the destination's field-name limit when it has one.
  const elidedRequestedFieldName = elideNameToMaxLength(requestedFieldName, options.maxFieldNameLength);
  const fieldName = allocateUniqueName(requestedFieldName, takenFieldNames, options.maxFieldNameLength);
  const wasFieldNameShortenedToFit = elidedRequestedFieldName !== requestedFieldName;
  const wasFieldNameDeduplicated = fieldName !== elidedRequestedFieldName;
  const renamedFromName = wasFieldNameShortenedToFit || wasFieldNameDeduplicated ? requestedFieldName : undefined;
  const renamedForReservedName =
    wasFieldNameDeduplicated &&
    (options.reservedFieldNames ?? []).some(
      (reserved) => normalizeNameForUniqueness(reserved) === normalizeNameForUniqueness(requestedFieldName),
    );
  const dedupClause = wasFieldNameDeduplicated
    ? renamedForReservedName
      ? `renamed from "${requestedFieldName}" — "${requestedFieldName}" is reserved by the destination`
      : `renamed from "${requestedFieldName}" to keep field names unique`
    : undefined;
  const shortenClause =
    wasFieldNameShortenedToFit && options.maxFieldNameLength !== undefined
      ? `shortened to fit the destination's ${options.maxFieldNameLength}-character field-name limit`
      : undefined;
  const renameClause = composeNoteMessage(shortenClause, dedupClause);

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
    schemaField,
    source.viewTypeByPath?.[schemaField.path],
    source.serviceDisplayName,
  );
  const message = composeNoteMessage(renameClause, inferred.message);
  notes.push({
    sourceDataFolderId: source.dataFolderId,
    sourceFieldPath: schemaField.path,
    fieldName,
    status: inferred.status,
    mappedKind: inferred.fieldType.kind,
    ...(message ? { message } : {}),
    ...(renamedFromName ? { renamedFromName } : {}),
  });
  return buildFieldSpec(fieldName, inferred.fieldType, isPrimary, schemaField.description);
}

/**
 * Compose the human-readable message for a `TableMappingNote` covering any mix of a
 * dedup rename (collision with an existing or in-plan table) and a length-limit
 * elision. The dedup-only wording is unchanged from before the elision feature, so a
 * plain collision reads exactly as it always did.
 */
function tableRenameMessage(args: {
  requestedName: string;
  finalName: string;
  wasShortenedToFit: boolean;
  wasDeduplicated: boolean;
  conflictsWithExistingTable: boolean;
  maxTableNameLength: number | undefined;
}): string {
  const clauses: string[] = [];
  if (args.wasDeduplicated) {
    clauses.push(
      args.conflictsWithExistingTable
        ? `a table named "${args.requestedName}" already exists on the destination`
        : `another table named "${args.requestedName}" is being created in this plan`,
    );
  }
  if (args.wasShortenedToFit && args.maxTableNameLength !== undefined) {
    clauses.push(`the name exceeded the destination's ${args.maxTableNameLength}-character table-name limit`);
  }
  return `${clauses.join('; ')}; renamed to "${args.finalName}"`;
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
 * otherwise falls back to the JSON-Schema primitive. Only structurally complex
 * (object/array) values are downgraded to `text`.
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
): InferredFieldType {
  // "this Notion object field" when we know the source service, "this object field" otherwise.
  const sourceServiceQualifier = sourceServiceDisplayName ? `${sourceServiceDisplayName} ` : '';
  if (viewType) {
    switch (viewType) {
      case 'checkbox':
        return { status: 'mapped', fieldType: { kind: 'boolean' } };
      case 'number':
        return { status: 'mapped', fieldType: { kind: 'number' } };
      case 'date':
        return { status: 'mapped', fieldType: dateCreateFieldType(field) };
      // An explicitly time-bearing column. `dateCreateFieldType` normally learns that from the
      // value's JSON-Schema `format`, but a column whose raw value is a Unix epoch NUMBER has no
      // string format to carry it (Stripe's `created`, flattened to a date by an `epoch_to_iso`
      // codec), so the view declares it directly. Without this it would land as a date-only
      // column and drop the time-of-day for the life of the export.
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
  destinationConnectorService?: Service,
  maxFieldNameLength?: number,
): CreateFieldSpec | null {
  if (source.idFieldPath === undefined) return null;
  const servicePrefix = source.connectorService ? source.connectorService.toLowerCase() : 'source';
  const sourceAndDestinationAreSameService =
    source.connectorService !== undefined && source.connectorService === destinationConnectorService;
  const fieldName = elideNameToMaxLength(
    sourceAndDestinationAreSameService ? `${servicePrefix}_source_record_id` : `${servicePrefix}_record_id`,
    maxFieldNameLength,
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

function buildFieldSpec(
  name: string,
  fieldType: CreateFieldType,
  isPrimary: boolean,
  description?: string,
): CreateFieldSpec {
  return {
    name,
    fieldType,
    ...(isPrimary ? { isPrimary: true } : {}),
    ...(description ? { description } : {}),
  };
}

function lastPathSegment(path: string): string {
  const segments = path.split('.');
  return segments[segments.length - 1] || path;
}
