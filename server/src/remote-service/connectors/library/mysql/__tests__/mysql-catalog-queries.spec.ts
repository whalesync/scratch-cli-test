/**
 * Unit tests for the information_schema discovery queries, without a database.
 *
 * `knex.raw` is faked: every call is also compiled through a connection-less knex with the production MySQL dialect
 * and identifier hooks, which (a) fails the test when a query's placeholder count doesn't match its bindings and
 * (b) gives the exact SQL for `??` identifier bindings. The fake then resolves to the `[rows, fields]` pair the
 * mysql2 dialect returns.
 */
import knex, { type Knex } from 'knex';
import { WSLogger } from 'src/logger';
import { buildMySqlTableLookupKey } from '../mysql-catalog';
import {
  findAllColumnsInTable,
  findAllTables,
  findDatabaseNames,
  findMariaDbJsonAliasColumnNames,
  findPrimaryKeyColumnNames,
  findSingleColumnForeignKeysInTable,
  findSingleColumnUniqueIndexColumns,
  findTableRow,
  findTablesWithAutoIncrementPrimaryKey,
  findTablesWithSingleColumnUniqueIndex,
  MYSQL_LISTABLE_TABLE_TYPES,
} from '../mysql-catalog-queries';
import { MYSQL_SYSTEM_DATABASE_NAMES, type MySqlDiscoveryScope } from '../mysql-catalog-types';
import { MySqlClientError, MySqlClientProblem } from '../mysql-client-error';
import { applyMySqlVerbatimIdentifierQuoting, qualifiedMySqlTableReferenceForKnex } from '../mysql-identifier-quoting';
import { ScratchMySql2KnexDialectClient } from '../mysql-knex-dialect-client';

const connectionlessMySqlKnex = knex({ client: ScratchMySql2KnexDialectClient });
applyMySqlVerbatimIdentifierQuoting(connectionlessMySqlKnex);

interface CapturedCatalogQuery {
  sql: string;
  bindings: unknown[];
  compiledSql: string;
  compiledBindings: unknown[];
}

/** A knex stand-in whose `raw` resolves to the queued `[rows, fields]` results in call order. */
function createFakeCatalogKnex(queuedRawResults: unknown[]): {
  fakeKnex: Knex;
  capturedQueries: CapturedCatalogQuery[];
  rawMock: jest.Mock;
} {
  const capturedQueries: CapturedCatalogQuery[] = [];
  const rawMock = jest.fn((sql: string, bindings: readonly Knex.RawBinding[]) => {
    const compiledRawQuery = connectionlessMySqlKnex.raw(sql, [...bindings]).toSQL();
    capturedQueries.push({
      sql,
      bindings: [...bindings],
      compiledSql: compiledRawQuery.sql,
      compiledBindings: [...compiledRawQuery.bindings],
    });
    if (queuedRawResults.length === 0) throw new Error('No queued raw result for this query');
    const nextRawResult = queuedRawResults.shift();
    return nextRawResult instanceof Error ? Promise.reject(nextRawResult) : Promise.resolve(nextRawResult);
  });
  return { fakeKnex: { raw: rawMock } as unknown as Knex, capturedQueries, rawMock };
}

const SCOPED_DISCOVERY: MySqlDiscoveryScope = {
  excludedDatabaseNames: MYSQL_SYSTEM_DATABASE_NAMES,
  onlyDatabaseName: 'shop',
};
const UNSCOPED_DISCOVERY: MySqlDiscoveryScope = { excludedDatabaseNames: MYSQL_SYSTEM_DATABASE_NAMES };
const ORDERS_TABLE = { databaseName: 'shop', tableName: 'orders' };

function onlyCapturedQuery(capturedQueries: CapturedCatalogQuery[]): CapturedCatalogQuery {
  expect(capturedQueries).toHaveLength(1);
  return capturedQueries[0];
}

