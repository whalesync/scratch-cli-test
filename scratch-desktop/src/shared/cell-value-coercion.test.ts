import { describe, expect, it } from 'vitest';

import {
  coerceCellInputText,
  coerceCellInputTextAgainstExistingValueOrSchema,
  resolveSchemaLeafHint,
  type SchemaLeafHint,
} from './cell-value-coercion';

const stringHint: SchemaLeafHint = { scalarType: 'string', nullable: false };
const numberHint: SchemaLeafHint = { scalarType: 'number', nullable: false };
const nullableNumberHint: SchemaLeafHint = { scalarType: 'number', nullable: true };
const booleanHint: SchemaLeafHint = { scalarType: 'boolean', nullable: false };
const nullableStringHint: SchemaLeafHint = { scalarType: 'string', nullable: true };

describe('coerceCellInputText', () => {
  it('preserves the old JSON.parse-or-string behavior', () => {
    expect(coerceCellInputText('"hello"')).toBe('hello');
    expect(coerceCellInputText(' 123 ')).toBe(123);
    expect(coerceCellInputText('{"city":"Sofia"}')).toEqual({ city: 'Sofia' });
    expect(coerceCellInputText("'hello'")).toBe("'hello'");
  });
});

describe('coerceCellInputTextAgainstExistingValueOrSchema', () => {
  describe('existing value present — its own JSON type wins, schema ignored', () => {
    it('keeps a string leaf verbatim even when the schema disagrees', () => {
      // A numeric-looking string (SKU, phone) stays a string; a wrong number
      // schema cannot retype it.
      expect(coerceCellInputTextAgainstExistingValueOrSchema('25000', numberHint, '30000')).toBe('30000');
      expect(coerceCellInputTextAgainstExistingValueOrSchema('old', null, 'true')).toBe('true');
      expect(coerceCellInputTextAgainstExistingValueOrSchema('old', null, '{"a":1}')).toBe('{"a":1}');
    });

    it('JSON-parses a non-string leaf (scalars and raw-JSON envelopes)', () => {
      expect(coerceCellInputTextAgainstExistingValueOrSchema(25000, stringHint, '30000')).toBe(30000);
      expect(coerceCellInputTextAgainstExistingValueOrSchema(true, null, 'false')).toBe(false);
      // Editing the raw JSON of a Notion envelope round-trips the whole object.
      expect(
        coerceCellInputTextAgainstExistingValueOrSchema(
          { id: 'AF<M', type: 'number', number: 25000 },
          null,
          '{"id":"AF<M","type":"number","number":30000}',
        ),
      ).toEqual({ id: 'AF<M', type: 'number', number: 30000 });
      // An ARRAY leaf JSON-parses too — this is the path the desktop grid relies on
      // for an editable codec FK column (DEV-10847): the pack seam serializes the
      // packed `[{ id }]` to JSON, and the coercion parses it straight back onto the
      // existing `associations.<type>.results` array leaf.
      expect(
        coerceCellInputTextAgainstExistingValueOrSchema(
          [{ id: 'C1', type: 'contact_to_company' }],
          null,
          '[{"id":"C2"}]',
        ),
      ).toEqual([{ id: 'C2' }]);
    });
  });

  describe('empty leaf — schema scalar type hint decides', () => {
    it('uses the scalar type for a null/absent leaf', () => {
      expect(coerceCellInputTextAgainstExistingValueOrSchema(null, numberHint, '30000')).toBe(30000);
      expect(coerceCellInputTextAgainstExistingValueOrSchema(null, stringHint, '30000')).toBe('30000');
      expect(coerceCellInputTextAgainstExistingValueOrSchema(undefined, numberHint, '30000')).toBe(30000);
      expect(coerceCellInputTextAgainstExistingValueOrSchema(undefined, stringHint, '30000')).toBe('30000');
      expect(coerceCellInputTextAgainstExistingValueOrSchema(null, booleanHint, 'true')).toBe(true);
    });

    it('falls back to a verbatim string when the text does not fit the hint (never throws)', () => {
      expect(coerceCellInputTextAgainstExistingValueOrSchema(null, numberHint, 'abc')).toBe('abc');
      expect(coerceCellInputTextAgainstExistingValueOrSchema(null, booleanHint, 'yes')).toBe('yes');
    });

    it('treats an integer hint like a number (no integer enforcement on write)', () => {
      const integerHint: SchemaLeafHint = { scalarType: 'integer', nullable: false };
      expect(coerceCellInputTextAgainstExistingValueOrSchema(null, integerHint, '1.5')).toBe(1.5);
    });

    it('JSON-parses-with-string fallback when there is no schema hint', () => {
      expect(coerceCellInputTextAgainstExistingValueOrSchema(null, null, '30000')).toBe(30000);
      expect(coerceCellInputTextAgainstExistingValueOrSchema(null, null, 'hello')).toBe('hello');
    });
  });

  describe('clearing (empty input)', () => {
    it('writes null for a nullable leaf and an empty string for a non-nullable one', () => {
      expect(coerceCellInputTextAgainstExistingValueOrSchema(25000, nullableNumberHint, '')).toBeNull();
      expect(coerceCellInputTextAgainstExistingValueOrSchema(25000, numberHint, '')).toBe('');
      expect(coerceCellInputTextAgainstExistingValueOrSchema('text', nullableStringHint, '   ')).toBeNull();
      expect(coerceCellInputTextAgainstExistingValueOrSchema('text', stringHint, '')).toBe('');
    });

    it('mirrors the leaf type when no schema is available', () => {
      expect(coerceCellInputTextAgainstExistingValueOrSchema('text', null, '')).toBe('');
      expect(coerceCellInputTextAgainstExistingValueOrSchema(25000, null, '')).toBeNull();
      expect(coerceCellInputTextAgainstExistingValueOrSchema(null, null, '')).toBeNull();
    });
  });
});

