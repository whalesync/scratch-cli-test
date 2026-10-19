import knex, { type Knex } from 'knex';
import { decodeColumnIdentifierForKnex } from '../../pg-common/knex-column-identifier-dot-encoding';
import { MySqlClientError, MySqlClientProblem } from '../mysql-client-error';
import { applyMySqlVerbatimIdentifierQuoting } from '../mysql-identifier-quoting';
import { ScratchMySql2KnexDialectClient } from '../mysql-knex-dialect-client';
import {
  buildSelectTableRowsByIdsQuery,
  buildSelectTableRowsPageQuery,
  type MySqlTableRowsPageRequest,
  selectTableRowsByIds,
  selectTableRowsPage,
} from '../mysql-record-reads';

// Connection-less knex with the production identifier hooks: compiles SQL, never loads a connection.
const compileOnlyMySqlKnex: Knex = knex({ client: ScratchMySql2KnexDialectClient });
applyMySqlVerbatimIdentifierQuoting(compileOnlyMySqlKnex);

// What a transaction client looks like: knex's `makeTxClient` copies `config` (so `wrapIdentifier` survives) but
// not our `client.alias` override. Every identifier must still compile verbatim.
const compileOnlyMySqlKnexWithoutAliasOverride: Knex = knex({
  client: ScratchMySql2KnexDialectClient,
  wrapIdentifier: (value, originalWrapIdentifier) => originalWrapIdentifier(decodeColumnIdentifierForKnex(value)),
});

afterAll(async () => {
  await compileOnlyMySqlKnex.destroy();
  await compileOnlyMySqlKnexWithoutAliasOverride.destroy();
});

const dealsTable = { databaseName: 'db', tableName: 't' };

function basePageRequest(overrides: Partial<MySqlTableRowsPageRequest> = {}): MySqlTableRowsPageRequest {
  return {
    table: dealsTable,
    selectedColumnNames: ['a.b', 'id', 'updated_at'],
    idColumnName: 'id',
    pageSize: 500,
    pageOffset: 0,
    ...overrides,
  };
}

/**
 * A knex stand-in whose query builders are the real (compile-only) ones, except that awaiting them records the
 * compiled SQL and resolves to canned rows instead of touching a connection.
 */
function createKnexResolvingRows(cannedRows: Record<string, unknown>[]): {
  executingKnex: Knex;
  tableReferenceCalls: jest.Mock;
  executedQueries: Knex.Sql[];
} {
  const executedQueries: Knex.Sql[] = [];
  const tableReferenceCalls = jest.fn((tableReference: string) => {
    const queryBuilder = compileOnlyMySqlKnex(tableReference);
    Object.defineProperty(queryBuilder, 'then', {
      value: (onFulfilled: (rows: Record<string, unknown>[]) => unknown) => {
        executedQueries.push(queryBuilder.toSQL());
        return Promise.resolve(cannedRows).then(onFulfilled);
      },
    });
    return queryBuilder;
  });
  const executingKnex = Object.assign(tableReferenceCalls, {
    ref: (reference: string) => compileOnlyMySqlKnex.ref(reference),
  }) as unknown as Knex;
  return { executingKnex, tableReferenceCalls, executedQueries };
}