describe('findDatabaseNames', () => {
  it('lists SCHEMATA with the scope fragment and returns the names', async () => {
    const { fakeKnex, capturedQueries } = createFakeCatalogKnex([[[{ database_name: 'shop' }], []]]);
    await expect(findDatabaseNames(fakeKnex, SCOPED_DISCOVERY)).resolves.toEqual(['shop']);
    const capturedQuery = onlyCapturedQuery(capturedQueries);
    expect(capturedQuery.sql).toContain('FROM information_schema.SCHEMATA');
    expect(capturedQuery.sql).toContain('SCHEMA_NAME AS database_name');
    expect(capturedQuery.sql).toContain('LOWER(SCHEMA_NAME) NOT IN (');
    expect(capturedQuery.sql).toContain('AND SCHEMA_NAME = ?');
    expect(capturedQuery.bindings).toEqual([...MYSQL_SYSTEM_DATABASE_NAMES, 'shop']);
  });

  it('omits the NOT IN clause when nothing is excluded', async () => {
    const { fakeKnex, capturedQueries } = createFakeCatalogKnex([[[], []]]);
    await findDatabaseNames(fakeKnex, { excludedDatabaseNames: [] });
    const capturedQuery = onlyCapturedQuery(capturedQueries);
    expect(capturedQuery.sql).not.toContain('NOT IN');
    expect(capturedQuery.bindings).toEqual([]);
  });
});

describe('findAllTables', () => {
  it('selects base tables, views and system-versioned tables in scope, normalized', async () => {
    const { fakeKnex, capturedQueries } = createFakeCatalogKnex([
      [
        [
          { database_name: 'shop', table_name: 'orders', table_type: 'BASE TABLE', storage_engine: 'InnoDB' },
          { database_name: 'shop', table_name: 'order_totals', table_type: 'VIEW', storage_engine: null },
        ],
        [],
      ],
    ]);
    await expect(findAllTables(fakeKnex, UNSCOPED_DISCOVERY)).resolves.toEqual([
      { databaseName: 'shop', tableName: 'orders', tableType: 'BASE TABLE', storageEngine: 'InnoDB' },
      { databaseName: 'shop', tableName: 'order_totals', tableType: 'VIEW', storageEngine: null },
    ]);
    const capturedQuery = onlyCapturedQuery(capturedQueries);
    expect(capturedQuery.sql).toContain('FROM information_schema.TABLES');
    expect(capturedQuery.sql).toContain('TABLE_TYPE IN (?, ?, ?)');
    expect(capturedQuery.sql).toContain('ENGINE AS storage_engine');
    expect(capturedQuery.bindings).toEqual([...MYSQL_SYSTEM_DATABASE_NAMES, ...MYSQL_LISTABLE_TABLE_TYPES]);
    expect(MYSQL_LISTABLE_TABLE_TYPES).toEqual(['BASE TABLE', 'VIEW', 'SYSTEM VERSIONED']);
  });

  it('throws on a result that is not [rows, fields] instead of reporting no tables', async () => {
    const { fakeKnex } = createFakeCatalogKnex([{ rows: [] }]);
    await expect(findAllTables(fakeKnex, UNSCOPED_DISCOVERY)).rejects.toThrow(/Unexpected result shape/);
  });
});

