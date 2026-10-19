/**
 * MySQL catalog collation integration test (DEV-12035): names that differ only by letter case or by an accent.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * Why this exists
 * ═══════════════════════════════════════════════════════════════════════════
 * MariaDB's `information_schema` name columns use `utf8mb3_general_ci` (case- AND accent-insensitive), but with
 * `lower_case_table_names=0` (the Linux / RDS default) `Orders` and `orders`, or `café` and `cafe`, are separate
 * tables. Discovery used to `GROUP BY TABLE_NAME` and join catalog names with plain `=`, so on MariaDB such a pair
 * merged into one two-row "PRIMARY" group and BOTH tables were listed as disabled ("no single-column unique key"),
 * and a same-named primary key of the twin could count as AUTO_INCREMENT. MySQL 8 (`utf8mb3_bin` names when
 * `lower_case_table_names=0`) was never affected; it runs the same assertions as a regression guard.
 *
 * What this validates, on real MySQL 8.4 and MariaDB 11.4 catalogs:
 *   1. listTables lists both tables of a case pair, an accent pair and a both-AUTO_INCREMENT case pair, each with
 *      its own preview flags (creates disabled exactly where the primary key isn't AUTO_INCREMENT).
 *   2. fetchJsonTableSpec and a pull address each twin's own columns and rows.
 *   3. Two unique indexes whose names differ only by an accent both count; a UNIQUE `café` column never makes the
 *      non-unique `cafe` column an id candidate; (MariaDB) two foreign keys whose constraint names differ only by
 *      an accent are both annotated.
 *   4. With no database configured, two databases whose names differ only by case both have their table listed
 *      correctly, and both are offered as create destinations.
 *   5. Every catalog query runs unchanged in an ONLY_FULL_GROUP_BY session (the grouped names are read via MIN()).
 *
 * Tables are named `scratch_mysql_it_collation_*` and live in the configured database; the two twin databases are
 * `scratch_mysql_it_collation_Db` / `scratch_mysql_it_collation_db` (root-created, so the scoped application user
 * never sees them). All are dropped before and (unless SKIP_CLEANUP=1) after the run.
 *
 * Run (from server/, with server/localdev/docker-compose.mysql.yml up):
 *   MYSQL_TEST_URL=mysql://test:test@127.0.0.1:3306/test_db MYSQL_TEST_ROOT_URL=mysql://root:root@127.0.0.1:3306/test_db \
 *   MARIADB_TEST_URL=mysql://test:test@127.0.0.1:3307/test_db MARIADB_TEST_ROOT_URL=mysql://root:root@127.0.0.1:3307/test_db \
 *   yarn test:integration test/integration/mysql-catalog-collation --runInBand
 */
import { type TObject } from '@sinclair/typebox';
import { X_SCRATCH_FOREIGN_KEY_OPTIONS } from '@spinner/shared-types';
import knex, { type Knex } from 'knex';
import { type Connection as MySql2CallbackConnection } from 'mysql2';
import { type Connection as MySqlAdminConnection, type RowDataPacket } from 'mysql2/promise';
import { type Connector } from 'src/remote-service/connectors/connector';
import { sanitizeForTableWsId } from 'src/remote-service/connectors/ids';
import { buildMySqlTableLookupKey } from 'src/remote-service/connectors/library/mysql/mysql-catalog';
import {
  findSingleColumnForeignKeysInTable,
  findSingleColumnUniqueIndexColumns,
  findTablesWithAutoIncrementPrimaryKey,
  findTablesWithSingleColumnUniqueIndex,
} from 'src/remote-service/connectors/library/mysql/mysql-catalog-queries';
import {
  MYSQL_SYSTEM_DATABASE_NAMES,
  type MySqlDiscoveryScope,
} from 'src/remote-service/connectors/library/mysql/mysql-catalog-types';
import { applyMySqlVerbatimIdentifierQuoting } from 'src/remote-service/connectors/library/mysql/mysql-identifier-quoting';
import { ScratchMySql2KnexDialectClient } from 'src/remote-service/connectors/library/mysql/mysql-knex-dialect-client';
import { TABLE_WITHOUT_AUTO_INCREMENT_ID_CREATES_DISABLED_REASON } from 'src/remote-service/connectors/library/mysql/mysql-table-writability';
import {
  type BaseJsonTableSpec,
  type ConnectorFile,
  type EntityId,
  type TablePreview,
} from 'src/remote-service/connectors/types';
import { type JsonSafeObject } from 'src/utils/objects';
import {
  buildMySqlConnectorCredentialsForIntegrationTest,
  createMySqlConnectorThroughRegistryForIntegrationTest,
  describeForEachConfiguredMySqlIntegrationFlavor,
  MYSQL_INTEGRATION_IDENTIFIER_PREFIX,
  openMySqlAdminConnection,
  quoteMySqlIdentifierVerbatim,
  waitForMySqlServerToAcceptConnections,
  type MySqlIntegrationServerAddress,
} from './mysql-integration-helpers';

