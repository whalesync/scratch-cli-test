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
      // Allow assigning non-null to null (e.g. string -> string | null)
      // and null to non-null (e.g. string | null -> string) depending on desired strictness.
      // For now, we only check if the base types are different.
      // Ideally we should check if source is assignable to dest.
      // But based on "return true if each field mapping is between fields of the same type",
      // we'll stick to simple equality of base types.
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
    // But usually traversal happens on objects.
    // If current is Union (e.g. Optional Object), we might need to find the Object part.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (current.type === undefined && (current as any).anyOf) {
      // Handle TypeBox Union
      // It's hard to distinguish which union member to follow without data.
      // But typically for data folders, we have Object or Optional(Object).
      // Let's try to unwrap default/optional wrapper.
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
    // TypeBox specific types like 'number', 'string', 'object'
    return schema.type as string;
  }

  // Handle TypeBox generic Union or Optional (which is often Union([Type, Null]))
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const anyOf = (schema as any).anyOf as TSchema[] | undefined;
  if (anyOf) {
    // Filter out Null type to find the "real" type
    const realTypes = anyOf.filter((s) => s.type !== 'null');
    if (realTypes.length === 1) {
      return getSchemaType(realTypes[0]);
    }
    // If multiple real types, it's a complex union, maybe return 'union'?
    // For now, assume simple Optional case.
    if (realTypes.length > 0) {
      // Just take the first one? Or maybe we can't determine unique type.
      return getSchemaType(realTypes[0]);
    }
  }

  return undefined;
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
