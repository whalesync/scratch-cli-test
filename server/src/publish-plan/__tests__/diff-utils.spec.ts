import { X_SCRATCH_ARRAY_KEYED_BY, X_SCRATCH_ASSET_FIELD } from '@spinner/shared-types';
import { computeChangedFields, pickByShape } from '../diff-utils';

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

describe('pickByShape', () => {
  it('picks flat keys present in shape', () => {
    const source = { a: 1, b: 2, c: 3 };
    const shape = { a: 'x', c: 'x' };
    expect(pickByShape(source, shape)).toEqual({ a: 1, c: 3 });
  });

  it('picks nested sub-keys from source', () => {
    const source = { properties: { email: 'new@ex.com', firstname: 'John', lastname: 'Doe' } };
    const shape = { properties: { email: 'old' } };
    expect(pickByShape(source, shape)).toEqual({ properties: { email: 'new@ex.com' } });
  });

  it('handles deeply nested paths (3+ levels)', () => {
    const source = { l1: { l2: { l3: 'value', other: 'skip' }, extra: 'skip' } };
    const shape = { l1: { l2: { l3: 'x' } } };
    expect(pickByShape(source, shape)).toEqual({ l1: { l2: { l3: 'value' } } });
  });

  it('skips shape keys missing from source', () => {
    const source = { a: 1 };
    const shape = { a: 'x', missing: 'x' };
    expect(pickByShape(source, shape)).toEqual({ a: 1 });
  });

  it('returns empty object for empty shape', () => {
    expect(pickByShape({ a: 1, b: 2 }, {})).toEqual({});
  });

  it('treats arrays as leaf nodes — takes full array from source', () => {
    const source = { tags: ['transformed-a', 'transformed-b'] };
    const shape = { tags: ['old-a', 'old-b'] };
    expect(pickByShape(source, shape)).toEqual({ tags: ['transformed-a', 'transformed-b'] });
  });

  it('takes source value when shape has object but source has primitive', () => {
    const source = { field: 'scalar-value' };
    const shape = { field: { nested: 'x' } };
    expect(pickByShape(source, shape)).toEqual({ field: 'scalar-value' });
  });

  it('takes full source object when shape has primitive but source has object', () => {
    const source = { field: { a: 1, b: 2, c: 3 } };
    const shape = { field: 'changed' };
    expect(pickByShape(source, shape)).toEqual({ field: { a: 1, b: 2, c: 3 } });
  });

  it('picks HubSpot-style nested properties', () => {
    const source = {
      id: '123',
      properties: { email: 'transformed@ex.com', firstname: 'John', company: 'Acme' },
      associations: { contacts: ['c1'] },
    };
    const shape = { properties: { email: 'old@ex.com' } };
    expect(pickByShape(source, shape)).toEqual({ properties: { email: 'transformed@ex.com' } });
  });

  it('picks Webflow-style fieldData', () => {
    const source = {
      id: 'abc',
      fieldData: { slug: 'new-slug', name: 'Full Name', body: '<p>content</p>' },
    };
    const shape = { fieldData: { slug: 'old-slug' } };
    expect(pickByShape(source, shape)).toEqual({ fieldData: { slug: 'new-slug' } });
  });

  it('handles null values in source', () => {
    const source = { a: null, b: 2 };
    const shape = { a: 'x', b: 'x' };
    expect(pickByShape(source, shape)).toEqual({ a: null, b: 2 });
  });

  it('handles array in source with object in shape', () => {
    const source = { items: [1, 2, 3] };
    const shape = { items: { 0: 'x' } };
    expect(pickByShape(source, shape)).toEqual({ items: [1, 2, 3] });
  });
});

describe('computeChangedFields — keyed arrays (x-scratch-array-keyed-by)', () => {
  // Copper-style schema: `custom_fields` is a verbatim [{custom_field_definition_id, value}] array,
  // annotated so the diff isolates the single changed element instead of the whole array.
  const schema = {
    properties: {
      name: { type: 'string' },
      custom_fields: {
        type: 'array',
        [X_SCRATCH_ARRAY_KEYED_BY]: {
          keyField: 'custom_field_definition_id',
          valuePath: 'value',
          columns: [
            { key: 700123, name: 'Tier' },
            { key: 700124, name: 'Renewal' },
          ],
        },
      },
    },
  };

  const main = {
    name: 'Acme',
    custom_fields: [
      { custom_field_definition_id: 700123, value: 'Enterprise' },
      { custom_field_definition_id: 700124, value: '2026-03-01' },
    ],
  };

  it('diffs a keyed array element-wise into a sparse changed-elements array', () => {
    const dirty = {
      name: 'Acme',
      custom_fields: [
        { custom_field_definition_id: 700123, value: 'SMB' },
        { custom_field_definition_id: 700124, value: '2026-03-01' },
      ],
    };
    expect(computeChangedFields(main, dirty, schema)).toEqual({
      custom_fields: [{ custom_field_definition_id: 700123, value: 'SMB' }],
    });
  });

  it('omits an unchanged keyed array entirely', () => {
    const dirty = { name: 'Acme Corp', custom_fields: main.custom_fields };
    expect(computeChangedFields(main, dirty, schema)).toEqual({ name: 'Acme Corp' });
  });

  it('falls back to atomic array diff when no schema is passed', () => {
    const dirty = {
      name: 'Acme',
      custom_fields: [
        { custom_field_definition_id: 700123, value: 'SMB' },
        { custom_field_definition_id: 700124, value: '2026-03-01' },
      ],
    };
    // Without the schema, the whole array is treated as one changed value.
    expect(computeChangedFields(main, dirty)).toEqual({ custom_fields: dirty.custom_fields });
  });
});

