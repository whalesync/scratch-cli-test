import { describe, expect, it } from 'vitest';
import { computeJsonObjectLineDiff, shouldRenderValuesAsJsonObjectDiff } from '../json-line-diff';

describe('shouldRenderValuesAsJsonObjectDiff', () => {
  it('is true when either side is a parsed object or array', () => {
    expect(shouldRenderValuesAsJsonObjectDiff({ a: 1 }, { a: 2 })).toBe(true);
    expect(shouldRenderValuesAsJsonObjectDiff([1], [2])).toBe(true);
    // A newly created record has no prior value on one side.
    expect(shouldRenderValuesAsJsonObjectDiff(undefined, { a: 1 })).toBe(true);
    expect(shouldRenderValuesAsJsonObjectDiff(null, [1, 2])).toBe(true);
  });

  it('is true when either side is an object/array display string', () => {
    expect(shouldRenderValuesAsJsonObjectDiff('{"a":1}', '{"a":2}')).toBe(true);
    expect(shouldRenderValuesAsJsonObjectDiff('[1,2]', '[1,3]')).toBe(true);
    expect(shouldRenderValuesAsJsonObjectDiff('  { "a": 1 } ', '{"a":2}')).toBe(true);
  });

  it('is false for plain scalars and non-JSON text (no regression for text/number fields)', () => {
    expect(shouldRenderValuesAsJsonObjectDiff('hello', 'world')).toBe(false);
    expect(shouldRenderValuesAsJsonObjectDiff('42', '43')).toBe(false);
    expect(shouldRenderValuesAsJsonObjectDiff('true', 'false')).toBe(false);
    expect(shouldRenderValuesAsJsonObjectDiff('', '')).toBe(false);
    expect(shouldRenderValuesAsJsonObjectDiff(null, null)).toBe(false);
    expect(shouldRenderValuesAsJsonObjectDiff(1, 2)).toBe(false);
    // Looks like it starts an object but is not valid JSON → falls back to text.
    expect(shouldRenderValuesAsJsonObjectDiff('{not json', 'x')).toBe(false);
  });
});

describe('computeJsonObjectLineDiff', () => {
  it('highlights only the changed line for a single-property edit', () => {
    const lines = computeJsonObjectLineDiff({ url: 'a', alt: 'x' }, { url: 'a', alt: 'y' });
    const changed = lines.filter((line) => line.kind !== 'unchanged');
    expect(changed.map((line) => line.kind).sort()).toEqual(['added', 'removed']);
    expect(changed.some((line) => line.kind === 'removed' && line.text.includes('"x"'))).toBe(true);
    expect(changed.some((line) => line.kind === 'added' && line.text.includes('"y"'))).toBe(true);
    // The untouched property survives as unchanged context.
    expect(lines.some((line) => line.kind === 'unchanged' && line.text.includes('"url"'))).toBe(true);
  });

  it('marks every line added when there is no prior value (created record)', () => {
    const lines = computeJsonObjectLineDiff(undefined, { a: 1, b: 2 });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.kind === 'added')).toBe(true);
  });

  it('diffs nested objects and arrays', () => {
    const lines = computeJsonObjectLineDiff({ meta: { tags: ['a'] } }, { meta: { tags: ['a', 'b'] } });
    expect(lines.some((line) => line.kind === 'added' && line.text.includes('"b"'))).toBe(true);
  });

  it('accepts display strings on either side', () => {
    const lines = computeJsonObjectLineDiff('{"a":1}', '{"a":2}');
    expect(lines.some((line) => line.kind === 'removed' && line.text.includes('1'))).toBe(true);
    expect(lines.some((line) => line.kind === 'added' && line.text.includes('2'))).toBe(true);
  });

  it('preserves the object key order instead of sorting keys', () => {
    const lines = computeJsonObjectLineDiff({ b: 1, a: 2 }, { b: 1, a: 3 });
    const rendered = lines.map((line) => line.text).join('\n');
    expect(rendered.indexOf('"b"')).toBeLessThan(rendered.indexOf('"a"'));
  });
});
