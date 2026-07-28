import { Type } from '@sinclair/typebox';
import { X_SCRATCH_ARRAY_KEYED_BY, type ArrayKeyedByOptions } from '@spinner/shared-types';
import {
  getSchemaAtFieldPath,
  readFieldValueAtPath,
  segmentFieldPathAgainstObject,
  segmentFieldPathAgainstSchema,
  setFieldValueAtPath,
} from './field-path';

// A source schema whose column is literally named `col.with.dots` — the DEV-10959
// repro. Per the Connector Prime Directive it is a single flat property, not a
// nested `col → with → dots`.
const dottedSourceSchema = Type.Object({
  name: Type.String(),
  'col.with.dots': Type.String(),
});

// A Notion-shaped destination schema where a created property is named with dots,
// so the dotted name sits in the MIDDLE of the path (`properties.<name>.rich_text`).
const notionDestSchema = Type.Object({
  properties: Type.Object({
    Name: Type.Object({ title: Type.Array(Type.Object({ plain_text: Type.String() })) }),
    'col.with.dots': Type.Object({ rich_text: Type.Array(Type.Object({ plain_text: Type.String() })) }),
  }),
});

describe('segmentFieldPathAgainstSchema', () => {
  it('recovers a flat dotted field name as a single segment', () => {
    expect(segmentFieldPathAgainstSchema(dottedSourceSchema, 'col.with.dots')).toEqual(['col.with.dots']);
  });

  it('recovers a dotted name sitting in the middle of a nested path', () => {
    expect(segmentFieldPathAgainstSchema(notionDestSchema, 'properties.col.with.dots.rich_text')).toEqual([
      'properties',
      'col.with.dots',
      'rich_text',
    ]);
  });

  it('is identical to a naive split for clean nested paths', () => {
    expect(segmentFieldPathAgainstSchema(notionDestSchema, 'properties.Name.title')).toEqual([
      'properties',
      'Name',
      'title',
    ]);
    expect(segmentFieldPathAgainstSchema(dottedSourceSchema, 'name')).toEqual(['name']);
  });

  it('falls back to a naive split once the path diverges from the schema', () => {
    // `unknown` is not a property; the remainder is segmented the old way.
    expect(segmentFieldPathAgainstSchema(dottedSourceSchema, 'unknown.leaf')).toEqual(['unknown', 'leaf']);
  });

  it('unwraps a nullable-union object schema while segmenting', () => {
    const nullableObject = Type.Union([Type.Object({ 'a.b': Type.String() }), Type.Null()]);
    expect(segmentFieldPathAgainstSchema(nullableObject, 'a.b')).toEqual(['a.b']);
  });

  it('segments through an object branch that is not the first non-null union branch', () => {
    // Pipedrive picture shape (DEV-11030): the object branch sits AFTER a scalar branch.
    const mixedUnion = Type.Object({
      picture_id: Type.Union([Type.Number(), Type.Object({ 'url.with.dots': Type.String() }), Type.Null()]),
    });
    expect(segmentFieldPathAgainstSchema(mixedUnion, 'picture_id.url.with.dots')).toEqual([
      'picture_id',
      'url.with.dots',
    ]);
  });
});

describe('segmentFieldPathAgainstObject', () => {
  it('recovers a flat dotted key present on the object', () => {
    expect(segmentFieldPathAgainstObject({ 'col.with.dots': 1 }, 'col.with.dots')).toEqual(['col.with.dots']);
  });

  it('prefers the longest matching key over a shorter dotted-prefix sibling', () => {
    // Both `col` and `col.with.dots` exist: the whole dotted name must win.
    const record = { col: { with: { dots: 'nested' } }, 'col.with.dots': 'flat' };
    expect(segmentFieldPathAgainstObject(record, 'col.with.dots')).toEqual(['col.with.dots']);
  });

  it('segments a genuinely nested path when no flat key matches', () => {
    expect(segmentFieldPathAgainstObject({ a: { b: 1 } }, 'a.b')).toEqual(['a', 'b']);
  });
});