jest.setTimeout(60_000);

// ---------------------------------------------------------------------------------------------------------------
// Fixture names
// ---------------------------------------------------------------------------------------------------------------

/** Every table, constraint and database this spec creates starts with this (and only this spec's cleanup drops them). */
const COLLATION_SPEC_IDENTIFIER_PREFIX = `${MYSQL_INTEGRATION_IDENTIFIER_PREFIX}collation_`;

/** A case pair with different keys: an AUTO_INCREMENT `id` versus a VARCHAR `code` (the reported scenario). */
const CASE_TWIN_WITH_AUTO_INCREMENT_ID_TABLE_NAME = `${COLLATION_SPEC_IDENTIFIER_PREFIX}Case`;
const CASE_TWIN_WITH_VARCHAR_CODE_KEY_TABLE_NAME = `${COLLATION_SPEC_IDENTIFIER_PREFIX}case`;
/**
 * An accent pair whose primary keys are BOTH named `id`, only the unaccented one AUTO_INCREMENT: a collation-aware
 * join to COLUMNS would lend the accented table its twin's AUTO_INCREMENT.
 */
const ACCENTED_TWIN_WITH_PLAIN_INTEGER_ID_TABLE_NAME = `${COLLATION_SPEC_IDENTIFIER_PREFIX}café`;
const UNACCENTED_TWIN_WITH_AUTO_INCREMENT_ID_TABLE_NAME = `${COLLATION_SPEC_IDENTIFIER_PREFIX}cafe`;
/** A case pair that are both AUTO_INCREMENT: a DISTINCT over names would fold them into one row. */
const UPPER_CASE_TWIN_BOTH_AUTO_INCREMENT_TABLE_NAME = `${COLLATION_SPEC_IDENTIFIER_PREFIX}Twin`;
const LOWER_CASE_TWIN_BOTH_AUTO_INCREMENT_TABLE_NAME = `${COLLATION_SPEC_IDENTIFIER_PREFIX}twin`;
/** No primary key; its only unique indexes are named `idx_café` (on `a`) and `idx_cafe` (on `b`). */
const ACCENT_TWIN_UNIQUE_INDEXES_TABLE_NAME = `${COLLATION_SPEC_IDENTIFIER_PREFIX}accent_indexes`;
const ACCENTED_UNIQUE_INDEX_NAME = 'idx_café';
const UNACCENTED_UNIQUE_INDEX_NAME = 'idx_cafe';
/** No primary key; a NOT NULL, non-unique `cafe` column BEFORE the UNIQUE `café` column. */
const ACCENT_TWIN_COLUMNS_TABLE_NAME = `${COLLATION_SPEC_IDENTIFIER_PREFIX}accent_columns`;
const UNACCENTED_NON_UNIQUE_COLUMN_NAME = 'cafe';
const ACCENTED_UNIQUE_COLUMN_NAME = 'café';
/** MariaDB only: two foreign keys whose constraint names differ only by an accent (MySQL refuses the pair, 1826). */
const FOREIGN_KEY_PARENT_TABLE_NAME = `${COLLATION_SPEC_IDENTIFIER_PREFIX}fk_parent`;
const FOREIGN_KEY_CHILD_TABLE_NAME = `${COLLATION_SPEC_IDENTIFIER_PREFIX}fk_child`;
/** Constraint names are unique per database, so they carry the spec prefix too. */
const ACCENTED_FOREIGN_KEY_CONSTRAINT_NAME = `${COLLATION_SPEC_IDENTIFIER_PREFIX}fk_café`;
const UNACCENTED_FOREIGN_KEY_CONSTRAINT_NAME = `${COLLATION_SPEC_IDENTIFIER_PREFIX}fk_cafe`;
const MYSQL_DUPLICATE_FOREIGN_KEY_NAME_ERRNO = 1826;

/** Two databases differing only by case, each holding a table of the same name with a different key. */
const UPPER_CASE_TWIN_DATABASE_NAME = `${COLLATION_SPEC_IDENTIFIER_PREFIX}Db`;
const LOWER_CASE_TWIN_DATABASE_NAME = `${COLLATION_SPEC_IDENTIFIER_PREFIX}db`;
const TABLE_NAME_IN_EACH_TWIN_DATABASE = `${COLLATION_SPEC_IDENTIFIER_PREFIX}t`;

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

function entityIdForMySqlTable(databaseName: string, tableName: string): EntityId {
  return { wsId: sanitizeForTableWsId(`${databaseName}__${tableName}`), remoteId: [databaseName, tableName] };
}

/** The preview whose remote id is EXACTLY `[databaseName, tableName]` (byte comparison, as the pipeline does). */
function findTablePreviewByExactRemoteId(
  tablePreviews: TablePreview[],
  databaseName: string,
  tableName: string,
): TablePreview {
  const matchingTablePreviews = tablePreviews.filter(
    (tablePreview) => tablePreview.id.remoteId[0] === databaseName && tablePreview.id.remoteId[1] === tableName,
  );
  expect(matchingTablePreviews).toHaveLength(1);
  return matchingTablePreviews[0];
}

