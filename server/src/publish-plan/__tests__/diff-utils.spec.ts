import { computeChangedFields } from '../diff-utils';

describe('computeChangedFields', () => {
  // --- Basic behavior ---

  it('returns empty object for identical flat objects', () => {
    expect(computeChangedFields({ a: 1, b: 'hello' }, { a: 1, b: 'hello' })).toEqual({});
  });

  it('returns only the changed field for a single field change', () => {
    expect(computeChangedFields({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual({ b: 3 });
  });

  it('returns multiple changed fields', () => {
    expect(computeChangedFields({ a: 1, b: 2, c: 3 }, { a: 10, b: 2, c: 30 })).toEqual({ a: 10, c: 30 });
  });

  it('returns full dirty content when all fields changed', () => {
    const dirty = { a: 10, b: 20 };
    expect(computeChangedFields({ a: 1, b: 2 }, dirty)).toEqual(dirty);
  });

  it('includes new fields added in dirty (absent in main)', () => {
    expect(computeChangedFields({ a: 1 }, { a: 1, b: 2 })).toEqual({ b: 2 });
  });

  it('ignores removed keys (present in main, absent in dirty)', () => {
    expect(computeChangedFields({ a: 1, b: 2 }, { a: 1 })).toEqual({});
  });

  // --- Nested objects ---

  it('diffs nested field changes', () => {
    expect(
      computeChangedFields({ fields: { Name: 'Old', Notes: 'Same' } }, { fields: { Name: 'New', Notes: 'Same' } }),
    ).toEqual({ fields: { Name: 'New' } });
  });

  it('includes only changed sibling in nested objects', () => {
    const main = { meta: { a: 1, b: 2 }, other: 'x' };
    const dirty = { meta: { a: 1, b: 99 }, other: 'x' };
    expect(computeChangedFields(main, dirty)).toEqual({ meta: { b: 99 } });
  });

  it('handles deeply nested changes (3+ levels)', () => {
    const main = { l1: { l2: { l3: 'old' } } };
    const dirty = { l1: { l2: { l3: 'new' } } };
    expect(computeChangedFields(main, dirty)).toEqual({ l1: { l2: { l3: 'new' } } });
  });

  it('includes new nested objects added in dirty', () => {
    expect(computeChangedFields({ a: 1 }, { a: 1, nested: { x: 1 } })).toEqual({ nested: { x: 1 } });
  });

  it('ignores removed nested keys', () => {
    expect(computeChangedFields({ a: 1, nested: { x: 1 } }, { a: 1 })).toEqual({});
  });

  it('handles mixed nested: some fields changed, some not', () => {
    const main = { fields: { Name: 'Same', Slug: 'old', Notes: 'Same' } };
    const dirty = { fields: { Name: 'Same', Slug: 'new', Notes: 'Same' } };
    expect(computeChangedFields(main, dirty)).toEqual({ fields: { Slug: 'new' } });
  });

  it('excludes parent key when all nested fields are identical', () => {
    const main = { fields: { Name: 'Same' }, id: 'abc' };
    const dirty = { fields: { Name: 'Same' }, id: 'abc' };
    expect(computeChangedFields(main, dirty)).toEqual({});
  });

  // --- Arrays (atomic comparison) ---

  it('treats identical arrays as unchanged', () => {
    expect(computeChangedFields({ tags: [1, 2, 3] }, { tags: [1, 2, 3] })).toEqual({});
  });

  it('includes entire array when an element changes', () => {
    expect(computeChangedFields({ tags: [1, 2, 3] }, { tags: [1, 99, 3] })).toEqual({ tags: [1, 99, 3] });
  });

  it('includes entire array when length changes', () => {
    expect(computeChangedFields({ tags: [1, 2] }, { tags: [1, 2, 3] })).toEqual({ tags: [1, 2, 3] });
  });

  it('includes entire array of objects when changed (atomic)', () => {
    const main = { items: [{ id: 1 }, { id: 2 }] };
    const dirty = { items: [{ id: 1 }, { id: 3 }] };
    expect(computeChangedFields(main, dirty)).toEqual({ items: [{ id: 1 }, { id: 3 }] });
  });

  it('treats nested array within object atomically', () => {
    const main = { fields: { Tags: ['a', 'b'] } };
    const dirty = { fields: { Tags: ['a', 'c'] } };
    expect(computeChangedFields(main, dirty)).toEqual({ fields: { Tags: ['a', 'c'] } });
  });

  // --- Type coercion / edge cases ---

  it('treats null vs undefined as different values', () => {
    expect(computeChangedFields({ a: null }, { a: undefined })).toEqual({ a: undefined });
  });

  it('includes null in dirty when key is missing in main', () => {
    expect(computeChangedFields({}, { a: null })).toEqual({ a: null });
  });

  it('treats 0 vs false as different values', () => {
    expect(computeChangedFields({ a: 0 }, { a: false })).toEqual({ a: false });
  });

  it('includes empty string when key is missing in main', () => {
    expect(computeChangedFields({}, { a: '' })).toEqual({ a: '' });
  });

  it('includes empty object when key is missing in main', () => {
    expect(computeChangedFields({}, { a: {} })).toEqual({ a: {} });
  });

  it('treats both values null as no change', () => {
    expect(computeChangedFields({ a: null }, { a: null })).toEqual({});
  });

  it('detects number change', () => {
    expect(computeChangedFields({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it('detects boolean change', () => {
    expect(computeChangedFields({ a: true }, { a: false })).toEqual({ a: false });
  });

  it('detects string change', () => {
    expect(computeChangedFields({ a: 'old' }, { a: 'new' })).toEqual({ a: 'new' });
  });

  it('detects type change (string vs number)', () => {
    expect(computeChangedFields({ a: '1' }, { a: 1 })).toEqual({ a: 1 });
  });

  // --- Connector-specific structures ---

  it('diffs Airtable-style records (fields wrapper)', () => {
    const main = { id: 'rec1', fields: { Name: 'Old', Notes: 'Same' } };
    const dirty = { id: 'rec1', fields: { Name: 'New', Notes: 'Same' } };
    expect(computeChangedFields(main, dirty)).toEqual({ fields: { Name: 'New' } });
  });

  it('diffs Webflow-style records (fieldData wrapper)', () => {
    const main = { id: 'abc', fieldData: { slug: 'old', name: 'Same' } };
    const dirty = { id: 'abc', fieldData: { slug: 'new', name: 'Same' } };
    expect(computeChangedFields(main, dirty)).toEqual({ fieldData: { slug: 'new' } });
  });

  it('diffs Notion-style records (properties wrapper)', () => {
    const main = { id: 'page1', properties: { Title: { rich_text: [{ text: 'Old' }] }, Status: 'Done' } };
    const dirty = { id: 'page1', properties: { Title: { rich_text: [{ text: 'New' }] }, Status: 'Done' } };
    expect(computeChangedFields(main, dirty)).toEqual({
      properties: { Title: { rich_text: [{ text: 'New' }] } },
    });
  });

  it('diffs flat structure (no wrapper) correctly', () => {
    const main = { id: 1, name: 'Old', active: true };
    const dirty = { id: 1, name: 'New', active: true };
    expect(computeChangedFields(main, dirty)).toEqual({ name: 'New' });
  });

  // --- Main content is null/undefined (fallback) ---

  it('returns full dirty content when main is empty object', () => {
    const dirty = { a: 1, b: 'hello' };
    expect(computeChangedFields({}, dirty)).toEqual(dirty);
  });
});
