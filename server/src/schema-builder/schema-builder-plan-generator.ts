import type {
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
import type { SchemaField } from 'src/utils/schema-helpers';
import { allocateUniqueName, normalizeNameForUniqueness } from './schema-builder-unique-names';

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
   * Remote table identifiers for THIS source. A sibling source's foreignKey
   * whose `linkedTableId` matches one of these resolves to an in-plan `{ ref }`.
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

/** An existing, materialized destination folder a source is diffed against. */
export interface ExistingDestinationTable {
  /** The destination folder's id (echoed back so the client can target it). */
  dataFolderId: string;
  /** The destination folder's remote table id (target of the /schema/fields POST). */
  remoteTableId: string[];
  /**
   * The destination table's current field names, derived on the SAME basis the
   * generator names fields (`displayLabel ?? lastPathSegment`) so the diff matches.
   */
  fieldNames: string[];
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
  linkedTableMappings?: PlanGeneratorLinkedTableMapping[];
  /**
   * Display names of tables that already exist on the destination under the
   * create parent (e.g. an Airtable base). A new table whose name collides with
   * one of these — or with another new table in this plan — is given a numeric
   * suffix and recorded in `tableNotes`. The service supplies these from
   * `connector.listTables()`; absent ⇒ only in-plan collisions are resolved.
   */
  existingDestinationTableNames?: string[];
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
          notes,
        ),
      );
    } else {
      const fields = collectCreateFieldSpecsForSource(
        source,
        { allowSiblingRefForeignKeys: true, markPrimaryField: true },
        linkedIdToRef,
        mappingByLinkedId,
        notes,
      );
      // Give the destination table a column to sync the source record's remote id
      // into, so a synced row always knows where it came from. Skipped when a
      // same-named field already exists (the source already has one) or when the
      // source has no known remote-id path to map from (see buildSourceRecordIdField).
      const sourceRecordIdField = buildSourceRecordIdField(source, fields, args.destinationConnectorService);
      if (sourceRecordIdField && source.idFieldPath !== undefined) {
        fields.push(sourceRecordIdField);
        // Record where this injected field is fed from: the source's remote-id
        // path (`idColumnRemoteId`). The client/sync reads `sourceFieldPath ->
        // fieldName` from notes to wire the source identity into this column.
        notes.push({
          sourceDataFolderId: source.dataFolderId,
          sourceFieldPath: source.idFieldPath,
          fieldName: sourceRecordIdField.name,
          status: 'mapped',
          mappedKind: 'text',
        });
      }
      // Classify the collision BEFORE allocating: `takenTableNames` merges existing
      // and in-plan names, so the distinction must be read off the frozen set first.
      const conflictsWithExistingTable = existingDestinationTableNames.has(
        normalizeNameForUniqueness(source.tableName),
      );
      const tableName = allocateUniqueName(source.tableName, takenTableNames);
      if (tableName !== source.tableName) {
        tableNotes.push({
          sourceDataFolderId: source.dataFolderId,
          ref: source.ref,
          tableName,
          renamedFromName: source.tableName,
          reason: conflictsWithExistingTable ? 'conflicts_with_existing_table' : 'duplicate_in_plan',
          message: conflictsWithExistingTable
            ? `a table named "${source.tableName}" already exists on the destination; renamed to "${tableName}"`
            : `another table named "${source.tableName}" is being created in this plan; renamed to "${tableName}"`,
        });
      }
      // `ref` is unchanged by the rename, so cross-table foreign keys (resolved by
      // ref, not name) still wire up correctly.
      tables.push({ name: tableName, fields, ref: source.ref });
    }
  }

  return { tables, fieldPlans, notes, tableNotes };
}

/**
 * Build an add-fields plan for a source whose destination table exists: the
 * source's create-field specs minus any field the destination already has (by
 * name, case-insensitive), with each skipped field surfaced as an `exists` note.
 * The primary field is not re-designated and sibling-`{ ref }` foreign keys are
 * downgraded to `unsupported` (the /schema/fields endpoint can't express either).
 */
