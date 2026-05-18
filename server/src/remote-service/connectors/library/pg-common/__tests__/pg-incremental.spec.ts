import { TSchema } from '@sinclair/typebox';
import { PullRecordFilesOptions } from '../../../types';
import { KnexPGClientError } from '../knex-pg-client';
import {
  applyPgClockSkew,
  assertModifiedAtColumnExists,
  PG_INCREMENTAL_CLOCK_SKEW_MS,
  resolvePgModifiedAtField,
} from '../pg-incremental';

describe('resolvePgModifiedAtField', () => {
  it('returns undefined when modifiedAtField is unset', () => {
    expect(resolvePgModifiedAtField({} as PullRecordFilesOptions)).toBeUndefined();
  });

  it('returns undefined when modifiedAtField is blank', () => {
    expect(resolvePgModifiedAtField({ modifiedAtField: '   ' } as PullRecordFilesOptions)).toBeUndefined();
  });

  it('returns the trimmed column name when set', () => {
    expect(resolvePgModifiedAtField({ modifiedAtField: '  updated_at  ' } as PullRecordFilesOptions)).toBe(
      'updated_at',
    );
  });
});

describe('applyPgClockSkew', () => {
  it('subtracts the clock-skew margin from the watermark', () => {
    const since = new Date('2026-05-14T12:00:00.000Z');
    const result = applyPgClockSkew(since);
    expect(result.getTime()).toBe(since.getTime() - PG_INCREMENTAL_CLOCK_SKEW_MS);
    expect(PG_INCREMENTAL_CLOCK_SKEW_MS).toBe(60_000);
  });
});

describe('assertModifiedAtColumnExists', () => {
  const schema = {
    properties: {
      id: { type: 'number' },
      name: { type: 'string' },
      updated_at: { type: 'string' },
    },
  } as unknown as TSchema;

  it('does not throw when the column exists in the schema', () => {
    expect(() => assertModifiedAtColumnExists(schema, 'records', 'updated_at')).not.toThrow();
  });

  it('throws a KnexPGClientError listing valid columns when the column is missing', () => {
    expect(() => assertModifiedAtColumnExists(schema, 'records', 'modified_on')).toThrow(KnexPGClientError);
    try {
      assertModifiedAtColumnExists(schema, 'records', 'modified_on');
      fail('expected to throw');
    } catch (error) {
      const err = error as KnexPGClientError;
      expect(err.code).toBe('INVALID_MODIFIED_AT_FIELD');
      expect(err.message).toContain('"modified_on"');
      expect(err.message).toContain('records');
      expect(err.message).toContain('id, name, updated_at');
    }
  });

  it('throws when the schema has no properties at all', () => {
    expect(() => assertModifiedAtColumnExists({} as unknown as TSchema, 'records', 'updated_at')).toThrow(
      KnexPGClientError,
    );
  });
});
