import { TSchema } from '@sinclair/typebox';
import { ColumnMapping, ColumnMappingV2 } from '@spinner/shared-types';
import { getSchemaAtFieldPath } from 'src/utils/field-path';

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

    // A transformer reshapes the source value before it reaches the destination, so
    // the raw source→destination type check no longer applies — the transform
    // exists precisely to bridge the mismatch (e.g. a string wrapped into Notion's
    // object-shaped `rich_text` envelope). The richer editor-time type tracer
    // (type-validator.ts) still validates the predicted types through the pipeline.
    if (mapping.transformer || (mapping.transformers && mapping.transformers.length > 0)) {
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
 *
 * A path segment (a connector field name) may itself contain a dot — a Postgres
 * column literally named `col.with.dots`, an Airtable "No. of Employees" — which a
 * naive `path.split('.')` would mis-segment, so this delegates to the schema-aware
 * resolver that recovers the real segment boundaries from the schema's own
 * property names before descending (DEV-10959). Behavior is identical for every
 * path whose segment names contain no dots.
 */
export function getSchemaAtPath(schema: TSchema, path: string): TSchema | undefined {
  return getSchemaAtFieldPath(schema, path);
}

/**
 * If `schema` is a nullable union — a `Type.Union([X, Type.Null()])` that a connector
 * produces when it wraps an optional field so it also accepts a present `null` — return
 * the underlying non-null branch `X`. Otherwise return `schema` unchanged.
 *
 * Leaf field schemas fetched via {@link getSchemaAtPath} keep this nullable wrapper in
 * place (the wrapper is only stripped while traversing *into* an object's properties, not
 * for the leaf itself), so callers that need to inspect the underlying field shape — e.g.
 * the Webflow Option transformers reading the field's `anyOf` option literals — must unwrap
 * it first. A schema that is not a nullable union (a bare option union, a plain object,
 * etc.) is returned as-is so its own `anyOf` is left intact.
 */
export function unwrapNullableUnionSchema(schema: TSchema): TSchema {
  const anyOf = (schema as { anyOf?: TSchema[] }).anyOf;
  if (Array.isArray(anyOf) && anyOf.some((branch) => branch.type === 'null')) {
    const nonNullBranch = anyOf.find((branch) => branch.type !== 'null');
    if (nonNullBranch) {
      return nonNullBranch;
    }
  }
  return schema;
}

/** The JSON-schema `format` values a connector puts on a date-typed string column. */
const ISO_DATE_STRING_FORMATS: ReadonlySet<string> = new Set(['date', 'date-time']);

/**
 * Whether a leaf field schema describes an ISO-8601 date / date-time STRING column —
 * a `Type.String({ format: 'date' | 'date-time' })`, including when wrapped in a
 * nullable or formula-error `Type.Union([...])` (as Airtable/Postgres/Webflow/… all
 * declare their date fields). Every connector types a real date column this way, so
 * this is the connector-agnostic signal the shared sync transform boundary uses to
 * know a destination will only accept a genuine calendar date — letting it null an
 * invalid one with a per-field warning instead of losing the whole record (DEV-11044).
 *
 * Notion's date property is a wrapped OBJECT, not a bare date-format string, so it is
 * deliberately NOT matched here; its invalid-date guard lives in the Notion write path.
 */
export function schemaIsIsoDateStringColumn(schema: TSchema | undefined): boolean {
  if (!schema) {
    return false;
  }
  const arms = (schema as { anyOf?: TSchema[] }).anyOf ?? [schema];
  return arms.some((arm) => {
    const format = (arm as { format?: unknown }).format;
    return arm.type === 'string' && typeof format === 'string' && ISO_DATE_STRING_FORMATS.has(format);
  });
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
