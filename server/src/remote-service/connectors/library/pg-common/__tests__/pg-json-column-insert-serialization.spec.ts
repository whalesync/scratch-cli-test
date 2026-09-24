import { Type } from '@sinclair/typebox';
import { PostgresColumnType, X_SCRATCH_CONNECTOR_DATA_TYPE } from '@spinner/shared-types';
import type { BaseJsonTableSpec } from '../../../types';
import { collectPgJsonColumnNames, serializeJsonColumnArraysForInsert } from '../pg-json-column-insert-serialization';

const tableSpec = {
  schema: Type.Object({
    name: Type.String({ [X_SCRATCH_CONNECTOR_DATA_TYPE]: PostgresColumnType.TEXT }),
    tags: Type.Array(Type.String(), { [X_SCRATCH_CONNECTOR_DATA_TYPE]: PostgresColumnType.TEXT_ARRAY }),
    payload: Type.Optional(Type.Unknown({ [X_SCRATCH_CONNECTOR_DATA_TYPE]: PostgresColumnType.JSONB })),
  }),
} as unknown as BaseJsonTableSpec;

describe('collectPgJsonColumnNames', () => {
  it('collects only json/jsonb columns', () => {
    expect([...collectPgJsonColumnNames(tableSpec)]).toEqual(['payload']);
  });
});

describe('serializeJsonColumnArraysForInsert', () => {
  const jsonColumnNames = new Set(['payload']);

  it('serializes an array (which the driver would bind as a pg array literal) to its JSON text', () => {
    expect(serializeJsonColumnArraysForInsert({ name: 'x', payload: ['a', { b: 2 }] }, jsonColumnNames)).toEqual({
      name: 'x',
      payload: '["a",{"b":2}]',
    });
  });

  it.each<[string, unknown]>([
    // Postgres parses a bound string as JSON text — an existing text → jsonb sync keeps storing the parsed value.
    ['a string holding JSON text', '{"a":1}'],
    ['an object (the driver JSON-stringifies it itself)', { k: 'v' }],
    ['a number', 5],
    ['null', null],
  ])('leaves %s untouched, returning the same object', (_label, value) => {
    const record = { name: 'x', payload: value };
    expect(serializeJsonColumnArraysForInsert(record, jsonColumnNames)).toBe(record);
  });

  it('leaves arrays in non-JSON columns (a text[] list) untouched', () => {
    const record = { tags: ['a'] };
    expect(serializeJsonColumnArraysForInsert(record, jsonColumnNames)).toBe(record);
  });

  it('does not mutate the caller-provided record', () => {
    const record = { payload: ['a'] };
    serializeJsonColumnArraysForInsert(record, jsonColumnNames);
    expect(record.payload).toEqual(['a']);
  });
});
