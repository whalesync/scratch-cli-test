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
