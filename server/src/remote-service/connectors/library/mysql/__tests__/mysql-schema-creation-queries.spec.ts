/**
 * Unit tests for the schema-creation executors. DB-free: a connection-less knex with the production MySQL dialect
 * and identifier hooks compiles every statement for real, and its query runner is intercepted so each executed
 * statement is recorded (and answered) instead of reaching a server. The discovery queries from
 * `mysql-catalog-queries.ts` are mocked.
 */
import { type CreateFieldSpec, type CreateFieldType } from '@spinner/shared-types';
import knex, { type Knex } from 'knex';
import { type KnexMySqlClient } from '../knex-mysql-client';
import { type MySqlSingleColumnUniqueIndexColumn, type MySqlTableRow } from '../mysql-catalog-types';
import { buildMySqlForeignKeyConstraintName, type ResolvedMySqlForeignKey } from '../mysql-create-schema';
import { applyMySqlVerbatimIdentifierQuoting } from '../mysql-identifier-quoting';
import { ScratchMySql2KnexDialectClient } from '../mysql-knex-dialect-client';
import { type MySqlTableReference } from '../mysql-types';

const mockFindTableRow = jest.fn<Promise<MySqlTableRow | null>, [unknown, MySqlTableReference]>();
const mockFindSingleColumnUniqueIndexColumns = jest.fn<
  Promise<MySqlSingleColumnUniqueIndexColumn[]>,
  [unknown, MySqlTableReference]
>();

jest.mock('../mysql-catalog-queries', () => ({
  findTableRow: (...args: [unknown, MySqlTableReference]) => mockFindTableRow(...args),
  findSingleColumnUniqueIndexColumns: (...args: [unknown, MySqlTableReference]) =>
    mockFindSingleColumnUniqueIndexColumns(...args),
}));

import {
  addForeignKeyColumnWithConstraint,
  addNonForeignKeyColumn,
  createTableWithAutoIncrementPrimaryKey,
  doesMySqlTableCarryCreatedTableComment,
  findStoredMySqlTableReference,
  hasFullLengthSingleColumnUniqueIndex,
  isExistingMySqlForeignKeyAsPlanned,
  resolveForeignKeyReferenceForTargetTable,
} from '../mysql-schema-creation-queries';

interface ExecutedStatement {
  sql: string;
  bindings: readonly unknown[];
}

/** The `[rows, fields]` answer for a raw catalog query, chosen by the statement's SQL. */
type CatalogQueryResponder = (executedStatement: ExecutedStatement) => Record<string, unknown>[];

const PREPARE_SESSION_MARKER = '<prepareSessionForSchemaChanges>';

function buildInterceptedMySqlKnex(
  executedStatements: ExecutedStatement[],
  respondToCatalogQuery: CatalogQueryResponder,
  failingStatementPattern?: { sqlPattern: RegExp; error: Error },
): Knex {
  const interceptedKnex = knex({ client: ScratchMySql2KnexDialectClient });
  applyMySqlVerbatimIdentifierQuoting(interceptedKnex);
  const knexDialectClient = interceptedKnex.client as {
    acquireConnection: () => Promise<unknown>;
    releaseConnection: () => Promise<void>;
    _query: (
      connection: unknown,
      queryObject: { sql: string; bindings: unknown[]; response?: unknown },
    ) => Promise<unknown>;
  };
  knexDialectClient.acquireConnection = () => Promise.resolve({ interceptedConnection: true });
  knexDialectClient.releaseConnection = () => Promise.resolve();
  knexDialectClient._query = (_connection, queryObject) => {
    const executedStatement = { sql: queryObject.sql, bindings: queryObject.bindings ?? [] };
    executedStatements.push(executedStatement);
    if (failingStatementPattern?.sqlPattern.test(queryObject.sql)) {
      return Promise.reject(failingStatementPattern.error);
    }
    queryObject.response = [respondToCatalogQuery(executedStatement), []];
    return Promise.resolve(queryObject);
  };
  return interceptedKnex;
}

function buildFakeKnexMySqlClient(interceptedKnex: Knex, executedStatements: ExecutedStatement[]): KnexMySqlClient {
  const fakeClient = {
    knex: interceptedKnex,
    prepareSessionForSchemaChanges: jest.fn(() => {
      executedStatements.push({ sql: PREPARE_SESSION_MARKER, bindings: [] });
      return Promise.resolve();
    }),
  };
  return fakeClient as unknown as KnexMySqlClient;
}

