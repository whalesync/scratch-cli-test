function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Walks a dot-separated column id against a record JSON, returning the raw value or `undefined`
 * when any segment is missing or non-object. Arrays are leaves; we never index into them.
 */
export function getByPath(source: Record<string, unknown>, id: string): unknown {
  const segments = id.split('.');
  let current: unknown = source;
  for (const segment of segments) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}
