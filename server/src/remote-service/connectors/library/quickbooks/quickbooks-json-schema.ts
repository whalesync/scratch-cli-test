import { Type, type TSchema } from '@sinclair/typebox';
import { CONNECTOR_DATA_TYPE, READONLY_FLAG } from '../../json-schema';
import { BaseJsonTableSpec, EntityId } from '../../types';
import { ENTITY_CONFIG, QuickBooksEntityType } from './quickbooks-types';

/**
 * Regex to detect ISO 8601 datetime strings.
 * Matches patterns like: 2024-01-15T10:30:00-07:00, 2024-01-15T10:30:00Z
 */
const ISO_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/**
 * Regex to detect ISO 8601 date-only strings.
 * Matches patterns like: 2024-01-15
 */
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Tracks observed types for a single field across multiple sample records.
 */
interface FieldTypeInfo {
  types: Set<string>;
  nullable: boolean;
  optional: boolean;
  /** For objects: nested field info keyed by property name */
  objectFields?: Map<string, FieldTypeInfo>;
  /** For arrays: type info for array elements */
  arrayItemInfo?: FieldTypeInfo;
  /** Count of samples that had this field */
  sampleCount: number;
}

/**
 * Classify a JS value into a type string for schema inference.
 */
function classifyValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') {
    if (ISO_DATETIME_REGEX.test(value)) return 'datetime';
    if (ISO_DATE_REGEX.test(value)) return 'date';
    return 'string';
  }
  return 'string';
}

/**
 * Merge a value's type information into a FieldTypeInfo tracker.
 */
function mergeValue(info: FieldTypeInfo, value: unknown, totalSamples: number): void {
  info.sampleCount++;

  const type = classifyValue(value);

  if (type === 'null') {
    info.nullable = true;
    return;
  }

  info.types.add(type);

  if (type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    if (!info.objectFields) {
      info.objectFields = new Map();
    }
    const obj = value as Record<string, unknown>;
    for (const [key, val] of Object.entries(obj)) {
      if (!info.objectFields.has(key)) {
        info.objectFields.set(key, createFieldTypeInfo());
      }
      mergeValue(info.objectFields.get(key)!, val, totalSamples);
    }
  }

  if (type === 'array' && Array.isArray(value)) {
    if (!info.arrayItemInfo) {
      info.arrayItemInfo = createFieldTypeInfo();
    }
    for (const item of value) {
      mergeValue(info.arrayItemInfo, item, totalSamples);
    }
  }
}

/**
 * Create a new empty FieldTypeInfo.
 */
function createFieldTypeInfo(): FieldTypeInfo {
  return {
    types: new Set(),
    nullable: false,
    optional: false,
    sampleCount: 0,
  };
}

/**
 * Convert a FieldTypeInfo into a TypeBox TSchema.
 */
function fieldInfoToSchema(info: FieldTypeInfo): TSchema {
  const schemas: TSchema[] = [];

  for (const type of info.types) {
    switch (type) {
      case 'string':
        schemas.push(Type.String());
        break;
      case 'datetime':
        schemas.push(Type.String({ format: 'date-time', [CONNECTOR_DATA_TYPE]: 'datetime' }));
        break;
      case 'date':
        schemas.push(Type.String({ format: 'date', [CONNECTOR_DATA_TYPE]: 'date' }));
        break;
      case 'number':
        schemas.push(Type.Number());
        break;
      case 'boolean':
        schemas.push(Type.Boolean());
        break;
      case 'object':
        if (info.objectFields && info.objectFields.size > 0) {
          const properties: Record<string, TSchema> = {};
          for (const [key, fieldInfo] of info.objectFields) {
            let fieldSchema = fieldInfoToSchema(fieldInfo);
            if (fieldInfo.optional || fieldInfo.nullable) {
              fieldSchema = Type.Optional(fieldSchema);
            }
            properties[key] = fieldSchema;
          }
          schemas.push(Type.Object(properties));
        } else {
          schemas.push(Type.Record(Type.String(), Type.Unknown()));
        }
        break;
      case 'array':
        if (info.arrayItemInfo && info.arrayItemInfo.types.size > 0) {
          schemas.push(Type.Array(fieldInfoToSchema(info.arrayItemInfo)));
        } else {
          schemas.push(Type.Array(Type.Unknown()));
        }
        break;
    }
  }

  if (info.nullable) {
    schemas.push(Type.Null());
  }

  if (schemas.length === 0) {
    return Type.Unknown();
  }
  if (schemas.length === 1) {
    return schemas[0];
  }
  return Type.Union(schemas);
}

/**
 * Infer a TypeBox schema from an array of sample JSON records.
 *
 * Walks all records, building a merged type map for each JSON path,
 * then converts the merged type map to TypeBox types.
 *
 * All fields are marked as read-only since this is a read-only connector.
 */
export function inferSchemaFromSamples(samples: Record<string, unknown>[]): TSchema {
  if (samples.length === 0) {
    return Type.Object(
      {
        Id: Type.String({ [READONLY_FLAG]: true }),
      },
      { additionalProperties: true },
    );
  }

  // Collect all field names and their type info across all samples
  const fieldMap = new Map<string, FieldTypeInfo>();

  for (const sample of samples) {
    for (const [key, value] of Object.entries(sample)) {
      if (!fieldMap.has(key)) {
        fieldMap.set(key, createFieldTypeInfo());
      }
      mergeValue(fieldMap.get(key)!, value, samples.length);
    }
  }

  // Mark fields that don't appear in all samples as optional
  for (const [, info] of fieldMap) {
    if (info.sampleCount < samples.length) {
      info.optional = true;
    }
  }

  // Build TypeBox properties
  const properties: Record<string, TSchema> = {};
  for (const [key, info] of fieldMap) {
    let schema = fieldInfoToSchema(info);
    // Mark all fields as readonly (read-only connector)
    schema = { ...schema, [READONLY_FLAG]: true };

    if (info.optional) {
      schema = Type.Optional(schema);
      schema = { ...schema, [READONLY_FLAG]: true };
    }

    properties[key] = schema;
  }

  return Type.Object(properties);
}

/**
 * Build a BaseJsonTableSpec for a QuickBooks entity type using inferred schema.
 */
export function buildQuickBooksJsonTableSpec(
  id: EntityId,
  entityType: QuickBooksEntityType,
  samples: Record<string, unknown>[],
): BaseJsonTableSpec {
  const config = ENTITY_CONFIG[entityType];
  const schema = inferSchemaFromSamples(samples);

  return {
    id,
    slug: entityType.toLowerCase(),
    name: config.displayName,
    schema,
    idColumnRemoteId: 'Id',
    titleColumnRemoteId: [config.titleField],
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}