describe('buildSelectTableRowsPageQuery', () => {
  it('parenthesizes the filter, ANDs the incremental bound, and binds only the bound, limit and offset', () => {
    const compiledPageQuery = buildSelectTableRowsPageQuery(
      compileOnlyMySqlKnex,
      basePageRequest({
        pageOffset: 1000,
        whereFilter: 'a = 1 OR b = 2',
        modifiedSince: { columnName: 'updated_at', exclusiveLowerBoundUtcLiteral: '2026-01-02 03:04:05.678000' },
      }),
    ).toSQL();
    expect(compiledPageQuery.sql).toBe(
      'select `a.b`, `id`, `updated_at` from `db`.`t` where (a = 1 OR b = 2) and `updated_at` > ? order by `id` asc limit ? offset ?',
    );
    expect(compiledPageQuery.bindings).toEqual(['2026-01-02 03:04:05.678000', 500, 1000]);
  });

  it('omits the where clause and a zero offset for a plain full pull', () => {
    const compiledPageQuery = buildSelectTableRowsPageQuery(compileOnlyMySqlKnex, basePageRequest()).toSQL();
    expect(compiledPageQuery.sql).toBe('select `a.b`, `id`, `updated_at` from `db`.`t` order by `id` asc limit ?');
    expect(compiledPageQuery.bindings).toEqual([500]);
  });

  it('treats a blank filter as no filter', () => {
    const compiledPageQuery = buildSelectTableRowsPageQuery(
      compileOnlyMySqlKnex,
      basePageRequest({ whereFilter: '   ' }),
    ).toSQL();
    expect(compiledPageQuery.sql).not.toContain('where');
  });

  it('trims the filter before wrapping it', () => {
    const compiledPageQuery = buildSelectTableRowsPageQuery(
      compileOnlyMySqlKnex,
      basePageRequest({ whereFilter: "  stage = 'won'\n" }),
    ).toSQL();
    expect(compiledPageQuery.sql).toContain("where (stage = 'won') order by");
  });

  it('re-validates the filter before it reaches whereRaw', () => {
    expect(() =>
      buildSelectTableRowsPageQuery(compileOnlyMySqlKnex, basePageRequest({ whereFilter: '1=1) OR (1=1' })),
    ).toThrow(MySqlClientError);
    try {
      buildSelectTableRowsPageQuery(compileOnlyMySqlKnex, basePageRequest({ whereFilter: 'SLEEP(10) = 0' }));
      throw new Error('expected an invalid filter');
    } catch (error) {
      expect(error).toBeInstanceOf(MySqlClientError);
      expect((error as MySqlClientError).problem).toBe(MySqlClientProblem.InvalidFilter);
    }
  });

  it('keeps every unusual identifier verbatim and backtick-quoted', () => {
    const compiledPageQuery = buildSelectTableRowsPageQuery(compileOnlyMySqlKnex, {
      table: { databaseName: 'my.db', tableName: 'Deals as of 2026' },
      selectedColumnNames: ['a.b', 'Certified AS Organic', 'Featured?', 'pk`tick'],
      idColumnName: 'pk`tick',
      pageSize: 50,
      pageOffset: 100,
      modifiedSince: { columnName: 'updated.at', exclusiveLowerBoundUtcLiteral: '2026-01-02 03:04:05.678000' },
    }).toSQL();
    expect(compiledPageQuery.sql).toBe(
      'select `a.b`, `Certified AS Organic`, `Featured?`, `pk``tick` from `my.db`.`Deals as of 2026` where `updated.at` > ? order by `pk``tick` asc limit ? offset ?',
    );
    // A `?` inside backticks is part of the name, not a placeholder: the bindings are exactly bound, limit, offset.
    expect(compiledPageQuery.bindings).toEqual(['2026-01-02 03:04:05.678000', 50, 100]);
    expect(compiledPageQuery.sql).not.toContain('"');
    expect(compiledPageQuery.sql).not.toContain('\\?');
  });

  it('compiles the same SQL on a transaction-like client without the alias override', () => {
    const pageRequest: MySqlTableRowsPageRequest = {
      table: { databaseName: 'my.db', tableName: 'Deals as of 2026' },
      selectedColumnNames: ['Certified AS Organic', 'id'],
      idColumnName: 'id',
      pageSize: 50,
      pageOffset: 0,
    };
    expect(buildSelectTableRowsPageQuery(compileOnlyMySqlKnexWithoutAliasOverride, pageRequest).toSQL().sql).toBe(
      buildSelectTableRowsPageQuery(compileOnlyMySqlKnex, pageRequest).toSQL().sql,
    );
  });

  it('adds the id column when the caller left it out of the column list', () => {
    const compiledPageQuery = buildSelectTableRowsPageQuery(
      compileOnlyMySqlKnex,
      basePageRequest({ selectedColumnNames: ['title'] }),
    ).toSQL();
    expect(compiledPageQuery.sql).toBe('select `title`, `id` from `db`.`t` order by `id` asc limit ?');
  });

  it('refuses an empty column list instead of letting knex select *', () => {
    expect(() =>
      buildSelectTableRowsPageQuery(compileOnlyMySqlKnex, basePageRequest({ selectedColumnNames: [] })),
    ).toThrow('non-empty column list');
  });

  it.each<[string, Partial<MySqlTableRowsPageRequest>]>([
    ['a zero page size', { pageSize: 0 }],
    ['a negative page size', { pageSize: -1 }],
    ['a fractional page size', { pageSize: 1.5 }],
    ['a negative offset', { pageOffset: -1 }],
    ['a NaN offset', { pageOffset: Number.NaN }],
  ])('refuses %s', (_description, pageWindowOverride) => {
    expect(() => buildSelectTableRowsPageQuery(compileOnlyMySqlKnex, basePageRequest(pageWindowOverride))).toThrow(
      /MySQL read page/,
    );
  });
});

