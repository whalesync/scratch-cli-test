import { describe, expect, it } from 'vitest';
import { getParagraphDiff, isLongFormContent, type ParagraphChangeKind } from '../content-paragraph-diff';

/** Paragraphs joined with a blank line, the canonical CMS-prose shape. */
function paragraphs(...items: string[]): string {
  return items.join('\n\n');
}

function kinds(fromText: string, toText: string): ParagraphChangeKind[] {
  return getParagraphDiff(fromText, toText).entries.map((entry) => entry.kind);
}

describe('getParagraphDiff', () => {
  it('returns a single unchanged run with no changes when the text is identical', () => {
    const text = paragraphs('First paragraph.', 'Second paragraph.', 'Third paragraph.');
    const result = getParagraphDiff(text, text);
    expect(result.changeCount).toBe(0);
    expect(result.counts).toEqual({ modified: 0, created: 0, deleted: 0 });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].kind).toBe('unchanged');
    expect(result.entries[0].unchangedCount).toBe(3);
  });

  it('marks every paragraph created when the before text is empty', () => {
    const after = paragraphs('Brand new one.', 'Brand new two.');
    const result = getParagraphDiff('', after);
    expect(kinds('', after)).toEqual(['created', 'created']);
    expect(result.counts).toEqual({ modified: 0, created: 2, deleted: 0 });
    expect(result.changeCount).toBe(2);
    expect(result.entries.map((entry) => entry.changeIndex)).toEqual([1, 2]);
  });

  it('marks every paragraph deleted when the after text is empty', () => {
    const result = getParagraphDiff(paragraphs('Gone one.', 'Gone two.'), '');
    expect(result.entries.map((entry) => entry.kind)).toEqual(['deleted', 'deleted']);
    expect(result.counts).toEqual({ modified: 0, created: 0, deleted: 2 });
  });

  it('pairs an edited paragraph as modified while leaving its neighbours unchanged', () => {
    const before = paragraphs('Opening stays.', 'Send the laptop early.', 'Closing stays.');
    const after = paragraphs('Opening stays.', 'Ship the laptop early.', 'Closing stays.');
    const result = getParagraphDiff(before, after);
    expect(result.entries.map((entry) => entry.kind)).toEqual(['unchanged', 'modified', 'unchanged']);
    const modified = result.entries.find((entry) => entry.kind === 'modified');
    expect(modified?.from).toBe('Send the laptop early.');
    expect(modified?.to).toBe('Ship the laptop early.');
    expect(result.counts).toEqual({ modified: 1, created: 0, deleted: 0 });
  });

  it('pairs a longer removed run against a shorter added run: extra removed become deleted', () => {
    // removed = [X1, X2] (2), added = [Y1] (1) -> 1 modified (X1↔Y1) + 1 deleted (X2)
    const before = paragraphs('Anchor.', 'X1 old.', 'X2 old.', 'Tail.');
    const after = paragraphs('Anchor.', 'Y1 new.', 'Tail.');
    const result = getParagraphDiff(before, after);
    expect(result.counts).toEqual({ modified: 1, created: 0, deleted: 1 });
    const changed = result.entries.filter((entry) => entry.kind !== 'unchanged');
    expect(changed.map((entry) => entry.kind)).toEqual(['modified', 'deleted']);
    expect(changed[0].from).toBe('X1 old.');
    expect(changed[0].to).toBe('Y1 new.');
    expect(changed[1].from).toBe('X2 old.');
  });

  it('pairs a shorter removed run against a longer added run: extra added become created', () => {
    // removed = [X1] (1), added = [Y1, Y2] (2) -> 1 modified (X1↔Y1) + 1 created (Y2)
    const before = paragraphs('Anchor.', 'X1 old.', 'Tail.');
    const after = paragraphs('Anchor.', 'Y1 new.', 'Y2 added.', 'Tail.');
    const result = getParagraphDiff(before, after);
    expect(result.counts).toEqual({ modified: 1, created: 1, deleted: 0 });
    const changed = result.entries.filter((entry) => entry.kind !== 'unchanged');
    expect(changed.map((entry) => entry.kind)).toEqual(['modified', 'created']);
    expect(changed[1].to).toBe('Y2 added.');
  });

  it('treats a pure insertion between unchanged paragraphs as created', () => {
    const before = paragraphs('One.', 'Two.');
    const after = paragraphs('One.', 'Inserted.', 'Two.');
    expect(kinds(before, after)).toEqual(['unchanged', 'created', 'unchanged']);
  });

  it('treats a pure deletion between unchanged paragraphs as deleted', () => {
    const before = paragraphs('One.', 'Removed.', 'Two.');
    const after = paragraphs('One.', 'Two.');
    expect(kinds(before, after)).toEqual(['unchanged', 'deleted', 'unchanged']);
  });

  it('assigns change indexes in document order across mixed change kinds', () => {
    const before = paragraphs('Keep.', 'Edit me.', 'Delete me.');
    const after = paragraphs('Keep.', 'Edited.', 'Fresh add.');
    const result = getParagraphDiff(before, after);
    const changed = result.entries.filter((entry) => entry.kind !== 'unchanged');
    expect(changed.map((entry) => entry.changeIndex)).toEqual(changed.map((_, index) => index + 1));
    expect(result.changeCount).toBe(changed.length);
  });

  it('diffs a single giant paragraph (no blank lines) as one modified entry', () => {
    const before = 'A long single line of prose that goes on and on without any breaks at all today.';
    const after = 'A long single line of prose that goes on and on without any pauses at all today.';
    const result = getParagraphDiff(before, after);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].kind).toBe('modified');
  });

  it('falls back to single-newline splitting when there are no blank-line boundaries', () => {
    const before = ['line one', 'line two', 'line three'].join('\n');
    const after = ['line one', 'line TWO', 'line three'].join('\n');
    const result = getParagraphDiff(before, after);
    expect(result.entries.map((entry) => entry.kind)).toEqual(['unchanged', 'modified', 'unchanged']);
  });
});

describe('isLongFormContent', () => {
  const longBody = paragraphs(
    'Remote onboarding is mostly a logistics problem dressed up as a culture problem, and getting the boring things right is most of the battle.',
    'Pre-stage every account the night before so the new hire can start building instead of waiting on access requests that eat a whole morning.',
    'Assign a single named point of contact for the first week, and by the end of it they should have shipped something small but real in production.',
  );

  it('returns true for a multi-paragraph body', () => {
    expect(isLongFormContent('', longBody)).toBe(true);
    expect(isLongFormContent(longBody, '')).toBe(true);
  });

  it('returns false for a short single-line title', () => {
    expect(isLongFormContent('Old Title', 'New Title')).toBe(false);
  });

  it('returns false for a medium single-line value below the word/length bar', () => {
    const tagline = 'A reasonably long single-line tagline with maybe around twenty five words total here in it now.';
    expect(isLongFormContent('', tagline)).toBe(false);
  });

  it('returns true for a very long single-line value even without line breaks', () => {
    const longSingleLine = Array.from({ length: 200 }, (_, index) => `word${index}`).join(' ');
    expect(longSingleLine.includes('\n')).toBe(false);
    expect(isLongFormContent('', longSingleLine)).toBe(true);
  });
});