describe('findTablesWithSingleColumnUniqueIndex', () => {
  it('counts key parts inside STATISTICS before anything else (functional key parts excluded)', async () => {
    const { fakeKnex, capturedQueries } = createFakeCatalogKnex([
      [
        [
          { database_name: 'shop', table_name: 'orders', column_type: 'int unsigned' },
          { database_name: 'a.b', table_name: 'c', column_type: 'varchar(20)' },
        ],
        [],
      ],
    ]);
    const tablesWithSingleColumnUniqueIndex = await findTablesWithSingleColumnUniqueIndex(fakeKnex, SCOPED_DISCOVERY);
    expect(tablesWithSingleColumnUniqueIndex).toEqual(
      new Set([buildMySqlTableLookupKey('shop', 'orders'), buildMySqlTableLookupKey('a.b', 'c')]),
    );
    expect(tablesWithSingleColumnUniqueIndex.has(buildMySqlTableLookupKey('a', 'b.c'))).toBe(false);
    const capturedQuery = onlyCapturedQuery(capturedQueries);
    expect(capturedQuery.sql).toContain('FROM information_schema.STATISTICS');
    expect(capturedQuery.sql).toContain('NON_UNIQUE = 0');
    expect(capturedQuery.sql).toContain('HAVING COUNT(*) = 1 AND COUNT(COLUMN_NAME) = 1');
    // The single-column count happens in the derived table, BEFORE the COLUMNS join reads the column's type.
    expect(capturedQuery.sql.indexOf('HAVING COUNT(*) = 1')).toBeLessThan(
      capturedQuery.sql.indexOf('JOIN information_schema.COLUMNS'),
    );
    expect(capturedQuery.bindings).toEqual([...MYSQL_SYSTEM_DATABASE_NAMES, 'shop']);
  });

  it("ignores unique indexes on columns Scratch can't address rows by (FLOAT, BLOB, spatial)", async () => {
    const { fakeKnex } = createFakeCatalogKnex([
      [
        [
          { database_name: 'shop', table_name: 'float_keyed', column_type: 'float' },
          { database_name: 'shop', table_name: 'blob_keyed', column_type: 'blob' },
          { database_name: 'shop', table_name: 'double_keyed', column_type: 'double' },
          { database_name: 'shop', table_name: 'timestamp_keyed', column_type: 'timestamp(3)' },
          { database_name: 'shop', table_name: 'binary_keyed', column_type: 'binary(16)' },
        ],
        [],
      ],
    ]);
    await expect(findTablesWithSingleColumnUniqueIndex(fakeKnex, SCOPED_DISCOVERY)).resolves.toEqual(
      new Set([
        buildMySqlTableLookupKey('shop', 'double_keyed'),
        buildMySqlTableLookupKey('shop', 'timestamp_keyed'),
        buildMySqlTableLookupKey('shop', 'binary_keyed'),
      ]),
    );
  });

  it('groups byte-exactly so MariaDB never merges tables whose names differ only by case or accent', async () => {
    const { fakeKnex, capturedQueries } = createFakeCatalogKnex([[[], []]]);
    await findTablesWithSingleColumnUniqueIndex(fakeKnex, SCOPED_DISCOVERY);
    const capturedQuery = onlyCapturedQuery(capturedQueries);
    expect(capturedQuery.sql).toContain(
      'GROUP BY CAST(TABLE_SCHEMA AS BINARY), CAST(TABLE_NAME AS BINARY), CAST(INDEX_NAME AS BINARY)',
    );
    // MIN() reads the group's (byte-identical) name and keeps the query valid under ONLY_FULL_GROUP_BY.
    expect(capturedQuery.sql).toContain('MIN(TABLE_SCHEMA) AS database_name, MIN(TABLE_NAME) AS table_name');
    // DISTINCT would fold `Orders` / `orders` in MariaDB's collation; the returned Set dedupes instead.
    expect(capturedQuery.sql).not.toMatch(/\bDISTINCT\b/i);
    // The constant scope predicate stays, so MariaDB still only opens the configured database's tables.
    expect(capturedQuery.sql).toContain('AND TABLE_SCHEMA = ?');
  });

  it("keeps names that differ only by case or accent apart, and collapses one table's several indexes", async () => {
    const { fakeKnex } = createFakeCatalogKnex([
      [
        [
          { database_name: 'shop', table_name: 'Orders', column_type: 'int' },
          { database_name: 'shop', table_name: 'orders', column_type: 'int' },
          { database_name: 'shop', table_name: 'orders', column_type: 'varchar(40)' },
          { database_name: 'shop', table_name: 'café', column_type: 'int' },
          { database_name: 'shop', table_name: 'cafe', column_type: 'int' },
        ],
        [],
      ],
    ]);
    await expect(findTablesWithSingleColumnUniqueIndex(fakeKnex, SCOPED_DISCOVERY)).resolves.toEqual(
      new Set([
        buildMySqlTableLookupKey('shop', 'Orders'),
        buildMySqlTableLookupKey('shop', 'orders'),
        buildMySqlTableLookupKey('shop', 'café'),
        buildMySqlTableLookupKey('shop', 'cafe'),
      ]),
    );
  });
});

