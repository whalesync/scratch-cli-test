import { diffWords } from 'diff';

export type WordDiffSegmentKind = 'unchanged' | 'added' | 'removed';

export interface WordDiffSegment {
  text: string;
  kind: WordDiffSegmentKind;
}

/**
 * Compute a word-level diff between two text values and return segments tagged as
 * `removed` (present only in the old text), `added` (present only in the new text),
 * or `unchanged`. For a substitution, `diffWords` emits the removed piece *before*
 * the added piece, so an inline renderer naturally paints "del old" before "ins new".
 *
 * Concatenating the `unchanged` + `added` segments reproduces the new text;
 * concatenating the `unchanged` + `removed` segments reproduces the old text (modulo
 * whitespace normalization performed by the diff algorithm — see `diff.diffWords`).
 *
 * Whitespace runs are folded into the surrounding segments so that a single
 * substituted word renders as one `removed` + one `added` segment, not several.
 */
export function getWordDiffSegments(fromText: string, toText: string): WordDiffSegment[] {
  const changes = diffWords(fromText, toText);
  const segments: WordDiffSegment[] = [];
  for (const change of changes) {
    const kind: WordDiffSegmentKind = change.added ? 'added' : change.removed ? 'removed' : 'unchanged';
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) {
      last.text += change.value;
    } else {
      segments.push({ text: change.value, kind });
    }
  }
  return segments;
}

/** The single-character ellipsis folded into a trimmed context segment to mark dropped text. */
export const DIFF_ELLIPSIS = '…';

/** Default unchanged-context budget (chars) kept on each side of the windowed change. */
export const DEFAULT_WINDOW_CONTEXT_CHARS = 24;

export interface WindowWordDiffOptions {
  /** Approximate unchanged chars to keep on each side of the changed run(s). Default {@link DEFAULT_WINDOW_CONTEXT_CHARS}. */
  contextChars?: number;
  /**
   * Merge changed runs whose intervening unchanged gap is ≤ this many chars into a single window
   * (so a cluster of nearby edits shows together), instead of windowing only the first change.
   * Default 16.
   */
  mergeGapChars?: number;
}

/** Index of the last whitespace char in `text`, or -1 when there is none. */
function lastWhitespaceIndex(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    if (/\s/.test(text[i])) return i;
  }
  return -1;
}

/** Keep the trailing `maxChars` of leading context, snapped forward to a whole-word boundary. */
function trimContextEnd(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const tail = text.slice(text.length - maxChars);
  // Drop the (probably partial) first word plus its trailing space so the kept slice starts at a
  // whole word — the ellipsis then attaches directly, e.g. `…fabric made from `.
  const firstWs = tail.search(/\s/);
  const snapped = firstWs >= 0 ? tail.slice(firstWs + 1) : tail;
  return { text: snapped, truncated: true };
}

/** Keep the leading `maxChars` of trailing context, snapped back to a whole-word boundary. */
function trimContextStart(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const head = text.slice(0, maxChars);
  // Drop the trailing (probably partial) word so the kept slice ends at a whole word; the ellipsis
  // then attaches directly, e.g. ` organic cotton with reinforced…`. The leading space (the natural
  // gap after the inserted value) is preserved.
  const lastWs = lastWhitespaceIndex(head);
  const snapped = lastWs > 0 ? head.slice(0, lastWs) : head;
  return { text: snapped, truncated: true };
}

/**
 * Transform a full word-diff segment list into a one-line window centred on the first change
 * (optionally merging nearby changes), trimming the leading/trailing unchanged context to
 * `contextChars` and folding an ellipsis into the trimmed context where text was dropped.
 *
 * Pure. Retains both `removed` and `added` segments and their original order (removed before
 * added for a substitution), so a canvas or React renderer can draw `…del ins…` without any
 * special-casing — the ellipsis is just an `unchanged` segment. Returns the input unchanged when
 * there is no real change, or nothing to trim.
 */
export function windowWordDiffSegments(
  segments: WordDiffSegment[],
  options: WindowWordDiffOptions = {},
): WordDiffSegment[] {
  const contextChars = options.contextChars ?? DEFAULT_WINDOW_CONTEXT_CHARS;
  const mergeGapChars = options.mergeGapChars ?? 16;
  if (segments.length === 0) return segments;

  const changeStart = segments.findIndex((segment) => segment.kind !== 'unchanged');
  if (changeStart === -1) return segments; // no change → nothing to window

  // Extend the covered span across changes separated only by a small unchanged gap. After
  // coalescing, an unchanged segment is never adjacent to another, so a gap with a following
  // segment (i + 1 < length) is always followed by a change — merge across it.
  let changeEnd = changeStart;
  for (let i = changeStart + 1; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.kind !== 'unchanged') {
      changeEnd = i;
    } else if (segment.text.length <= mergeGapChars && i + 1 < segments.length) {
      continue; // small gap between two changes → keep it inside the window
    } else {
      break; // wide gap or trailing context → window ends here
    }
  }

  const windowed: WordDiffSegment[] = [];

  // Leading context: the single unchanged segment immediately before the first change (index 0).
  if (changeStart > 0) {
    const lead = trimContextEnd(segments[changeStart - 1].text, contextChars);
    windowed.push({ text: lead.truncated ? DIFF_ELLIPSIS + lead.text : lead.text, kind: 'unchanged' });
  }
  // The changed span, verbatim (including any small merged unchanged gaps).
  for (let i = changeStart; i <= changeEnd; i++) {
    windowed.push(segments[i]);
  }
  // Trailing context: the unchanged segment immediately after the last covered change.
  if (changeEnd < segments.length - 1) {
    const trail = trimContextStart(segments[changeEnd + 1].text, contextChars);
    windowed.push({ text: trail.truncated ? trail.text + DIFF_ELLIPSIS : trail.text, kind: 'unchanged' });
  }
  return windowed;
}

/**
 * Convenience wrapper: compute a word diff from raw text and window it around the first change.
 * Used where no memoized segments exist (e.g. the React By-Field preview and unit tests).
 */
export function getWindowedWordDiffSegments(
  fromText: string,
  toText: string,
  options?: WindowWordDiffOptions,
): WordDiffSegment[] {
  return windowWordDiffSegments(getWordDiffSegments(fromText, toText), options);
}
