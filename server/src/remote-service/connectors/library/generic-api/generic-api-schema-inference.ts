/**
 * Schema inference for GENERIC_API endpoints.
 *
 * Generic APIs don't expose schema endpoints; the only way to learn record
 * shape is to look at records. The probe walks every record returned across
 * page 1 + page 2 verification (capped at 500 records / 2 pages — bounded
 * cost on large endpoints) and unions the value types observed per JSON path.
 *
 * Output is a **plain JSON Schema object**, NOT a TypeBox `TSchema` instance.
 * TypeBox attaches symbol-keyed runtime metadata (`Symbol(TypeBox.Kind)` etc.)
 * that doesn't round-trip through a Prisma `Json` column. The connector
 * reconstructs a `TSchema` from this plain shape at read time inside
 * `fetchJsonTableSpec`.
 *
 * Eng review note: this is the v1 schema story. There is NO user-facing UI
 * to override the inferred schema in v1 — if inference is wrong (e.g. a
 * sometimes-null field gets typed as `string` instead of `string | null`),
 * the data is still on disk in the raw record file; the failure mode is
 * "filter/sort behaves weirdly", not data loss. Staff can patch via the
 * diagnostic endpoint until the v2 schema editor ships.
 */

/** Max records the probe walks to build the schema. */
export const SCHEMA_INFERENCE_RECORD_CAP = 500;

/**
 * A plain JSON Schema object (Draft 7-ish — what TypeBox would emit via
 * `Type.Strict()`, minus the brand symbols). Object-typed so the connector
 * can hand it straight to a Prisma `Json` column without conversion.
 */
export type InferredJsonSchema = {
  type: 'object';
  properties: Record<string, InferredFieldSchema>;
  required?: string[];
  additionalProperties?: boolean;
};

/** One property's inferred schema. Union types use `anyOf`. */
export type InferredFieldSchema =
  | { type: 'string' }
  | { type: 'string'; format?: 'date-time' | 'email' | 'uri' }
  | { type: 'number' }
  | { type: 'integer' }
  | { type: 'boolean' }
  | { type: 'null' }
  | { type: 'array'; items?: InferredFieldSchema }
  | { type: 'object'; properties?: Record<string, InferredFieldSchema>; additionalProperties?: boolean }
  | { anyOf: InferredFieldSchema[] };

/**
 * Walk the given records and infer a JSON Schema describing them. Returns a
 * plain object suitable for storage in `DataFolder.options`.
 *
 * Behavior:
 *   - Only the first `SCHEMA_INFERENCE_RECORD_CAP` records are walked. Caller
 *     is expected to cap upstream (probe is page 1 + page 2 = ~200 records
 *     typically), but the guard is here as a safety belt for unbounded inputs.
 *   - For each JSON path, the inferred type is the union of all value types
 *     observed. A field seen as `string` + `null` becomes
 *     `{ anyOf: [{ type: 'string' }, { type: 'null' }] }`.
 *   - Fields seen on some records but not others are still included in the
 *     properties map (`required` excludes them).
 *   - Records that aren't plain objects are skipped (the caller should have
 *     already extracted records via `apiget`'s `extractData`).
 */
export function inferJsonSchema(records: unknown[]): InferredJsonSchema {
  const walked = records.slice(0, SCHEMA_INFERENCE_RECORD_CAP);

  // Per-field accumulator: set of distinct JSON Schema fragments observed for
  // that field, plus a count of records that included the field (used to
  // compute `required`).
  const acc = new Map<string, { variants: InferredFieldSchema[]; seenCount: number }>();
  let totalRecords = 0;

  for (const record of walked) {
    if (!isPlainObject(record)) continue;
    totalRecords++;
    for (const [key, value] of Object.entries(record)) {
      const variant = inferValue(value);
      const entry = acc.get(key);
      if (entry) {
        if (!includesVariant(entry.variants, variant)) entry.variants.push(variant);
        entry.seenCount++;
      } else {
        acc.set(key, { variants: [variant], seenCount: 1 });
      }
    }
  }

  const properties: Record<string, InferredFieldSchema> = {};
  const required: string[] = [];
  for (const [key, entry] of acc.entries()) {
    properties[key] = entry.variants.length === 1 ? entry.variants[0] : { anyOf: entry.variants };
    if (entry.seenCount === totalRecords) required.push(key);
  }

  const result: InferredJsonSchema = {
    type: 'object',
    properties,
    additionalProperties: true,
  };
  if (required.length > 0) result.required = required.sort();
  return result;
}

/** Infer a schema fragment for one value. Recurses into objects and arrays. */
function inferValue(value: unknown): InferredFieldSchema {
  if (value === null) return { type: 'null' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { type: 'integer' } : { type: 'number' };
  }
  if (typeof value === 'string') {
    // Light format detection — date-time, email, uri. Optional and
    // best-effort; the user can correct later via the diagnostic endpoint.
    const format = detectStringFormat(value);
    return format ? { type: 'string', format } : { type: 'string' };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return { type: 'array' };
    // Union the item types
    const itemVariants: InferredFieldSchema[] = [];
    for (const item of value.slice(0, 25)) {
      // Cap items per array — large arrays don't need full inspection
      const itemSchema = inferValue(item);
      if (!includesVariant(itemVariants, itemSchema)) itemVariants.push(itemSchema);
    }
    const items = itemVariants.length === 1 ? itemVariants[0] : { anyOf: itemVariants };
    return { type: 'array', items };
  }
  if (isPlainObject(value)) {
    const properties: Record<string, InferredFieldSchema> = {};
    for (const [k, v] of Object.entries(value)) {
      properties[k] = inferValue(v);
    }
    return { type: 'object', properties, additionalProperties: true };
  }
  // Fallback (function, undefined, symbol — none should appear in JSON data)
  return { type: 'string' };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Light string-format detection. Conservative — we'd rather under-detect than
 * mislabel. Format hints help downstream consumers (views, default sort)
 * pick reasonable defaults; they're not load-bearing.
 */
function detectStringFormat(value: string): 'date-time' | 'email' | 'uri' | undefined {
  if (value.length > 200) return undefined; // long strings unlikely to be any of these
  if (ISO_DATETIME_RE.test(value)) return 'date-time';
  if (EMAIL_RE.test(value)) return 'email';
  if (URI_RE.test(value)) return 'uri';
  return undefined;
}

// Pragmatic ISO 8601 / RFC 3339 — covers what most APIs return.
// 2026-05-18T12:34:56Z, 2026-05-18T12:34:56.789+02:00, etc.
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
// Looser-than-RFC-5322 — matches what APIs actually return without false-positives on URLs.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// http:// or https:// prefix; we don't validate full RFC 3986.
const URI_RE = /^https?:\/\/[^\s]+$/;

/**
 * Structural equality check on InferredFieldSchema variants so we don't
 * accumulate duplicate `{ type: 'string' }` entries. JSON.stringify is fine
 * here because variants are plain JSON-Schema objects with no symbols and
 * no functions, and order matters for our equality semantics.
 */
function includesVariant(variants: InferredFieldSchema[], candidate: InferredFieldSchema): boolean {
  const candidateJson = JSON.stringify(candidate);
  return variants.some((v) => JSON.stringify(v) === candidateJson);
}
