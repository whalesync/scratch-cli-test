import { describe, expect, it } from 'vitest';
import { getWordDiffSegments } from './word-diff';

function joined(segments: { text: string }[]): string {
  return segments.map((s) => s.text).join('');
}

describe('getWordDiffSegments', () => {
  it('returns a single unchanged segment when both values match', () => {
    const segs = getWordDiffSegments('hello world', 'hello world');
    expect(segs).toEqual([{ text: 'hello world', changed: false }]);
  });

  it('marks an added word in the middle as the only changed segment', () => {
    const segs = getWordDiffSegments(
      'TypeScript, class systems, language design',
      'TypeScript, data systems, language design',
    );
    // Reproduces the new text in order.
    expect(joined(segs)).toBe('TypeScript, data systems, language design');
    // Exactly one changed segment, and its trimmed content is "data".
    const changed = segs.filter((s) => s.changed);
    expect(changed).toHaveLength(1);
    expect(changed[0].text.trim()).toBe('data');
  });

  it('marks a populate (empty -> text) entirely as changed', () => {
    const segs = getWordDiffSegments('', 'hello world');
    expect(segs.every((s) => s.changed)).toBe(true);
    expect(joined(segs)).toBe('hello world');
  });

  it('returns no segments for a delete (text -> empty), since nothing is rendered', () => {
    const segs = getWordDiffSegments('hello world', '');
    expect(segs).toEqual([]);
  });

  it('coalesces consecutive segments with the same flag', () => {
    // Two adjacent changed words should become one segment, not two.
    const segs = getWordDiffSegments('alpha beta gamma', 'alpha XX YY gamma');
    const changed = segs.filter((s) => s.changed);
    expect(changed).toHaveLength(1);
    expect(changed[0].text.trim()).toBe('XX YY');
  });

  it('handles a fully-rewritten value as one changed segment', () => {
    const segs = getWordDiffSegments('foo bar', 'baz qux');
    expect(segs.every((s) => s.changed)).toBe(true);
    expect(joined(segs)).toBe('baz qux');
  });
});
