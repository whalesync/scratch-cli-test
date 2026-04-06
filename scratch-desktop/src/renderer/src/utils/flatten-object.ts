/**
 * Flattens a nested object into dot-separated keys.
 * `{ id: "a", fields: { field1: "b" } }` → `{ id: "a", "fields.field1": "b" }`
 * Arrays and non-plain-object values are kept as leaf values (not recursed into).
 */
export function flattenObject(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const flatKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value as Record<string, unknown>, flatKey));
    } else {
      result[flatKey] = value;
    }
  }
  return result;
}
