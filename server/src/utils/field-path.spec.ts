import { Type } from '@sinclair/typebox';
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