function field(name: string, fieldType: CreateFieldType, extra: Partial<CreateFieldSpec> = {}): CreateFieldSpec {
  return { name, fieldType, ...extra };
}

const noCatalogRows: CatalogQueryResponder = () => [];
const widgetsTable: MySqlTableReference = { databaseName: 'Shop', tableName: 'Widgets' };
const WIDGETS_CREATE_REQUEST = { createRef: 'dfd_widgets001', foreignKeyFieldNames: new Set<string>(['Maker']) };
const knexInstancesToDestroy: Knex[] = [];

afterEach(async () => {
  await Promise.all(knexInstancesToDestroy.splice(0).map((knexInstance) => knexInstance.destroy()));
});

function setUpInterceptedClient(
  respondToCatalogQuery: CatalogQueryResponder = noCatalogRows,
  failingStatementPattern?: { sqlPattern: RegExp; error: Error },
): { client: KnexMySqlClient; interceptedKnex: Knex; executedStatements: ExecutedStatement[] } {
  const executedStatements: ExecutedStatement[] = [];
  const interceptedKnex = buildInterceptedMySqlKnex(executedStatements, respondToCatalogQuery, failingStatementPattern);
  knexInstancesToDestroy.push(interceptedKnex);
  return { client: buildFakeKnexMySqlClient(interceptedKnex, executedStatements), interceptedKnex, executedStatements };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('createTableWithAutoIncrementPrimaryKey', () => {
  it('prepares the session, runs one CREATE TABLE (no transaction), then reads back the stored names', async () => {
    const { client, executedStatements } = setUpInterceptedClient((executedStatement) =>
      executedStatement.sql.includes('information_schema.TABLES')
        ? [{ stored_database_name: 'shop', stored_table_name: 'widgets' }]
        : [],
    );

    const result = await createTableWithAutoIncrementPrimaryKey(
      client,
      widgetsTable,
      [
        field('Name', { kind: 'text' }, { required: true }),
        field('id', { kind: 'text' }),
        field('tags', { kind: 'multiSelect', options: [{ name: 'a' }] }),
      ],
      WIDGETS_CREATE_REQUEST,
    );

    expect(executedStatements.map((executedStatement) => executedStatement.sql)).toEqual([
      PREPARE_SESSION_MARKER,
      "create table `Shop`.`Widgets` (`id` bigint unsigned not null auto_increment primary key, `Name` mediumtext not null) default character set utf8mb4 engine = InnoDB comment = 'live_export:dfd_widgets001'",
      expect.stringContaining('FROM information_schema.TABLES'),
    ]);
    expect(executedStatements[2].bindings).toEqual(['Shop', 'Widgets']);
    expect([...result.skipReasonByFieldName.keys()]).toEqual(['id', 'tags']);
    // lower_case_table_names=1: the remote id must be the stored spelling.
    expect(result.storedTable).toEqual({ databaseName: 'shop', tableName: 'widgets' });
    expect(executedStatements.some((executedStatement) => /begin|start transaction/i.test(executedStatement.sql))).toBe(
      false,
    );
  });

  it('creates the table without a comment when the ref is not a Live Export source table', async () => {
    const { client, executedStatements } = setUpInterceptedClient(noCatalogRows);
    await createTableWithAutoIncrementPrimaryKey(client, widgetsTable, [field('Name', { kind: 'text' })], {
      ...WIDGETS_CREATE_REQUEST,
      createRef: 't1',
    });
    const createTableStatement = executedStatements.find((executedStatement) =>
      executedStatement.sql.startsWith('create table'),
    );
    expect(createTableStatement?.sql).toBe(
      'create table `Shop`.`Widgets` (`id` bigint unsigned not null auto_increment primary key, `Name` mediumtext null) default character set utf8mb4 engine = InnoDB',
    );
  });

  it('falls back to the requested names when the catalog does not show the new table', async () => {
    const { client } = setUpInterceptedClient(noCatalogRows);
    const result = await createTableWithAutoIncrementPrimaryKey(
      client,
      widgetsTable,
      [field('Name', { kind: 'text' })],
      WIDGETS_CREATE_REQUEST,
    );
    expect(result.storedTable).toEqual(widgetsTable);
  });

  it('propagates a MySQL error other than 1050 and skips the read-back', async () => {
    const createDeniedError = Object.assign(new Error('CREATE command denied'), {
      errno: 1142,
      code: 'ER_TABLEACCESS_DENIED_ERROR',
    });
    const { client, executedStatements } = setUpInterceptedClient(noCatalogRows, {
      sqlPattern: /^create table/,
      error: createDeniedError,
    });
    await expect(
      createTableWithAutoIncrementPrimaryKey(
        client,
        widgetsTable,
        [field('Name', { kind: 'text' })],
        WIDGETS_CREATE_REQUEST,
      ),
    ).rejects.toBe(createDeniedError);
    expect(executedStatements.some((executedStatement) => executedStatement.sql.includes('information_schema'))).toBe(
      false,
    );
  });

  describe('when the table already exists (1050)', () => {
    const duplicateTableError = Object.assign(new Error('Table exists'), {
      errno: 1050,
      code: 'ER_TABLE_EXISTS_ERROR',
    });

    /** The catalog of a table an interrupted create of `dfd_widgets001` left behind (lower_case_table_names=1). */
    function respondWithLeftoverTable(overrides: {
      tableType?: string;
      tableComment?: string;
      anyRow?: boolean;
      nameColumnType?: string;
    }): CatalogQueryResponder {
      return (executedStatement) => {
        if (executedStatement.sql.includes('information_schema.TABLES')) {
          return [
            {
              stored_database_name: 'shop',
              stored_table_name: 'widgets',
              table_type: overrides.tableType ?? 'BASE TABLE',
              storage_engine: 'InnoDB',
              table_comment: overrides.tableComment ?? 'live_export:dfd_widgets001',
            },
          ];
        }
        if (executedStatement.sql.includes('information_schema.COLUMNS')) {
          return [
            {
              column_name: 'id',
              column_type: 'bigint unsigned',
              is_nullable: 'NO',
              column_key: 'PRI',
              extra: 'auto_increment',
            },
            {
              column_name: 'Name',
              column_type: overrides.nameColumnType ?? 'mediumtext',
              is_nullable: 'NO',
              column_key: '',
              extra: '',
            },
            { column_name: 'Maker', column_type: 'bigint unsigned', is_nullable: 'YES', column_key: 'MUL', extra: '' },
          ];
        }
        if (executedStatement.sql.startsWith('SELECT 1 AS any_row')) {
          return overrides.anyRow ? [{ any_row: 1 }] : [];
        }
        return [];
      };
    }

    it('reuses the empty table an earlier attempt of the same request left, under its stored names', async () => {
      const { client, executedStatements } = setUpInterceptedClient(respondWithLeftoverTable({}), {
        sqlPattern: /^create table/,
        error: duplicateTableError,
      });

      const result = await createTableWithAutoIncrementPrimaryKey(
        client,
        widgetsTable,
        [field('Name', { kind: 'text' }, { required: true }), field('id', { kind: 'text' })],
        WIDGETS_CREATE_REQUEST,
      );

      expect(result.storedTable).toEqual({ databaseName: 'shop', tableName: 'widgets' });
      expect([...result.skipReasonByFieldName.keys()]).toEqual(['id']);
      const rowCheck = executedStatements.find((executedStatement) =>
        executedStatement.sql.startsWith('SELECT 1 AS any_row'),
      );
      expect(rowCheck?.sql).toBe('SELECT 1 AS any_row FROM `shop`.`widgets` LIMIT 1');
    });

    // Cheapest check first: a table that isn't ours never has its columns read, and only a table whose columns are
    // as planned is checked for rows (a row check on a view would compute it).
    it.each<[string, Parameters<typeof respondWithLeftoverTable>[0], { readsColumns: boolean; checksRows: boolean }]>([
      ['is a view', { tableType: 'VIEW' }, { readsColumns: false, checksRows: false }],
      ['has no comment', { tableComment: '' }, { readsColumns: false, checksRows: false }],
      [
        "carries another request's comment",
        { tableComment: 'live_export:dfd_otherexprt' },
        { readsColumns: false, checksRows: false },
      ],
      [
        'has a planned column of another type',
        { nameColumnType: 'varchar(20)' },
        { readsColumns: true, checksRows: false },
      ],
      ['has rows', { anyRow: true }, { readsColumns: true, checksRows: true }],
    ])(
      'rethrows the 1050 when the existing table %s, reading no more than needed',
      async (_label, overrides, reads) => {
        const { client, executedStatements } = setUpInterceptedClient(respondWithLeftoverTable(overrides), {
          sqlPattern: /^create table/,
          error: duplicateTableError,
        });
        await expect(
          createTableWithAutoIncrementPrimaryKey(
            client,
            widgetsTable,
            [field('Name', { kind: 'text' }, { required: true })],
            WIDGETS_CREATE_REQUEST,
          ),
        ).rejects.toBe(duplicateTableError);
        const executedSql = executedStatements.map((executedStatement) => executedStatement.sql);
        expect(executedSql.some((sql) => sql.includes('information_schema.COLUMNS'))).toBe(reads.readsColumns);
        expect(executedSql.some((sql) => sql.startsWith('SELECT 1 AS any_row'))).toBe(reads.checksRows);
      },
    );

    it('rethrows the 1050 without reading the catalog when the ref is not a Live Export source table', async () => {
      const { client, executedStatements } = setUpInterceptedClient(respondWithLeftoverTable({}), {
        sqlPattern: /^create table/,
        error: duplicateTableError,
      });
      await expect(
        createTableWithAutoIncrementPrimaryKey(client, widgetsTable, [field('Name', { kind: 'text' })], {
          ...WIDGETS_CREATE_REQUEST,
          createRef: 't1',
        }),
      ).rejects.toBe(duplicateTableError);
      expect(executedStatements.some((executedStatement) => executedStatement.sql.includes('information_schema'))).toBe(
        false,
      );
    });

    it('rethrows the 1050 when the catalog no longer shows the table, or reading it fails', async () => {
      const { client } = setUpInterceptedClient(noCatalogRows, {
        sqlPattern: /^create table/,
        error: duplicateTableError,
      });
      await expect(
        createTableWithAutoIncrementPrimaryKey(
          client,
          widgetsTable,
          [field('Name', { kind: 'text' })],
          WIDGETS_CREATE_REQUEST,
        ),
      ).rejects.toBe(duplicateTableError);

      const { client: failingCatalogClient } = setUpInterceptedClient(
        () => {
          throw new Error('information_schema unavailable');
        },
        { sqlPattern: /^create table/, error: duplicateTableError },
      );
      await expect(
        createTableWithAutoIncrementPrimaryKey(
          failingCatalogClient,
          widgetsTable,
          [field('Name', { kind: 'text' })],
          WIDGETS_CREATE_REQUEST,
        ),
      ).rejects.toBe(duplicateTableError);
    });
  });
});

describe('doesMySqlTableCarryCreatedTableComment', () => {
  it("is true only when the table's comment is exactly the given one", async () => {
    const { client, executedStatements } = setUpInterceptedClient(() => [
      { table_comment: 'live_export:dfd_widgets001' },
    ]);
    await expect(
      doesMySqlTableCarryCreatedTableComment(client, widgetsTable, 'live_export:dfd_widgets001'),
    ).resolves.toBe(true);
    expect(executedStatements[0].bindings).toEqual(['Shop', 'Widgets']);

    await expect(
      doesMySqlTableCarryCreatedTableComment(client, widgetsTable, 'live_export:dfd_otherexprt'),
    ).resolves.toBe(false);
  });

  it('is false for a table without a comment, a missing table, or a failed read', async () => {
    const { client } = setUpInterceptedClient(() => [{ table_comment: '' }]);
    await expect(
      doesMySqlTableCarryCreatedTableComment(client, widgetsTable, 'live_export:dfd_widgets001'),
    ).resolves.toBe(false);

    const { client: emptyCatalogClient } = setUpInterceptedClient(noCatalogRows);
    await expect(
      doesMySqlTableCarryCreatedTableComment(emptyCatalogClient, widgetsTable, 'live_export:dfd_widgets001'),
    ).resolves.toBe(false);

    const { client: failingClient } = setUpInterceptedClient(() => {
      throw new Error('information_schema unavailable');
    });
    await expect(
      doesMySqlTableCarryCreatedTableComment(failingClient, widgetsTable, 'live_export:dfd_widgets001'),
    ).resolves.toBe(false);
  });
});

describe('isExistingMySqlForeignKeyAsPlanned', () => {
  const makerField = field('Maker', { kind: 'foreignKey', target: { existingRemoteTableId: ['shop', 'makers'] } });
  const resolutionToMakers: ResolvedMySqlForeignKey = {
    kind: 'resolved',
    targetTable: { databaseName: 'shop', tableName: 'makers' },
    targetColumnName: 'id',
    foreignKeyColumnTypeDefinition: 'bigint unsigned',
  };

  it("looks up Scratch's named constraint on the column and is true when it references the resolved target", async () => {
    const { client, executedStatements } = setUpInterceptedClient(() => [
      { referenced_database_name: 'shop', referenced_table_name: 'makers', referenced_column_name: 'id' },
    ]);
    await expect(
      isExistingMySqlForeignKeyAsPlanned(client, widgetsTable, makerField, resolutionToMakers),
    ).resolves.toBe(true);
    expect(executedStatements[0].bindings).toEqual([
      'Shop',
      'Widgets',
      'Maker',
      buildMySqlForeignKeyConstraintName('Widgets', 'Maker'),
    ]);
  });

  it('is false without the constraint, or when it references another table', async () => {
    const { client } = setUpInterceptedClient(noCatalogRows);
    await expect(
      isExistingMySqlForeignKeyAsPlanned(client, widgetsTable, makerField, resolutionToMakers),
    ).resolves.toBe(false);
    const { client: otherTargetClient } = setUpInterceptedClient(() => [
      { referenced_database_name: 'shop', referenced_table_name: 'vendors', referenced_column_name: 'id' },
    ]);
    await expect(
      isExistingMySqlForeignKeyAsPlanned(otherTargetClient, widgetsTable, makerField, resolutionToMakers),
    ).resolves.toBe(false);
  });
});

describe('findStoredMySqlTableReference', () => {
  it('reads TABLE_SCHEMA and TABLE_NAME as stored (Buffers decoded), or null when absent', async () => {
    const { interceptedKnex } = setUpInterceptedClient(() => [
      { stored_database_name: Buffer.from('shop'), stored_table_name: 'widgets' },
    ]);
    await expect(findStoredMySqlTableReference(interceptedKnex, widgetsTable)).resolves.toEqual({
      databaseName: 'shop',
      tableName: 'widgets',
    });

    const { interceptedKnex: emptyCatalogKnex } = setUpInterceptedClient(noCatalogRows);
    await expect(findStoredMySqlTableReference(emptyCatalogKnex, widgetsTable)).resolves.toBeNull();
  });
});

describe('addNonForeignKeyColumn', () => {
  it('prepares the session and runs one ALTER TABLE for the field', async () => {
    const { client, executedStatements } = setUpInterceptedClient();
    await expect(
      addNonForeignKeyColumn(client, widgetsTable, field('Dealroom.co URL?', { kind: 'url' })),
    ).resolves.toEqual({});
    expect(executedStatements.map((executedStatement) => executedStatement.sql)).toEqual([
      PREPARE_SESSION_MARKER,
      'alter table `Shop`.`Widgets` add `Dealroom.co URL?` mediumtext null',
    ]);
  });

  it('returns the skip reason without touching the server', async () => {
    const { client, executedStatements } = setUpInterceptedClient();
    const result = await addNonForeignKeyColumn(client, widgetsTable, field('Status 🚀', { kind: 'text' }));
    expect(result.skipReason).toContain('outside the Basic Multilingual Plane');
    expect(executedStatements).toEqual([]);
  });
});

describe('addForeignKeyColumnWithConstraint', () => {
  const resolution: ResolvedMySqlForeignKey = {
    kind: 'resolved',
    targetTable: { databaseName: 'shop', tableName: 'companies' },
    targetColumnName: 'id',
    foreignKeyColumnTypeDefinition: 'bigint unsigned',
  };

  it('prepares the session, then runs ONE ALTER with the column and the constraint and no foreign_key_checks toggle', async () => {
    const { client, executedStatements } = setUpInterceptedClient();
    await addForeignKeyColumnWithConstraint(
      client,
      widgetsTable,
      field('Company', { kind: 'foreignKey', target: { existingRemoteTableId: ['shop', 'companies'] } }),
      resolution,
    );
    expect(executedStatements.map((executedStatement) => executedStatement.sql)).toEqual([
      PREPARE_SESSION_MARKER,
      `ALTER TABLE \`Shop\`.\`Widgets\` ADD COLUMN \`Company\` bigint unsigned NULL, ADD CONSTRAINT \`${buildMySqlForeignKeyConstraintName('Widgets', 'Company')}\` FOREIGN KEY (\`Company\`) REFERENCES \`shop\`.\`companies\` (\`id\`) ON DELETE SET NULL`,
    ]);
    expect(executedStatements.some((executedStatement) => /foreign_key_checks/i.test(executedStatement.sql))).toBe(
      false,
    );
  });

  it('refuses an invalid request before preparing the session or running DDL', async () => {
    const { client, executedStatements } = setUpInterceptedClient();
    await expect(
      addForeignKeyColumnWithConstraint(client, widgetsTable, field('Company', { kind: 'text' }), resolution),
    ).rejects.toThrow("isn't a single-valued foreign key");
    expect(executedStatements).toEqual([]);
  });

  it('propagates a MySQL foreign-key error', async () => {
    const incompatibleColumnsError = Object.assign(new Error('incompatible'), { errno: 3780 });
    const { client } = setUpInterceptedClient(noCatalogRows, {
      sqlPattern: /^ALTER TABLE/,
      error: incompatibleColumnsError,
    });
    await expect(
      addForeignKeyColumnWithConstraint(
        client,
        widgetsTable,
        field('Company', { kind: 'foreignKey', target: { existingRemoteTableId: ['shop', 'companies'] } }),
        resolution,
      ),
    ).rejects.toBe(incompatibleColumnsError);
  });
});

describe('hasFullLengthSingleColumnUniqueIndex', () => {
  it('requires a single-part, full-length unique index on exactly that column', () => {
    expect(
      hasFullLengthSingleColumnUniqueIndex([{ indexName: 'PRIMARY', columnName: 'id', prefixLength: null }], 'ID'),
    ).toBe(true);
    // A prefix-only unique index doesn't qualify.
    expect(
      hasFullLengthSingleColumnUniqueIndex([{ indexName: 'code_prefix', columnName: 'code', prefixLength: 5 }], 'code'),
    ).toBe(false);
    // A composite unique index (or one with a functional part) doesn't qualify either.
    expect(
      hasFullLengthSingleColumnUniqueIndex(
        [
          { indexName: 'code_region', columnName: 'code', prefixLength: null },
          { indexName: 'code_region', columnName: 'region', prefixLength: null },
          { indexName: 'code_functional', columnName: 'code', prefixLength: null },
          { indexName: 'code_functional', columnName: null, prefixLength: null },
        ],
        'code',
      ),
    ).toBe(false);
    // A full-length index next to a prefix one does.
    expect(
      hasFullLengthSingleColumnUniqueIndex(
        [
          { indexName: 'code_prefix', columnName: 'code', prefixLength: 5 },
          { indexName: 'code_full', columnName: 'code', prefixLength: null },
        ],
        'code',
      ),
    ).toBe(true);
  });
});

describe('resolveForeignKeyReferenceForTargetTable', () => {
  const companiesTable: MySqlTableReference = { databaseName: 'Shop', tableName: 'Companies' };
  const storedCompaniesTableRow: MySqlTableRow = {
    databaseName: 'shop',
    tableName: 'companies',
    tableType: 'BASE TABLE',
    storageEngine: 'InnoDB',
  };

  function uniqueColumn(overrides: Partial<MySqlSingleColumnUniqueIndexColumn>): MySqlSingleColumnUniqueIndexColumn {
    return {
      indexName: 'PRIMARY',
      columnName: 'id',
      nativeType: 'bigint unsigned',
      isPrimaryKey: true,
      isNullable: false,
      isAutoIncrement: true,
      ordinalPosition: 1,
      ...overrides,
    };
  }

  /** Answers the partitioning query, the column-details query and the unique-index-parts query of the resolver. */
  function catalogResponder(
    columnDetailsRow: Record<string, unknown> | undefined,
    uniqueIndexKeyPartRows: Record<string, unknown>[],
    createOptions = '',
  ): CatalogQueryResponder {
    return (executedStatement) => {
      if (executedStatement.sql.includes('CREATE_OPTIONS')) return [{ create_options: createOptions }];
      if (executedStatement.sql.includes('information_schema.COLUMNS'))
        return columnDetailsRow ? [columnDetailsRow] : [];
      if (executedStatement.sql.includes('information_schema.STATISTICS')) return uniqueIndexKeyPartRows;
      return [];
    };
  }

  it('resolves to the chosen id column of the table as stored, typed like it', async () => {
    mockFindTableRow.mockResolvedValue(storedCompaniesTableRow);
    mockFindSingleColumnUniqueIndexColumns.mockResolvedValue([
      uniqueColumn({
        indexName: 'email_unique',
        columnName: 'email',
        isPrimaryKey: false,
        isAutoIncrement: false,
        ordinalPosition: 2,
      }),
      uniqueColumn({}),
    ]);
    const { interceptedKnex, executedStatements } = setUpInterceptedClient(
      catalogResponder({ column_type: 'bigint unsigned', character_set_name: null, collation_name: null }, [
        { index_name: 'PRIMARY', column_name: 'id', prefix_length: null },
        { index_name: 'email_unique', column_name: 'email', prefix_length: null },
      ]),
    );

    await expect(resolveForeignKeyReferenceForTargetTable(interceptedKnex, companiesTable)).resolves.toEqual({
      kind: 'resolved',
      targetTable: { databaseName: 'shop', tableName: 'companies' },
      targetColumnName: 'id',
      foreignKeyColumnTypeDefinition: 'bigint unsigned',
    });
    expect(mockFindTableRow).toHaveBeenCalledWith(interceptedKnex, companiesTable);
    expect(mockFindSingleColumnUniqueIndexColumns).toHaveBeenCalledWith(interceptedKnex, {
      databaseName: 'shop',
      tableName: 'companies',
    });
    expect(executedStatements.map((executedStatement) => executedStatement.bindings)).toEqual([
      ['shop', 'companies'],
      ['shop', 'companies', 'id'],
      ['shop', 'companies'],
    ]);
  });

  it('refuses a partitioned target table (MySQL can never reference one) without reading its columns', async () => {
    mockFindTableRow.mockResolvedValue(storedCompaniesTableRow);
    mockFindSingleColumnUniqueIndexColumns.mockResolvedValue([uniqueColumn({})]);
    const { interceptedKnex } = setUpInterceptedClient(
      catalogResponder(
        { column_type: 'bigint unsigned', character_set_name: null, collation_name: null },
        [],
        'partitioned',
      ),
    );

    const resolution = await resolveForeignKeyReferenceForTargetTable(interceptedKnex, companiesTable);
    expect(resolution).toEqual({ kind: 'unresolvable', reason: expect.stringContaining('is partitioned') as string });
    expect(mockFindSingleColumnUniqueIndexColumns).not.toHaveBeenCalled();
  });

  it('refuses a VIRTUAL generated id column (MySQL 3733 / MariaDB 1005)', async () => {
    mockFindTableRow.mockResolvedValue(storedCompaniesTableRow);
    mockFindSingleColumnUniqueIndexColumns.mockResolvedValue([uniqueColumn({ columnName: 'code', nativeType: 'int' })]);
    const { interceptedKnex } = setUpInterceptedClient(
      catalogResponder(
        { column_type: 'int', character_set_name: null, collation_name: null, extra: 'VIRTUAL GENERATED' },
        [{ index_name: 'PRIMARY', column_name: 'code', prefix_length: null }],
      ),
    );

    const resolution = await resolveForeignKeyReferenceForTargetTable(interceptedKnex, companiesTable);
    expect(resolution).toEqual({
      kind: 'unresolvable',
      reason: expect.stringContaining('is a VIRTUAL generated column') as string,
    });
  });

  it('carries a character column’s character set and collation (catalog values may arrive as strings or Buffers)', async () => {
    mockFindTableRow.mockResolvedValue(storedCompaniesTableRow);
    mockFindSingleColumnUniqueIndexColumns.mockResolvedValue([
      uniqueColumn({ columnName: 'code', nativeType: 'varchar(2)' }),
    ]);
    const { interceptedKnex } = setUpInterceptedClient(
      catalogResponder(
        { column_type: 'varchar(2)', character_set_name: Buffer.from('latin1'), collation_name: 'latin1_swedish_ci' },
        [{ index_name: 'PRIMARY', column_name: 'code', prefix_length: null }],
      ),
    );
    await expect(resolveForeignKeyReferenceForTargetTable(interceptedKnex, companiesTable)).resolves.toEqual(
      expect.objectContaining({
        kind: 'resolved',
        targetColumnName: 'code',
        foreignKeyColumnTypeDefinition: 'varchar(2) CHARACTER SET latin1 COLLATE latin1_swedish_ci',
      }),
    );
  });

  it.each([
    [
      'a missing table',
      null,
      [],
      undefined,
      [],
      'the linked table "Shop"."Companies" doesn\'t exist, or this connection\'s MySQL user can\'t see it',
    ],
    ['a view', { ...storedCompaniesTableRow, tableType: 'VIEW', storageEngine: null }, [], undefined, [], 'is a view'],
    [
      'a MyISAM table',
      { ...storedCompaniesTableRow, storageEngine: 'MyISAM' },
      [],
      undefined,
      [],
      'uses the MyISAM storage engine, and MySQL only enforces foreign keys between InnoDB tables',
    ],
    [
      'a table without a single-column unique column',
      storedCompaniesTableRow,
      [],
      undefined,
      [],
      'has no single-column primary key or unique column',
    ],
    [
      'a TEXT id column',
      storedCompaniesTableRow,
      [uniqueColumn({ columnName: 'slug', nativeType: 'text' })],
      { column_type: 'text', character_set_name: 'utf8mb4', collation_name: 'utf8mb4_bin' },
      [{ index_name: 'slug_prefix', column_name: 'slug', prefix_length: '20' }],
      'the id column "slug" of the linked table "shop"."companies" has type text',
    ],
    [
      'a BINARY(16) id column',
      storedCompaniesTableRow,
      [uniqueColumn({ columnName: 'uuid', nativeType: 'binary(16)' })],
      { column_type: 'binary(16)', character_set_name: null, collation_name: null },
      [{ index_name: 'PRIMARY', column_name: 'uuid', prefix_length: null }],
      'encoded text',
    ],
    [
      'a prefix-only unique id column',
      storedCompaniesTableRow,
      [uniqueColumn({ columnName: 'code', nativeType: 'varchar(20)', isPrimaryKey: false, isAutoIncrement: false })],
      { column_type: 'varchar(20)', character_set_name: 'utf8mb4', collation_name: 'utf8mb4_0900_ai_ci' },
      [{ index_name: 'code_prefix', column_name: 'code', prefix_length: '5' }],
      'unique only through a prefix index',
    ],
    [
      'an id column that vanished between the two catalog reads',
      storedCompaniesTableRow,
      [uniqueColumn({})],
      undefined,
      [],
      'disappeared',
    ],
  ])(
    'is unresolvable for %s',
    async (
      _label,
      tableRow: MySqlTableRow | null,
      uniqueColumns: MySqlSingleColumnUniqueIndexColumn[],
      columnDetailsRow: Record<string, unknown> | undefined,
      uniqueIndexKeyPartRows: Record<string, unknown>[],
      expectedReasonFragment: string,
    ) => {
      mockFindTableRow.mockResolvedValue(tableRow);
      mockFindSingleColumnUniqueIndexColumns.mockResolvedValue(uniqueColumns);
      const { interceptedKnex } = setUpInterceptedClient(catalogResponder(columnDetailsRow, uniqueIndexKeyPartRows));
      const resolution = await resolveForeignKeyReferenceForTargetTable(interceptedKnex, companiesTable);
      if (resolution.kind !== 'unresolvable') throw new Error('expected the foreign key to be unresolvable');
      expect(resolution.reason).toContain(expectedReasonFragment);
    },
  );
});
