import { diffLines } from 'diff';

/**
 * Shared, connector-agnostic helpers for rendering a JSON object/array field's
 * before/after as a unified line diff.
 *
 * A record's object-valued fields (e.g. a Webflow image element) are stored and
 * compared whole, so editing a single sub-value would otherwise render the entire
 * object as one changed blob — a compact `JSON.stringify` word-diffed against
 * another, which paints the whole value as removed + added (DEV-10890). These
 * helpers pretty-print each side and diff it line-by-line so only the edited
 * line(s) are highlighted, with the rest of the object shown as context.
 *
 * Lives in a plain `.ts` module (no components) so `diff-renderers.tsx` can import
 * `computeJsonObjectLineDiff` without tripping `react-refresh/only-export-components`.
 */

export type JsonDiffLineKind = 'unchanged' | 'added' | 'removed';

export interface JsonDiffLine {
  text: string;
  kind: JsonDiffLineKind;
}

/**
 * Normalize a field value to the object/array it represents, or `null` when it is
 * not a JSON object/array. Accepts either an already-parsed value (as held by the
 * review drawer's `__fromFields` / `displayData`) or its display string (as held
 * by the detail-view grid's row values), so one predicate serves both surfaces.
 *
 * Scalar strings like `"42"` / `"true"` are intentionally NOT treated as JSON, so
 * plain text/number/boolean fields keep their existing word-diff rendering.
 */
function normalizeToJsonObjectOrArray(value: unknown): object | null {
  if (value == null) return null;
  if (typeof value === 'object') return value; // plain object or array (both `typeof === 'object'`)
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // Only object/array literals qualify; this rules out scalar strings such as
    // "42" or "true" that JSON.parse would otherwise accept as non-object JSON.
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return parsed != null && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * True when a field's before/after should render as a structural JSON diff — i.e.
 * at least one side is a non-null object or array. Used by both the review drawer
 * and the detail-view grid to route object-valued fields to `InlineJsonDiff`
 * instead of the whole-blob / word-diff renderers.
 */
export function shouldRenderValuesAsJsonObjectDiff(fromValue: unknown, toValue: unknown): boolean {
  return normalizeToJsonObjectOrArray(fromValue) !== null || normalizeToJsonObjectOrArray(toValue) !== null;
}

/**
 * Pretty-print both sides (2-space indent, preserving each object's on-disk key
 * order — unlike jsdiff's `diffJson`, which sorts keys) and diff them line-by-line.
 * A side that is not an object/array (e.g. the empty "before" of a newly created
 * record) pretty-prints to an empty string, so a create shows every line as
 * `added`. Splits each multi-line change back into individual lines, mirroring
 * `getWordDiffSegments` in `src/shared/word-diff.ts`.
 */
export function computeJsonObjectLineDiff(fromValue: unknown, toValue: unknown): JsonDiffLine[] {
  const fromObject = normalizeToJsonObjectOrArray(fromValue);
  const toObject = normalizeToJsonObjectOrArray(toValue);
  const fromPrettyPrinted = fromObject == null ? '' : JSON.stringify(fromObject, null, 2);
  const toPrettyPrinted = toObject == null ? '' : JSON.stringify(toObject, null, 2);

  const changes = diffLines(fromPrettyPrinted, toPrettyPrinted);
  const lines: JsonDiffLine[] = [];
  for (const change of changes) {
    const kind: JsonDiffLineKind = change.added ? 'added' : change.removed ? 'removed' : 'unchanged';
    // `diffLines` emits one change per run of lines, each ending in a newline; drop
    // that trailing newline before splitting so we don't push a spurious empty line.
    const text = change.value.endsWith('\n') ? change.value.slice(0, -1) : change.value;
    for (const line of text.split('\n')) {
      lines.push({ text: line, kind });
    }
  }
  return lines;
}