describe('buildSelectTableRowsByIdsQuery', () => {
  it('binds BigInt and Buffer ids as-is in an IN list', () => {
    const binaryIdBytes = Buffer.from([0x01, 0x02, 0xff]);
    const compiledByIdsQuery = buildSelectTableRowsByIdsQuery(compileOnlyMySqlKnex, {
      table: dealsTable,
      selectedColumnNames: ['a.b'],
      idColumnName: 'id',
      idBindingValues: [9007199254740993n, binaryIdBytes],
    }).toSQL();
    expect(compiledByIdsQuery.sql).toBe('select `a.b`, `id` from `db`.`t` where `id` in (?, ?)');
    expect(compiledByIdsQuery.bindings).toEqual([9007199254740993n, binaryIdBytes]);
    expect(typeof compiledByIdsQuery.bindings[0]).toBe('bigint');
    expect(Buffer.isBuffer(compiledByIdsQuery.bindings[1])).toBe(true);
  });

  it('quotes an unusual id column verbatim', () => {
    const compiledByIdsQuery = buildSelectTableRowsByIdsQuery(compileOnlyMySqlKnex, {
      table: { databaseName: 'my.db', tableName: 't' },
      selectedColumnNames: ['Row ID.v2', 'name'],
      idColumnName: 'Row ID.v2',
      idBindingValues: ['abc'],
    }).toSQL();
    expect(compiledByIdsQuery.sql).toBe('select `Row ID.v2`, `name` from `my.db`.`t` where `Row ID.v2` in (?)');
  });
});

describe('selectTableRowsPage', () => {
  it('runs the compiled page query and returns the rows unchanged', async () => {
    const cannedRows = [
      { id: '1', 'a.b': 1 },
      { id: '2', 'a.b': 2 },
    ];
    const { executingKnex, executedQueries } = createKnexResolvingRows(cannedRows);
    const returnedRows = await selectTableRowsPage(executingKnex, basePageRequest({ whereFilter: 'a = 1 OR b = 2' }));
    expect(returnedRows).toBe(cannedRows);
    expect(executedQueries).toHaveLength(1);
    expect(executedQueries[0].sql).toBe(
      'select `a.b`, `id`, `updated_at` from `db`.`t` where (a = 1 OR b = 2) order by `id` asc limit ?',
    );
  });

  it('rejects an invalid filter before running anything', async () => {
    const { executingKnex, executedQueries } = createKnexResolvingRows([]);
    await expect(
      selectTableRowsPage(executingKnex, basePageRequest({ whereFilter: "a = 'x ; DROP TABLE t'" })),
    ).resolves.toBeDefined();
    // `;` inside a literal is fine; outside it isn't:
    await expect(
      selectTableRowsPage(executingKnex, basePageRequest({ whereFilter: 'a = 1; DROP TABLE t' })),
    ).rejects.toThrow(MySqlClientError);
    expect(executedQueries).toHaveLength(1);
  });
});

describe('selectTableRowsByIds', () => {
  it('runs the compiled IN query and returns the rows unchanged', async () => {
    const cannedRows = [{ id: '9007199254740993' }];
    const { executingKnex, executedQueries } = createKnexResolvingRows(cannedRows);
    const returnedRows = await selectTableRowsByIds(executingKnex, {
      table: dealsTable,
      selectedColumnNames: ['id'],
      idColumnName: 'id',
      idBindingValues: [9007199254740993n],
    });
    expect(returnedRows).toBe(cannedRows);
    expect(executedQueries[0].sql).toBe('select `id` from `db`.`t` where `id` in (?)');
    expect(executedQueries[0].bindings).toEqual([9007199254740993n]);
  });

  it('does not query at all for an empty id list', async () => {
    const { executingKnex, tableReferenceCalls } = createKnexResolvingRows([{ id: 'unexpected' }]);
    await expect(
      selectTableRowsByIds(executingKnex, {
        table: dealsTable,
        selectedColumnNames: ['id'],
        idColumnName: 'id',
        idBindingValues: [],
      }),
    ).resolves.toEqual([]);
    expect(tableReferenceCalls).not.toHaveBeenCalled();
  });
});