describe('getSchemaAtFieldPath', () => {
  it('finds a flat dotted field (the DEV-10959 case that previously reported "not found")', () => {
    const found = getSchemaAtFieldPath(dottedSourceSchema, 'col.with.dots');
    expect(found).toBeDefined();
    expect(found?.type).toBe('string');
  });

  it('finds a leaf under a dotted middle segment', () => {
    const found = getSchemaAtFieldPath(notionDestSchema, 'properties.col.with.dots.rich_text');
    expect(found?.type).toBe('array');
  });

  it('returns undefined for a genuinely absent field', () => {
    expect(getSchemaAtFieldPath(dottedSourceSchema, 'nope')).toBeUndefined();
  });

  it('still resolves clean nested paths', () => {
    expect(getSchemaAtFieldPath(notionDestSchema, 'properties.Name.title')?.type).toBe('array');
  });

  it('resolves a subfield through a union whose object branch is not first (DEV-11030 picture_id.url)', () => {
    // The exact Pipedrive picture shape: `Union[Number, Object({url}), Null]`. The
    // plan expands `picture_id.url` from the object branch; the resolver must find
    // it too instead of stopping at the scalar first branch and reporting
    // "Source field 'picture_id.url' not found in schema".
    const pipedrivePersonLikeSchema = Type.Object({
      picture_id: Type.Union([
        Type.Number(),
        Type.Object({ url: Type.Optional(Type.Union([Type.String(), Type.Null()])) }),
        Type.Null(),
      ]),
    });
    const found = getSchemaAtFieldPath(pipedrivePersonLikeSchema, 'picture_id.url');
    expect(found).toBeDefined();
    const foundUnionBranches = (found as { anyOf?: { type?: string }[] } | undefined)?.anyOf;
    expect(foundUnionBranches?.some((branch) => branch.type === 'string')).toBe(true);
  });

  it('resolves subfields from every object branch of a multi-object union', () => {
    const multiObjectUnion = Type.Object({
      field: Type.Union([Type.Object({ first: Type.String() }), Type.Object({ second: Type.Number() }), Type.Null()]),
    });
    expect(getSchemaAtFieldPath(multiObjectUnion, 'field.first')?.type).toBe('string');
    expect(getSchemaAtFieldPath(multiObjectUnion, 'field.second')?.type).toBe('number');
  });

  it('resolves through a oneOf union wrapper like schema-helpers propertySchemaAt does', () => {
    const oneOfWrapped = Type.Object({
      field: Type.Unsafe<unknown>({ oneOf: [Type.Number(), Type.Object({ inner: Type.String() })] }),
    });
    expect(getSchemaAtFieldPath(oneOfWrapped, 'field.inner')?.type).toBe('string');
  });
});

describe('readFieldValueAtPath', () => {
  it('reads a dotted field name as a flat key rather than a nested miss', () => {
    expect(readFieldValueAtPath({ 'col.with.dots': 'hello' }, 'col.with.dots')).toBe('hello');
  });

  it('returns the explicit value even when it is null (a real cleared dotted field)', () => {
    expect(readFieldValueAtPath({ 'col.with.dots': null }, 'col.with.dots')).toBeNull();
  });

  it('reads genuinely nested values unchanged', () => {
    expect(readFieldValueAtPath({ a: { b: 2 } }, 'a.b')).toBe(2);
  });
});

// An Affinity-shaped source schema (DEV-11062): custom fields are stored as the
// verbatim `entity.fields` array annotated with `x-scratch-array-keyed-by`, so each
// field is addressed by a filter segment `entity.fields.[id=<fieldId>]` and drills
// into `.value.data`. A `location` field's `data` is an OPEN object (its
// `.streetAddress` / `.city` subfields are not named in the schema).
const affinityFieldsKeyedBy: ArrayKeyedByOptions = {
  keyField: 'id',
  columns: [
    { key: 'field-text', name: 'Text field', type: 'text' },
    { key: 'field-number', name: 'Number field', type: 'number' },
    { key: 'field-location', name: 'Location field', type: 'text' },
  ],
};
const affinityLikeSourceSchema = Type.Object({
  id: Type.Number(),
  entity: Type.Object({
    name: Type.Union([Type.String(), Type.Null()]),
    fields: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          value: Type.Union([
            Type.Object({ type: Type.Literal('text'), data: Type.Union([Type.String(), Type.Null()]) }),
            Type.Object({ type: Type.Literal('number'), data: Type.Union([Type.Number(), Type.Null()]) }),
            Type.Object({
              type: Type.Literal('location'),
              data: Type.Union([Type.Object({}, { additionalProperties: true }), Type.Null()]),
            }),
            Type.Null(),
          ]),
        },
        { additionalProperties: true },
      ),
      { [X_SCRATCH_ARRAY_KEYED_BY]: affinityFieldsKeyedBy },
    ),
  }),
});

