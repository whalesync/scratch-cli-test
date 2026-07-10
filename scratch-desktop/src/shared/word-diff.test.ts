import { describe, expect, it } from 'vitest';
import {
  DIFF_ELLIPSIS,
  getWindowedWordDiffSegments,
  getWordDiffSegments,
  windowWordDiffSegments,
  type WordDiffSegment,
} from './word-diff';

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

/** The first `unchanged` segment carries a leading ellipsis when leading context was trimmed. */
function hasLeadingEllipsis(segments: WordDiffSegment[]): boolean {
  return segments.length > 0 && segments[0].kind === 'unchanged' && segments[0].text.startsWith(DIFF_ELLIPSIS);
}

/** The last `unchanged` segment carries a trailing ellipsis when trailing context was trimmed. */
function hasTrailingEllipsis(segments: WordDiffSegment[]): boolean {
  const last = segments[segments.length - 1];
  return !!last && last.kind === 'unchanged' && last.text.endsWith(DIFF_ELLIPSIS);
}

describe('windowWordDiffSegments / getWindowedWordDiffSegments', () => {
  const from = 'Our flagship tote is made from 12oz organic cotton with reinforced stitching and a lifetime guarantee.';
  const to = 'Our flagship tote is made from 16oz organic cotton with reinforced stitching and a lifetime guarantee.';

  it('windows a deep change with ellipsis on both sides and keeps del before ins', () => {
    const segs = getWindowedWordDiffSegments(from, to);
    expect(hasLeadingEllipsis(segs)).toBe(true);
    expect(hasTrailingEllipsis(segs)).toBe(true);
    const removed = segs.filter((s) => s.kind === 'removed');
    const added = segs.filter((s) => s.kind === 'added');
    expect(removed.map((s) => s.text.trim())).toEqual(['12oz']);
    expect(added.map((s) => s.text.trim())).toEqual(['16oz']);
    expect(segs.indexOf(removed[0])).toBeLessThan(segs.indexOf(added[0]));
    // The full original prefix/suffix are dropped — the window is far shorter than the value.
    expect(segs.map((s) => s.text).join('').length).toBeLessThan(from.length);
  });

  it('trims context to roughly the budget, snapped to word boundaries (no bisected words)', () => {
    const segs = getWindowedWordDiffSegments(from, to, { contextChars: 24 });
    const lead = segs[0];
    const trail = segs[segs.length - 1];
    // Leading context (minus the ellipsis) starts at a whole word; trailing ends at a whole word.
    const leadBody = lead.text.slice(DIFF_ELLIPSIS.length);
    expect(from.includes(leadBody)).toBe(true);
    const trailBody = trail.text.slice(0, -DIFF_ELLIPSIS.length);
    expect(to.includes(trailBody)).toBe(true);
  });

  it('omits the leading ellipsis when the change is at the very start', () => {
    const segs = getWindowedWordDiffSegments(
      '12oz organic cotton with reinforced stitching',
      '16oz organic cotton with reinforced stitching',
    );
    expect(hasLeadingEllipsis(segs)).toBe(false);
    expect(hasTrailingEllipsis(segs)).toBe(true);
  });

  it('omits the trailing ellipsis when the change is at the very end', () => {
    const segs = getWindowedWordDiffSegments(
      'organic cotton with reinforced 12oz',
      'organic cotton with reinforced 16oz',
    );
    expect(hasLeadingEllipsis(segs)).toBe(true);
    expect(hasTrailingEllipsis(segs)).toBe(false);
  });

  it('returns a full rewrite (no unchanged context) with no ellipsis', () => {
    const segs = getWindowedWordDiffSegments('foo bar', 'baz qux');
    expect(hasLeadingEllipsis(segs)).toBe(false);
    expect(hasTrailingEllipsis(segs)).toBe(false);
    expect(segs.filter((s) => s.kind === 'removed')).toHaveLength(1);
    expect(segs.filter((s) => s.kind === 'added')).toHaveLength(1);
  });

  it('merges two nearby changes into one window', () => {
    // "12oz"→"16oz" and "cotton"→"linen" are separated by a short unchanged gap ("organic").
    const segs = getWindowedWordDiffSegments(
      'made from 12oz organic cotton with reinforced stitching everywhere',
      'made from 16oz organic linen with reinforced stitching everywhere',
    );
    expect(segs.filter((s) => s.kind === 'removed').map((s) => s.text.trim())).toEqual(['12oz', 'cotton']);
    expect(segs.filter((s) => s.kind === 'added').map((s) => s.text.trim())).toEqual(['16oz', 'linen']);
  });

  it('windows only the first cluster when changes are far apart (trailing ellipsis signals more)', () => {
    const longFrom = `alpha 12oz ${'filler word '.repeat(8)}bravo cotton charlie`;
    const longTo = `alpha 16oz ${'filler word '.repeat(8)}bravo linen charlie`;
    const segs = getWindowedWordDiffSegments(longFrom, longTo, { contextChars: 12, mergeGapChars: 8 });
    // Only the first change ("12oz"→"16oz") is in the window; the far "cotton"→"linen" is dropped.
    expect(segs.filter((s) => s.kind === 'removed').map((s) => s.text.trim())).toEqual(['12oz']);
    expect(hasTrailingEllipsis(segs)).toBe(true);
  });

  it('windows a populate (empty -> long text) as all added, no ellipsis needed', () => {
    const segs = getWindowedWordDiffSegments('', 'a brand new long-form description of the product');
    expect(segs.every((s) => s.kind === 'added')).toBe(true);
    expect(hasLeadingEllipsis(segs)).toBe(false);
  });

  it('windows a delete (long text -> empty) as all removed', () => {
    const segs = getWindowedWordDiffSegments('a long-form description that is going away entirely', '');
    expect(segs.every((s) => s.kind === 'removed')).toBe(true);
  });

  it('returns [] for both-empty and the input unchanged for a no-op', () => {
    expect(windowWordDiffSegments(getWordDiffSegments('', ''))).toHaveLength(0);
    const noop = getWordDiffSegments('same text', 'same text');
    expect(windowWordDiffSegments(noop)).toBe(noop);
  });
});
