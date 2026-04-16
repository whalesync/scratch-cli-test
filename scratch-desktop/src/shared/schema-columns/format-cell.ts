function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

/**
 * Renders a raw record value as a single-line display string for the data grid.
 *
 * Rules:
 *   - `null` / `undefined` → ''
 *   - booleans → 'true' | 'false'
 *   - strings → the string verbatim
 *   - numbers / bigints → decimal representation
 *   - everything else (objects, arrays, symbols) → compact `JSON.stringify`, or
 *     '[unserializable]' if stringify throws (e.g. circular references)
 */
export function formatCellForGrid(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return safeStringify(value);
}
