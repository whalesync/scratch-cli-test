import type {
  CreateFieldSpec,
  CreateFieldType,
  CreateSchemaFieldsPlan,
  CreateTableSpec,
  FieldMappingNote,
  ForeignKeyTarget,
  TablePropertyType,
} from '@spinner/shared-types';
import type { SchemaField } from 'src/utils/schema-helpers';

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
}

export function generateCreatePlanFromSources(args: {
  sources: PlanGeneratorSource[];
  /** The single destination connector account every source targets. */
  destinationConnectorAccountId: string;
  linkedTableMappings?: PlanGeneratorLinkedTableMapping[];
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
  const tables: CreateTableSpec[] = [];
  const fieldPlans: CreateSchemaFieldsPlan[] = [];

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
      tables.push({ name: source.tableName, fields, ref: source.ref });
    }
  }

  return { tables, fieldPlans, notes };
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
  const existingDestinationFieldNames = new Set(existingDestination.fieldNames.map(normalizeFieldName));
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
  for (const schemaField of source.schemaFields) {
    const spec = mapSchemaFieldToCreateFieldSpec(source, schemaField, options, linkedIdToRef, mappingByLinkedId, notes);
    if (spec) fields.push(spec);
  }
  return fields;
}

/**
 * Map one source field to a create-field spec, or return null (with an
 * explanatory note) when it should be omitted: the id column, a field the
 * destination already has, or an unresolvable/sibling-ref foreign key.
 */
function mapSchemaFieldToCreateFieldSpec(
  source: PlanGeneratorSource,
  schemaField: SchemaField,
  options: CreateFieldSpecOptions,
  linkedIdToRef: Map<string, string>,
  mappingByLinkedId: Map<string, string[]>,
  notes: FieldMappingNote[],
): CreateFieldSpec | null {
  // The destination auto-creates its own id column — never recreate it.
  if (source.idFieldPath !== undefined && schemaField.path === source.idFieldPath) return null;

  const fieldName = schemaField.displayLabel ?? lastPathSegment(schemaField.path);

  // Add-fields diff: a field the destination already has is skipped, not recreated.
  if (options.existingDestinationFieldNames?.has(normalizeFieldName(fieldName))) {
    notes.push({
      sourceDataFolderId: source.dataFolderId,
      sourceFieldPath: schemaField.path,
      fieldName,
      status: 'exists',
      message: `a field named "${fieldName}" already exists on the destination table; skipped`,
    });
    return null;
  }

  const isPrimary =
    options.markPrimaryField && source.primaryFieldPath !== undefined && schemaField.path === source.primaryFieldPath;

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
        fieldName,
        status: 'unsupported',
        message: isSiblingRefTarget
          ? `foreignKey to a table being created in the same plan can't be added to an existing destination table; provide a linkedTableMappings entry; field omitted`
          : `foreignKey to table "${schemaField.foreignKey.linkedTableId}" is not in the plan and has no linkedTableMappings entry; field omitted`,
      });
      return null;
    }
    const fieldType: CreateFieldType = { kind: 'foreignKey', target: resolution };
    notes.push({
      sourceDataFolderId: source.dataFolderId,
      sourceFieldPath: schemaField.path,
      fieldName,
      status: 'mapped',
      mappedKind: 'foreignKey',
    });
    return buildFieldSpec(fieldName, fieldType, isPrimary, schemaField.description);
  }

  const inferred = inferLogicalFieldType(schemaField, source.viewTypeByPath?.[schemaField.path]);
  notes.push({
    sourceDataFolderId: source.dataFolderId,
    sourceFieldPath: schemaField.path,
    fieldName,
    status: inferred.status,
    mappedKind: inferred.fieldType.kind,
    message: inferred.message,
  });
  return buildFieldSpec(fieldName, inferred.fieldType, isPrimary, schemaField.description);
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

/**
 * Field-name identity for the add-fields diff: trim + lowercase, matching the
 * server's `validateNamesAgainstExisting` and the client's duplicate-name check,
 * so the plan and the eventual /schema/fields create agree on what "exists".
 */
function normalizeFieldName(name: string): string {
  return name.trim().toLowerCase();
}
