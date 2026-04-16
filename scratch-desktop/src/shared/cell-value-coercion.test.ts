import { describe, expect, it } from 'vitest';

import { CellInputCoercionError, coerceCellInputText, coerceCellInputTextWithSchema } from './cell-value-coercion';

const folderSchema = {
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      count: { type: 'number' },
      wholeCount: { type: 'integer' },
      enabled: { type: 'boolean' },
      emptyValue: { type: 'null' },
      metadata: {
        type: 'object',
        properties: {
          city: { type: 'string' },
        },
      },
      profile: {
        type: 'object',
        properties: {
          company: {
            type: 'object',
            properties: {
              address: {
                type: 'object',
                properties: {
                  city: { type: 'string' },
                },
              },
            },
          },
        },
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
      },
      maybeTitle: {
        type: ['string', 'null'],
      },
      maybeEnabled: {
        anyOf: [{ type: 'boolean' }, { type: 'null' }],
      },
      unresolved: {},
    },
  },
} satisfies Record<string, unknown>;

describe('coerceCellInputText', () => {
  it('preserves the old JSON.parse-or-string behavior', () => {
    expect(coerceCellInputText('"hello"')).toBe('hello');
    expect(coerceCellInputText(' 123 ')).toBe(123);
    expect(coerceCellInputText('{"city":"Sofia"}')).toEqual({ city: 'Sofia' });
    expect(coerceCellInputText("'hello'")).toBe("'hello'");
  });
});

describe('coerceCellInputTextWithSchema', () => {
  it('preserves exact text for string fields', () => {
    expect(coerceCellInputTextWithSchema(folderSchema, 'title', '"hello"')).toBe('"hello"');
    expect(coerceCellInputTextWithSchema(folderSchema, 'title', ' 123 ')).toBe(' 123 ');
    expect(coerceCellInputTextWithSchema(folderSchema, 'metadata.city', 'Sofia')).toBe('Sofia');
    expect(coerceCellInputTextWithSchema(folderSchema, 'profile.company.address.city', 'Plovdiv')).toBe('Plovdiv');
  });

  it('parses numbers and integers by schema', () => {
    expect(coerceCellInputTextWithSchema(folderSchema, 'count', '123')).toBe(123);
    expect(coerceCellInputTextWithSchema(folderSchema, 'count', '1.5')).toBe(1.5);
    expect(coerceCellInputTextWithSchema(folderSchema, 'wholeCount', '123')).toBe(123);
    expect(() => coerceCellInputTextWithSchema(folderSchema, 'wholeCount', '1.5')).toThrow(
      new CellInputCoercionError('Field "wholeCount" expects an integer.'),
    );
  });

  it('parses booleans and nullables by schema', () => {
    expect(coerceCellInputTextWithSchema(folderSchema, 'enabled', 'true')).toBe(true);
    expect(coerceCellInputTextWithSchema(folderSchema, 'enabled', 'false')).toBe(false);
    expect(coerceCellInputTextWithSchema(folderSchema, 'emptyValue', 'null')).toBeNull();
    expect(coerceCellInputTextWithSchema(folderSchema, 'maybeTitle', 'null')).toBeNull();
    expect(coerceCellInputTextWithSchema(folderSchema, 'maybeTitle', 'hello')).toBe('hello');
    expect(coerceCellInputTextWithSchema(folderSchema, 'maybeEnabled', 'null')).toBeNull();
    expect(coerceCellInputTextWithSchema(folderSchema, 'maybeEnabled', 'true')).toBe(true);
  });

  it('parses objects and arrays by schema', () => {
    expect(coerceCellInputTextWithSchema(folderSchema, 'metadata', '{"city":"Sofia"}')).toEqual({ city: 'Sofia' });
    expect(coerceCellInputTextWithSchema(folderSchema, 'tags', '["a","b"]')).toEqual(['a', 'b']);
    expect(() => coerceCellInputTextWithSchema(folderSchema, 'metadata', '["not","an","object"]')).toThrow(
      new CellInputCoercionError('Field "metadata" expects a JSON object.'),
    );
    expect(() => coerceCellInputTextWithSchema(folderSchema, 'tags', '{"not":"an array"}')).toThrow(
      new CellInputCoercionError('Field "tags" expects a JSON array.'),
    );
  });

  it('rejects invalid scalar input', () => {
    expect(() => coerceCellInputTextWithSchema(folderSchema, 'count', 'abc')).toThrow(
      new CellInputCoercionError('Field "count" expects a number.'),
    );
    expect(() => coerceCellInputTextWithSchema(folderSchema, 'enabled', 'yes')).toThrow(
      new CellInputCoercionError('Field "enabled" expects "true" or "false".'),
    );
    expect(() => coerceCellInputTextWithSchema(folderSchema, 'emptyValue', '')).toThrow(
      new CellInputCoercionError('Field "emptyValue" expects null.'),
    );
  });

  it('falls back to exact text when the field schema is missing or unknown', () => {
    expect(coerceCellInputTextWithSchema(folderSchema, 'doesNotExist', '{"city":"Sofia"}')).toBe('{"city":"Sofia"}');
    expect(coerceCellInputTextWithSchema(folderSchema, 'unresolved', '123')).toBe('123');
  });
});