function buildAddFieldsPlanForSource(
  source: PlanGeneratorSource,
  existingDestination: ExistingDestinationTable,
  connectorAccountId: string,
  linkedIdToRef: Map<string, string>,
  mappingByLinkedId: Map<string, string[]>,
  notes: FieldMappingNote[],
): CreateSchemaFieldsPlan {
  const existingDestinationFieldNames = new Set(existingDestination.fieldNames.map(normalizeNameForUniqueness));
  const fields = collectCreateFieldSpecsForSource(
    source,
    { allowSiblingRefForeignKeys: false, markPrimaryField: false, existingDestinationFieldNames },
    linkedIdToRef,
    mappingByLinkedId,
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
  /** When present, skip any field whose name is already in this (normalized) set. */
  existingDestinationFieldNames?: Set<string>;
}

/** Map every field of a source to a create-field spec, pushing a note per field. */
function collectCreateFieldSpecsForSource(
  source: PlanGeneratorSource,
  options: CreateFieldSpecOptions,
  linkedIdToRef: Map<string, string>,
  mappingByLinkedId: Map<string, string[]>,
  notes: FieldMappingNote[],
): CreateFieldSpec[] {
  const fields: CreateFieldSpec[] = [];
  // Field names already taken in this table's namespace: the destination's current
  // fields (add-fields case) plus every field we emit here. An emitted field whose
  // name collides gets a numeric suffix + a 'renamed' note. A COPY of the
  // existing-destination set, so the frozen original still drives the 'exists' skip.
  const takenFieldNames = new Set(options.existingDestinationFieldNames ?? []);
  for (const schemaField of source.schemaFields) {
    const spec = mapSchemaFieldToCreateFieldSpec(
      source,
      schemaField,
      options,
      takenFieldNames,
      linkedIdToRef,
      mappingByLinkedId,
      notes,
    );
    if (spec) fields.push(spec);
  }
  return fields;
}

/**
 * Map one source field to a create-field spec, or return null (with an
 * explanatory note) when it should be omitted: the id column, a field the
 * destination already has, or an unresolvable/sibling-ref foreign key.
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
  notes: FieldMappingNote[],
): CreateFieldSpec | null {
  // The destination auto-creates its own id column — never recreate it.
  if (source.idFieldPath !== undefined && schemaField.path === source.idFieldPath) return null;

  const requestedFieldName = schemaField.displayLabel ?? lastPathSegment(schemaField.path);

  // Add-fields diff: a field the destination already has is skipped, not recreated.
  // Checked against the FROZEN existing-destination set (not the growing taken set)
  // so a second NEW field of the same name is renamed rather than mistaken for "exists".
  if (options.existingDestinationFieldNames?.has(normalizeNameForUniqueness(requestedFieldName))) {
    notes.push({
      sourceDataFolderId: source.dataFolderId,
      sourceFieldPath: schemaField.path,
      fieldName: requestedFieldName,
      status: 'exists',
      message: `a field named "${requestedFieldName}" already exists on the destination table; skipped`,
    });
    return null;
  }

  const isPrimary =
    options.markPrimaryField && source.primaryFieldPath !== undefined && schemaField.path === source.primaryFieldPath;

  // Resolve a foreignKey up front so an unsupported one is omitted (and its note
  // pushed) BEFORE a unique name slot is allocated to a field we won't emit.
  let foreignKeyType: CreateFieldType | null = null;
  if (schemaField.foreignKey) {
    const resolution = resolveForeignKey(schemaField.foreignKey.linkedTableId, linkedIdToRef, mappingByLinkedId);
    // A sibling `{ ref }` target can't be expressed when adding fields to an
    // existing table (the /schema/fields endpoint rejects `{ ref }`); only a
    // mapped `existingRemoteTableId` is usable there.
    const isSiblingRefTarget = resolution !== null && 'ref' in resolution;
    if (resolution === null || (isSiblingRefTarget && !options.allowSiblingRefForeignKeys)) {
      notes.push({
        sourceDataFolderId: source.dataFolderId,
        sourceFieldPath: schemaField.path,
        fieldName: requestedFieldName,
        status: 'unsupported',
        message: isSiblingRefTarget
          ? `foreignKey to a table being created in the same plan can't be added to an existing destination table; provide a linkedTableMappings entry; field omitted`
          : `foreignKey to table "${schemaField.foreignKey.linkedTableId}" is not in the plan and has no linkedTableMappings entry; field omitted`,
      });
      return null;
    }
    foreignKeyType = { kind: 'foreignKey', target: resolution };
  }

  // This field will be emitted — give it a name unique within the table.
  const fieldName = allocateUniqueName(requestedFieldName, takenFieldNames);
  const renamedFromName = fieldName !== requestedFieldName ? requestedFieldName : undefined;
  const renameClause = renamedFromName ? `renamed from "${renamedFromName}" to keep field names unique` : undefined;

  if (foreignKeyType) {
    notes.push({
      sourceDataFolderId: source.dataFolderId,
      sourceFieldPath: schemaField.path,
      fieldName,
      status: 'mapped',
      mappedKind: 'foreignKey',
      ...(renameClause ? { message: renameClause } : {}),
      ...(renamedFromName ? { renamedFromName } : {}),
    });
    return buildFieldSpec(fieldName, foreignKeyType, isPrimary, schemaField.description);
  }

  const inferred = inferLogicalFieldType(schemaField, source.viewTypeByPath?.[schemaField.path]);
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
 */
export function inferLogicalFieldType(field: SchemaField, viewType?: TablePropertyType): InferredFieldType {
  if (viewType) {
    switch (viewType) {
      case 'checkbox':
        return { status: 'mapped', fieldType: { kind: 'boolean' } };
      case 'number':
        return { status: 'mapped', fieldType: { kind: 'number' } };
      case 'date':
        return { status: 'mapped', fieldType: { kind: 'date' } };
      case 'url':
        return { status: 'mapped', fieldType: { kind: 'url' } };
      case 'richtext':
        return { status: 'mapped', fieldType: { kind: 'longText' } };
      case 'string':
        return { status: 'mapped', fieldType: { kind: 'text' } };
      case 'object':
        return {
          status: 'downgraded',
          fieldType: { kind: 'text' },
          message: 'complex object field; created as plain text',
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
        message: `${field.type} field; created as plain text`,
      };
    default:
      return {
        status: 'downgraded',
        fieldType: { kind: 'text' },
        message: `unrecognized source type "${field.type}"; created as plain text`,
      };
  }
}

/** Resolve a source foreignKey's linked table to a create-side target, or null if unresolvable. */
function resolveForeignKey(
  linkedTableId: string,
  linkedIdToRef: Map<string, string>,
  mappingByLinkedId: Map<string, string[]>,
): ForeignKeyTarget | null {
  const siblingRef = linkedIdToRef.get(linkedTableId);
  if (siblingRef !== undefined) return { ref: siblingRef };
  const existingRemoteTableId = mappingByLinkedId.get(linkedTableId);
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
): CreateFieldSpec | null {
  if (source.idFieldPath === undefined) return null;
  const servicePrefix = source.connectorService ? source.connectorService.toLowerCase() : 'source';
  const sourceAndDestinationAreSameService =
    source.connectorService !== undefined && source.connectorService === destinationConnectorService;
  const fieldName = sourceAndDestinationAreSameService
    ? `${servicePrefix}_source_record_id`
    : `${servicePrefix}_record_id`;
  const existingFieldNames = new Set(existingFields.map((field) => normalizeNameForUniqueness(field.name)));
  if (existingFieldNames.has(normalizeNameForUniqueness(fieldName))) return null;
  return {
    name: fieldName,
    fieldType: { kind: 'text' },
    description: 'Remote id of the source record this row was synced from.',
    isSourceRecordId: true,
  };
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
