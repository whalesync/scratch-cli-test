import type { TableViewCol } from '@spinner/shared-types';
import { describe, expect, it } from 'vitest';
import { classifyFieldChange } from './field-change-classification';

function col(overrides: Partial<TableViewCol> = {}): TableViewCol {
  return {
    kind: 'col',
    path: 'f',
    ...overrides,
  };
}

describe('classifyFieldChange — changeType', () => {
  it('treats null/undefined/whitespace-only as empty for populate/delete', () => {
    expect(classifyFieldChange(null, 'hello', col())).toMatchObject({ changeType: 'populate' });
    expect(classifyFieldChange(undefined, 'hello', col())).toMatchObject({ changeType: 'populate' });
    expect(classifyFieldChange('   ', 'hello', col())).toMatchObject({ changeType: 'populate' });

    expect(classifyFieldChange('hello', null, col())).toMatchObject({ changeType: 'delete' });
    expect(classifyFieldChange('hello', '', col())).toMatchObject({ changeType: 'delete' });
  });

  it('treats empty arrays and objects as empty', () => {
    expect(classifyFieldChange([], ['a'], col())).toMatchObject({ changeType: 'populate' });
    expect(classifyFieldChange({}, { k: 1 }, col({ type: 'object' }))).toMatchObject({ changeType: 'populate' });
    expect(classifyFieldChange(['a'], [], col())).toMatchObject({ changeType: 'delete' });
  });

  it('classifies a small in-place edit as a tweak', () => {
    const before = 'The quick brown fox jumps over the lazy dog in the meadow at dawn.';
    const after = 'The quick brown fox jumps over the sleepy dog in the meadow at dawn.';
    expect(classifyFieldChange(before, after, col())).toMatchObject({ changeType: 'tweak' });
  });

  it('classifies a link swap inside long text as a tweak', () => {
    const before = 'See our docs at https://example.com/old-page for more info on this topic right here.';
    const after = 'See our docs at https://example.com/new-page for more info on this topic right here.';
    expect(classifyFieldChange(before, after, col())).toMatchObject({ changeType: 'tweak' });
  });

  it('classifies a wholesale replacement as a rewrite', () => {
    const before = 'The quick brown fox jumps over the lazy dog.';
    const after = 'A completely different sentence that shares almost nothing.';
    expect(classifyFieldChange(before, after, col())).toMatchObject({ changeType: 'rewrite' });
  });

  it('classifies a short value swap as a rewrite, not a tweak', () => {
    expect(classifyFieldChange('foo', 'bar', col())).toMatchObject({ changeType: 'rewrite' });
  });
});

describe('classifyFieldChange — fieldSize', () => {
  it('marks checkboxes and numbers as XS', () => {
    expect(classifyFieldChange(false, true, col({ type: 'checkbox' }))).toMatchObject({ fieldSize: 'XS' });
    expect(classifyFieldChange(1, 2, col({ type: 'number' }))).toMatchObject({ fieldSize: 'XS' });
  });

  it('marks date/url type hints as XS regardless of length', () => {
    expect(classifyFieldChange('', '2026-04-28T10:00:00Z', col({ type: 'date' }))).toMatchObject({ fieldSize: 'XS' });
    expect(classifyFieldChange('', 'https://example.com/page', col({ type: 'url' }))).toMatchObject({
      fieldSize: 'XS',
    });
  });

  it('buckets strings by length', () => {
    expect(classifyFieldChange('', 'Active', col())).toMatchObject({ fieldSize: 'XS' });
    expect(classifyFieldChange('', 'A short article title goes here', col())).toMatchObject({ fieldSize: 'S' });
    const summary =
      'A summary that is long enough to take a couple of lines but is still meant to be glanceable. '.repeat(2);
    expect(classifyFieldChange('', summary, col())).toMatchObject({ fieldSize: 'M' });
    const body = 'paragraph '.repeat(60);
    expect(classifyFieldChange('', body, col())).toMatchObject({ fieldSize: 'L' });
  });

  it('floors objects at S, then promotes by length', () => {
    expect(classifyFieldChange({}, { k: 1 }, col({ type: 'object' }))).toMatchObject({ fieldSize: 'S' });
    const longObj: Record<string, string> = {};
    for (let i = 0; i < 30; i++) longObj[`key${i}`] = `value-${i}`;
    expect(classifyFieldChange({}, longObj, col({ type: 'object' }))).toMatchObject({ fieldSize: 'L' });
  });

  it("uses the longer side when one side is empty (delete shouldn't look like XS just because target is empty)", () => {
    const longBody = 'paragraph '.repeat(60);
    expect(classifyFieldChange(longBody, '', col())).toMatchObject({ fieldSize: 'L', changeType: 'delete' });
  });
});