describe('findTablesWithAutoIncrementPrimaryKey', () => {
  it('requires a single-part primary key whose column EXTRA has auto_increment (never DEFAULT_GENERATED)', async () => {
    const { fakeKnex, capturedQueries } = createFakeCatalogKnex([
      [[{ database_name: 'shop', table_name: 'orders' }], []],
    ]);
    await expect(findTablesWithAutoIncrementPrimaryKey(fakeKnex, SCOPED_DISCOVERY)).resolves.toEqual(
      new Set([buildMySqlTableLookupKey('shop', 'orders')]),
    );
    const capturedQuery = onlyCapturedQuery(capturedQueries);
    expect(capturedQuery.sql).toContain("INDEX_NAME = 'PRIMARY'");
    expect(capturedQuery.sql).toContain('HAVING COUNT(*) = 1');
    expect(capturedQuery.sql).toContain("LOWER(primary_key_column.EXTRA) LIKE '%auto_increment%'");
    expect(capturedQuery.sql).not.toMatch(/DEFAULT_GENERATED/i);
    // The scope is applied to both the STATISTICS and the COLUMNS side.
    expect(capturedQuery.bindings).toEqual([
      ...MYSQL_SYSTEM_DATABASE_NAMES,
      'shop',
      ...MYSQL_SYSTEM_DATABASE_NAMES,
      'shop',
    ]);
    expect(capturedQuery.sql).toContain('primary_key_column.TABLE_SCHEMA = ?');
  });

  it('groups and joins byte-exactly, so a same-named key of a case/accent twin table never counts', async () => {
    const { fakeKnex, capturedQueries } = createFakeCatalogKnex([
      [
        [
          { database_name: 'shop', table_name: 'Orders' },
          { database_name: 'shop', table_name: 'orders' },
        ],
        [],
      ],
    ]);
    await expect(findTablesWithAutoIncrementPrimaryKey(fakeKnex, SCOPED_DISCOVERY)).resolves.toEqual(
      new Set([buildMySqlTableLookupKey('shop', 'Orders'), buildMySqlTableLookupKey('shop', 'orders')]),
    );
    const capturedQuery = onlyCapturedQuery(capturedQueries);
    expect(capturedQuery.sql).toContain('GROUP BY CAST(TABLE_SCHEMA AS BINARY), CAST(TABLE_NAME AS BINARY)');
    expect(capturedQuery.sql).toContain(
      'MIN(TABLE_SCHEMA) AS database_name, MIN(TABLE_NAME) AS table_name, MAX(COLUMN_NAME) AS column_name',
    );
    for (const [columnsSideName, primaryKeySideName] of [
      ['primary_key_column.TABLE_SCHEMA', 'single_column_primary_key.database_name'],
      ['primary_key_column.TABLE_NAME', 'single_column_primary_key.table_name'],
      ['primary_key_column.COLUMN_NAME', 'single_column_primary_key.column_name'],
    ]) {
      // The collation-aware equality stays (MySQL 8 uses it to look names up in its data-dictionary indexes)...
      expect(capturedQuery.sql).toContain(`${columnsSideName} = ${primaryKeySideName}`);
      // ...and the byte equality is what keeps MariaDB's case- and accent-insensitive names apart.
      expect(capturedQuery.sql).toContain(`CAST(${columnsSideName} AS BINARY) = CAST(${primaryKeySideName} AS BINARY)`);
    }
    expect(capturedQuery.sql).not.toMatch(/\bDISTINCT\b/i);
  });
});

describe('findTableRow', () => {
  it('returns the normalized row, or null when the table is absent', async () => {
    const { fakeKnex, capturedQueries } = createFakeCatalogKnex([
      [[{ database_name: 'shop', table_name: 'orders', table_type: 'BASE TABLE', storage_engine: 'MyISAM' }], []],
      [[], []],
    ]);
    await expect(findTableRow(fakeKnex, ORDERS_TABLE)).resolves.toEqual({
      databaseName: 'shop',
      tableName: 'orders',
      tableType: 'BASE TABLE',
      storageEngine: 'MyISAM',
    });
    await expect(findTableRow(fakeKnex, ORDERS_TABLE)).resolves.toBeNull();
    expect(capturedQueries[0].sql).toContain('WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?');
    expect(capturedQueries[0].bindings).toEqual(['shop', 'orders']);
  });
});

