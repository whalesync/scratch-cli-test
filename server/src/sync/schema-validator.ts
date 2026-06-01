import { TSchema } from '@sinclair/typebox';
import { ColumnMapping, ColumnMappingV2 } from '@spinner/shared-types';

/**
 * Validates that the source and destination fields in a mapping are compatible.
 * Returns an array of error messages, or an empty array if valid.
 */
export function validateSchemaMapping(
  sourceSchema: TSchema,
  destSchema: TSchema,
  columnMappings: ColumnMapping[],
): string[] {
  const errors: string[] = [];

  for (const mapping of columnMappings) {
    const sourcePath = mapping.sourceColumnId;
    const destPath = mapping.destinationColumnId;
    const sourceFieldSchema = getSchemaAtPath(sourceSchema, sourcePath);
    const destFieldSchema = getSchemaAtPath(destSchema, destPath);

    if (!sourceFieldSchema) {
      errors.push(`Source field '${sourcePath}' not found in schema`);
      continue;
    }

    if (!destFieldSchema) {
      errors.push(`Destination field '${destPath}' not found in schema`);
      continue;
    }

    const sourceType = getSchemaType(sourceFieldSchema);
    const destType = getSchemaType(destFieldSchema);

    if (sourceType && destType && sourceType !== destType) {
      errors.push(
        `Type mismatch for mapping '${sourcePath}' -> '${destPath}': Source type '${sourceType}' cannot be mapped to Destination type '${destType}'`,
      );
    }
  }

  return errors;
}

export interface ConstantTypeMismatch {
  destinationColumnId: string;
  /** Destination-schema type vocabulary: string | number | integer | boolean | object | array. */
  expected: string;
  /** Constant value's type, in the same vocabulary. */
  got: string;
}

/**
 * Maps a constant literal value to the destination-schema type vocabulary used
 * by `getSchemaType`. Returns null for `null` constants, which are assignable
 * to any column (they clear the field).
 */
function constantValueType(value: string | number | boolean | null): 'string' | 'number' | 'boolean' | null {
  if (value === null) return null;
  switch (typeof value) {
    case 'boolean':
      return 'boolean';
    case 'number':
      return 'number';
    default:
      return 'string';
  }
}

/** True when a constant of `constantType` may be written into a `expectedColumnType` column. */
function isConstantTypeCompatible(constantType: 'string' | 'number' | 'boolean', expectedColumnType: string): boolean {
  if (constantType === 'number') {
    // JSON has a single number type; an `integer` column accepts a numeric constant.
    return expectedColumnType === 'number' || expectedColumnType === 'integer';
  }
  return constantType === expectedColumnType;
}

/**
 * Checks that every `{ kind: 'constant' }` column mapping writes a value whose
 * type matches its destination column. Returns one entry per mismatch (empty
 * when all constants are compatible).
 *
 * Skips constants whose destination column type cannot be resolved from the
 * schema (column absent, or `Type.Any()`) — the same lenient stance as
 * `validateSchemaMapping`, which only flags a conflict when both types are known.
 * `null` constants are always allowed (they clear the field on any column).
 */
export function findConstantTypeMismatches(
  destSchema: TSchema,
  columnMappings: ColumnMappingV2[],
): ConstantTypeMismatch[] {
  const mismatches: ConstantTypeMismatch[] = [];

  for (const mapping of columnMappings) {
    if (mapping.source.kind !== 'constant') continue;

    const constantType = constantValueType(mapping.source.value);
    if (constantType === null) continue;

    const destFieldSchema = getSchemaAtPath(destSchema, mapping.destinationColumnId);
    if (!destFieldSchema) continue;

    const expectedColumnType = getSchemaType(destFieldSchema);
    if (!expectedColumnType) continue;

    if (!isConstantTypeCompatible(constantType, expectedColumnType)) {
      mismatches.push({
        destinationColumnId: mapping.destinationColumnId,
        expected: expectedColumnType,
        got: constantType,
      });
    }
  }

  return mismatches;
}

/**
 * Traverses a JSON schema using a dot-notation path to find a nested schema.
 * Supports traversing 'properties' of objects.
 */
export function getSchemaAtPath(schema: TSchema, path: string): TSchema | undefined {
  const parts = path.split('.');
  let current: TSchema | undefined = schema;

  for (const part of parts) {
    if (!current) {
      return undefined;
    }

    // Unwrap Optional/Union wrapper to get to the object if needed
    if (current.type === undefined && (current as { anyOf?: unknown }).anyOf) {
      const unwrapped = unwrapSchema(current);
      if (unwrapped) current = unwrapped;
    }

    if (current.type !== 'object' || !current.properties) {
      return undefined;
    }

    const properties = current.properties as Record<string, TSchema>;
    current = properties[part];
  }

  return current;
}

/**
 * Unwraps schema from TypeBox Optional/Union wrappers to get the underlying type.
 * Returns the base type string (e.g. 'string', 'number', 'boolean', 'object').
 */
export function getSchemaType(schema: TSchema): string | undefined {
  if (schema.type) {
    return schema.type as string;
  }

  const anyOf = (schema as { anyOf?: TSchema[] }).anyOf;
  if (anyOf) {
    const realTypes = anyOf.filter((s) => s.type !== 'null');
    if (realTypes.length === 1) {
      return getSchemaType(realTypes[0]);
    }
    if (realTypes.length > 0) {
      return getSchemaType(realTypes[0]);
    }
  }

  return undefined;
}

/**
 * Returns true if a value of `sourceType` can be assigned to a field typed as `destType`.
 *
 * Rules:
 * - Any (Type.Any() / empty schema) on either side is always compatible.
 * - Primitive equality: string→string, number→number, boolean→boolean, object→object, etc.
 * - Source is compatible with dest if dest is anyOf(...) and source matches one of the members.
 */
export function isTypeCompatible(sourceType: TSchema, destType: TSchema): boolean {
  // Any on either side is always compatible
  if (isAnySchema(sourceType) || isAnySchema(destType)) {
    return true;
  }

  // Unwrap Optional/nullable on both sides for comparison
  const source = unwrapSchema(sourceType) ?? sourceType;
  const dest = unwrapSchema(destType) ?? destType;

  // If dest is a union (anyOf), source is compatible if it matches any member
  const destAnyOf = (dest as { anyOf?: TSchema[] }).anyOf;
  if (destAnyOf) {
    return destAnyOf.some((member) => isTypeCompatible(source, member));
  }

  // Primitive equality: both have a `type` field and they match
  if (source.type && dest.type) {
    return source.type === dest.type;
  }

  return false;
}

/** Type.Any() produces an empty schema `{}` with no `type` field and no `anyOf`. */
function isAnySchema(schema: TSchema): boolean {
  return !schema.type && !(schema as { anyOf?: unknown }).anyOf;
}

function unwrapSchema(schema: TSchema): TSchema | undefined {
  const anyOf = (schema as { anyOf?: TSchema[] }).anyOf;
  if (anyOf) {
    const nonNull = anyOf.find((s) => s.type !== 'null');
    return nonNull;
  }
  return undefined;
}
