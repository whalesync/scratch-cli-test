import { type TSchema } from '@sinclair/typebox';
import { JSON_SCHEMA_LOCAL_DATE_TIME_FORMAT, X_SCRATCH_NATIVE_COLUMN_TYPE } from '@spinner/shared-types';
import { type BaseJsonTableSpec, dotPath } from '../../../types';
import { PG_INCREMENTAL_CLOCK_SKEW_MS } from '../../pg-common/pg-incremental';
import { MySqlClientError, MySqlClientProblem } from '../mysql-client-error';
import {
  assertMySqlModifiedAtColumnIsUsable,
  buildMySqlModifiedSinceLowerBoundWithClockSkew,
  listSelectableColumnNames,
  MYSQL_DEFAULT_READ_PAGE_SIZE,
  MYSQL_LARGE_BINARY_OBJECT_READ_PAGE_SIZE,
  readPageSizeForTableSpec,
} from '../mysql-incremental';

function mysqlColumnSchema(nativeColumnType: string, valueSchema: Record<string, unknown>): Record<string, unknown> {
  return {
    ...valueSchema,
    [X_SCRATCH_NATIVE_COLUMN_TYPE]: { typeSystem: 'mysql', type: nativeColumnType, isRecreatableVerbatim: true },
  };
}

function nullable(valueSchema: Record<string, unknown>): Record<string, unknown> {
  return { anyOf: [valueSchema, { type: 'null' }] };
}

function buildTableSpec(properties: Record<string, unknown>): BaseJsonTableSpec {
  return {
    id: { wsId: 'test_db__deals', remoteId: ['test_db', 'deals'] },
    slug: 'deals',
    name: 'deals',
    schema: { type: 'object', properties } as unknown as TSchema,
    idPath: dotPath('id'),
  };
}

const dealsTableSpec = buildTableSpec({
  id: mysqlColumnSchema('bigint unsigned', { anyOf: [{ type: 'string' }, { type: 'number' }] }),
  title: mysqlColumnSchema('varchar(255)', { type: 'string' }),
  close_date: mysqlColumnSchema('date', { type: 'string', format: 'date' }),
  updated_at: mysqlColumnSchema('timestamp(6)', { type: 'string', format: 'date-time' }),
  synced_at: mysqlColumnSchema('datetime', nullable({ type: 'string', format: JSON_SCHEMA_LOCAL_DATE_TIME_FORMAT })),
});

function captureModifiedAtRejection(tableSpec: BaseJsonTableSpec, columnName: string): MySqlClientError {
  try {
    assertMySqlModifiedAtColumnIsUsable(tableSpec, columnName);
  } catch (error) {
    if (error instanceof MySqlClientError) return error;
    throw error;
  }
  throw new Error(`Expected "${columnName}" to be rejected`);
}

describe('listSelectableColumnNames', () => {
  it('lists the top-level schema properties in schema order', () => {
    expect(listSelectableColumnNames(dealsTableSpec)).toEqual(['id', 'title', 'close_date', 'updated_at', 'synced_at']);
  });

  it('keeps unusual column names verbatim', () => {
    const tableSpec = buildTableSpec({ id: {}, 'a.b': {}, 'Featured?': {}, 'pk`tick': {}, 'Marked as done': {} });
    expect(listSelectableColumnNames(tableSpec)).toEqual(['id', 'a.b', 'Featured?', 'pk`tick', 'Marked as done']);
  });

  it('returns an empty list for a schema without properties', () => {
    expect(listSelectableColumnNames(buildTableSpec(undefined as unknown as Record<string, unknown>))).toEqual([]);
  });
});