describe('findAllColumnsInTable', () => {
  it('selects every catalog field with lower-case aliases and normalizes numeric strings', async () => {
    const { fakeKnex, capturedQueries } = createFakeCatalogKnex([
      [
        [
          {
            column_name: 'name',
            data_type: 'varchar',
            column_type: 'varchar(80)',
            is_nullable: 'NO',
            column_default: null,
            extra: '',
            generation_expression: '',
            privileges: 'select,insert,update,references',
            column_key: '',
            character_maximum_length: '80',
            numeric_precision: null,
            numeric_scale: null,
            datetime_precision: null,
            character_set_name: 'utf8mb4',
            collation_name: 'utf8mb4_0900_ai_ci',
            ordinal_position: '2',
          },
        ],
        [],
      ],
    ]);
    const catalogColumns = await findAllColumnsInTable(fakeKnex, ORDERS_TABLE);
    expect(catalogColumns).toHaveLength(1);
    expect(catalogColumns[0].characterMaximumLength).toBe(80);
    expect(catalogColumns[0].ordinalPosition).toBe(2);
    expect(catalogColumns[0].isNullable).toBe(false);
    const capturedQuery = onlyCapturedQuery(capturedQueries);
    for (const catalogAlias of [
      'COLUMN_NAME AS column_name',
      'DATA_TYPE AS data_type',
      'COLUMN_TYPE AS column_type',
      'IS_NULLABLE AS is_nullable',
      'COLUMN_DEFAULT AS column_default',
      'EXTRA AS extra',
      'GENERATION_EXPRESSION AS generation_expression',
      'PRIVILEGES AS privileges',
      'COLUMN_KEY AS column_key',
      'CHARACTER_MAXIMUM_LENGTH AS character_maximum_length',
      'NUMERIC_PRECISION AS numeric_precision',
      'NUMERIC_SCALE AS numeric_scale',
      'DATETIME_PRECISION AS datetime_precision',
      'CHARACTER_SET_NAME AS character_set_name',
      'COLLATION_NAME AS collation_name',
      'ORDINAL_POSITION AS ordinal_position',
    ]) {
      expect(capturedQuery.sql).toContain(catalogAlias);
    }
    expect(capturedQuery.sql).toContain('ORDER BY ORDINAL_POSITION');
    expect(capturedQuery.bindings).toEqual(['shop', 'orders']);
  });

  it('throws TableNotFound when the catalog returns no column (unlike Postgres, never an empty spec)', async () => {
    const { fakeKnex } = createFakeCatalogKnex([[[], []]]);
    const thrownError: unknown = await findAllColumnsInTable(fakeKnex, { databaseName: 'a.b', tableName: 'c' }).catch(
      (error: unknown) => error,
    );
    expect(thrownError).toBeInstanceOf(MySqlClientError);
    expect((thrownError as MySqlClientError).problem).toBe(MySqlClientProblem.TableNotFound);
    expect((thrownError as MySqlClientError).userFriendlyMessage).toBe(
      'Table "a.b"."c" was not found, or you can\'t read any of its columns.',
    );
  });
});

describe('findPrimaryKeyColumnNames', () => {
  it('returns the PRIMARY index columns in key order', async () => {
    const { fakeKnex, capturedQueries } = createFakeCatalogKnex([
      [[{ column_name: 'tenant_id' }, { column_name: 'id' }], []],
    ]);
    await expect(findPrimaryKeyColumnNames(fakeKnex, ORDERS_TABLE)).resolves.toEqual(['tenant_id', 'id']);
    const capturedQuery = onlyCapturedQuery(capturedQueries);
    expect(capturedQuery.sql).toContain("INDEX_NAME = 'PRIMARY'");
    expect(capturedQuery.sql).toContain('ORDER BY SEQ_IN_INDEX');
  });
});