describe('computeChangedFields — atomic asset fields (x-scratch-asset-field) (DEV-10755)', () => {
  // Webflow-style schema: `image` is an atomic media reference `{ fileId, url, alt }`
  // the service requires whole on write. The annotation is hoisted to the field
  // top level AND kept on the nullable `anyOf` object member (the real persisted shape).
  const assetOpts = { idPath: 'fileId', urlExpires: false };
  const imageFieldSchema = {
    anyOf: [
      {
        type: 'object',
        properties: { fileId: {}, url: { format: 'uri' }, alt: {} },
        [X_SCRATCH_ASSET_FIELD]: assetOpts,
      },
      { type: 'null' },
    ],
    [X_SCRATCH_ASSET_FIELD]: assetOpts,
  };
  const schema = {
    properties: {
      fieldData: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          image: imageFieldSchema,
        },
      },
    },
  };

  const mainImage = { fileId: 'f1', url: 'https://cdn/x.png', alt: 'old alt' };

  it('emits the WHOLE asset object when only a subfield (alt) changed', () => {
    const main = { id: 'abc', fieldData: { name: 'Same', image: mainImage } };
    const dirty = { id: 'abc', fieldData: { name: 'Same', image: { ...mainImage, alt: 'new alt' } } };
    // The fix: the changed subfield re-expands to the full object, so the connector
    // sends `{ fileId, url, alt }` — not the malformed sparse `{ alt }` that Webflow rejects.
    expect(computeChangedFields(main, dirty, schema)).toEqual({
      fieldData: { image: { fileId: 'f1', url: 'https://cdn/x.png', alt: 'new alt' } },
    });
  });

  it('omits an unchanged asset object', () => {
    const main = { id: 'abc', fieldData: { name: 'A', image: mainImage } };
    const dirty = { id: 'abc', fieldData: { name: 'B', image: { ...mainImage } } };
    expect(computeChangedFields(main, dirty, schema)).toEqual({ fieldData: { name: 'B' } });
  });

  it('WITHOUT the schema, falls back to the sparse (pre-fix) subfield diff', () => {
    const main = { id: 'abc', fieldData: { name: 'Same', image: mainImage } };
    const dirty = { id: 'abc', fieldData: { name: 'Same', image: { ...mainImage, alt: 'new alt' } } };
    // Documents that the atomic behavior is schema-driven — the bug shape reproduces without it.
    expect(computeChangedFields(main, dirty)).toEqual({ fieldData: { image: { alt: 'new alt' } } });
  });

  it('detects the annotation when it lives ONLY on an anyOf member (nullable pattern)', () => {
    const anyOfOnlySchema = {
      properties: {
        fieldData: {
          type: 'object',
          properties: {
            image: {
              anyOf: [
                { type: 'object', properties: { fileId: {}, url: {}, alt: {} }, [X_SCRATCH_ASSET_FIELD]: assetOpts },
                { type: 'null' },
              ],
            },
          },
        },
      },
    };
    const main = { fieldData: { image: mainImage } };
    const dirty = { fieldData: { image: { ...mainImage, alt: 'new alt' } } };
    expect(computeChangedFields(main, dirty, anyOfOnlySchema)).toEqual({
      fieldData: { image: { fileId: 'f1', url: 'https://cdn/x.png', alt: 'new alt' } },
    });
  });

  it('emits the whole object when the asset field is set from null', () => {
    const main = { fieldData: { image: null } };
    const dirty = { fieldData: { image: mainImage } };
    expect(computeChangedFields(main, dirty, schema)).toEqual({ fieldData: { image: mainImage } });
  });

  it('emits null when the asset field is cleared to null', () => {
    const main = { fieldData: { image: mainImage } };
    const dirty = { fieldData: { image: null } };
    expect(computeChangedFields(main, dirty, schema)).toEqual({ fieldData: { image: null } });
  });

  it('emits the whole array (atomically) for an array-of-assets (MultiImage via items)', () => {
    const gallerySchema = {
      properties: {
        fieldData: {
          type: 'object',
          properties: {
            gallery: {
              type: 'array',
              items: {
                type: 'object',
                properties: { fileId: {}, url: {}, alt: {} },
                [X_SCRATCH_ASSET_FIELD]: assetOpts,
              },
            },
          },
        },
      },
    };
    const main = {
      fieldData: {
        gallery: [
          { fileId: 'a', url: 'ua', alt: '1' },
          { fileId: 'b', url: 'ub', alt: '2' },
        ],
      },
    };
    const dirty = {
      fieldData: {
        gallery: [
          { fileId: 'a', url: 'ua', alt: 'changed' },
          { fileId: 'b', url: 'ub', alt: '2' },
        ],
      },
    };
    expect(computeChangedFields(main, dirty, gallerySchema)).toEqual({
      fieldData: { gallery: dirty.fieldData.gallery },
    });
  });
});

describe('pickByShape — whole asset object survives the mask (DEV-10755)', () => {
  it('reproduces the full asset object when the shape carries every subkey', () => {
    // Post-fix, computeChangedFields yields a whole-object shape; pickByShape must
    // reproduce it in full from the resolved record (not re-narrow to one subfield).
    const source = {
      id: 'abc',
      fieldData: {
        name: 'Full Name',
        image: { fileId: 'f1', url: 'https://cdn/x.png', alt: 'new alt' },
      },
    };
    const shape = { fieldData: { image: { fileId: 'f1', url: 'https://cdn/x.png', alt: 'new alt' } } };
    expect(pickByShape(source, shape)).toEqual({
      fieldData: { image: { fileId: 'f1', url: 'https://cdn/x.png', alt: 'new alt' } },
    });
  });
});
