import { diffWords } from 'diff';

export interface WordDiffSegment {
  text: string;
  changed: boolean;
}

/**
 * Compute a word-level diff between two text values and return the segments of the
 * *new* text labelled as `changed` (added since the old text) or unchanged.
 *
 * Concatenating `segments[].text` reproduces the new text (modulo whitespace
 * normalization performed by the diff algorithm — see `diff.diffWords` docs).
 *
 * Whitespace runs are folded into the surrounding segments so that a single
 * substituted word renders as one `changed` segment, not three.
 */
export function getWordDiffSegments(fromText: string, toText: string): WordDiffSegment[] {
  const changes = diffWords(fromText, toText);
  const segments: WordDiffSegment[] = [];
  for (const change of changes) {
    if (change.removed) continue; // Removed pieces aren't in the rendered new value.
    const changed = change.added === true;
    const last = segments[segments.length - 1];
    if (last && last.changed === changed) {
      last.text += change.value;
    } else {
      segments.push({ text: change.value, changed });
    }
  }
  return segments;
}