describe('findSingleColumnUniqueIndexColumns', () => {
  it('counts parts inside STATISTICS, then joins COLUMNS; primary key first, then column order', async () => {
    const { fakeKnex, capturedQueries } = createFakeCatalogKnex([
      [
        [
          {
            index_name: 'email_unique',
            column_name: 'email',
            native_type: 'varchar(255)',
            is_nullable: 'YES',
            extra: '',
            ordinal_position: '2',
          },
          {
            index_name: 'PRIMARY',
            column_name: 'id',
            native_type: 'bigint unsigned',
            is_nullable: 'NO',
            extra: 'auto_increment',
            ordinal_position: '5',
          },
          {
            index_name: 'code_unique',
            column_name: 'code',
            native_type: 'char(3)',
            is_nullable: 'NO',
            extra: '',
            ordinal_position: '1',
          },
        ],
        [],
      ],
    ]);
    const singleColumnUniqueIndexColumns = await findSingleColumnUniqueIndexColumns(fakeKnex, ORDERS_TABLE);
    expect(singleColumnUniqueIndexColumns).toEqual([
      {
        indexName: 'PRIMARY',
        columnName: 'id',
        nativeType: 'bigint unsigned',
        isPrimaryKey: true,
        isNullable: false,
        isAutoIncrement: true,
        ordinalPosition: 5,
      },
      {
        indexName: 'code_unique',
        columnName: 'code',
        nativeType: 'char(3)',
        isPrimaryKey: false,
        isNullable: false,
        isAutoIncrement: false,
        ordinalPosition: 1,
      },
      {
        indexName: 'email_unique',
        columnName: 'email',
        nativeType: 'varchar(255)',
        isPrimaryKey: false,
        isNullable: true,
        isAutoIncrement: false,
        ordinalPosition: 2,
      },
    ]);
    const capturedQuery = onlyCapturedQuery(capturedQueries);
    const statisticsSubqueryPosition = capturedQuery.sql.indexOf('FROM information_schema.STATISTICS');
    const havingPosition = capturedQuery.sql.indexOf('HAVING COUNT(*) = 1 AND COUNT(COLUMN_NAME) = 1');
    const columnsJoinPosition = capturedQuery.sql.indexOf('JOIN information_schema.COLUMNS');
    expect(statisticsSubqueryPosition).toBeGreaterThan(-1);
    expect(havingPosition).toBeGreaterThan(statisticsSubqueryPosition);
    expect(columnsJoinPosition).toBeGreaterThan(havingPosition);
    expect(capturedQuery.bindings).toEqual(['shop', 'orders', 'shop', 'orders']);
  });

  it('groups indexes and joins columns byte-exactly (MariaDB: `idx_café` ≠ `idx_cafe`, column `café` ≠ `cafe`)', async () => {
    const { fakeKnex, capturedQueries } = createFakeCatalogKnex([
      [
        [
          {
            index_name: 'idx_café',
            column_name: 'café',
            native_type: 'int',
            is_nullable: 'YES',
            extra: '',
            ordinal_position: 2,
          },
          {
            index_name: 'idx_cafe',
            column_name: 'b',
            native_type: 'int',
            is_nullable: 'NO',
            extra: '',
            ordinal_position: 3,
          },
        ],
        [],
      ],
    ]);
    const singleColumnUniqueIndexColumns = await findSingleColumnUniqueIndexColumns(fakeKnex, ORDERS_TABLE);
    expect(singleColumnUniqueIndexColumns.map(({ indexName, columnName }) => [indexName, columnName])).toEqual([
      ['idx_café', 'café'],
      ['idx_cafe', 'b'],
    ]);
    const capturedQuery = onlyCapturedQuery(capturedQueries);
    expect(capturedQuery.sql).toContain('GROUP BY CAST(INDEX_NAME AS BINARY)');
    expect(capturedQuery.sql).toContain('MIN(INDEX_NAME) AS index_name');
    expect(capturedQuery.sql).toContain('unique_column.COLUMN_NAME = single_column_unique_index.column_name');
    expect(capturedQuery.sql).toContain(
      'CAST(unique_column.COLUMN_NAME AS BINARY) = CAST(single_column_unique_index.column_name AS BINARY)',
    );
    // The table itself is still matched by constants (exact on both servers, and prunes MariaDB's catalog scan).
    expect(capturedQuery.sql).toContain('unique_column.TABLE_SCHEMA = ? AND unique_column.TABLE_NAME = ?');
  });

  it('recognizes MariaDB lower-case EXTRA', async () => {
    const { fakeKnex } = createFakeCatalogKnex([
      [
        [
          {
            index_name: 'PRIMARY',
            column_name: 'id',
            native_type: 'int(11)',
            is_nullable: 'NO',
            extra: 'AUTO_INCREMENT',
            ordinal_position: 1,
          },
        ],
        [],
      ],
    ]);
    const [primaryKeyColumn] = await findSingleColumnUniqueIndexColumns(fakeKnex, ORDERS_TABLE);
    expect(primaryKeyColumn.isAutoIncrement).toBe(true);
  });
});