describe('resolveSchemaLeafHint', () => {
  const folderSchema = {
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        count: { type: 'number' },
        wholeCount: { type: 'integer' },
        enabled: { type: 'boolean' },
        maybeTitle: { type: ['string', 'null'] },
        maybeCount: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        metadata: { type: 'object', properties: { city: { type: 'string' } } },
        // A Notion-style envelope: the schema describes the wrapper, the inner
        // leaf carries the real scalar type.
        properties: {
          type: 'object',
          properties: {
            'Typical Check Size': {
              type: 'object',
              properties: {
                id: { type: 'string' },
                type: { type: 'string' },
                number: { type: ['number', 'null'] },
              },
            },
          },
        },
      },
    },
  } satisfies Record<string, unknown>;

  it('resolves scalar type and nullability for scalar leaves', () => {
    expect(resolveSchemaLeafHint(folderSchema, 'title')).toEqual({ scalarType: 'string', nullable: false });
    expect(resolveSchemaLeafHint(folderSchema, 'count')).toEqual({ scalarType: 'number', nullable: false });
    expect(resolveSchemaLeafHint(folderSchema, 'wholeCount')).toEqual({ scalarType: 'integer', nullable: false });
    expect(resolveSchemaLeafHint(folderSchema, 'enabled')).toEqual({ scalarType: 'boolean', nullable: false });
  });

  it('detects nullability from type arrays and anyOf unions', () => {
    expect(resolveSchemaLeafHint(folderSchema, 'maybeTitle')).toEqual({ scalarType: 'string', nullable: true });
    expect(resolveSchemaLeafHint(folderSchema, 'maybeCount')).toEqual({ scalarType: 'number', nullable: true });
  });

  it('resolves the inner leaf of an enveloped (nested) property', () => {
    expect(resolveSchemaLeafHint(folderSchema, 'properties.Typical Check Size.number')).toEqual({
      scalarType: 'number',
      nullable: true,
    });
  });

  it('returns null when the schema is missing, the path is unknown, or the leaf has no scalar', () => {
    expect(resolveSchemaLeafHint(null, 'title')).toBeNull();
    expect(resolveSchemaLeafHint(folderSchema, 'doesNotExist')).toBeNull();
    expect(resolveSchemaLeafHint(folderSchema, 'metadata')).toBeNull();
  });
});
