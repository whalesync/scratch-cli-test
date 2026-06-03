/**
 * Shared cell-input coercion for saved field edits.
 *
 * Saving an edited field round-trips the user's input as faithfully as possible —
 * like editing a value in a text file. The connector JSON schema never decides
 * the *structure* written to disk (schema-driven structural coercion is what
 * clobbered Notion's `{id,type,<type>}` envelopes — see DEV-10308); it only
 * contributes a scalar *type hint* for the one thing the data itself can't
 * answer: how to interpret text typed into an empty leaf.
 *
 * Precedence when interpreting typed text for a leaf:
 *  1. The leaf already holds a value → use that value's own JSON type, schema
 *     ignored. A string leaf stays a string (numeric-looking text can't silently
 *     become a number); a number/boolean/object/array leaf is JSON-parsed, so
 *     raw-JSON edits of an envelope round-trip as the same object.
 *  2. The leaf is empty (`null` / missing) → use the schema's scalar type hint
 *     (string → verbatim text; number/integer/boolean → parse; else JSON-parse).
 *  3. No usable schema hint → JSON-parse-with-string fallback.
 *
 * Clearing a cell (empty input) writes `null` when the schema marks the leaf
 * nullable, otherwise an empty string (falling back to the leaf's own type when
 * no schema is available). Coercion never throws: text that doesn't fit the hint
 * is written verbatim as a string and surfaced by the separate validators — we
 * prefer flexibility over rejecting the edit, since the schema may itself be wrong.
 *
 * Full rule, worked examples, and rationale: ../../docs/cell-edit-save-coercion.md
 */

type JsonSchemaRecord = Record<string, unknown>;

export type CellScalarType = 'string' | 'number' | 'integer' | 'boolean';

export interface SchemaLeafHint {
  /** First non-null scalar type the schema allows for this leaf, if any. */
  scalarType: CellScalarType | null;
  /** Whether the schema permits `null` at this leaf. */
  nullable: boolean;
}

/**
 * Legacy primitive: trim, try `JSON.parse`, and fall back to the original
 * (untrimmed) string. The structural-interpretation step used by
 * {@link coerceCellInputTextAgainstExistingValueOrSchema} when neither the
 * existing value nor the schema constrains the result.
 */
export function coerceCellInputText(input: string): unknown {
  const trimmed = input.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return input;
  }
}

/**
 * Interprets the user's typed text for a saved field edit. The caller surgically
 * replaces just this leaf with the returned value, leaving the rest of the
 * record byte-identical. Follows the existing-value-then-schema precedence
 * documented at the top of this file. See DEV-10308.
 */
export function coerceCellInputTextAgainstExistingValueOrSchema(
  existingValue: unknown,
  schemaHint: SchemaLeafHint | null,
  input: string,
): unknown {
  // Clearing the cell: schema nullability decides whether "empty" means `null`
  // or an empty string; with no schema, mirror the leaf's own type.
  if (input.trim() === '') {
    if (schemaHint) {
      return schemaHint.nullable ? null : '';
    }
    return typeof existingValue === 'string' ? '' : null;
  }

  // The leaf already has a value → its own JSON type wins and the schema is
  // ignored, so a wrong/normalized schema can never retype or restructure
  // already-stored data.
  if (typeof existingValue === 'string') {
    return input;
  }
  if (existingValue !== null && existingValue !== undefined) {
    return coerceCellInputText(input);
  }

  // Empty leaf → fall back to the schema's scalar type hint.
  if (schemaHint?.scalarType) {
    return coerceByScalarType(schemaHint.scalarType, input);
  }
  return coerceCellInputText(input);
}

function coerceByScalarType(scalarType: CellScalarType, input: string): unknown {
  switch (scalarType) {
    case 'string':
      return input;
    case 'number':
    case 'integer': {
      const parsed = tryParseJson(input);
      return parsed.ok && typeof parsed.value === 'number' ? parsed.value : input;
    }
    case 'boolean': {
      const parsed = tryParseJson(input);
      return parsed.ok && typeof parsed.value === 'boolean' ? parsed.value : input;
    }
  }
}

function tryParseJson(input: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(input.trim()) };
  } catch {
    return { ok: false };
  }
}

