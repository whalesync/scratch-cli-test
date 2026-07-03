import { describe, expect, it } from 'vitest';
import { getWordDiffSegments, type WordDiffSegment } from './word-diff';

/** Reconstruct the new text: unchanged + added segments, in order. */
function joinedNew(segments: WordDiffSegment[]): string {
  return segments
    .filter((s) => s.kind !== 'removed')
    .map((s) => s.text)
    .join('');
}

/** Reconstruct the old text: unchanged + removed segments, in order. */
function joinedOld(segments: WordDiffSegment[]): string {
  return segments
    .filter((s) => s.kind !== 'added')
    .map((s) => s.text)
    .join('');
}

describe('getWordDiffSegments', () => {
  it('returns a single unchanged segment when both values match', () => {
    const segs = getWordDiffSegments('hello world', 'hello world');
    expect(segs).toEqual([{ text: 'hello world', kind: 'unchanged' }]);
  });

  it('emits the removed piece before the added piece for a substitution', () => {
    const segs = getWordDiffSegments(
      'TypeScript, class systems, language design',
      'TypeScript, data systems, language design',
    );
    // Reconstructs both sides in order.
    expect(joinedOld(segs)).toBe('TypeScript, class systems, language design');
    expect(joinedNew(segs)).toBe('TypeScript, data systems, language design');
    // Exactly one removed ("class") and one added ("data"), removed before added.
    const removed = segs.filter((s) => s.kind === 'removed');
    const added = segs.filter((s) => s.kind === 'added');
    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect(removed[0].text.trim()).toBe('class');
    expect(added[0].text.trim()).toBe('data');
    expect(segs.indexOf(removed[0])).toBeLessThan(segs.indexOf(added[0]));
  });

  it('marks a populate (empty -> text) entirely as added', () => {
    const segs = getWordDiffSegments('', 'hello world');
    expect(segs.every((s) => s.kind === 'added')).toBe(true);
    expect(joinedNew(segs)).toBe('hello world');
  });

  it('marks a delete (text -> empty) entirely as removed', () => {
    const segs = getWordDiffSegments('hello world', '');
    expect(segs.every((s) => s.kind === 'removed')).toBe(true);
    expect(joinedOld(segs)).toBe('hello world');
  });

  it('coalesces consecutive segments with the same kind', () => {
    // Two adjacent substituted words should become one added (and one removed) segment.
    const segs = getWordDiffSegments('alpha beta gamma', 'alpha XX YY gamma');
    const added = segs.filter((s) => s.kind === 'added');
    const removed = segs.filter((s) => s.kind === 'removed');
    expect(added).toHaveLength(1);
    expect(added[0].text.trim()).toBe('XX YY');
    expect(removed).toHaveLength(1);
    expect(removed[0].text.trim()).toBe('beta');
  });

  it('handles a fully-rewritten value as one removed + one added segment', () => {
    const segs = getWordDiffSegments('foo bar', 'baz qux');
    expect(segs.filter((s) => s.kind === 'removed')).toHaveLength(1);
    expect(segs.filter((s) => s.kind === 'added')).toHaveLength(1);
    expect(joinedOld(segs)).toBe('foo bar');
    expect(joinedNew(segs)).toBe('baz qux');
  });
});