describe('findSingleColumnForeignKeysInTable', () => {
  it('keeps only single-column constraints (grouped, one catalog scan)', async () => {
    const { fakeKnex, capturedQueries } = createFakeCatalogKnex([
      [
        [
          {
            constraint_name: 'orders_customer_fk',
            column_name: 'customer_id',
            referenced_database_name: 'crm',
            referenced_table_name: 'customers',
            referenced_column_name: 'id',
          },
        ],
        [],
      ],
    ]);
    await expect(findSingleColumnForeignKeysInTable(fakeKnex, ORDERS_TABLE)).resolves.toEqual([
      {
        constraintName: 'orders_customer_fk',
        columnName: 'customer_id',
        referencedDatabaseName: 'crm',
        referencedTableName: 'customers',
        referencedColumnName: 'id',
      },
    ]);
    const capturedQuery = onlyCapturedQuery(capturedQueries);
    expect(capturedQuery.sql).toContain('FROM information_schema.KEY_COLUMN_USAGE');
    expect(capturedQuery.sql).toContain('REFERENCED_TABLE_NAME IS NOT NULL');
    expect(capturedQuery.sql).toContain('HAVING COUNT(*) = 1');
    expect(capturedQuery.bindings).toEqual(['shop', 'orders']);
  });

  it('groups constraints byte-exactly, so MariaDB keeps `fk_café` and `fk_cafe` as two foreign keys', async () => {
    const { fakeKnex, capturedQueries } = createFakeCatalogKnex([
      [
        [
          {
            constraint_name: 'fk_cafe',
            column_name: 'second_parent_id',
            referenced_database_name: 'shop',
            referenced_table_name: 'parents',
            referenced_column_name: 'id',
          },
          {
            constraint_name: 'fk_café',
            column_name: 'first_parent_id',
            referenced_database_name: 'shop',
            referenced_table_name: 'parents',
            referenced_column_name: 'id',
          },
        ],
        [],
      ],
    ]);
    const foreignKeys = await findSingleColumnForeignKeysInTable(fakeKnex, ORDERS_TABLE);
    expect(foreignKeys.map(({ constraintName, columnName }) => [constraintName, columnName])).toEqual([
      ['fk_cafe', 'second_parent_id'],
      ['fk_café', 'first_parent_id'],
    ]);
    const capturedQuery = onlyCapturedQuery(capturedQueries);
    expect(capturedQuery.sql).toContain('GROUP BY CAST(CONSTRAINT_NAME AS BINARY)');
    expect(capturedQuery.sql).toContain('MIN(CONSTRAINT_NAME) AS constraint_name');
    // Ordered by the aggregate: under ONLY_FULL_GROUP_BY a bare CONSTRAINT_NAME isn't a grouped expression any more.
    expect(capturedQuery.sql).toContain('ORDER BY MIN(CONSTRAINT_NAME)');
  });
});

describe('findMariaDbJsonAliasColumnNames', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(WSLogger, 'warn').mockImplementation();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns the columns whose result metadata carries MariaDB's JSON format flag", async () => {
    const { fakeKnex } = createFakeCatalogKnex([
      [
        [],
        [
          { name: 'id', extendedFormat: undefined },
          { name: 'doc', extendedFormat: 'json' },
          { name: 'notes', extendedTypeName: undefined },
          { name: 'a.b `json`', extendedFormat: 'json' },
        ],
      ],
    ]);
    await expect(findMariaDbJsonAliasColumnNames(fakeKnex, ORDERS_TABLE)).resolves.toEqual(
      new Set(['doc', 'a.b `json`']),
    );
  });

  it('reads metadata only: SELECT * … LIMIT 0 on the verbatim-quoted table', async () => {
    const { fakeKnex, capturedQueries } = createFakeCatalogKnex([[[], []]]);
    await findMariaDbJsonAliasColumnNames(fakeKnex, { databaseName: 'my.db', tableName: 'Company.io Deals as x' });
    const capturedQuery = onlyCapturedQuery(capturedQueries);
    expect(capturedQuery.sql).toBe('SELECT * FROM ?? LIMIT 0');
    expect(capturedQuery.bindings).toEqual([
      qualifiedMySqlTableReferenceForKnex({ databaseName: 'my.db', tableName: 'Company.io Deals as x' }),
    ]);
    expect(capturedQuery.compiledSql).toBe('SELECT * FROM `my.db`.`Company.io Deals as x` LIMIT 0');
    expect(capturedQuery.compiledBindings).toEqual([]);
  });

  it('logs and returns an empty set when the metadata query fails (the safe, non-JSON direction)', async () => {
    const { fakeKnex } = createFakeCatalogKnex([Object.assign(new Error('denied'), { errno: 1142, code: 'X' })]);
    await expect(findMariaDbJsonAliasColumnNames(fakeKnex, ORDERS_TABLE)).resolves.toEqual(new Set());
    expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({ source: 'MySqlCatalogQueries', errno: 1142 }));
  });

  it('returns an empty set when the driver reports no column metadata', async () => {
    const { fakeKnex } = createFakeCatalogKnex([[[], undefined]]);
    await expect(findMariaDbJsonAliasColumnNames(fakeKnex, ORDERS_TABLE)).resolves.toEqual(new Set());
  });
});