/**
 * Resolves the scalar-type + nullability hint for the leaf at `fieldPath` from
 * the folder JSON schema. Returns `null` when the schema is missing or the path
 * can't be resolved to a scalar/nullable leaf — callers then rely on the
 * existing value / JSON-parse fallback. Used only as a hint for empty leaves and
 * for clear semantics; never to reshape what's written.
 */
export function resolveSchemaLeafHint(folderSchema: JsonSchemaRecord | null, fieldPath: string): SchemaLeafHint | null {
  const fieldSchema = resolveFieldSchema(folderSchema, fieldPath);
  if (!fieldSchema) {
    return null;
  }
  const { scalarType, nullable } = collectScalarTypeAndNullability(fieldSchema);
  if (!scalarType && !nullable) {
    return null;
  }
  return { scalarType, nullable };
}

function resolveFieldSchema(folderSchema: JsonSchemaRecord | null, fieldPath: string): JsonSchemaRecord | null {
  const parts = fieldPath.split('.');
  let current: JsonSchemaRecord | null = unwrapFolderSchema(folderSchema);

  for (const part of parts) {
    const objectSchema = pickObjectSchema(current);
    if (!objectSchema) {
      return null;
    }
    const properties = objectSchema.properties;
    if (!isRecord(properties)) {
      return null;
    }
    const next = properties[part];
    if (!isRecord(next)) {
      return null;
    }
    current = next;
  }

  return current;
}

function unwrapFolderSchema(folderSchema: JsonSchemaRecord | null): JsonSchemaRecord | null {
  if (!isRecord(folderSchema)) {
    return null;
  }
  const nested = folderSchema.schema;
  if (isRecord(nested)) {
    return nested;
  }
  return folderSchema;
}

function pickObjectSchema(schema: JsonSchemaRecord | null): JsonSchemaRecord | null {
  if (!isRecord(schema)) {
    return null;
  }
  if (
    schema.type === 'object' ||
    (Array.isArray(schema.type) && schema.type.includes('object')) ||
    isRecord(schema.properties)
  ) {
    return schema;
  }
  for (const unionKey of ['anyOf', 'oneOf', 'allOf'] as const) {
    const variants = schema[unionKey];
    if (!Array.isArray(variants)) {
      continue;
    }
    for (const variant of variants) {
      const objectVariant = pickObjectSchema(isRecord(variant) ? variant : null);
      if (objectVariant) {
        return objectVariant;
      }
    }
  }
  return null;
}

function collectScalarTypeAndNullability(schema: JsonSchemaRecord): {
  scalarType: CellScalarType | null;
  nullable: boolean;
} {
  const typeNames = new Set<string>();
  collectSchemaTypeNames(schema, typeNames);
  // Prefer 'string' so an ambiguous string|number leaf keeps text verbatim.
  const scalarPriority: CellScalarType[] = ['string', 'number', 'integer', 'boolean'];
  const scalarType = scalarPriority.find((candidate) => typeNames.has(candidate)) ?? null;
  return { scalarType, nullable: typeNames.has('null') };
}

function collectSchemaTypeNames(schema: JsonSchemaRecord | null, out: Set<string>): void {
  if (!isRecord(schema)) {
    return;
  }
  const schemaType = schema.type;
  if (typeof schemaType === 'string') {
    out.add(schemaType);
  } else if (Array.isArray(schemaType)) {
    for (const typeValue of schemaType) {
      if (typeof typeValue === 'string') {
        out.add(typeValue);
      }
    }
  }
  if ('const' in schema) {
    out.add(runtimeTypeName(schema.const));
  }
  if (isRecord(schema.properties)) {
    out.add('object');
  }
  if ('items' in schema) {
    out.add('array');
  }
  for (const unionKey of ['anyOf', 'oneOf', 'allOf'] as const) {
    const variants = schema[unionKey];
    if (!Array.isArray(variants)) {
      continue;
    }
    for (const variant of variants) {
      if (isRecord(variant)) {
        collectSchemaTypeNames(variant, out);
      }
    }
  }
}

function runtimeTypeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isRecord(value: unknown): value is JsonSchemaRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
