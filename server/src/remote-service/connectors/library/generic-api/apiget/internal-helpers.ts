/**
 * Tiny helpers shared across apiget modules. Internal — not part of the
 * public API surface.
 */

/** Type guard for "this is a plain object I can index into". */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Type guard for "this is an array of unknowns". */
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Try to coerce an unknown to an integer. Matches Go apiget's `extractIntValue`
 * which accepts int / float64 / int64. In JS: number (whole or fractional —
 * we floor fractions, matching `int(v)` in Go) or numeric strings.
 *
 * Returns 0 if the value isn't coercible — matches Go's "return 0 if missing".
 */
export function toInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.floor(n) : 0;
  }
  return 0;
}

/** Extract the first matching key's value as an int (uses `toInt`). */
export function extractIntValue(obj: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    if (key in obj) {
      const v = toInt(obj[key]);
      if (v !== 0) return v;
    }
  }
  return 0;
}

/** Mirrors Go's `hasAnyKey`: true iff at least one key is present in `obj`. */
export function hasAnyKey(obj: Record<string, unknown>, ...keys: string[]): boolean {
  for (const key of keys) {
    if (key in obj) return true;
  }
  return false;
}