describe('every discovery query', () => {
  it('works on a transaction handle too (only `raw` is used)', async () => {
    const { fakeKnex, rawMock } = createFakeCatalogKnex([[[{ column_name: 'id' }], []]]);
    const fakeTransaction = fakeKnex as unknown as Knex.Transaction;
    await expect(findPrimaryKeyColumnNames(fakeTransaction, ORDERS_TABLE)).resolves.toEqual(['id']);
    expect(rawMock).toHaveBeenCalledTimes(1);
  });

  it('groups and joins catalog names byte-exactly and never DISTINCTs them (MariaDB folds case and accents)', async () => {
    const emptyRawResult = (): unknown => [[], []];
    const { fakeKnex, capturedQueries } = createFakeCatalogKnex(Array.from({ length: 9 }, emptyRawResult));
    await findDatabaseNames(fakeKnex, UNSCOPED_DISCOVERY);
    await findAllTables(fakeKnex, UNSCOPED_DISCOVERY);
    await findTablesWithSingleColumnUniqueIndex(fakeKnex, UNSCOPED_DISCOVERY);
    await findTablesWithAutoIncrementPrimaryKey(fakeKnex, UNSCOPED_DISCOVERY);
    await findTableRow(fakeKnex, ORDERS_TABLE);
    await expect(findAllColumnsInTable(fakeKnex, ORDERS_TABLE)).rejects.toBeInstanceOf(MySqlClientError);
    await findPrimaryKeyColumnNames(fakeKnex, ORDERS_TABLE);
    await findSingleColumnUniqueIndexColumns(fakeKnex, ORDERS_TABLE);
    await findSingleColumnForeignKeysInTable(fakeKnex, ORDERS_TABLE);
    expect(capturedQueries).toHaveLength(9);

    const everyGroupedExpression: string[] = [];
    const everyJoinedCatalogNamePair: [string, string][] = [];
    for (const { sql } of capturedQueries) {
      expect(sql).not.toMatch(/\bDISTINCT\b/i);
      for (const [, groupByList] of sql.matchAll(/GROUP BY ([^\n]+)/g)) {
        everyGroupedExpression.push(...groupByList.split(',').map((groupedExpression) => groupedExpression.trim()));
      }
      // `a = b` between two column references (not a `?` binding, a literal or a CAST(...) expression).
      for (const [, leftCatalogName, rightCatalogName] of sql.matchAll(
        /(?<![\w.(])([A-Za-z_][\w.]*)\s*=\s*([A-Za-z_][\w.]*)(?![\w.(])/g,
      )) {
        everyJoinedCatalogNamePair.push([leftCatalogName, rightCatalogName]);
        expect(sql).toContain(`CAST(${leftCatalogName} AS BINARY) = CAST(${rightCatalogName} AS BINARY)`);
      }
    }
    // Unique indexes (3) + auto-increment primary keys (2) + unique-index columns (1) + foreign keys (1).
    expect(everyGroupedExpression).toHaveLength(7);
    for (const groupedExpression of everyGroupedExpression) {
      expect(groupedExpression).toMatch(/^CAST\([\w.]+ AS BINARY\)$/);
    }
    // Unique-index tables' column types (schema, table, column) + auto-increment primary keys (schema, table,
    // column) + unique-index columns (column).
    expect(everyJoinedCatalogNamePair).toHaveLength(7);
  });
});
