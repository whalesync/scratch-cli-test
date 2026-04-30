import { describe, expect, it } from 'vitest';
import { classifyFieldChange } from './field-change-classification';
import type { ColumnDefinition } from './schema-columns/types';

function col(overrides: Partial<ColumnDefinition>): ColumnDefinition {
  return {
    id: 'f',
    displayName: 'f',
    dataType: 'string',
    attributes: { readOnly: false, required: false, nested: false },
    ...overrides,
  };
}

describe('classifyFieldChange — changeType', () => {
  it('treats null/undefined/whitespace-only as empty for populate/delete', () => {
    expect(classifyFieldChange(null, 'hello', col({}))).toMatchObject({ changeType: 'populate' });
    expect(classifyFieldChange(undefined, 'hello', col({}))).toMatchObject({ changeType: 'populate' });
    expect(classifyFieldChange('   ', 'hello', col({}))).toMatchObject({ changeType: 'populate' });

    expect(classifyFieldChange('hello', null, col({}))).toMatchObject({ changeType: 'delete' });
    expect(classifyFieldChange('hello', '', col({}))).toMatchObject({ changeType: 'delete' });
  });

  it('treats empty arrays and objects as empty', () => {
    expect(classifyFieldChange([], ['a'], col({ dataType: 'array' }))).toMatchObject({ changeType: 'populate' });
    expect(classifyFieldChange({}, { k: 1 }, col({ dataType: 'object' }))).toMatchObject({ changeType: 'populate' });
    expect(classifyFieldChange(['a'], [], col({ dataType: 'array' }))).toMatchObject({ changeType: 'delete' });
  });

  it('classifies a small in-place edit as a tweak', () => {
    const before = 'The quick brown fox jumps over the lazy dog in the meadow at dawn.';
    const after = 'The quick brown fox jumps over the sleepy dog in the meadow at dawn.';
    expect(classifyFieldChange(before, after, col({}))).toMatchObject({ changeType: 'tweak' });
  });

  it('classifies a link swap inside long text as a tweak', () => {
    const before = 'See our docs at https://example.com/old-page for more info on this topic right here.';
    const after = 'See our docs at https://example.com/new-page for more info on this topic right here.';
    expect(classifyFieldChange(before, after, col({}))).toMatchObject({ changeType: 'tweak' });
  });

  it('classifies a wholesale replacement as a rewrite', () => {
    const before = 'The quick brown fox jumps over the lazy dog.';
    const after = 'A completely different sentence that shares almost nothing.';
    expect(classifyFieldChange(before, after, col({}))).toMatchObject({ changeType: 'rewrite' });
  });

  it('classifies a short value swap as a rewrite, not a tweak', () => {
    expect(classifyFieldChange('foo', 'bar', col({}))).toMatchObject({ changeType: 'rewrite' });
  });
});

describe('classifyFieldChange — fieldSize', () => {
  it('marks booleans, numbers, and integers as XS', () => {
    expect(classifyFieldChange(false, true, col({ dataType: 'boolean' }))).toMatchObject({ fieldSize: 'XS' });
    expect(classifyFieldChange(1, 2, col({ dataType: 'number' }))).toMatchObject({ fieldSize: 'XS' });
    expect(classifyFieldChange(1, 2, col({ dataType: 'integer' }))).toMatchObject({ fieldSize: 'XS' });
  });

  it('marks date/email/uri formats as XS regardless of length', () => {
    expect(
      classifyFieldChange('', '2026-04-28T10:00:00Z', col({ dataType: 'string', format: 'date-time' })),
    ).toMatchObject({ fieldSize: 'XS' });
    expect(classifyFieldChange('', 'someone@example.com', col({ dataType: 'string', format: 'email' }))).toMatchObject({
      fieldSize: 'XS',
    });
  });

  it('buckets strings by length', () => {
    expect(classifyFieldChange('', 'Active', col({}))).toMatchObject({ fieldSize: 'XS' });
    expect(classifyFieldChange('', 'A short article title goes here', col({}))).toMatchObject({ fieldSize: 'S' });
    const summary =
      'A summary that is long enough to take a couple of lines but is still meant to be glanceable. '.repeat(2);
    expect(classifyFieldChange('', summary, col({}))).toMatchObject({ fieldSize: 'M' });
    const body = 'paragraph '.repeat(60);
    expect(classifyFieldChange('', body, col({}))).toMatchObject({ fieldSize: 'L' });
  });

  it('floors arrays and objects at S, then promotes by length', () => {
    expect(classifyFieldChange([], ['a'], col({ dataType: 'array' }))).toMatchObject({ fieldSize: 'S' });
    const longArray = Array.from({ length: 30 }, (_, i) => `item-${i}`);
    expect(classifyFieldChange([], longArray, col({ dataType: 'array' }))).toMatchObject({ fieldSize: 'L' });
  });

  it("uses the longer side when one side is empty (delete shouldn't look like XS just because target is empty)", () => {
    const longBody = 'paragraph '.repeat(60);
    expect(classifyFieldChange(longBody, '', col({}))).toMatchObject({ fieldSize: 'L', changeType: 'delete' });
  });
});