function pickTablePreviewAvailabilityFlags(tablePreview: TablePreview): Partial<TablePreview> {
  return {
    disabled: tablePreview.disabled,
    disabledCreates: tablePreview.disabledCreates,
    disabledUpdates: tablePreview.disabledUpdates,
    disabledDeletes: tablePreview.disabledDeletes,
    disabledReason: tablePreview.disabledReason,
  };
}

const FULLY_USABLE_TABLE_PREVIEW_FLAGS: Partial<TablePreview> = {
  disabled: undefined,
  disabledCreates: undefined,
  disabledUpdates: undefined,
  disabledDeletes: undefined,
  disabledReason: undefined,
};
const CREATES_DISABLED_TABLE_PREVIEW_FLAGS: Partial<TablePreview> = {
  ...FULLY_USABLE_TABLE_PREVIEW_FLAGS,
  disabledCreates: true,
  disabledReason: TABLE_WITHOUT_AUTO_INCREMENT_ID_CREATES_DISABLED_REASON,
};

function readSchemaPropertyNames(tableSpec: BaseJsonTableSpec): string[] {
  return Object.keys((tableSpec.schema as TObject).properties).sort();
}

async function pullEveryRecordFile(
  connector: Connector<string, JsonSafeObject>,
  tableSpec: BaseJsonTableSpec,
): Promise<ConnectorFile[]> {
  const pulledRecordFiles: ConnectorFile[] = [];
  await connector.pullRecordFiles(
    tableSpec,
    ({ files }) => {
      pulledRecordFiles.push(...files);
      return Promise.resolve();
    },
    {},
    {},
  );
  return pulledRecordFiles;
}

function readAdminCatalogText(value: unknown): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

