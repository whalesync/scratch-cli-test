import type {
  CreateFieldSpec,
  CreateFieldType,
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
}

/** Maps a source `linkedTableId` to an already-existing destination table. */
export interface PlanGeneratorLinkedTableMapping {
  sourceLinkedTableId: string;
  destinationRemoteTableId: string[];
}

export interface GeneratedPlan {
  tables: CreateTableSpec[];
  notes: FieldMappingNote[];
}

export function generateCreatePlanFromSources(args: {
  sources: PlanGeneratorSource[];
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
  const tables: CreateTableSpec[] = args.sources.map((source) => {
    const fields: CreateFieldSpec[] = [];

    for (const schemaField of source.schemaFields) {
      // The destination auto-creates its own id column — never recreate it.
      if (source.idFieldPath !== undefined && schemaField.path === source.idFieldPath) continue;

      const fieldName = schemaField.displayLabel ?? lastPathSegment(schemaField.path);
      const isPrimary = source.primaryFieldPath !== undefined && schemaField.path === source.primaryFieldPath;

      if (schemaField.foreignKey) {
        const resolution = resolveForeignKey(schemaField.foreignKey.linkedTableId, linkedIdToRef, mappingByLinkedId);
        if (resolution === null) {
          notes.push({
            sourceDataFolderId: source.dataFolderId,
            sourceFieldPath: schemaField.path,
            fieldName,
            status: 'unsupported',
            message: `foreignKey to table "${schemaField.foreignKey.linkedTableId}" is not in the plan and has no linkedTableMappings entry; field omitted`,
          });
          continue;
        }
        const fieldType: CreateFieldType = { kind: 'foreignKey', target: resolution };
        fields.push(buildFieldSpec(fieldName, fieldType, isPrimary, schemaField.description));
        notes.push({
          sourceDataFolderId: source.dataFolderId,
          sourceFieldPath: schemaField.path,
          fieldName,
          status: 'mapped',
          mappedKind: 'foreignKey',
        });
        continue;
      }

      const inferred = inferLogicalFieldType(schemaField, source.viewTypeByPath?.[schemaField.path]);
      fields.push(buildFieldSpec(fieldName, inferred.fieldType, isPrimary, schemaField.description));
      notes.push({
        sourceDataFolderId: source.dataFolderId,
        sourceFieldPath: schemaField.path,
        fieldName,
        status: inferred.status,
        mappedKind: inferred.fieldType.kind,
        message: inferred.message,
      });
    }

    return { name: source.tableName, fields, ref: source.ref };
  });

  return { tables, notes };
}

export interface InferredFieldType {
  status: 'mapped' | 'downgraded';
  fieldType: CreateFieldType;
  message?: string;
}

/**
 * Map a non-foreignKey source field to a logical create field type using only
 * generic signals. Prefers a `TablePropertyType` display hint when available,
 * otherwise falls back to the JSON-Schema primitive. Anything read-only,
 * computed, or structurally complex is downgraded to `text` with a note.
 */
export function inferLogicalFieldType(field: SchemaField, viewType?: TablePropertyType): InferredFieldType {
  if (field.readonly) {
    return {
      status: 'downgraded',
      fieldType: { kind: 'text' },
      message: 'read-only/computed source field; created as an editable text field',
    };
  }

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