describe('readPageSizeForTableSpec', () => {
  it('uses the default page size for ordinary tables', () => {
    expect(readPageSizeForTableSpec(dealsTableSpec)).toBe(MYSQL_DEFAULT_READ_PAGE_SIZE);
    expect(MYSQL_DEFAULT_READ_PAGE_SIZE).toBe(500);
  });

  it.each(['mediumblob', 'longblob', 'LONGBLOB'])('uses the small page size when a %s column is present', (type) => {
    const tableSpec = buildTableSpec({
      id: mysqlColumnSchema('int', { type: 'number' }),
      payload: mysqlColumnSchema(type, {}),
    });
    expect(readPageSizeForTableSpec(tableSpec)).toBe(MYSQL_LARGE_BINARY_OBJECT_READ_PAGE_SIZE);
    expect(MYSQL_LARGE_BINARY_OBJECT_READ_PAGE_SIZE).toBe(50);
  });

  it('finds the native type on a nullable union variant too', () => {
    const tableSpec = buildTableSpec({
      id: mysqlColumnSchema('int', { type: 'number' }),
      payload: { anyOf: [mysqlColumnSchema('longblob', { type: 'string' }), { type: 'null' }] },
    });
    expect(readPageSizeForTableSpec(tableSpec)).toBe(MYSQL_LARGE_BINARY_OBJECT_READ_PAGE_SIZE);
  });

  it.each(['blob', 'tinyblob', 'longtext', 'varbinary(255)', 'json'])('keeps the default page size for %s', (type) => {
    const tableSpec = buildTableSpec({
      id: mysqlColumnSchema('int', { type: 'number' }),
      payload: mysqlColumnSchema(type, {}),
    });
    expect(readPageSizeForTableSpec(tableSpec)).toBe(MYSQL_DEFAULT_READ_PAGE_SIZE);
  });

  it('ignores native type annotations from another type system', () => {
    const tableSpec = buildTableSpec({
      payload: { [X_SCRATCH_NATIVE_COLUMN_TYPE]: { typeSystem: 'postgres', type: 'longblob' } },
    });
    expect(readPageSizeForTableSpec(tableSpec)).toBe(MYSQL_DEFAULT_READ_PAGE_SIZE);
  });
});

describe('assertMySqlModifiedAtColumnIsUsable', () => {
  it('accepts a TIMESTAMP column (date-time)', () => {
    expect(() => assertMySqlModifiedAtColumnIsUsable(dealsTableSpec, 'updated_at')).not.toThrow();
  });

  it('accepts a nullable DATETIME column (date-time-local inside anyOf)', () => {
    expect(() => assertMySqlModifiedAtColumnIsUsable(dealsTableSpec, 'synced_at')).not.toThrow();
  });

  it('rejects a DATE column, which would miss rows changed later on the same day', () => {
    const rejection = captureModifiedAtRejection(dealsTableSpec, 'close_date');
    expect(rejection.problem).toBe(MySqlClientProblem.InvalidModifiedAtField);
    expect(rejection.userFriendlyMessage).toContain('"close_date"');
    expect(rejection.userFriendlyMessage).toContain("isn't a TIMESTAMP or DATETIME column");
    expect(rejection.userFriendlyMessage).toContain('updated_at, synced_at.');
    expect(rejection.message).toBe(rejection.userFriendlyMessage);
  });

  it('rejects a text column', () => {
    expect(captureModifiedAtRejection(dealsTableSpec, 'title').problem).toBe(MySqlClientProblem.InvalidModifiedAtField);
  });

  it('rejects a typo and lists the usable columns', () => {
    const rejection = captureModifiedAtRejection(dealsTableSpec, 'updatedat');
    expect(rejection.problem).toBe(MySqlClientProblem.InvalidModifiedAtField);
    expect(rejection.userFriendlyMessage).toContain('"updatedat" isn\'t a column of the table "deals"');
    expect(rejection.userFriendlyMessage).toContain('updated_at, synced_at.');
    expect(rejection.userFriendlyMessage).not.toContain('title');
  });

  it('does not mistake an inherited object property for a column', () => {
    expect(captureModifiedAtRejection(dealsTableSpec, 'constructor').userFriendlyMessage).toContain(
      "isn't a column of the table",
    );
  });

  it('explains what to do when the table has no time-bearing column', () => {
    const tableSpec = buildTableSpec({ id: mysqlColumnSchema('int', { type: 'number' }) });
    expect(captureModifiedAtRejection(tableSpec, 'updated_at').userFriendlyMessage).toContain(
      'has no TIMESTAMP or DATETIME column',
    );
  });
});

describe('buildMySqlModifiedSinceLowerBoundWithClockSkew', () => {
  it('subtracts the shared clock skew and formats a UTC literal with microseconds', () => {
    expect(PG_INCREMENTAL_CLOCK_SKEW_MS).toBe(60_000);
    expect(buildMySqlModifiedSinceLowerBoundWithClockSkew('updated_at', new Date('2026-01-02T03:05:05.678Z'))).toEqual({
      columnName: 'updated_at',
      exclusiveLowerBoundUtcLiteral: '2026-01-02 03:04:05.678000',
    });
  });

  it('crosses midnight and the year boundary in UTC', () => {
    expect(
      buildMySqlModifiedSinceLowerBoundWithClockSkew('updated_at', new Date('2026-01-01T00:00:30.000Z'))
        .exclusiveLowerBoundUtcLiteral,
    ).toBe('2025-12-31 23:59:30.000000');
  });
});