/** Drop this spec's tables (FK checks off, any order) and twin databases; other MySQL specs keep theirs. */
async function dropThisSpecsTablesAndDatabases(
  adminConnection: MySqlAdminConnection,
  databaseName: string,
): Promise<void> {
  const likePatternForThisSpecsPrefix = `${COLLATION_SPEC_IDENTIFIER_PREFIX.replace(/_/g, '\\_')}%`;
  const [thisSpecsTables] = await adminConnection.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS table_name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE ?`,
    [databaseName, likePatternForThisSpecsPrefix],
  );
  await adminConnection.query('SET SESSION FOREIGN_KEY_CHECKS = 0');
  try {
    for (const thisSpecsTable of thisSpecsTables) {
      await adminConnection.query(
        `DROP TABLE IF EXISTS ${quoteMySqlIdentifierVerbatim(databaseName)}.${quoteMySqlIdentifierVerbatim(readAdminCatalogText(thisSpecsTable.table_name))}`,
      );
    }
  } finally {
    await adminConnection.query('SET SESSION FOREIGN_KEY_CHECKS = 1');
  }
  for (const twinDatabaseName of [UPPER_CASE_TWIN_DATABASE_NAME, LOWER_CASE_TWIN_DATABASE_NAME]) {
    await adminConnection.query(`DROP DATABASE IF EXISTS ${quoteMySqlIdentifierVerbatim(twinDatabaseName)}`);
  }
}

async function createCollationFixtures(
  adminConnection: MySqlAdminConnection,
  databaseName: string,
  options: { serverAcceptsForeignKeyNamesDifferingOnlyByAccent: boolean },
): Promise<void> {
  const qualifyTableForAdminSql = (tableName: string): string =>
    `${quoteMySqlIdentifierVerbatim(databaseName)}.${quoteMySqlIdentifierVerbatim(tableName)}`;
  const createTable = (tableName: string, columnsAndKeysSql: string): Promise<unknown> =>
    adminConnection.query(
      `CREATE TABLE ${qualifyTableForAdminSql(tableName)} (${columnsAndKeysSql}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );

  await createTable(
    CASE_TWIN_WITH_AUTO_INCREMENT_ID_TABLE_NAME,
    'id INT AUTO_INCREMENT PRIMARY KEY, upper_case_twin_only VARCHAR(10)',
  );
  await createTable(
    CASE_TWIN_WITH_VARCHAR_CODE_KEY_TABLE_NAME,
    'code VARCHAR(10) PRIMARY KEY, lower_case_twin_only VARCHAR(10)',
  );
  await adminConnection.query(
    `INSERT INTO ${qualifyTableForAdminSql(CASE_TWIN_WITH_AUTO_INCREMENT_ID_TABLE_NAME)} (upper_case_twin_only) VALUES ('U')`,
  );
  await adminConnection.query(
    `INSERT INTO ${qualifyTableForAdminSql(CASE_TWIN_WITH_VARCHAR_CODE_KEY_TABLE_NAME)} (code, lower_case_twin_only) VALUES ('k', 'L')`,
  );

  await createTable(ACCENTED_TWIN_WITH_PLAIN_INTEGER_ID_TABLE_NAME, 'id INT PRIMARY KEY, accented_twin_only INT');
  await createTable(
    UNACCENTED_TWIN_WITH_AUTO_INCREMENT_ID_TABLE_NAME,
    'id INT AUTO_INCREMENT PRIMARY KEY, unaccented_twin_only INT',
  );

  await createTable(UPPER_CASE_TWIN_BOTH_AUTO_INCREMENT_TABLE_NAME, 'id INT AUTO_INCREMENT PRIMARY KEY');
  await createTable(LOWER_CASE_TWIN_BOTH_AUTO_INCREMENT_TABLE_NAME, 'id INT AUTO_INCREMENT PRIMARY KEY');

  await createTable(
    ACCENT_TWIN_UNIQUE_INDEXES_TABLE_NAME,
    `a INT NOT NULL, b INT NOT NULL, UNIQUE KEY ${quoteMySqlIdentifierVerbatim(ACCENTED_UNIQUE_INDEX_NAME)} (a), ` +
      `UNIQUE KEY ${quoteMySqlIdentifierVerbatim(UNACCENTED_UNIQUE_INDEX_NAME)} (b)`,
  );

  await createTable(
    ACCENT_TWIN_COLUMNS_TABLE_NAME,
    `${quoteMySqlIdentifierVerbatim(UNACCENTED_NON_UNIQUE_COLUMN_NAME)} INT NOT NULL, ` +
      `${quoteMySqlIdentifierVerbatim(ACCENTED_UNIQUE_COLUMN_NAME)} INT NOT NULL, ` +
      `UNIQUE KEY accented_column_unique (${quoteMySqlIdentifierVerbatim(ACCENTED_UNIQUE_COLUMN_NAME)})`,
  );

  if (options.serverAcceptsForeignKeyNamesDifferingOnlyByAccent) {
    await createTable(FOREIGN_KEY_PARENT_TABLE_NAME, 'id INT AUTO_INCREMENT PRIMARY KEY');
    await createTable(FOREIGN_KEY_CHILD_TABLE_NAME, buildForeignKeyChildColumnsAndKeysSql(databaseName));
  }

  await adminConnection.query(`CREATE DATABASE ${quoteMySqlIdentifierVerbatim(UPPER_CASE_TWIN_DATABASE_NAME)}`);
  await adminConnection.query(`CREATE DATABASE ${quoteMySqlIdentifierVerbatim(LOWER_CASE_TWIN_DATABASE_NAME)}`);
  await adminConnection.query(
    `CREATE TABLE ${quoteMySqlIdentifierVerbatim(UPPER_CASE_TWIN_DATABASE_NAME)}.${quoteMySqlIdentifierVerbatim(TABLE_NAME_IN_EACH_TWIN_DATABASE)} ` +
      '(id INT AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB',
  );
  await adminConnection.query(
    `CREATE TABLE ${quoteMySqlIdentifierVerbatim(LOWER_CASE_TWIN_DATABASE_NAME)}.${quoteMySqlIdentifierVerbatim(TABLE_NAME_IN_EACH_TWIN_DATABASE)} ` +
      '(code VARCHAR(10) PRIMARY KEY) ENGINE=InnoDB',
  );
}

function buildForeignKeyChildColumnsAndKeysSql(databaseName: string): string {
  const qualifiedParentTable = `${quoteMySqlIdentifierVerbatim(databaseName)}.${quoteMySqlIdentifierVerbatim(FOREIGN_KEY_PARENT_TABLE_NAME)}`;
  return (
    'id INT AUTO_INCREMENT PRIMARY KEY, first_parent_id INT NULL, second_parent_id INT NULL, ' +
    `CONSTRAINT ${quoteMySqlIdentifierVerbatim(ACCENTED_FOREIGN_KEY_CONSTRAINT_NAME)} ` +
    `FOREIGN KEY (first_parent_id) REFERENCES ${qualifiedParentTable} (id), ` +
    `CONSTRAINT ${quoteMySqlIdentifierVerbatim(UNACCENTED_FOREIGN_KEY_CONSTRAINT_NAME)} ` +
    `FOREIGN KEY (second_parent_id) REFERENCES ${qualifiedParentTable} (id)`
  );
}

/**
 * A plain knex (the production dialect and identifier quoting) whose every session runs with ONLY_FULL_GROUP_BY —
 * the strictest GROUP BY rules either server has. The connector sets its own sql_mode without it, so this is the
 * only place the catalog queries meet it.
 */
