import { TSchema } from '@sinclair/typebox';
import { ColumnMapping } from '@spinner/shared-types';

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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (current.type === undefined && (current as any).anyOf) {
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

  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const anyOf = (schema as any).anyOf as TSchema[] | undefined;
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
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const anyOf = (schema as any).anyOf as TSchema[] | undefined;
  if (anyOf) {
    const nonNull = anyOf.find((s) => s.type !== 'null');
    return nonNull;
  }
  return undefined;
}