describe('keyed arrays (x-scratch-array-keyed-by) — DEV-11062', () => {
  it('segments a filter segment as its own token amid a nested path', () => {
    expect(segmentFieldPathAgainstSchema(affinityLikeSourceSchema, 'entity.fields.[id=field-text].value.data')).toEqual(
      ['entity', 'fields', '[id=field-text]', 'value', 'data'],
    );
  });

  it('resolves the typed leaf of a keyed-array element (the save error that blocked every Affinity export)', () => {
    // `getSchemaAtFieldPath` must descend into the array element for `[id=…]` instead
    // of looking for a property literally named `[id=field-text]` and rejecting it.
    const textData = getSchemaAtFieldPath(affinityLikeSourceSchema, 'entity.fields.[id=field-text].value.data');
    expect(textData).toBeDefined();
    const numberData = getSchemaAtFieldPath(affinityLikeSourceSchema, 'entity.fields.[id=field-number].value.data');
    expect(numberData).toBeDefined();
    // The `value` union mixes every field's `{ type, data }` shape, so `.data`
    // resolves to a union of all branches' data types (the number one included).
    const dataAsJson = JSON.stringify(numberData);
    expect(dataAsJson).toContain('"number"');
    expect(dataAsJson).toContain('"string"');
  });

  it('resolves a subfield of an OPEN object value (Affinity location: `…value.data.streetAddress`)', () => {
    const streetAddress = getSchemaAtFieldPath(
      affinityLikeSourceSchema,
      'entity.fields.[id=field-location].value.data.streetAddress',
    );
    // The exact path from the DEV-11062 error list — must resolve (present), not
    // be rejected as "not found in schema".
    expect(streetAddress).toBeDefined();
  });

  it('returns undefined for a filter segment against a non-keyed array', () => {
    const plainArraySchema = Type.Object({ tags: Type.Array(Type.Object({ id: Type.String() })) });
    expect(getSchemaAtFieldPath(plainArraySchema, 'tags.[id=x].id')).toBeUndefined();
  });

  it('reads the value of a keyed-array element by its key field', () => {
    const record = {
      id: 1,
      entity: {
        name: 'Acme',
        fields: [
          { id: 'field-text', value: { type: 'text', data: 'hello' } },
          { id: 'field-number', value: { type: 'number', data: 42 } },
        ],
      },
    };
    expect(readFieldValueAtPath(record, 'entity.fields.[id=field-text].value.data')).toBe('hello');
    expect(readFieldValueAtPath(record, 'entity.fields.[id=field-number].value.data')).toBe(42);
  });

  it('returns undefined when the keyed element is absent', () => {
    const record = { entity: { fields: [{ id: 'field-text', value: { type: 'text', data: 'hi' } }] } };
    expect(readFieldValueAtPath(record, 'entity.fields.[id=missing].value.data')).toBeUndefined();
  });

  it('writes into an existing keyed-array element without disturbing its siblings', () => {
    const target: Record<string, unknown> = {
      custom_fields: [
        { custom_field_definition_id: 700123, value: 'old' },
        { custom_field_definition_id: 700124, value: 'keep' },
      ],
    };
    setFieldValueAtPath(target, 'custom_fields.[custom_field_definition_id=700123].value', 'new');
    expect(target).toEqual({
      custom_fields: [
        { custom_field_definition_id: 700123, value: 'new' },
        { custom_field_definition_id: 700124, value: 'keep' },
      ],
    });
  });

  it('creates a missing keyed-array element (seeded with its coerced key field) on write', () => {
    const target: Record<string, unknown> = { custom_fields: [] };
    setFieldValueAtPath(target, 'custom_fields.[custom_field_definition_id=700123].value', 'v');
    expect(target).toEqual({ custom_fields: [{ custom_field_definition_id: 700123, value: 'v' }] });
  });

  it('materializes the array container when the keyed path is written into a fresh record', () => {
    const target: Record<string, unknown> = {};
    setFieldValueAtPath(target, 'customFields.[shortKey=contact_source].field_value', 'web');
    expect(target).toEqual({ customFields: [{ shortKey: 'contact_source', field_value: 'web' }] });
  });
});

describe('setFieldValueAtPath', () => {
  it('writes a dotted destination property as a flat key when given the schema (new record)', () => {
    const target: Record<string, unknown> = {};
    setFieldValueAtPath(target, 'properties.col.with.dots.rich_text', ['v'], notionDestSchema);
    expect(target).toEqual({ properties: { 'col.with.dots': { rich_text: ['v'] } } });
  });

  it('without a schema, segments against the target object keys', () => {
    const target: Record<string, unknown> = { 'col.with.dots': 'old' };
    setFieldValueAtPath(target, 'col.with.dots', 'new');
    expect(target).toEqual({ 'col.with.dots': 'new' });
  });

  it('writes clean nested paths identically to lodash set', () => {
    const target: Record<string, unknown> = {};
    setFieldValueAtPath(target, 'a.b.c', 1);
    expect(target).toEqual({ a: { b: { c: 1 } } });
  });
});
