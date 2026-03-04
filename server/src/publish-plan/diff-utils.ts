/**
 * Deep-diffs two JSON objects and returns a sparse object containing only changed paths.
 *
 * Behavior:
 * - Iterates over keys of `dirtyContent` only
 * - For nested plain objects, recurses and only includes changed sub-paths
 * - Arrays are compared atomically via JSON.stringify (not element-wise)
 * - Removed keys (present in main but absent in dirty) are NOT tracked — this is intentional.
 *   Users should set fields to `null` or `""` to clear them, not delete JSON keys.
 *   Key removal typically indicates schema changes or reference cleaning, not user intent.
 * - Returns `{}` if nothing changed
 */
export function computeChangedFields(
  mainContent: Record<string, unknown>,
  dirtyContent: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(dirtyContent)) {
    const dirtyVal = dirtyContent[key];
    const mainVal = mainContent[key];

    // Both are plain objects — recurse
    if (isPlainObject(dirtyVal) && isPlainObject(mainVal)) {
      const nested = computeChangedFields(mainVal, dirtyVal);
      if (Object.keys(nested).length > 0) {
        result[key] = nested;
      }
      continue;
    }

    // Compare via JSON.stringify for deep equality (handles arrays, primitives, null)
    if (JSON.stringify(dirtyVal) !== JSON.stringify(mainVal)) {
      result[key] = dirtyVal;
    }
  }

  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