function createCatalogQueryKnexWithOnlyFullGroupBySessions(serverAddress: MySqlIntegrationServerAddress): Knex {
  const catalogQueryKnex = knex({
    client: ScratchMySql2KnexDialectClient,
    connection: {
      host: serverAddress.host,
      port: serverAddress.port,
      user: serverAddress.username,
      password: serverAddress.password,
      database: serverAddress.databaseName,
      ssl: { rejectUnauthorized: false },
    },
    pool: {
      min: 0,
      max: 1,
      afterCreate: (
        rawConnection: MySql2CallbackConnection,
        done: (error: Error | null, connection: MySql2CallbackConnection) => void,
      ) => {
        rawConnection.query("SET SESSION sql_mode = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES'", (error) =>
          done(error, rawConnection),
        );
      },
    },
  });
  applyMySqlVerbatimIdentifierQuoting(catalogQueryKnex);
  return catalogQueryKnex;
}

// ---------------------------------------------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------------------------------------------

describeForEachConfiguredMySqlIntegrationFlavor('MySQL catalog discovery with case / accent twin names', (flavor) => {
  const databaseName = flavor.applicationUserServerAddress.databaseName;
  const serverAcceptsForeignKeyNamesDifferingOnlyByAccent = flavor.flavorName === 'mariadb';
  const itWhen = (condition: boolean): jest.It => (condition ? it : it.skip);

  let adminConnection: MySqlAdminConnection | undefined;
  let scopedConnector: Connector<string, JsonSafeObject>;
  let unscopedRootConnector: Connector<string, JsonSafeObject>;
  let catalogQueryKnexWithOnlyFullGroupBy: Knex | undefined;

  const requireAdminConnection = (): MySqlAdminConnection => {
    if (!adminConnection) throw new Error('The admin connection was not opened (see beforeAll)');
    return adminConnection;
  };
  const requireCatalogQueryKnex = (): Knex => {
    if (!catalogQueryKnexWithOnlyFullGroupBy) throw new Error('The catalog query knex was not created (see beforeAll)');
    return catalogQueryKnexWithOnlyFullGroupBy;
  };
  const fetchTableSpec = (tableName: string): Promise<BaseJsonTableSpec> =>
    scopedConnector.fetchJsonTableSpec(entityIdForMySqlTable(databaseName, tableName));
  const scopedDiscovery: MySqlDiscoveryScope = {
    excludedDatabaseNames: MYSQL_SYSTEM_DATABASE_NAMES,
    onlyDatabaseName: databaseName,
  };

  beforeAll(async () => {
    if (flavor.rootUserServerAddress.databaseName !== databaseName) {
      throw new Error('The *_TEST_URL and *_TEST_ROOT_URL of a flavor must name the same database');
    }
    await waitForMySqlServerToAcceptConnections(flavor.rootUserServerAddress);
    adminConnection = await openMySqlAdminConnection(flavor.rootUserServerAddress);
    const [lowerCaseTableNamesRows] = await adminConnection.query<RowDataPacket[]>(
      'SELECT @@lower_case_table_names AS lower_case_table_names',
    );
    if (Number(lowerCaseTableNamesRows[0]?.lower_case_table_names) !== 0) {
      // With 1 / 2 the server folds names itself, so the twin tables below can't even be created.
      throw new Error('This spec needs a server with lower_case_table_names=0 (the Linux / Docker default)');
    }
    await dropThisSpecsTablesAndDatabases(adminConnection, databaseName);
    await createCollationFixtures(adminConnection, databaseName, { serverAcceptsForeignKeyNamesDifferingOnlyByAccent });
    scopedConnector = await createMySqlConnectorThroughRegistryForIntegrationTest(
      buildMySqlConnectorCredentialsForIntegrationTest(flavor.applicationUserServerAddress),
    );
    // Root sees the root-created twin databases; an empty database name means "no database configured".
    unscopedRootConnector = await createMySqlConnectorThroughRegistryForIntegrationTest(
      buildMySqlConnectorCredentialsForIntegrationTest(flavor.rootUserServerAddress, { databaseName: '' }),
    );
    catalogQueryKnexWithOnlyFullGroupBy = createCatalogQueryKnexWithOnlyFullGroupBySessions(
      flavor.applicationUserServerAddress,
    );
  }, 150_000);

  afterAll(async () => {
    await catalogQueryKnexWithOnlyFullGroupBy?.destroy();
    if (!adminConnection) return;
    try {
      // Set SKIP_CLEANUP=1 locally to leave the fixture tables and databases in place for inspection.
      if (process.env.SKIP_CLEANUP !== '1') {
        await dropThisSpecsTablesAndDatabases(adminConnection, databaseName);
      }
    } finally {
      await adminConnection.end();
    }
  });

  describe('listTables (configured database)', () => {
    let tablePreviews: TablePreview[];

    beforeAll(async () => {
      tablePreviews = await scopedConnector.listTables();
    });

    it('lists both tables of a case pair with different keys; only the AUTO_INCREMENT one takes creates', () => {
      const autoIncrementTwinPreview = findTablePreviewByExactRemoteId(
        tablePreviews,
        databaseName,
        CASE_TWIN_WITH_AUTO_INCREMENT_ID_TABLE_NAME,
      );
      const varcharKeyTwinPreview = findTablePreviewByExactRemoteId(
        tablePreviews,
        databaseName,
        CASE_TWIN_WITH_VARCHAR_CODE_KEY_TABLE_NAME,
      );
      expect(autoIncrementTwinPreview.displayName).toBe(CASE_TWIN_WITH_AUTO_INCREMENT_ID_TABLE_NAME);
      expect(varcharKeyTwinPreview.displayName).toBe(CASE_TWIN_WITH_VARCHAR_CODE_KEY_TABLE_NAME);
      expect(pickTablePreviewAvailabilityFlags(autoIncrementTwinPreview)).toEqual(FULLY_USABLE_TABLE_PREVIEW_FLAGS);
      expect(pickTablePreviewAvailabilityFlags(varcharKeyTwinPreview)).toEqual(CREATES_DISABLED_TABLE_PREVIEW_FLAGS);
    });

    it("lists both tables of an accent pair; the twin's same-named AUTO_INCREMENT `id` is never lent across", () => {
      expect(
        pickTablePreviewAvailabilityFlags(
          findTablePreviewByExactRemoteId(tablePreviews, databaseName, ACCENTED_TWIN_WITH_PLAIN_INTEGER_ID_TABLE_NAME),
        ),
      ).toEqual(CREATES_DISABLED_TABLE_PREVIEW_FLAGS);
      expect(
        pickTablePreviewAvailabilityFlags(
          findTablePreviewByExactRemoteId(
            tablePreviews,
            databaseName,
            UNACCENTED_TWIN_WITH_AUTO_INCREMENT_ID_TABLE_NAME,
          ),
        ),
      ).toEqual(FULLY_USABLE_TABLE_PREVIEW_FLAGS);
    });

    it('lists both tables of a case pair that are both AUTO_INCREMENT as fully usable (no DISTINCT folding)', () => {
      for (const twinTableName of [
        UPPER_CASE_TWIN_BOTH_AUTO_INCREMENT_TABLE_NAME,
        LOWER_CASE_TWIN_BOTH_AUTO_INCREMENT_TABLE_NAME,
      ]) {
        expect(
          pickTablePreviewAvailabilityFlags(
            findTablePreviewByExactRemoteId(tablePreviews, databaseName, twinTableName),
          ),
        ).toEqual(FULLY_USABLE_TABLE_PREVIEW_FLAGS);
      }
    });

    it('enables a table whose only unique indexes are named `idx_café` and `idx_cafe` (creates off: no primary key)', () => {
      expect(
        pickTablePreviewAvailabilityFlags(
          findTablePreviewByExactRemoteId(tablePreviews, databaseName, ACCENT_TWIN_UNIQUE_INDEXES_TABLE_NAME),
        ),
      ).toEqual(CREATES_DISABLED_TABLE_PREVIEW_FLAGS);
    });
  });

  describe('fetchJsonTableSpec and pulls (configured database)', () => {
    it("addresses each case twin by its own key and reads only that twin's columns and rows", async () => {
      const autoIncrementTwinSpec = await fetchTableSpec(CASE_TWIN_WITH_AUTO_INCREMENT_ID_TABLE_NAME);
      const varcharKeyTwinSpec = await fetchTableSpec(CASE_TWIN_WITH_VARCHAR_CODE_KEY_TABLE_NAME);
      expect(autoIncrementTwinSpec.idPath).toBe('id');
      expect(readSchemaPropertyNames(autoIncrementTwinSpec)).toEqual(['id', 'upper_case_twin_only']);
      expect(varcharKeyTwinSpec.idPath).toBe('code');
      expect(readSchemaPropertyNames(varcharKeyTwinSpec)).toEqual(['code', 'lower_case_twin_only']);

      expect(await pullEveryRecordFile(scopedConnector, autoIncrementTwinSpec)).toEqual([
        { id: 1, upper_case_twin_only: 'U' },
      ]);
      expect(await pullEveryRecordFile(scopedConnector, varcharKeyTwinSpec)).toEqual([
        { code: 'k', lower_case_twin_only: 'L' },
      ]);
    });

    it("reads each accent twin's own columns", async () => {
      expect(readSchemaPropertyNames(await fetchTableSpec(ACCENTED_TWIN_WITH_PLAIN_INTEGER_ID_TABLE_NAME))).toEqual([
        'accented_twin_only',
        'id',
      ]);
      expect(readSchemaPropertyNames(await fetchTableSpec(UNACCENTED_TWIN_WITH_AUTO_INCREMENT_ID_TABLE_NAME))).toEqual([
        'id',
        'unaccented_twin_only',
      ]);
    });

    it('keeps unique indexes `idx_café` and `idx_cafe` apart, so the table has a real id', async () => {
      const accentTwinIndexesSpec = await fetchTableSpec(ACCENT_TWIN_UNIQUE_INDEXES_TABLE_NAME);
      expect(accentTwinIndexesSpec.idPath).toBe('a');
      expect(accentTwinIndexesSpec.idPathRequiresUserSelection).toBeFalsy();
    });

    it('never offers the non-unique `cafe` column as the id because the `café` column is unique', async () => {
      const accentTwinColumnsSpec = await fetchTableSpec(ACCENT_TWIN_COLUMNS_TABLE_NAME);
      expect(accentTwinColumnsSpec.idPath).toBe(ACCENTED_UNIQUE_COLUMN_NAME);
      expect(accentTwinColumnsSpec.idPathRequiresUserSelection).toBeFalsy();
    });

    itWhen(serverAcceptsForeignKeyNamesDifferingOnlyByAccent)(
      'annotates both foreign keys whose constraint names differ only by an accent (MariaDB)',
      async () => {
        const foreignKeyChildSpec = await fetchTableSpec(FOREIGN_KEY_CHILD_TABLE_NAME);
        const childSchemaProperties = (foreignKeyChildSpec.schema as TObject).properties;
        const expectedForeignKeyOptions = {
          linkedTableId: `${databaseName}.${FOREIGN_KEY_PARENT_TABLE_NAME}`,
          linkedTableRemoteId: [databaseName, FOREIGN_KEY_PARENT_TABLE_NAME],
        };
        expect(childSchemaProperties.first_parent_id).toMatchObject({
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: expectedForeignKeyOptions,
        });
        expect(childSchemaProperties.second_parent_id).toMatchObject({
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: expectedForeignKeyOptions,
        });
      },
    );

    itWhen(!serverAcceptsForeignKeyNamesDifferingOnlyByAccent)(
      'MySQL itself refuses two foreign-key names that differ only by an accent (1826), so only MariaDB has the pair',
      async () => {
        const qualifiedChildTable = `${quoteMySqlIdentifierVerbatim(databaseName)}.${quoteMySqlIdentifierVerbatim(FOREIGN_KEY_CHILD_TABLE_NAME)}`;
        await requireAdminConnection().query(
          `CREATE TABLE ${quoteMySqlIdentifierVerbatim(databaseName)}.${quoteMySqlIdentifierVerbatim(FOREIGN_KEY_PARENT_TABLE_NAME)} ` +
            '(id INT AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB',
        );
        await expect(
          requireAdminConnection().query(
            `CREATE TABLE ${qualifiedChildTable} (${buildForeignKeyChildColumnsAndKeysSql(databaseName)}) ENGINE=InnoDB`,
          ),
        ).rejects.toMatchObject({ errno: MYSQL_DUPLICATE_FOREIGN_KEY_NAME_ERRNO });
      },
    );
  });

  describe('no database configured (root)', () => {
    it('lists the same-named table in two databases that differ only by case, each with its own flags', async () => {
      const unscopedTablePreviews = await unscopedRootConnector.listTables();
      expect(
        pickTablePreviewAvailabilityFlags(
          findTablePreviewByExactRemoteId(
            unscopedTablePreviews,
            UPPER_CASE_TWIN_DATABASE_NAME,
            TABLE_NAME_IN_EACH_TWIN_DATABASE,
          ),
        ),
      ).toEqual(FULLY_USABLE_TABLE_PREVIEW_FLAGS);
      expect(
        pickTablePreviewAvailabilityFlags(
          findTablePreviewByExactRemoteId(
            unscopedTablePreviews,
            LOWER_CASE_TWIN_DATABASE_NAME,
            TABLE_NAME_IN_EACH_TWIN_DATABASE,
          ),
        ),
      ).toEqual(CREATES_DISABLED_TABLE_PREVIEW_FLAGS);
    });

    it('offers both twin databases as create destinations', async () => {
      if (!unscopedRootConnector.listCreateDestinations) {
        throw new Error('The MySQL connector must implement listCreateDestinations');
      }
      const createDestinationIds = (await unscopedRootConnector.listCreateDestinations()).map(
        (createDestination) => createDestination.id,
      );
      expect(createDestinationIds).toEqual(
        expect.arrayContaining([UPPER_CASE_TWIN_DATABASE_NAME, LOWER_CASE_TWIN_DATABASE_NAME]),
      );
    });
  });

  describe('catalog queries in an ONLY_FULL_GROUP_BY session', () => {
    it('runs with ONLY_FULL_GROUP_BY actually on', async () => {
      const [sessionSqlModeRows] = (await requireCatalogQueryKnex().raw(
        'SELECT @@SESSION.sql_mode AS session_sql_mode',
      )) as [{ session_sql_mode: string }[], unknown];
      expect(sessionSqlModeRows[0].session_sql_mode).toContain('ONLY_FULL_GROUP_BY');
    });

    it('returns the exact names of every twin from the scope-wide unique-index and AUTO_INCREMENT lookups', async () => {
      const tablesWithSingleColumnUniqueIndex = await findTablesWithSingleColumnUniqueIndex(
        requireCatalogQueryKnex(),
        scopedDiscovery,
      );
      const tablesWithAutoIncrementPrimaryKey = await findTablesWithAutoIncrementPrimaryKey(
        requireCatalogQueryKnex(),
        scopedDiscovery,
      );
      const hasSingleColumnUniqueIndex = (tableName: string): boolean =>
        tablesWithSingleColumnUniqueIndex.has(buildMySqlTableLookupKey(databaseName, tableName));
      const hasAutoIncrementPrimaryKey = (tableName: string): boolean =>
        tablesWithAutoIncrementPrimaryKey.has(buildMySqlTableLookupKey(databaseName, tableName));

      const everyTwinTableName = [
        CASE_TWIN_WITH_AUTO_INCREMENT_ID_TABLE_NAME,
        CASE_TWIN_WITH_VARCHAR_CODE_KEY_TABLE_NAME,
        ACCENTED_TWIN_WITH_PLAIN_INTEGER_ID_TABLE_NAME,
        UNACCENTED_TWIN_WITH_AUTO_INCREMENT_ID_TABLE_NAME,
        UPPER_CASE_TWIN_BOTH_AUTO_INCREMENT_TABLE_NAME,
        LOWER_CASE_TWIN_BOTH_AUTO_INCREMENT_TABLE_NAME,
        ACCENT_TWIN_UNIQUE_INDEXES_TABLE_NAME,
        ACCENT_TWIN_COLUMNS_TABLE_NAME,
      ];
      expect(
        Object.fromEntries(everyTwinTableName.map((tableName) => [tableName, hasSingleColumnUniqueIndex(tableName)])),
      ).toEqual(Object.fromEntries(everyTwinTableName.map((tableName) => [tableName, true])));
      expect(
        Object.fromEntries(
          [
            CASE_TWIN_WITH_AUTO_INCREMENT_ID_TABLE_NAME,
            CASE_TWIN_WITH_VARCHAR_CODE_KEY_TABLE_NAME,
            ACCENTED_TWIN_WITH_PLAIN_INTEGER_ID_TABLE_NAME,
            UNACCENTED_TWIN_WITH_AUTO_INCREMENT_ID_TABLE_NAME,
            UPPER_CASE_TWIN_BOTH_AUTO_INCREMENT_TABLE_NAME,
            LOWER_CASE_TWIN_BOTH_AUTO_INCREMENT_TABLE_NAME,
          ].map((tableName) => [tableName, hasAutoIncrementPrimaryKey(tableName)]),
        ),
      ).toEqual({
        [CASE_TWIN_WITH_AUTO_INCREMENT_ID_TABLE_NAME]: true,
        [CASE_TWIN_WITH_VARCHAR_CODE_KEY_TABLE_NAME]: false,
        [ACCENTED_TWIN_WITH_PLAIN_INTEGER_ID_TABLE_NAME]: false,
        [UNACCENTED_TWIN_WITH_AUTO_INCREMENT_ID_TABLE_NAME]: true,
        [UPPER_CASE_TWIN_BOTH_AUTO_INCREMENT_TABLE_NAME]: true,
        [LOWER_CASE_TWIN_BOTH_AUTO_INCREMENT_TABLE_NAME]: true,
      });
    });

    it('lists the accent-twin unique indexes separately and joins only the unique `café` column', async () => {
      const accentTwinIndexColumns = await findSingleColumnUniqueIndexColumns(requireCatalogQueryKnex(), {
        databaseName,
        tableName: ACCENT_TWIN_UNIQUE_INDEXES_TABLE_NAME,
      });
      expect(accentTwinIndexColumns.map(({ indexName, columnName }) => [indexName, columnName])).toEqual([
        [ACCENTED_UNIQUE_INDEX_NAME, 'a'],
        [UNACCENTED_UNIQUE_INDEX_NAME, 'b'],
      ]);

      const accentTwinColumnUniqueIndexColumns = await findSingleColumnUniqueIndexColumns(requireCatalogQueryKnex(), {
        databaseName,
        tableName: ACCENT_TWIN_COLUMNS_TABLE_NAME,
      });
      expect(accentTwinColumnUniqueIndexColumns.map(({ columnName }) => columnName)).toEqual([
        ACCENTED_UNIQUE_COLUMN_NAME,
      ]);
    });

    itWhen(serverAcceptsForeignKeyNamesDifferingOnlyByAccent)(
      'returns both foreign keys whose constraint names differ only by an accent (MariaDB)',
      async () => {
        const foreignKeys = await findSingleColumnForeignKeysInTable(requireCatalogQueryKnex(), {
          databaseName,
          tableName: FOREIGN_KEY_CHILD_TABLE_NAME,
        });
        // A Map compares order-independently (the query orders by MariaDB's accent-insensitive collation).
        expect(new Map(foreignKeys.map(({ constraintName, columnName }) => [constraintName, columnName]))).toEqual(
          new Map([
            [ACCENTED_FOREIGN_KEY_CONSTRAINT_NAME, 'first_parent_id'],
            [UNACCENTED_FOREIGN_KEY_CONSTRAINT_NAME, 'second_parent_id'],
          ]),
        );
      },
    );
  });
});
