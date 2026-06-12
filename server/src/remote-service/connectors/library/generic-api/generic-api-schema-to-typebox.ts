/**
 * Convert the plain inferred JSON Schema (from `generic-api-schema-inference.ts`)
 * into a TypeBox `TSchema` whose `properties` are populated, so the web/desktop/
 * CLI frontends render real columns for a generic-connector table.
 *
 * This is the inverse-ish of inference and lives in its own module on purpose:
 * `generic-api-schema-inference.ts` is deliberately TypeBox-free (its output
 * round-trips through a Prisma `Json` column), and this is the read-time bridge
 * that re-hydrates that plain shape into TypeBox. Kept separate so the mapping
 * for every JSON value kind can be unit-tested in isolation.
 */
import { Type, type TSchema } from '@sinclair/typebox';
import { assertUnreachable } from 'src/utils/asserts';
import type { InferredFieldSchema, InferredJsonSchema } from './generic-api-schema-inference';

/**
 * Convert one inferred field schema into a TypeBox `TSchema`. Recurses into
 * objects/arrays; maps a multi-type field (`anyOf`) to `Type.Union`.
 */
export function inferredFieldToTypeBox(field: InferredFieldSchema): TSchema {
  if ('anyOf' in field) {
    const variants = field.anyOf.map(inferredFieldToTypeBox);
    return variants.length > 0 ? Type.Union(variants) : Type.Unknown();
  }
  switch (field.type) {
    case 'string':
      // Intentionally drop the inferred `format` hint. Inference is best-effort
      // from samples, and `Value.Check` ENFORCES a `format` keyword — so a
      // mis-/over-detected format (or a stricter format validator registered
      // elsewhere) would silently reject otherwise-valid records. A generic
      // connector must never drop valid data over a guessed format; the format
      // stays in the persisted inferred schema for diagnostics, just not here.
      return Type.String();
    case 'number':
      return Type.Number();
    case 'integer':
      return Type.Integer();
    case 'boolean':
      return Type.Boolean();
    case 'null':
      return Type.Null();
    case 'array':
      return Type.Array(field.items ? inferredFieldToTypeBox(field.items) : Type.Unknown());
    case 'object': {
      const nestedProperties: Record<string, TSchema> = {};
      for (const [nestedFieldName, nestedFieldSchema] of Object.entries(field.properties ?? {})) {
        nestedProperties[nestedFieldName] = inferredFieldToTypeBox(nestedFieldSchema);
      }
      return Type.Object(nestedProperties, { additionalProperties: field.additionalProperties ?? true });
    }
    default:
      return assertUnreachable(field);
  }
}

/** True when the persisted blob is the inferred-object-schema shape we expect. */
export function isInferredObjectSchema(value: object): value is InferredJsonSchema {
  const candidate = value as Partial<InferredJsonSchema>;
  return candidate.type === 'object' && typeof candidate.properties === 'object' && candidate.properties !== null;
}

/**
 * Build the table-view `TSchema` from the persisted inferred schema, with its
 * `properties` populated so the frontends render real columns. Fields not seen
 * on every probed record are marked optional. Defensive: an unexpected persisted
 * shape (or an empty schema from a table probed while empty) falls back to an
 * empty object rather than throwing at read time.
 */
export function inferredSchemaToTableSchema(rawInferredSchema: object, description: string): TSchema {
  if (!isInferredObjectSchema(rawInferredSchema)) {
    return Type.Object({}, { description });
  }
  const requiredFieldNames = new Set(rawInferredSchema.required ?? []);
  const properties: Record<string, TSchema> = {};
  for (const [fieldName, fieldSchema] of Object.entries(rawInferredSchema.properties)) {
    const convertedField = inferredFieldToTypeBox(fieldSchema);
    properties[fieldName] = requiredFieldNames.has(fieldName) ? convertedField : Type.Optional(convertedField);
  }
  return Type.Object(properties, { description, additionalProperties: rawInferredSchema.additionalProperties ?? true });
}
