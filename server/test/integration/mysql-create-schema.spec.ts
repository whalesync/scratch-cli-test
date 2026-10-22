/**
 * MySQL create-schema integration test (DEV-12035): real DDL against MySQL 8.4 and MariaDB 11.4.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * What this validates that the unit tests don't
 * ═══════════════════════════════════════════════════════════════════════════
 * The pure builders (`library/mysql/__tests__/mysql-create-schema.spec.ts`) assert the generated SQL against a
 * connection-less knex. This spec runs the registry-built `MysqlConnector` against real servers and proves what
 * a Live Export into MySQL relies on:
 *
 *   1. createTable maps every supported logical kind to the column the PLAN specifies (read back from
 *      information_schema.COLUMNS), with an injected `bigint unsigned auto_increment` id primary key, ENGINE InnoDB
 *      and utf8mb4 — and keeps awkward names verbatim (`Dealroom.co URL`, `Featured?`, spaces, 64 characters).
 *   2. Fields MySQL can't hold (reserved `id`, multiSelect, `isArray`, emoji / over-long names) are skipped with a
 *      reason while the rest of the table lands.
 *   3. A foreign key is ONE atomic `ALTER TABLE … ADD COLUMN …, ADD CONSTRAINT … ON DELETE SET NULL`: deleting the
 *      parent row nulls the reference, and a reference MySQL rejects (3780 / MariaDB 1005) leaves no column behind.
 *   4. Unresolvable foreign-key targets (MyISAM, TEXT / BINARY / prefix-only keys, views, composite keys, missing
 *      tables) are per-field skips with a reason.
 *   5. The created tables round-trip through the connector's own read side (listTables: creatable;
 *      fetchJsonTableSpec: FK annotation) and accept createRecords, which returns the AUTO_INCREMENT id.
 *   6. Database scoping, duplicate tables (1050), MySQL → MySQL native type fidelity (and refusal of types that
 *      can't be recreated safely), the 180-field / 64-character row-size cap.
 *   7. The field-value canonicalizer: values MySQL re-renders on write (offset DATETIME, DECIMAL scale, FLOAT, BOOLEAN,
 *      ENUM case, SET order, JSON, integer and FLOAT/DOUBLE(M,D) rounding, TIME) compare equal to what the next pull
 *      reads back — so a Live Export re-run is a no-op.
 *
 * Every table / view is named `scratch_mysql_it_ddl_*`, created by this spec, and dropped before (and, unless
 * SKIP_CLEANUP=1, after) the run. The seeded `companies` / `deals` tables are never touched.
 *
 * Run via (from server/, with server/localdev/docker-compose.mysql.yml up):
 *   MYSQL_TEST_URL=mysql://test:test@127.0.0.1:3306/test_db MYSQL_TEST_ROOT_URL=mysql://root:root@127.0.0.1:3306/test_db \
 *   MARIADB_TEST_URL=mysql://test:test@127.0.0.1:3307/test_db MARIADB_TEST_ROOT_URL=mysql://root:root@127.0.0.1:3307/test_db \
 *   yarn test:integration test/integration/mysql-create-schema --runInBand
 */
import {
  PostgresColumnType,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_NATIVE_COLUMN_TYPE,
  X_SCRATCH_READONLY,
  type CreateFieldResult,
  type CreateTableResult,
  type DecryptedCredentials,
} from '@spinner/shared-types';
import isEqual from 'lodash/isEqual';
import { type Connection as MySqlAdminConnection, type RowDataPacket } from 'mysql2/promise';
import { connectorRegistry } from 'src/remote-service/connectors/connector-registry';
import {
  areFieldValuesCanonicallyEqual,
  resolveFieldValueCanonicalizersForTable,
} from 'src/remote-service/connectors/field-value-canonicalization';
import { MYSQL_SYSTEM_DATABASE_NAMES } from 'src/remote-service/connectors/library/mysql/mysql-catalog-types';
import { MysqlConnector } from 'src/remote-service/connectors/library/mysql/mysql-connector';
import {
  buildMySqlForeignKeyConstraintName,
  MYSQL_MAX_FIELDS_PER_CREATED_TABLE,
  MYSQL_MAX_IDENTIFIER_LENGTH,
} from 'src/remote-service/connectors/library/mysql/mysql-create-schema';
import { resolveMySqlFieldValueCanonicalizer } from 'src/remote-service/connectors/library/mysql/mysql-field-value-canonicalizer';
import { type ResolvedCreateFieldSpec } from 'src/remote-service/connectors/schema-creation.types';
import { Service } from 'src/remote-service/connectors/service-constants';
import { type BaseJsonTableSpec, type ConnectorFile } from 'src/remote-service/connectors/types';
import {
  buildMySqlConnectorCredentialsForIntegrationTest,
  createMySqlConnectorThroughRegistryForIntegrationTest,
  describeForEachConfiguredMySqlIntegrationFlavor,
  expectUserFacingErrorMessageToLeakNoNetworkOrSqlDetails,
  MYSQL_INTEGRATION_IDENTIFIER_PREFIX,
  openMySqlAdminConnection,
  waitForMySqlServerToAcceptConnections,
  type MySqlIntegrationFlavor,
} from './mysql-integration-helpers';

jest.setTimeout(60_000);

/** Every table and view this spec creates starts with this, so its cleanup never touches another spec's tables. */
const CREATE_SCHEMA_SPEC_TABLE_PREFIX = `${MYSQL_INTEGRATION_IDENTIFIER_PREFIX}ddl_`;

const EVERY_KIND_TABLE_NAME = `${CREATE_SCHEMA_SPEC_TABLE_PREFIX}every_kind`;
const PARENT_TABLE_NAME = `${CREATE_SCHEMA_SPEC_TABLE_PREFIX}parent`;
/** A space, a dot and capitals: the table name must reach MySQL verbatim (Connector Prime Directive). */
const CHILD_TABLE_NAME_WITH_SPACE_AND_DOT = `${CREATE_SCHEMA_SPEC_TABLE_PREFIX}Child rows.io`;
const UNRESOLVABLE_FOREIGN_KEY_CHILD_TABLE_NAME = `${CREATE_SCHEMA_SPEC_TABLE_PREFIX}unresolvable_fk_child`;
const MYISAM_TARGET_TABLE_NAME = `${CREATE_SCHEMA_SPEC_TABLE_PREFIX}myisam_target`;
const TEXT_PRIMARY_KEY_TARGET_TABLE_NAME = `${CREATE_SCHEMA_SPEC_TABLE_PREFIX}text_pk_target`;
const PREFIX_ONLY_UNIQUE_KEY_TARGET_TABLE_NAME = `${CREATE_SCHEMA_SPEC_TABLE_PREFIX}prefix_unique_target`;
const BINARY_PRIMARY_KEY_TARGET_TABLE_NAME = `${CREATE_SCHEMA_SPEC_TABLE_PREFIX}binary_pk_target`;
const COMPOSITE_PRIMARY_KEY_TARGET_TABLE_NAME = `${CREATE_SCHEMA_SPEC_TABLE_PREFIX}composite_pk_target`;
const VIEW_TARGET_NAME = `${CREATE_SCHEMA_SPEC_TABLE_PREFIX}view_target`;
const MISSING_TARGET_TABLE_NAME = `${CREATE_SCHEMA_SPEC_TABLE_PREFIX}missing_target`;
const RETRY_TABLE_NAME = `${CREATE_SCHEMA_SPEC_TABLE_PREFIX}retry`;
const OTHER_REQUEST_TABLE_NAME = `${CREATE_SCHEMA_SPEC_TABLE_PREFIX}other_request`;
const ATOMICITY_PARENT_TABLE_NAME = `${CREATE_SCHEMA_SPEC_TABLE_PREFIX}atomic_parent`;
const ATOMICITY_CHILD_TABLE_NAME = `${CREATE_SCHEMA_SPEC_TABLE_PREFIX}atomic_child`;
const PARTITIONED_TARGET_TABLE_NAME = `${CREATE_SCHEMA_SPEC_TABLE_PREFIX}partitioned_target`;
const DEFAULT_DATABASE_TABLE_NAME = `${CREATE_SCHEMA_SPEC_TABLE_PREFIX}default_database`;
const UNSCOPED_CONNECTION_TABLE_NAME = `${CREATE_SCHEMA_SPEC_TABLE_PREFIX}unscoped_connection`;
const NATIVE_TYPES_TABLE_NAME = `${CREATE_SCHEMA_SPEC_TABLE_PREFIX}native_types`;
const INJECTION_CANARY_TABLE_NAME = `${CREATE_SCHEMA_SPEC_TABLE_PREFIX}injection_canary`;
const CANONICALIZER_TABLE_NAME = `${CREATE_SCHEMA_SPEC_TABLE_PREFIX}canonicalizer`;
/** Exactly MySQL's 64-character identifier limit. */
const ROW_SIZE_CAP_TABLE_NAME_OF_MAXIMUM_LENGTH = `${CREATE_SCHEMA_SPEC_TABLE_PREFIX}row_size_cap_`.padEnd(
  MYSQL_MAX_IDENTIFIER_LENGTH,
  'x',
);
/** A database this spec never creates: the scoped connection must refuse it before any DDL. */
const OUT_OF_SCOPE_DATABASE_NAME = `${CREATE_SCHEMA_SPEC_TABLE_PREFIX}other_database`;

const FIELD_NAME_OF_MAXIMUM_LENGTH = 'Field name at the MySQL identifier limit '.padEnd(
  MYSQL_MAX_IDENTIFIER_LENGTH,
  'z',
);
const FIELD_NAME_ONE_CHARACTER_OVER_THE_LIMIT = `${FIELD_NAME_OF_MAXIMUM_LENGTH}z`;
const FIELD_NAME_WITH_EMOJI = 'Mood 😀';

/**
 * One field of every non-foreign-key kind the connector supports, with the awkward real-world names Scratch must
 * keep verbatim. (Foreign keys are covered by their own tests below.)
 */
const EVERY_SUPPORTED_NON_FOREIGN_KEY_KIND_FIELDS: ResolvedCreateFieldSpec[] = [
  { name: 'Company name', fieldType: { kind: 'text' }, required: true },
  { name: 'Notes', fieldType: { kind: 'longText' } },
  { name: 'Employee count', fieldType: { kind: 'number', format: 'integer' } },
  { name: 'Score', fieldType: { kind: 'number', format: 'plain' } },
  { name: 'Win rate', fieldType: { kind: 'number', format: 'percent' } },
  { name: 'Exact ratio', fieldType: { kind: 'number', format: 'decimal', precision: 3 } },
  { name: 'Unbounded ratio', fieldType: { kind: 'number', format: 'decimal' } },
  { name: 'Deal size', fieldType: { kind: 'currency', currencyCode: 'USD' } },
  { name: 'Fee', fieldType: { kind: 'currency', currencyCode: 'EUR', precision: 2 } },
  { name: 'Featured?', fieldType: { kind: 'boolean' } },
  { name: 'Founded on', fieldType: { kind: 'date' } },
  { name: 'Marked as done time', fieldType: { kind: 'date', includesTime: true } },
  { name: 'Stage', fieldType: { kind: 'select', options: [{ name: 'Lead' }, { name: 'Won' }] } },
  { name: 'Dealroom.co URL', fieldType: { kind: 'url' } },
  { name: 'Contact email', fieldType: { kind: 'email' } },
  { name: 'Phone', fieldType: { kind: 'phone' } },
  { name: 'Raw payload', fieldType: { kind: 'json' } },
  { name: FIELD_NAME_OF_MAXIMUM_LENGTH, fieldType: { kind: 'text' } },
];

/** Fields the connector must skip (each with a reason matching the pattern) without failing the table. */
const EVERY_KIND_TABLE_FIELDS_EXPECTED_TO_BE_SKIPPED: { field: ResolvedCreateFieldSpec; skipReasonPattern: RegExp }[] =
  [
    { field: { name: 'id', fieldType: { kind: 'text' } }, skipReasonPattern: /"id" is reserved/ },
    {
      field: { name: 'Tags', fieldType: { kind: 'multiSelect', options: [{ name: 'a' }] } },
      skipReasonPattern: /is a multi-select, but MySQL has no list column/,
    },
    {
      field: { name: 'Aliases', fieldType: { kind: 'text', isArray: true } },
      skipReasonPattern: /is a list, but MySQL has no list column/,
    },
    {
      field: { name: FIELD_NAME_WITH_EMOJI, fieldType: { kind: 'text' } },
      skipReasonPattern: /outside the Basic Multilingual Plane/,
    },
    {
      field: { name: FIELD_NAME_ONE_CHARACTER_OVER_THE_LIMIT, fieldType: { kind: 'text' } },
      skipReasonPattern: /is 65 characters long; MySQL allows at most 64/,
    },
  ];

interface ExpectedCreatedColumn {
  /** `information_schema.COLUMNS.COLUMN_TYPE` on MySQL 8.4. */
  mysqlColumnType: string;
  /** The same on MariaDB 11.4, when it differs (integer display widths, the JSON → LONGTEXT alias). */
  mariaDbColumnType?: string;
  isNullable: 'YES' | 'NO';
}

/** The PLAN's kind → column mapping (`.context/dev-12035/PLAN.md` → DDL), per field of the every-kind table. */
const EXPECTED_EVERY_KIND_TABLE_COLUMNS: Record<string, ExpectedCreatedColumn> = {
  id: { mysqlColumnType: 'bigint unsigned', mariaDbColumnType: 'bigint(20) unsigned', isNullable: 'NO' },
  'Company name': { mysqlColumnType: 'mediumtext', isNullable: 'NO' },
  Notes: { mysqlColumnType: 'longtext', isNullable: 'YES' },
  'Employee count': { mysqlColumnType: 'int', mariaDbColumnType: 'int(11)', isNullable: 'YES' },
  Score: { mysqlColumnType: 'double', isNullable: 'YES' },
  'Win rate': { mysqlColumnType: 'double', isNullable: 'YES' },
  'Exact ratio': { mysqlColumnType: 'decimal(11,3)', isNullable: 'YES' },
  'Unbounded ratio': { mysqlColumnType: 'decimal(65,30)', isNullable: 'YES' },
  'Deal size': { mysqlColumnType: 'decimal(12,4)', isNullable: 'YES' },
  Fee: { mysqlColumnType: 'decimal(10,2)', isNullable: 'YES' },
  'Featured?': { mysqlColumnType: 'tinyint(1)', isNullable: 'YES' },
  'Founded on': { mysqlColumnType: 'date', isNullable: 'YES' },
  'Marked as done time': { mysqlColumnType: 'datetime(3)', isNullable: 'YES' },
  Stage: { mysqlColumnType: 'mediumtext', isNullable: 'YES' },
  'Dealroom.co URL': { mysqlColumnType: 'mediumtext', isNullable: 'YES' },
  'Contact email': { mysqlColumnType: 'mediumtext', isNullable: 'YES' },
  Phone: { mysqlColumnType: 'mediumtext', isNullable: 'YES' },
  'Raw payload': { mysqlColumnType: 'json', mariaDbColumnType: 'longtext', isNullable: 'YES' },
  [FIELD_NAME_OF_MAXIMUM_LENGTH]: { mysqlColumnType: 'mediumtext', isNullable: 'YES' },
};

interface CreatedColumnFromCatalog {
  columnName: string;
  dataType: string;
  columnType: string;
  isNullable: string;
  extra: string;
  columnKey: string;
  characterSetName: string | null;
}

interface ForeignKeyConstraintFromCatalog {
  constraintName: string;
  columnName: string;
  referencedDatabaseName: string;
  referencedTableName: string;
  referencedColumnName: string;
  deleteRule: string;
}

function expectedColumnTypeForFlavor(expectedColumn: ExpectedCreatedColumn, flavor: MySqlIntegrationFlavor): string {
  return flavor.flavorName === 'mariadb'
    ? (expectedColumn.mariaDbColumnType ?? expectedColumn.mysqlColumnType)
    : expectedColumn.mysqlColumnType;
}

/**
 * A backtick-quoted identifier for the ADMIN connection's SQL, kept verbatim. Not mysql2's `??`: it splits on `.`,
 * so `Child rows.io` would become `` `Child rows`.`io` `` (a different, qualified name).
 */
function quoteIdentifierVerbatimForAdminSql(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``;
}

function quoteQualifiedTableNameForAdminSql(databaseName: string, tableName: string): string {
  return `${quoteIdentifierVerbatimForAdminSql(databaseName)}.${quoteIdentifierVerbatimForAdminSql(tableName)}`;
}

/** Drop only THIS spec's tables and views (FK checks off, so order doesn't matter). Other specs' tables stay. */
async function dropCreateSchemaSpecTablesAndViews(
  adminConnection: MySqlAdminConnection,
  databaseName: string,
): Promise<void> {
  const [createSchemaSpecTables] = await adminConnection.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS table_name, TABLE_TYPE AS table_type FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE 'scratch\\_mysql\\_it\\_ddl\\_%'`,
    [databaseName],
  );
  await adminConnection.query('SET SESSION FOREIGN_KEY_CHECKS = 0');
  try {
    for (const createSchemaSpecTable of createSchemaSpecTables) {
      const dropStatementPrefix =
        createSchemaSpecTable.table_type === 'VIEW' ? 'DROP VIEW IF EXISTS' : 'DROP TABLE IF EXISTS';
      await adminConnection.query(
        `${dropStatementPrefix} ${quoteQualifiedTableNameForAdminSql(databaseName, String(createSchemaSpecTable.table_name))}`,
      );
    }
  } finally {
    await adminConnection.query('SET SESSION FOREIGN_KEY_CHECKS = 1');
  }
}

async function readColumnsOfTableFromCatalog(
  adminConnection: MySqlAdminConnection,
  databaseName: string,
  tableName: string,
): Promise<Map<string, CreatedColumnFromCatalog>> {
  const [columnRows] = await adminConnection.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, COLUMN_TYPE AS column_type,
            IS_NULLABLE AS is_nullable, EXTRA AS extra, COLUMN_KEY AS column_key,
            CHARACTER_SET_NAME AS character_set_name
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [databaseName, tableName],
  );
  return new Map(
    columnRows.map((columnRow) => [
      String(columnRow.column_name),
      {
        columnName: String(columnRow.column_name),
        dataType: String(columnRow.data_type),
        columnType: String(columnRow.column_type),
        isNullable: String(columnRow.is_nullable),
        extra: String(columnRow.extra),
        columnKey: String(columnRow.column_key),
        characterSetName: columnRow.character_set_name === null ? null : String(columnRow.character_set_name),
      },
    ]),
  );
}

async function readForeignKeyConstraintsOfTableFromCatalog(
  adminConnection: MySqlAdminConnection,
  databaseName: string,
  tableName: string,
): Promise<ForeignKeyConstraintFromCatalog[]> {
  const [constraintRows] = await adminConnection.query<RowDataPacket[]>(
    `SELECT key_column.CONSTRAINT_NAME AS constraint_name, key_column.COLUMN_NAME AS column_name,
            key_column.REFERENCED_TABLE_SCHEMA AS referenced_database_name,
            key_column.REFERENCED_TABLE_NAME AS referenced_table_name,
            key_column.REFERENCED_COLUMN_NAME AS referenced_column_name,
            referential_constraint.DELETE_RULE AS delete_rule
     FROM information_schema.KEY_COLUMN_USAGE AS key_column
     JOIN information_schema.REFERENTIAL_CONSTRAINTS AS referential_constraint
       ON referential_constraint.CONSTRAINT_SCHEMA = key_column.CONSTRAINT_SCHEMA
      AND referential_constraint.CONSTRAINT_NAME = key_column.CONSTRAINT_NAME
      AND referential_constraint.TABLE_NAME = key_column.TABLE_NAME
     WHERE key_column.TABLE_SCHEMA = ? AND key_column.TABLE_NAME = ? AND key_column.REFERENCED_TABLE_NAME IS NOT NULL
     ORDER BY key_column.CONSTRAINT_NAME`,
    [databaseName, tableName],
  );
  return constraintRows.map((constraintRow) => ({
    constraintName: String(constraintRow.constraint_name),
    columnName: String(constraintRow.column_name),
    referencedDatabaseName: String(constraintRow.referenced_database_name),
    referencedTableName: String(constraintRow.referenced_table_name),
    referencedColumnName: String(constraintRow.referenced_column_name),
    deleteRule: String(constraintRow.delete_rule),
  }));
}

async function countTablesNamedInAnyDatabase(
  adminConnection: MySqlAdminConnection,
  tableName: string,
): Promise<number> {
  const [tableCountRows] = await adminConnection.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS table_count FROM information_schema.TABLES WHERE TABLE_NAME = ?',
    [tableName],
  );
  return Number(tableCountRows[0]?.table_count);
}

/** Build the connector exactly as production does (registry `createConnector`), narrowed to the MySQL class. */
async function createMySqlConnectorForSchemaCreation(
  decryptedCredentials: DecryptedCredentials,
): Promise<MysqlConnector> {
  const connector = await createMySqlConnectorThroughRegistryForIntegrationTest(decryptedCredentials);
  if (!(connector instanceof MysqlConnector)) {
    throw new Error('The registry built something other than a MysqlConnector for Service.MYSQL');
  }
  return connector;
}

function indexFieldResultsByName(fieldResults: CreateFieldResult[]): Map<string, CreateFieldResult> {
  return new Map(fieldResults.map((fieldResult) => [fieldResult.name, fieldResult]));
}

function expectEveryFieldToBeCreated(createTableResult: CreateTableResult): void {
  expect(createTableResult.fields).toEqual(
    createTableResult.fields.map((fieldResult) => ({
      name: fieldResult.name,
      status: 'created',
      remoteFieldId: fieldResult.name,
    })),
  );
}

function foreignKeyFieldTo(fieldName: string, targetRemoteTableId: string[]): ResolvedCreateFieldSpec {
  return { name: fieldName, fieldType: { kind: 'foreignKey', target: { existingRemoteTableId: targetRemoteTableId } } };
}

/** Pull every row and give it the JSON round-trip it gets on disk (what the next sync compares against). */
async function pullAllRecordFilesAsStoredOnDisk(
  connector: MysqlConnector,
  tableSpec: BaseJsonTableSpec,
): Promise<ConnectorFile[]> {
  const pulledRecordFiles: ConnectorFile[] = [];
  await connector.pullRecordFiles(
    tableSpec,
    ({ files }) => {
      pulledRecordFiles.push(...(JSON.parse(JSON.stringify(files)) as ConnectorFile[]));
      return Promise.resolve();
    },
    {},
    {},
  );
  return pulledRecordFiles;
}

/**
 * Poll the processlist until a statement mentioning `tableName` waits for a metadata lock — i.e. the connector's
 * ALTER is parked behind the lock the test holds.
 */
async function waitUntilSchemaChangeOnTableWaitsForMetadataLock(
  adminConnection: MySqlAdminConnection,
  tableName: string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const [waitingStatementRows] = await adminConnection.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS waiting_statement_count FROM information_schema.PROCESSLIST
       WHERE STATE = 'Waiting for table metadata lock' AND INFO LIKE ?`,
      [`%${tableName}%`],
    );
    if (Number(waitingStatementRows[0]?.waiting_statement_count) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No statement on ${tableName} started waiting for a metadata lock within 20 s`);
}

describeForEachConfiguredMySqlIntegrationFlavor('MySQL create-schema — real DDL round-trip', (flavor) => {
  const databaseName = flavor.applicationUserServerAddress.databaseName;
  let adminConnection: MySqlAdminConnection | undefined;
  let connector: MysqlConnector;

  /** The admin connection, which beforeAll always opens before any test runs. */
  function admin(): MySqlAdminConnection {
    if (!adminConnection) throw new Error('beforeAll did not open the admin connection');
    return adminConnection;
  }

  beforeAll(async () => {
    await waitForMySqlServerToAcceptConnections(flavor.rootUserServerAddress);
    adminConnection = await openMySqlAdminConnection(flavor.rootUserServerAddress);
    await dropCreateSchemaSpecTablesAndViews(adminConnection, databaseName);
    connector = await createMySqlConnectorForSchemaCreation(
      buildMySqlConnectorCredentialsForIntegrationTest(flavor.applicationUserServerAddress),
    );
  }, 120_000);

  afterAll(async () => {
    if (!adminConnection) return;
    try {
      // Set SKIP_CLEANUP=1 locally to leave the created tables in place for inspection (the next run drops them).
      // Leftover tables (SKIP_CLEANUP=1) are harmless: dropAllMySqlIntegrationTables quotes names verbatim, so other
      // MySQL specs' cleanup drops the dotted `…Child rows.io` table too.
      if (process.env.SKIP_CLEANUP !== '1') {
        await dropCreateSchemaSpecTablesAndViews(adminConnection, databaseName);
      }
    } finally {
      await adminConnection.end();
    }
  });

  it('lists the scoped database as the only create destination, never a system database', async () => {
    const createDestinations = await connector.listCreateDestinations();

    expect(createDestinations).toEqual([{ id: databaseName, name: databaseName, created: true }]);
  });

  it('creates every supported non-FK kind as the planned column, with an AUTO_INCREMENT bigint unsigned id, InnoDB and utf8mb4', async () => {
    // Self-check: the plan covers every kind the connector declares (foreign keys have their own tests).
    const supportedNonForeignKeyKinds = connector
      .getSchemaCreationCapabilities()
      .supportedFieldKinds.filter((fieldKind) => fieldKind !== 'foreignKey');
    expect(
      [...new Set(EVERY_SUPPORTED_NON_FOREIGN_KEY_KIND_FIELDS.map((field) => field.fieldType.kind))].sort(),
    ).toEqual([...supportedNonForeignKeyKinds].sort());

    const createTableResult = await connector.createTable({
      remoteParentId: [databaseName],
      ref: 'every_kind',
      name: EVERY_KIND_TABLE_NAME,
      fields: [
        ...EVERY_SUPPORTED_NON_FOREIGN_KEY_KIND_FIELDS,
        ...EVERY_KIND_TABLE_FIELDS_EXPECTED_TO_BE_SKIPPED.map(({ field }) => field),
      ],
      deferredFkFields: [],
    });

    // A skipped field makes the table `partial`, never `failed`: the rest of the table landed.
    expect(createTableResult.status).toBe('partial');
    expect(createTableResult.remoteTableId).toEqual([databaseName, EVERY_KIND_TABLE_NAME]);
    const fieldResultByName = indexFieldResultsByName(createTableResult.fields);
    for (const createdField of EVERY_SUPPORTED_NON_FOREIGN_KEY_KIND_FIELDS) {
      expect(fieldResultByName.get(createdField.name)).toEqual({
        name: createdField.name,
        status: 'created',
        remoteFieldId: createdField.name,
      });
    }
    for (const { field: skippedField, skipReasonPattern } of EVERY_KIND_TABLE_FIELDS_EXPECTED_TO_BE_SKIPPED) {
      const skippedFieldResult = fieldResultByName.get(skippedField.name);
      expect(skippedFieldResult?.status).toBe('skipped');
      expect(skippedFieldResult?.error).toMatch(skipReasonPattern);
    }

    const createdColumnByName = await readColumnsOfTableFromCatalog(admin(), databaseName, EVERY_KIND_TABLE_NAME);
    // Exactly the planned columns, names verbatim — no skipped field left a column behind.
    expect([...createdColumnByName.keys()].sort()).toEqual(Object.keys(EXPECTED_EVERY_KIND_TABLE_COLUMNS).sort());
    for (const [columnName, expectedColumn] of Object.entries(EXPECTED_EVERY_KIND_TABLE_COLUMNS)) {
      expect({ columnName, ...createdColumnByName.get(columnName) }).toMatchObject({
        columnName,
        columnType: expectedColumnTypeForFlavor(expectedColumn, flavor),
        isNullable: expectedColumn.isNullable,
      });
    }
    expect(createdColumnByName.get('id')).toMatchObject({ extra: 'auto_increment', columnKey: 'PRI' });
    // Text-like columns are utf8mb4, so emoji and 4-byte CJK values fit.
    for (const textColumnName of ['Company name', 'Notes', 'Stage', 'Dealroom.co URL']) {
      expect(createdColumnByName.get(textColumnName)?.characterSetName).toBe('utf8mb4');
    }

    const [tableRows] = await admin().query<RowDataPacket[]>(
      `SELECT ENGINE AS storage_engine, TABLE_COLLATION AS table_collation FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [databaseName, EVERY_KIND_TABLE_NAME],
    );
    expect(tableRows).toHaveLength(1);
    expect(tableRows[0].storage_engine).toBe('InnoDB');
    expect(String(tableRows[0].table_collation)).toMatch(/^utf8mb4_/);
  });

  it('inserts a record into the created table, returning the AUTO_INCREMENT id and the stored values', async () => {
    const everyKindTableSpec = await connector.fetchJsonTableSpec({
      wsId: 'every_kind',
      remoteId: [databaseName, EVERY_KIND_TABLE_NAME],
    });
    expect(everyKindTableSpec.idPath).toBe('id');
    // MariaDB's JSON is a LONGTEXT alias; the read side must still see a JSON column.
    const rawPayloadColumnSchema = (everyKindTableSpec.schema.properties as Record<string, Record<string, unknown>>)[
      'Raw payload'
    ];
    expect(rawPayloadColumnSchema[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe(PostgresColumnType.JSONB);
    expect(rawPayloadColumnSchema[X_SCRATCH_NATIVE_COLUMN_TYPE]).toMatchObject({ typeSystem: 'mysql', type: 'json' });

    const createdRecordFiles = await connector.createRecords(everyKindTableSpec, [
      {
        'Company name': 'Acme 😀 株式会社',
        Notes: "Line one\nIt's line two",
        'Employee count': 42,
        Score: 0.5,
        'Win rate': 0.25,
        'Exact ratio': '1.125',
        'Unbounded ratio': '3.141592653589793238462643383279',
        'Deal size': '1234.5678',
        Fee: '9.99',
        'Featured?': true,
        'Founded on': '2020-02-29',
        'Marked as done time': '2026-01-02T03:04:05.678Z',
        Stage: 'Won',
        'Dealroom.co URL': 'https://dealroom.co/companies/acme',
        'Contact email': 'hello@acme.test',
        Phone: '+1 555 0100',
        'Raw payload': { nested: { list: [1, 'two', null] } },
        [FIELD_NAME_OF_MAXIMUM_LENGTH]: 'at the limit',
      },
    ]);

    expect(createdRecordFiles).toHaveLength(1);
    const createdRecordFile = createdRecordFiles[0];
    // bigint unsigned reads back as its verbatim decimal string.
    expect(String(createdRecordFile.id)).toMatch(/^[1-9]\d*$/);
    expect(createdRecordFile).toMatchObject({
      'Company name': 'Acme 😀 株式会社',
      Notes: "Line one\nIt's line two",
      'Employee count': 42,
      Score: 0.5,
      'Exact ratio': '1.125',
      'Unbounded ratio': '3.141592653589793238462643383279',
      'Deal size': '1234.5678',
      Fee: '9.99',
      'Featured?': 1,
      'Founded on': '2020-02-29',
      'Marked as done time': '2026-01-02 03:04:05.678',
      'Dealroom.co URL': 'https://dealroom.co/companies/acme',
      'Raw payload': { nested: { list: [1, 'two', null] } },
      [FIELD_NAME_OF_MAXIMUM_LENGTH]: 'at the limit',
    });

    const [storedRows] = await admin().query<RowDataPacket[]>(
      `SELECT id, JSON_TYPE(${quoteIdentifierVerbatimForAdminSql('Raw payload')}) AS raw_payload_json_type
       FROM ${quoteQualifiedTableNameForAdminSql(databaseName, EVERY_KIND_TABLE_NAME)}`,
    );
    expect(storedRows).toHaveLength(1);
    expect(String(storedRows[0].id)).toBe(String(createdRecordFile.id));
    // A document, never the text '[object Object]'.
    expect(storedRows[0].raw_payload_json_type).toBe('OBJECT');
  });

  it('creates a foreign key as ON DELETE SET NULL, and deleting the parent row nulls the reference', async () => {
    const parentCreateTableResult = await connector.createTable({
      remoteParentId: [databaseName],
      ref: 'parent',
      name: PARENT_TABLE_NAME,
      fields: [
        { name: 'Full name', fieldType: { kind: 'text' }, required: true },
        { name: 'Email', fieldType: { kind: 'email' } },
      ],
      deferredFkFields: [],
    });
    expect(parentCreateTableResult.status).toBe('created');
    expectEveryFieldToBeCreated(parentCreateTableResult);

    const childCreateTableResult = await connector.createTable({
      remoteParentId: [databaseName],
      ref: 'child',
      name: CHILD_TABLE_NAME_WITH_SPACE_AND_DOT,
      fields: [
        { name: 'Title', fieldType: { kind: 'text' }, required: true },
        foreignKeyFieldTo('Owner', [databaseName, PARENT_TABLE_NAME]),
      ],
      deferredFkFields: [],
    });
    expect(childCreateTableResult.status).toBe('created');
    expect(childCreateTableResult.remoteTableId).toEqual([databaseName, CHILD_TABLE_NAME_WITH_SPACE_AND_DOT]);
    expectEveryFieldToBeCreated(childCreateTableResult);

    const childForeignKeyConstraints = await readForeignKeyConstraintsOfTableFromCatalog(
      admin(),
      databaseName,
      CHILD_TABLE_NAME_WITH_SPACE_AND_DOT,
    );
    expect(childForeignKeyConstraints).toEqual([
      {
        constraintName: buildMySqlForeignKeyConstraintName(CHILD_TABLE_NAME_WITH_SPACE_AND_DOT, 'Owner'),
        columnName: 'Owner',
        referencedDatabaseName: databaseName,
        referencedTableName: PARENT_TABLE_NAME,
        referencedColumnName: 'id',
        deleteRule: 'SET NULL',
      },
    ]);
    // The FK column copies the referenced id's exact type (incl. unsigned) and is always nullable (SET NULL).
    const childColumnByName = await readColumnsOfTableFromCatalog(
      admin(),
      databaseName,
      CHILD_TABLE_NAME_WITH_SPACE_AND_DOT,
    );
    const parentColumnByName = await readColumnsOfTableFromCatalog(admin(), databaseName, PARENT_TABLE_NAME);
    expect(childColumnByName.get('Owner')).toMatchObject({
      columnType: parentColumnByName.get('id')?.columnType,
      isNullable: 'YES',
    });

    const parentTableSpec = await connector.fetchJsonTableSpec({
      wsId: 'parent',
      remoteId: [databaseName, PARENT_TABLE_NAME],
    });
    const childTableSpec = await connector.fetchJsonTableSpec({
      wsId: 'child',
      remoteId: [databaseName, CHILD_TABLE_NAME_WITH_SPACE_AND_DOT],
    });
    const [createdParentRecordFile] = await connector.createRecords(parentTableSpec, [
      { 'Full name': 'Ada Lovelace', Email: 'ada@example.test' },
    ]);
    const createdParentId = String(createdParentRecordFile.id);
    const [createdChildRecordFile] = await connector.createRecords(childTableSpec, [
      { Title: 'Analytical Engine notes', Owner: createdParentId },
    ]);
    expect(createdChildRecordFile.Owner).toBe(createdParentId);

    await connector.deleteRecords(parentTableSpec, [createdParentRecordFile]);

    const [childRowsAfterParentDelete] = await admin().query<RowDataPacket[]>(
      `SELECT ${quoteIdentifierVerbatimForAdminSql('Owner')} AS owner
       FROM ${quoteQualifiedTableNameForAdminSql(databaseName, CHILD_TABLE_NAME_WITH_SPACE_AND_DOT)}`,
    );
    expect(childRowsAfterParentDelete).toHaveLength(1);
    expect(childRowsAfterParentDelete[0].owner).toBeNull();
  });

  it('round-trips the created tables through listTables (creatable) and fetchJsonTableSpec (FK annotation)', async () => {
    const tablePreviews = await connector.listTables();
    for (const createdTableName of [EVERY_KIND_TABLE_NAME, PARENT_TABLE_NAME, CHILD_TABLE_NAME_WITH_SPACE_AND_DOT]) {
      const createdTablePreview = tablePreviews.find((tablePreview) =>
        isEqual(tablePreview.id.remoteId, [databaseName, createdTableName]),
      );
      expect(createdTablePreview).toBeDefined();
      // An AUTO_INCREMENT primary key on an InnoDB table: readable and fully writable, creates included.
      expect(createdTablePreview?.disabled).toBeUndefined();
      expect(createdTablePreview?.disabledCreates).toBeUndefined();
      expect(createdTablePreview?.disabledUpdates).toBeUndefined();
      expect(createdTablePreview?.disabledDeletes).toBeUndefined();
    }

    const childTableSpec = await connector.fetchJsonTableSpec({
      wsId: 'child',
      remoteId: [databaseName, CHILD_TABLE_NAME_WITH_SPACE_AND_DOT],
    });
    expect(childTableSpec.idPath).toBe('id');
    expect(childTableSpec.idPathRequiresUserSelection).toBeUndefined();
    const childColumnSchemaByName = childTableSpec.schema.properties as Record<string, Record<string, unknown>>;
    expect(childColumnSchemaByName.id[X_SCRATCH_READONLY]).toBe(true);
    expect(childColumnSchemaByName.Owner[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({
      linkedTableId: `${databaseName}.${PARENT_TABLE_NAME}`,
      linkedTableRemoteId: [databaseName, PARENT_TABLE_NAME],
    });
  });

  it('createFields adds a plain column and a self-referential foreign key; a duplicate column fails on its own', async () => {
    const createFieldResults = await connector.createFields({
      remoteTableId: [databaseName, PARENT_TABLE_NAME],
      fields: [
        { name: 'Nickname', fieldType: { kind: 'text' } },
        foreignKeyFieldTo('Manager', [databaseName, PARENT_TABLE_NAME]),
      ],
    });

    expect(createFieldResults).toEqual([
      { name: 'Nickname', status: 'created', remoteFieldId: 'Nickname' },
      { name: 'Manager', status: 'created', remoteFieldId: 'Manager' },
    ]);
    const parentColumnByName = await readColumnsOfTableFromCatalog(admin(), databaseName, PARENT_TABLE_NAME);
    expect(parentColumnByName.get('Nickname')).toMatchObject({ columnType: 'mediumtext', isNullable: 'YES' });
    expect(parentColumnByName.get('Manager')).toMatchObject({
      columnType: parentColumnByName.get('id')?.columnType,
      isNullable: 'YES',
    });
    expect(await readForeignKeyConstraintsOfTableFromCatalog(admin(), databaseName, PARENT_TABLE_NAME)).toEqual([
      {
        constraintName: buildMySqlForeignKeyConstraintName(PARENT_TABLE_NAME, 'Manager'),
        columnName: 'Manager',
        referencedDatabaseName: databaseName,
        referencedTableName: PARENT_TABLE_NAME,
        referencedColumnName: 'id',
        deleteRule: 'SET NULL',
      },
    ]);

    const duplicateColumnResults = await connector.createFields({
      remoteTableId: [databaseName, PARENT_TABLE_NAME],
      fields: [
        { name: 'Nickname', fieldType: { kind: 'text' } },
        { name: 'Title', fieldType: { kind: 'text' } },
      ],
    });
    expect(duplicateColumnResults).toEqual([
      {
        name: 'Nickname',
        status: 'failed',
        error: `A column named "Nickname" already exists on "${databaseName}"."${PARENT_TABLE_NAME}".`,
      },
      { name: 'Title', status: 'created', remoteFieldId: 'Title' },
    ]);
  });

  it('createFields never adopts an existing column or foreign key on a table no Live Export create made', async () => {
    const constraintsBefore = await readForeignKeyConstraintsOfTableFromCatalog(
      admin(),
      databaseName,
      PARENT_TABLE_NAME,
    );
    const alreadyExistingFields = [
      { name: 'Nickname', fieldType: { kind: 'text' } },
      foreignKeyFieldTo('Manager', [databaseName, PARENT_TABLE_NAME]),
    ] satisfies ResolvedCreateFieldSpec[];
    const expectedFailures = ['Nickname', 'Manager'].map((fieldName) => ({
      name: fieldName,
      status: 'failed',
      error: `A column named "${fieldName}" already exists on "${databaseName}"."${PARENT_TABLE_NAME}".`,
    }));

    // Without a create ref (a field added after the first save), and with one the table's comment doesn't name.
    for (const createRef of [undefined, 'dfd_retrytest1']) {
      const retriedCreateFieldResults = await connector.createFields({
        remoteTableId: [databaseName, PARENT_TABLE_NAME],
        fields: alreadyExistingFields,
        ...(createRef !== undefined ? { createRef } : {}),
      });
      expect(retriedCreateFieldResults).toEqual(expectedFailures);
    }
    expect(await readForeignKeyConstraintsOfTableFromCatalog(admin(), databaseName, PARENT_TABLE_NAME)).toEqual(
      constraintsBefore,
    );
  });

  it('skips every unresolvable foreign-key target with a reason and still creates the rest of the table', async () => {
    const qualifiedTargetName = (tableName: string) => quoteQualifiedTableNameForAdminSql(databaseName, tableName);
    const unresolvableTargetFixtureStatements = [
      `CREATE TABLE ${qualifiedTargetName(MYISAM_TARGET_TABLE_NAME)} (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY) ENGINE=MyISAM`,
      `CREATE TABLE ${qualifiedTargetName(TEXT_PRIMARY_KEY_TARGET_TABLE_NAME)} (code TEXT NOT NULL, PRIMARY KEY (code(20))) ENGINE=InnoDB`,
      `CREATE TABLE ${qualifiedTargetName(PREFIX_ONLY_UNIQUE_KEY_TARGET_TABLE_NAME)} (code VARCHAR(40) NOT NULL, UNIQUE KEY prefix_only_code (code(10))) ENGINE=InnoDB`,
      `CREATE TABLE ${qualifiedTargetName(BINARY_PRIMARY_KEY_TARGET_TABLE_NAME)} (id BINARY(16) NOT NULL PRIMARY KEY) ENGINE=InnoDB`,
      `CREATE TABLE ${qualifiedTargetName(COMPOSITE_PRIMARY_KEY_TARGET_TABLE_NAME)} (a INT NOT NULL, b INT NOT NULL, PRIMARY KEY (a, b)) ENGINE=InnoDB`,
      `CREATE VIEW ${qualifiedTargetName(VIEW_TARGET_NAME)} AS SELECT 1 AS id`,
    ];
    for (const fixtureStatement of unresolvableTargetFixtureStatements) {
      await admin().query(fixtureStatement);
    }

    const foreignKeyFieldsExpectedToBeSkipped: { field: ResolvedCreateFieldSpec; skipReasonPattern: RegExp }[] = [
      {
        field: foreignKeyFieldTo('MyISAM link', [databaseName, MYISAM_TARGET_TABLE_NAME]),
        skipReasonPattern: /uses the MyISAM storage engine, and MySQL only enforces foreign keys between InnoDB tables/,
      },
      {
        field: foreignKeyFieldTo('Text key link', [databaseName, TEXT_PRIMARY_KEY_TARGET_TABLE_NAME]),
        skipReasonPattern: /"code" .* has type text, which a MySQL foreign key can't reference/,
      },
      {
        field: foreignKeyFieldTo('Prefix key link', [databaseName, PREFIX_ONLY_UNIQUE_KEY_TARGET_TABLE_NAME]),
        skipReasonPattern: /"code" .* is unique only through a prefix index/,
      },
      {
        field: foreignKeyFieldTo('Binary key link', [databaseName, BINARY_PRIMARY_KEY_TARGET_TABLE_NAME]),
        skipReasonPattern: /has type binary\(16\), whose values Scratch reads as encoded text/,
      },
      {
        field: foreignKeyFieldTo('Composite key link', [databaseName, COMPOSITE_PRIMARY_KEY_TARGET_TABLE_NAME]),
        skipReasonPattern: /has no single-column primary key or unique column for a foreign key to reference/,
      },
      {
        field: foreignKeyFieldTo('View link', [databaseName, VIEW_TARGET_NAME]),
        skipReasonPattern: /is a view, and MySQL foreign keys can only reference tables/,
      },
      {
        field: foreignKeyFieldTo('Missing link', [databaseName, MISSING_TARGET_TABLE_NAME]),
        skipReasonPattern: /doesn't exist, or this connection's MySQL user can't see it/,
      },
    ];
    const allowMultipleForeignKeyField: ResolvedCreateFieldSpec = {
      name: 'Many parents',
      fieldType: {
        kind: 'foreignKey',
        target: { existingRemoteTableId: [databaseName, PARENT_TABLE_NAME] },
        allowMultiple: true,
      },
    };

    const createTableResult = await connector.createTable({
      remoteParentId: [databaseName],
      ref: 'unresolvable_fk_child',
      name: UNRESOLVABLE_FOREIGN_KEY_CHILD_TABLE_NAME,
      fields: [
        { name: 'label', fieldType: { kind: 'text' } },
        ...foreignKeyFieldsExpectedToBeSkipped.map(({ field }) => field),
        allowMultipleForeignKeyField,
      ],
      deferredFkFields: [],
    });

    expect(createTableResult.status).toBe('partial');
    const fieldResultByName = indexFieldResultsByName(createTableResult.fields);
    expect(fieldResultByName.get('label')).toEqual({ name: 'label', status: 'created', remoteFieldId: 'label' });
    for (const { field: skippedField, skipReasonPattern } of foreignKeyFieldsExpectedToBeSkipped) {
      const skippedFieldResult = fieldResultByName.get(skippedField.name);
      expect(skippedFieldResult?.status).toBe('skipped');
      expect(skippedFieldResult?.error).toMatch(new RegExp(`^couldn't create foreign key "${skippedField.name}": `));
      expect(skippedFieldResult?.error).toMatch(skipReasonPattern);
    }
    expect(fieldResultByName.get(allowMultipleForeignKeyField.name)?.status).toBe('skipped');
    expect(fieldResultByName.get(allowMultipleForeignKeyField.name)?.error).toMatch(
      /^couldn't create foreign key "Many parents": it links to multiple records \(allowMultiple\)/,
    );

    const createdColumnByName = await readColumnsOfTableFromCatalog(
      admin(),
      databaseName,
      UNRESOLVABLE_FOREIGN_KEY_CHILD_TABLE_NAME,
    );
    expect([...createdColumnByName.keys()]).toEqual(['id', 'label']);
    expect(
      await readForeignKeyConstraintsOfTableFromCatalog(
        admin(),
        databaseName,
        UNRESOLVABLE_FOREIGN_KEY_CHILD_TABLE_NAME,
      ),
    ).toEqual([]);
  });

  it('a foreign key MySQL rejects after resolution (3780 / MariaDB 1005) leaves no column behind', async () => {
    // The resolver copies the target id's exact type, so a real incompatibility can only arise when the target
    // changes between resolve and ALTER. Provoke exactly that: park the connector's first ALTER (a plain column)
    // behind a metadata lock, widen the target's id while it waits, then release it — the foreign-key ALTER that
    // follows still carries the resolved `int unsigned`.
    await admin().query(
      `CREATE TABLE ${quoteQualifiedTableNameForAdminSql(databaseName, ATOMICITY_PARENT_TABLE_NAME)}
       (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB`,
    );
    const atomicityChildCreateTableResult = await connector.createTable({
      remoteParentId: [databaseName],
      ref: 'atomic_child',
      name: ATOMICITY_CHILD_TABLE_NAME,
      fields: [{ name: 'label', fieldType: { kind: 'text' } }],
      deferredFkFields: [],
    });
    expect(atomicityChildCreateTableResult.status).toBe('created');

    const lockHoldingAdminConnection = await openMySqlAdminConnection(flavor.rootUserServerAddress);
    let createFieldResultsPromise: Promise<CreateFieldResult[]> | undefined;
    try {
      // An open transaction that read the child keeps a shared metadata lock on it until COMMIT.
      await lockHoldingAdminConnection.query('START TRANSACTION');
      await lockHoldingAdminConnection.query(
        `SELECT COUNT(*) AS row_count FROM ${quoteQualifiedTableNameForAdminSql(databaseName, ATOMICITY_CHILD_TABLE_NAME)}`,
      );
      createFieldResultsPromise = connector.createFields({
        remoteTableId: [databaseName, ATOMICITY_CHILD_TABLE_NAME],
        fields: [
          { name: 'Added while the parent changed', fieldType: { kind: 'text' } },
          foreignKeyFieldTo('Atomic parent', [databaseName, ATOMICITY_PARENT_TABLE_NAME]),
        ],
      });
      // Awaited below; this only keeps an early rejection from being reported as unhandled meanwhile.
      void createFieldResultsPromise.catch(() => undefined);
      await waitUntilSchemaChangeOnTableWaitsForMetadataLock(admin(), ATOMICITY_CHILD_TABLE_NAME);
      await admin().query(
        `ALTER TABLE ${quoteQualifiedTableNameForAdminSql(databaseName, ATOMICITY_PARENT_TABLE_NAME)}
         MODIFY id BIGINT NOT NULL AUTO_INCREMENT`,
      );
    } finally {
      await lockHoldingAdminConnection.query('COMMIT');
      await lockHoldingAdminConnection.end();
    }
    const createFieldResults = await createFieldResultsPromise;

    expect(createFieldResults?.[0]).toEqual({
      name: 'Added while the parent changed',
      status: 'created',
      remoteFieldId: 'Added while the parent changed',
    });
    expect(createFieldResults?.[1]?.status).toBe('failed');
    expect(createFieldResults?.[1]?.error).toBe(
      `Couldn't create foreign key "Atomic parent" on "${databaseName}"."${ATOMICITY_CHILD_TABLE_NAME}": ` +
        "MySQL rejected the reference to the linked table. Check that the linked table's id column still exists, is unique, and has the same type and character set.",
    );
    // Atomic: the rejected constraint took its column with it.
    const atomicityChildColumnByName = await readColumnsOfTableFromCatalog(
      admin(),
      databaseName,
      ATOMICITY_CHILD_TABLE_NAME,
    );
    expect([...atomicityChildColumnByName.keys()]).toEqual(['id', 'label', 'Added while the parent changed']);
    expect(
      await readForeignKeyConstraintsOfTableFromCatalog(admin(), databaseName, ATOMICITY_CHILD_TABLE_NAME),
    ).toEqual([]);

    // Control: nothing was left behind to collide with, so a retry (which re-resolves the widened id) succeeds.
    const retriedCreateFieldResults = await connector.createFields({
      remoteTableId: [databaseName, ATOMICITY_CHILD_TABLE_NAME],
      fields: [foreignKeyFieldTo('Atomic parent', [databaseName, ATOMICITY_PARENT_TABLE_NAME])],
    });
    expect(retriedCreateFieldResults).toEqual([
      { name: 'Atomic parent', status: 'created', remoteFieldId: 'Atomic parent' },
    ]);
    expect(
      (await readColumnsOfTableFromCatalog(admin(), databaseName, ATOMICITY_CHILD_TABLE_NAME)).get('Atomic parent'),
    ).toMatchObject({ columnType: flavor.flavorName === 'mariadb' ? 'bigint(20)' : 'bigint', isNullable: 'YES' });
  });

  it('a foreign key into a partitioned table is skipped with a reason and leaves no column behind', async () => {
    // Partitioned InnoDB tables can't be foreign-key parents (MySQL 1506, MariaDB 1005), so the resolver refuses
    // them up front instead of letting the ALTER be rejected.
    await admin().query(
      `CREATE TABLE ${quoteQualifiedTableNameForAdminSql(databaseName, PARTITIONED_TARGET_TABLE_NAME)}
       (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB PARTITION BY HASH(id) PARTITIONS 2`,
    );

    const [partitionedForeignKeyResult] = await connector.createFields({
      remoteTableId: [databaseName, ATOMICITY_CHILD_TABLE_NAME],
      fields: [foreignKeyFieldTo('Partitioned parent', [databaseName, PARTITIONED_TARGET_TABLE_NAME])],
    });

    expect(partitionedForeignKeyResult.status).toBe('skipped');
    expect(partitionedForeignKeyResult.error).toMatch(
      /^couldn't create foreign key "Partitioned parent": the linked table .* is partitioned, and MySQL foreign keys can't reference a partitioned table$/,
    );
    expectUserFacingErrorMessageToLeakNoNetworkOrSqlDetails(partitionedForeignKeyResult.error ?? '');
    const atomicityChildColumnByName = await readColumnsOfTableFromCatalog(
      admin(),
      databaseName,
      ATOMICITY_CHILD_TABLE_NAME,
    );
    expect(atomicityChildColumnByName.has('Partitioned parent')).toBe(false);
  });

  it('refuses to create a table that already exists (1050), naming it, and leaves the existing table alone', async () => {
    const parentColumnNamesBefore = [
      ...(await readColumnsOfTableFromCatalog(admin(), databaseName, PARENT_TABLE_NAME)).keys(),
    ];

    const duplicateCreateTableResult = await connector.createTable({
      remoteParentId: [databaseName],
      ref: 'parent_again',
      name: PARENT_TABLE_NAME,
      fields: [{ name: 'Something else', fieldType: { kind: 'text' } }],
      deferredFkFields: [],
    });

    expect(duplicateCreateTableResult.status).toBe('failed');
    expect(duplicateCreateTableResult.remoteTableId).toBeUndefined();
    expect(duplicateCreateTableResult.error).toBe(
      `A table named "${PARENT_TABLE_NAME}" already exists in the "${databaseName}" database. Rename the new table, or map to the existing table instead.`,
    );
    expect(duplicateCreateTableResult.fields).toEqual([{ name: 'Something else', status: 'failed' }]);
    expect([...(await readColumnsOfTableFromCatalog(admin(), databaseName, PARENT_TABLE_NAME)).keys()]).toEqual(
      parentColumnNamesBefore,
    );
  });

  describe('a save retried after an interrupted create', () => {
    const RETRY_TABLE_REF = 'dfd_retrytest1';
    const retryTableParentField = () => foreignKeyFieldTo('Parent', [databaseName, RETRY_TABLE_NAME]);

    function buildRetryTablePlan(overrides: { titleKind?: 'text' | 'longText' } = {}) {
      return {
        remoteParentId: [databaseName],
        ref: RETRY_TABLE_REF,
        name: RETRY_TABLE_NAME,
        fields: [
          { name: 'Title', fieldType: { kind: overrides.titleKind ?? 'text' }, required: true },
          { name: 'Amount', fieldType: { kind: 'currency', currencyCode: 'USD', precision: 2 } },
          { name: 'Payload', fieldType: { kind: 'json' } },
          foreignKeyFieldTo('Owner', [databaseName, PARENT_TABLE_NAME]),
        ],
        // A self link: the server adds it with createFields once the table exists.
        deferredFkFields: [retryTableParentField()],
      } satisfies Parameters<MysqlConnector['createTable']>[0];
    }

    const RETRY_TABLE_OWNER_CONSTRAINT_NAME = buildMySqlForeignKeyConstraintName(RETRY_TABLE_NAME, 'Owner');

    it('marks the created table with the request it came from', async () => {
      const createTableResult = await connector.createTable(buildRetryTablePlan());
      expect(createTableResult.status).toBe('created');

      const [tableRows] = await admin().query<RowDataPacket[]>(
        `SELECT TABLE_COMMENT AS table_comment FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [databaseName, RETRY_TABLE_NAME],
      );
      expect(tableRows[0].table_comment).toBe(`live_export:${RETRY_TABLE_REF}`);
    });

    it('reuses the empty table and adds the foreign key the interrupted attempt never reached', async () => {
      // The interruption: the CREATE committed, the foreign-key ALTER never ran.
      await admin().query(`ALTER TABLE ??.?? DROP FOREIGN KEY ??, DROP COLUMN ??`, [
        databaseName,
        RETRY_TABLE_NAME,
        RETRY_TABLE_OWNER_CONSTRAINT_NAME,
        'Owner',
      ]);

      const retriedCreateTableResult = await connector.createTable(buildRetryTablePlan());

      expect(retriedCreateTableResult).toMatchObject({
        status: 'created',
        name: RETRY_TABLE_NAME,
        remoteTableId: [databaseName, RETRY_TABLE_NAME],
      });
      expectEveryFieldToBeCreated(retriedCreateTableResult);
      expect(await readForeignKeyConstraintsOfTableFromCatalog(admin(), databaseName, RETRY_TABLE_NAME)).toEqual([
        expect.objectContaining({ constraintName: RETRY_TABLE_OWNER_CONSTRAINT_NAME, columnName: 'Owner' }),
      ]);
    });

    it('reuses it again when everything had landed, foreign key included', async () => {
      const columnsBefore = await readColumnsOfTableFromCatalog(admin(), databaseName, RETRY_TABLE_NAME);

      const retriedCreateTableResult = await connector.createTable(buildRetryTablePlan());

      expect(retriedCreateTableResult.status).toBe('created');
      expectEveryFieldToBeCreated(retriedCreateTableResult);
      expect(await readColumnsOfTableFromCatalog(admin(), databaseName, RETRY_TABLE_NAME)).toEqual(columnsBefore);
    });

    it("adopts a deferred foreign key the same save already added, only when given the save's ref", async () => {
      const addDeferredForeignKey = (createRef?: string) =>
        connector.createFields({
          remoteTableId: [databaseName, RETRY_TABLE_NAME],
          fields: [retryTableParentField()],
          ...(createRef !== undefined ? { createRef } : {}),
        });

      expect(await addDeferredForeignKey(RETRY_TABLE_REF)).toEqual([
        { name: 'Parent', status: 'created', remoteFieldId: 'Parent' },
      ]);
      const constraintsAfterFirstAttempt = await readForeignKeyConstraintsOfTableFromCatalog(
        admin(),
        databaseName,
        RETRY_TABLE_NAME,
      );

      expect(await addDeferredForeignKey(RETRY_TABLE_REF)).toEqual([
        { name: 'Parent', status: 'created', remoteFieldId: 'Parent' },
      ]);
      for (const otherCreateRef of [undefined, 'dfd_otherexprt']) {
        expect(await addDeferredForeignKey(otherCreateRef)).toEqual([
          {
            name: 'Parent',
            status: 'failed',
            error: `A column named "Parent" already exists on "${databaseName}"."${RETRY_TABLE_NAME}".`,
          },
        ]);
      }
      expect(await readForeignKeyConstraintsOfTableFromCatalog(admin(), databaseName, RETRY_TABLE_NAME)).toEqual(
        constraintsAfterFirstAttempt,
      );
    });

    it('gives a table created for any other request no comment, and never reuses it', async () => {
      const otherRequestPlan = { ...buildRetryTablePlan(), ref: 'table_1', name: OTHER_REQUEST_TABLE_NAME };
      expect((await connector.createTable(otherRequestPlan)).status).toBe('created');

      const [tableRows] = await admin().query<RowDataPacket[]>(
        `SELECT TABLE_COMMENT AS table_comment FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [databaseName, OTHER_REQUEST_TABLE_NAME],
      );
      expect(tableRows[0].table_comment).toBe('');

      const retriedCreateTableResult = await connector.createTable(otherRequestPlan);
      expect(retriedCreateTableResult.status).toBe('failed');
      expect(retriedCreateTableResult.error).toBe(
        `A table named "${OTHER_REQUEST_TABLE_NAME}" already exists in the "${databaseName}" database. Rename the new table, or map to the existing table instead.`,
      );
    });

    it.each<[string, () => Promise<Parameters<MysqlConnector['createTable']>[0]>]>([
      ['the plan changed a column type', () => Promise.resolve(buildRetryTablePlan({ titleKind: 'longText' }))],
      ['another request asks for the name', () => Promise.resolve({ ...buildRetryTablePlan(), ref: 'dfd_otherexprt' })],
      [
        'the table already has rows',
        async () => {
          await admin().query(`INSERT INTO ??.?? (Title) VALUES ('written by the first run')`, [
            databaseName,
            RETRY_TABLE_NAME,
          ]);
          return buildRetryTablePlan();
        },
      ],
    ])('refuses the table, as any existing one, when %s', async (_label, buildPlan) => {
      const refusedCreateTableResult = await connector.createTable(await buildPlan());

      expect(refusedCreateTableResult.status).toBe('failed');
      expect(refusedCreateTableResult.error).toBe(
        `A table named "${RETRY_TABLE_NAME}" already exists in the "${databaseName}" database. Rename the new table, or map to the existing table instead.`,
      );
    });
  });

  it('refuses a database outside the connection scope, and system databases, before any DDL', async () => {
    const outOfScopeTableName = `${CREATE_SCHEMA_SPEC_TABLE_PREFIX}out_of_scope`;
    const outOfScopeCreateTableResult = await connector.createTable({
      remoteParentId: [OUT_OF_SCOPE_DATABASE_NAME],
      ref: 'out_of_scope',
      name: outOfScopeTableName,
      fields: [{ name: 'label', fieldType: { kind: 'text' } }],
      deferredFkFields: [],
    });
    expect(outOfScopeCreateTableResult).toEqual({
      ref: 'out_of_scope',
      name: outOfScopeTableName,
      status: 'failed',
      fields: [{ name: 'label', status: 'failed' }],
      error: `This connection is limited to the "${databaseName}" database, so the table can't be created in "${OUT_OF_SCOPE_DATABASE_NAME}".`,
    });

    const systemDatabaseCreateTableResult = await connector.createTable({
      remoteParentId: ['mysql'],
      ref: 'system_database',
      name: outOfScopeTableName,
      fields: [{ name: 'label', fieldType: { kind: 'text' } }],
      deferredFkFields: [],
    });
    expect(systemDatabaseCreateTableResult.status).toBe('failed');
    expect(systemDatabaseCreateTableResult.error).toBe('"mysql" is a MySQL system database; choose another database.');

    expect(await countTablesNamedInAnyDatabase(admin(), outOfScopeTableName)).toBe(0);
  });

  it('creates the table in the configured database when the plan has no remoteParentId', async () => {
    const createTableResult = await connector.createTable({
      ref: 'default_database',
      name: DEFAULT_DATABASE_TABLE_NAME,
      fields: [{ name: 'label', fieldType: { kind: 'text' } }],
      deferredFkFields: [],
    });

    expect(createTableResult.status).toBe('created');
    expect(createTableResult.remoteTableId).toEqual([databaseName, DEFAULT_DATABASE_TABLE_NAME]);
    expect([
      ...(await readColumnsOfTableFromCatalog(admin(), databaseName, DEFAULT_DATABASE_TABLE_NAME)).keys(),
    ]).toEqual(['id', 'label']);
  });

  it('an unscoped connection offers every visible non-system database and needs a database for each create', async () => {
    const unscopedConnector = await createMySqlConnectorForSchemaCreation(
      buildMySqlConnectorCredentialsForIntegrationTest(flavor.applicationUserServerAddress, { databaseName: '' }),
    );

    const createDestinationIds = (await unscopedConnector.listCreateDestinations()).map(
      (createDestination) => createDestination.id,
    );
    expect(createDestinationIds).toContain(databaseName);
    for (const systemDatabaseName of MYSQL_SYSTEM_DATABASE_NAMES) {
      expect(createDestinationIds).not.toContain(systemDatabaseName);
    }

    const withoutDatabaseCreateTableResult = await unscopedConnector.createTable({
      ref: 'unscoped_connection',
      name: UNSCOPED_CONNECTION_TABLE_NAME,
      fields: [{ name: 'label', fieldType: { kind: 'text' } }],
      deferredFkFields: [],
    });
    expect(withoutDatabaseCreateTableResult.status).toBe('failed');
    expect(withoutDatabaseCreateTableResult.error).toBe('Choose a database to create the table in.');

    const withDatabaseCreateTableResult = await unscopedConnector.createTable({
      remoteParentId: [databaseName],
      ref: 'unscoped_connection',
      name: UNSCOPED_CONNECTION_TABLE_NAME,
      fields: [{ name: 'label', fieldType: { kind: 'text' } }],
      deferredFkFields: [],
    });
    expect(withDatabaseCreateTableResult.status).toBe('created');
    expect(withDatabaseCreateTableResult.remoteTableId).toEqual([databaseName, UNSCOPED_CONNECTION_TABLE_NAME]);
  });

  it('recreates same-type-system native MySQL types exactly and refuses non-recreatable ones without DDL', async () => {
    await admin().query(
      `CREATE TABLE ${quoteQualifiedTableNameForAdminSql(databaseName, INJECTION_CANARY_TABLE_NAME)}
       (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB`,
    );
    const nativeTypeFields: { field: ResolvedCreateFieldSpec; expectedColumn: ExpectedCreatedColumn }[] = [
      {
        field: {
          name: 'exact_amount',
          fieldType: { kind: 'number', format: 'decimal', precision: 2 },
          nativeFieldType: { typeSystem: 'mysql', type: 'decimal(12,3)' },
        },
        expectedColumn: { mysqlColumnType: 'decimal(12,3)', isNullable: 'YES' },
      },
      {
        field: {
          name: 'short_code',
          fieldType: { kind: 'text' },
          nativeFieldType: { typeSystem: 'mysql', type: 'varchar(40)' },
          required: true,
        },
        expectedColumn: { mysqlColumnType: 'varchar(40)', isNullable: 'NO' },
      },
      {
        field: {
          name: 'unsigned_count',
          fieldType: { kind: 'number', format: 'integer' },
          nativeFieldType: { typeSystem: 'mysql', type: 'int unsigned' },
        },
        expectedColumn: { mysqlColumnType: 'int unsigned', mariaDbColumnType: 'int(10) unsigned', isNullable: 'YES' },
      },
      {
        field: {
          name: 'happened_at',
          fieldType: { kind: 'date', includesTime: true },
          nativeFieldType: { typeSystem: 'mysql', type: 'datetime(3)' },
        },
        expectedColumn: { mysqlColumnType: 'datetime(3)', isNullable: 'YES' },
      },
      {
        // An explicit NULL keeps a TIMESTAMP from silently becoming NOT NULL DEFAULT CURRENT_TIMESTAMP.
        field: {
          name: 'seen_at',
          fieldType: { kind: 'date', includesTime: true },
          nativeFieldType: { typeSystem: 'mysql', type: 'timestamp' },
        },
        expectedColumn: { mysqlColumnType: 'timestamp', isNullable: 'YES' },
      },
      {
        field: {
          name: 'big_counter',
          fieldType: { kind: 'number', format: 'integer' },
          nativeFieldType: { typeSystem: 'mysql', type: 'bigint unsigned' },
        },
        expectedColumn: {
          mysqlColumnType: 'bigint unsigned',
          mariaDbColumnType: 'bigint(20) unsigned',
          isNullable: 'YES',
        },
      },
      {
        field: {
          name: 'country_code',
          fieldType: { kind: 'text' },
          nativeFieldType: { typeSystem: 'mysql', type: 'char(2)' },
        },
        expectedColumn: { mysqlColumnType: 'char(2)', isNullable: 'YES' },
      },
      {
        field: {
          name: 'founded_year',
          fieldType: { kind: 'number', format: 'integer' },
          nativeFieldType: { typeSystem: 'mysql', type: 'year' },
        },
        expectedColumn: { mysqlColumnType: 'year', mariaDbColumnType: 'year(4)', isNullable: 'YES' },
      },
      {
        field: {
          name: 'duration',
          fieldType: { kind: 'text' },
          nativeFieldType: { typeSystem: 'mysql', type: 'time(3)' },
        },
        expectedColumn: { mysqlColumnType: 'time(3)', isNullable: 'YES' },
      },
      {
        // Another type system's native type is ignored in favour of the logical kind.
        field: {
          name: 'from_postgres',
          fieldType: { kind: 'number', format: 'decimal', precision: 2 },
          nativeFieldType: { typeSystem: 'postgres', type: 'numeric(10,2)' },
        },
        expectedColumn: { mysqlColumnType: 'decimal(10,2)', isNullable: 'YES' },
      },
    ];
    const refusedNativeTypeFields: ResolvedCreateFieldSpec[] = [
      {
        name: 'mood',
        fieldType: { kind: 'select', options: [{ name: 'a' }, { name: 'b' }] },
        nativeFieldType: { typeSystem: 'mysql', type: "enum('a','b')" },
      },
      {
        name: 'injected',
        fieldType: { kind: 'text' },
        nativeFieldType: { typeSystem: 'mysql', type: `varchar(10); drop table ${INJECTION_CANARY_TABLE_NAME}` },
      },
    ];

    const createTableResult = await connector.createTable({
      remoteParentId: [databaseName],
      ref: 'native_types',
      name: NATIVE_TYPES_TABLE_NAME,
      fields: [...nativeTypeFields.map(({ field }) => field), ...refusedNativeTypeFields],
      deferredFkFields: [],
    });

    expect(createTableResult.status).toBe('partial');
    const fieldResultByName = indexFieldResultsByName(createTableResult.fields);
    for (const { field } of nativeTypeFields) {
      expect(fieldResultByName.get(field.name)?.status).toBe('created');
    }
    for (const refusedField of refusedNativeTypeFields) {
      expect(fieldResultByName.get(refusedField.name)?.status).toBe('skipped');
      expect(fieldResultByName.get(refusedField.name)?.error).toMatch(
        new RegExp(
          `^field "${refusedField.name}" asks for native MySQL type .*, which the MySQL connector can't create`,
        ),
      );
    }

    const createdColumnByName = await readColumnsOfTableFromCatalog(admin(), databaseName, NATIVE_TYPES_TABLE_NAME);
    for (const { field, expectedColumn } of nativeTypeFields) {
      expect({ columnName: field.name, ...createdColumnByName.get(field.name) }).toMatchObject({
        columnName: field.name,
        columnType: expectedColumnTypeForFlavor(expectedColumn, flavor),
        isNullable: expectedColumn.isNullable,
      });
    }
    for (const refusedField of refusedNativeTypeFields) {
      expect(createdColumnByName.has(refusedField.name)).toBe(false);
    }
    // The injected statement never ran: the type was refused before it could reach DDL.
    expect(await countTablesNamedInAnyDatabase(admin(), INJECTION_CANARY_TABLE_NAME)).toBe(1);

    // The read side annotates the created columns with the same native types, so MySQL → MySQL round-trips.
    const nativeTypesTableSpec = await connector.fetchJsonTableSpec({
      wsId: 'native_types',
      remoteId: [databaseName, NATIVE_TYPES_TABLE_NAME],
    });
    const nativeTypesColumnSchemaByName = nativeTypesTableSpec.schema.properties as Record<
      string,
      Record<string, unknown>
    >;
    for (const { field, expectedColumn } of nativeTypeFields) {
      expect(nativeTypesColumnSchemaByName[field.name][X_SCRATCH_NATIVE_COLUMN_TYPE]).toEqual({
        typeSystem: 'mysql',
        type: expectedColumnTypeForFlavor(expectedColumn, flavor),
        isRecreatableVerbatim: true,
      });
    }
  });

  it(`creates the maximum ${MYSQL_MAX_FIELDS_PER_CREATED_TABLE} MEDIUMTEXT fields under a 64-character table name and fills a row`, async () => {
    expect(ROW_SIZE_CAP_TABLE_NAME_OF_MAXIMUM_LENGTH).toHaveLength(MYSQL_MAX_IDENTIFIER_LENGTH);
    const maximumTextFields: ResolvedCreateFieldSpec[] = Array.from(
      { length: MYSQL_MAX_FIELDS_PER_CREATED_TABLE },
      (_unused, fieldIndex) => ({
        name: `Text field ${String(fieldIndex + 1).padStart(3, '0')}`,
        fieldType: { kind: 'text' },
      }),
    );

    const createTableResult = await connector.createTable({
      remoteParentId: [databaseName],
      ref: 'row_size_cap',
      name: ROW_SIZE_CAP_TABLE_NAME_OF_MAXIMUM_LENGTH,
      fields: maximumTextFields,
      deferredFkFields: [],
    });

    expect(createTableResult.status).toBe('created');
    expect(createTableResult.remoteTableId).toEqual([databaseName, ROW_SIZE_CAP_TABLE_NAME_OF_MAXIMUM_LENGTH]);
    const createdColumnByName = await readColumnsOfTableFromCatalog(
      admin(),
      databaseName,
      ROW_SIZE_CAP_TABLE_NAME_OF_MAXIMUM_LENGTH,
    );
    expect(createdColumnByName.size).toBe(MYSQL_MAX_FIELDS_PER_CREATED_TABLE + 1);

    // Every column filled at once: far past the ~8 KB in-page row limit, so InnoDB must move values off-page.
    const rowSizeCapTableSpec = await connector.fetchJsonTableSpec({
      wsId: 'row_size_cap',
      remoteId: [databaseName, ROW_SIZE_CAP_TABLE_NAME_OF_MAXIMUM_LENGTH],
    });
    const valueFillingEveryColumn = 'v'.repeat(200);
    const [createdRecordFile] = await connector.createRecords(rowSizeCapTableSpec, [
      Object.fromEntries(maximumTextFields.map((field) => [field.name, valueFillingEveryColumn])),
    ]);
    for (const field of maximumTextFields) {
      expect(createdRecordFile[field.name]).toBe(valueFillingEveryColumn);
    }
  });

  it('canonicalizes values MySQL re-renders on write so they equal what the next pull reads back', async () => {
    await admin().query(
      `CREATE TABLE ${quoteQualifiedTableNameForAdminSql(databaseName, CANONICALIZER_TABLE_NAME)} (
         id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
         wall_clock_datetime DATETIME(3) NULL,
         exact_decimal DECIMAL(10,4) NULL,
         approximate_float FLOAT NULL,
         boolean_flag TINYINT(1) NULL,
         status_enum ENUM('Draft','Mixed','Published') NULL,
         tag_set SET('red','green','blue') NULL,
         payload_json JSON NULL
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
    const canonicalizerTableSpec = await connector.fetchJsonTableSpec({
      wsId: 'canonicalizer',
      remoteId: [databaseName, CANONICALIZER_TABLE_NAME],
    });

    // What a Live Export sync writes (the source's own shapes), and what MySQL stores / the pull reads back.
    const sourceValueAndExpectedReadBackByColumnName: Record<string, { sourceValue: unknown; readBackValue: unknown }> =
      {
        wall_clock_datetime: {
          sourceValue: '2026-03-05T14:30:00.123456-05:00',
          readBackValue: '2026-03-05 19:30:00.123',
        },
        exact_decimal: { sourceValue: '1.23456', readBackValue: '1.2346' },
        approximate_float: { sourceValue: 3.14159265, readBackValue: 3.14159 },
        boolean_flag: { sourceValue: true, readBackValue: 1 },
        status_enum: { sourceValue: 'MIXED', readBackValue: 'Mixed' },
        tag_set: { sourceValue: 'blue,RED', readBackValue: 'red,blue' },
        payload_json: {
          sourceValue: { zebra: 1, apple: [1, 2, { nested: true }] },
          readBackValue: { apple: [1, 2, { nested: true }], zebra: 1 },
        },
      };
    await connector.createRecords(canonicalizerTableSpec, [
      Object.fromEntries(
        Object.entries(sourceValueAndExpectedReadBackByColumnName).map(([columnName, { sourceValue }]) => [
          columnName,
          sourceValue,
        ]),
      ),
    ]);
    const pulledRecordFiles = await pullAllRecordFilesAsStoredOnDisk(connector, canonicalizerTableSpec);
    expect(pulledRecordFiles).toHaveLength(1);
    const pulledRecordFile = pulledRecordFiles[0];

    // The registry hook is the MySQL canonicalizer, resolved the way the sync resolves it (per field of the spec).
    expect(connectorRegistry.get(Service.MYSQL)?.resolveFieldValueCanonicalizer).toBe(
      resolveMySqlFieldValueCanonicalizer,
    );
    const canonicalizerByFieldPath = resolveFieldValueCanonicalizersForTable(Service.MYSQL, canonicalizerTableSpec);
    expect(canonicalizerByFieldPath.has('id')).toBe(false); // read-only: never written, never compared
    for (const [columnName, { sourceValue, readBackValue }] of Object.entries(
      sourceValueAndExpectedReadBackByColumnName,
    )) {
      expect({ columnName, readBack: pulledRecordFile[columnName] }).toEqual({ columnName, readBack: readBackValue });
      const columnCanonicalizer = canonicalizerByFieldPath.get(columnName);
      expect({ columnName, hasCanonicalizer: columnCanonicalizer !== undefined }).toEqual({
        columnName,
        hasCanonicalizer: true,
      });
      if (!columnCanonicalizer) continue;
      expect({
        columnName,
        sourceEqualsReadBack: areFieldValuesCanonicallyEqual(columnCanonicalizer, sourceValue, readBackValue),
      }).toEqual({ columnName, sourceEqualsReadBack: true });
    }

    // Without the canonicalizer these would all look changed on every run...
    for (const columnName of [
      'wall_clock_datetime',
      'exact_decimal',
      'approximate_float',
      'boolean_flag',
      'status_enum',
      'tag_set',
    ]) {
      const { sourceValue, readBackValue } = sourceValueAndExpectedReadBackByColumnName[columnName];
      expect({ columnName, structurallyEqual: isEqual(sourceValue, readBackValue) }).toEqual({
        columnName,
        structurallyEqual: false,
      });
    }
    // ...and it still tells a genuinely different value apart.
    const genuinelyDifferentValueByColumnName: Record<string, unknown> = {
      wall_clock_datetime: '2026-03-05T14:30:00.124-05:00',
      exact_decimal: '1.2347',
      approximate_float: 3.1416,
      boolean_flag: false,
      status_enum: 'Draft',
      tag_set: 'red',
      payload_json: { zebra: 2, apple: [1, 2, { nested: true }] },
    };
    for (const [columnName, genuinelyDifferentValue] of Object.entries(genuinelyDifferentValueByColumnName)) {
      const columnCanonicalizer = canonicalizerByFieldPath.get(columnName);
      if (!columnCanonicalizer) continue;
      expect({
        columnName,
        differentValueEqualsReadBack: areFieldValuesCanonicallyEqual(
          columnCanonicalizer,
          genuinelyDifferentValue,
          pulledRecordFile[columnName],
        ),
      }).toEqual({ columnName, differentValueEqualsReadBack: false });
    }
  });

  it("canonicalizes MySQL's rounding of integers, FLOAT/DOUBLE(M,D) ties and TIME text so a re-run is a no-op", async () => {
    const roundingCanonicalizerTableName = `${CREATE_SCHEMA_SPEC_TABLE_PREFIX}canonicalizer_rounding`;
    await admin().query(
      `CREATE TABLE ${quoteQualifiedTableNameForAdminSql(databaseName, roundingCanonicalizerTableName)} (
         id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
         whole_int INT NULL,
         whole_bigint BIGINT NULL,
         whole_decimal DECIMAL(10,0) NULL,
         rounded_double DOUBLE(10,2) NULL,
         whole_double DOUBLE(10,0) NULL,
         plain_time TIME NULL,
         millisecond_time TIME(3) NULL
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
    const roundingCanonicalizerTableSpec = await connector.fetchJsonTableSpec({
      wsId: 'canonicalizer_rounding',
      remoteId: [databaseName, roundingCanonicalizerTableName],
    });

    // One row per case: what a Live Export source sends, and what both MySQL 8.4 and MariaDB 11.4 store for it.
    const roundTripCases: { columnName: string; sourceValue: unknown; readBackValue: unknown }[] = [
      // Integers round a fraction half AWAY from zero (Math.round would give -2 for -2.5).
      { columnName: 'whole_int', sourceValue: 3.7, readBackValue: 4 },
      { columnName: 'whole_int', sourceValue: 2.5, readBackValue: 3 },
      { columnName: 'whole_int', sourceValue: -2.5, readBackValue: -3 },
      { columnName: 'whole_int', sourceValue: '3.7', readBackValue: 4 },
      { columnName: 'whole_bigint', sourceValue: 3.7, readBackValue: '4' },
      { columnName: 'whole_bigint', sourceValue: '-2.5', readBackValue: '-3' },
      { columnName: 'whole_decimal', sourceValue: 2.5, readBackValue: '3' },
      { columnName: 'whole_decimal', sourceValue: -2.5, readBackValue: '-3' },
      // DOUBLE(M,D): an exact binary tie goes to the even digit; non-ties follow the float64 value.
      { columnName: 'rounded_double', sourceValue: 1.125, readBackValue: 1.12 },
      { columnName: 'rounded_double', sourceValue: 1.375, readBackValue: 1.38 },
      { columnName: 'rounded_double', sourceValue: 2.675, readBackValue: 2.67 },
      { columnName: 'rounded_double', sourceValue: 1.005, readBackValue: 1 },
      { columnName: 'rounded_double', sourceValue: 1.055, readBackValue: 1.05 },
      // DOUBLE(M,0): a tie always goes down.
      { columnName: 'whole_double', sourceValue: 0.5, readBackValue: 0 },
      { columnName: 'whole_double', sourceValue: 1.5, readBackValue: 1 },
      { columnName: 'whole_double', sourceValue: -0.5, readBackValue: -1 },
      // TIME: seconds added, fraction truncated to the column precision by the write path (MySQL alone would
      // round 14:30:00.999 up to 14:30:01 in TIME, MariaDB would truncate).
      { columnName: 'plain_time', sourceValue: '14:30', readBackValue: '14:30:00' },
      { columnName: 'plain_time', sourceValue: '14:30:00.5', readBackValue: '14:30:00' },
      { columnName: 'plain_time', sourceValue: '14:30:00.999', readBackValue: '14:30:00' },
      { columnName: 'plain_time', sourceValue: '-01:00:00', readBackValue: '-01:00:00' },
      { columnName: 'plain_time', sourceValue: '838:59:59', readBackValue: '838:59:59' },
      { columnName: 'millisecond_time', sourceValue: '14:30', readBackValue: '14:30:00.000' },
      { columnName: 'millisecond_time', sourceValue: '14:30:00.5', readBackValue: '14:30:00.500' },
      { columnName: 'millisecond_time', sourceValue: '14:30:00.999', readBackValue: '14:30:00.999' },
      { columnName: 'millisecond_time', sourceValue: '-01:00:00', readBackValue: '-01:00:00.000' },
      { columnName: 'millisecond_time', sourceValue: '838:59:59', readBackValue: '838:59:59.000' },
    ];

    const createdRecordFiles = await connector.createRecords(
      roundingCanonicalizerTableSpec,
      roundTripCases.map(({ columnName, sourceValue }) => ({ [columnName]: sourceValue })),
    );
    expect(createdRecordFiles).toHaveLength(roundTripCases.length);
    const pulledRecordFileById = new Map(
      (await pullAllRecordFilesAsStoredOnDisk(connector, roundingCanonicalizerTableSpec)).map((pulledRecordFile) => [
        String(pulledRecordFile.id),
        pulledRecordFile,
      ]),
    );
    const canonicalizerByFieldPath = resolveFieldValueCanonicalizersForTable(
      Service.MYSQL,
      roundingCanonicalizerTableSpec,
    );

    roundTripCases.forEach(({ columnName, sourceValue, readBackValue }, caseIndex) => {
      const caseLabel = `${columnName} ← ${JSON.stringify(sourceValue)}`;
      const pulledRecordFile = pulledRecordFileById.get(String(createdRecordFiles[caseIndex].id));
      expect({ caseLabel, readBack: pulledRecordFile?.[columnName] }).toEqual({ caseLabel, readBack: readBackValue });
      const columnCanonicalizer = canonicalizerByFieldPath.get(columnName);
      if (!columnCanonicalizer) throw new Error(`expected a canonicalizer for ${columnName}`);
      expect({
        caseLabel,
        sourceEqualsReadBack: areFieldValuesCanonicallyEqual(columnCanonicalizer, sourceValue, readBackValue),
      }).toEqual({ caseLabel, sourceEqualsReadBack: true });
    });

    // ...and a genuinely different stored value still counts as a change.
    const genuinelyDifferentCases: { columnName: string; sourceValue: unknown; storedValue: unknown }[] = [
      { columnName: 'whole_int', sourceValue: 3.4, storedValue: 4 },
      { columnName: 'whole_bigint', sourceValue: -2.4, storedValue: '-3' },
      { columnName: 'rounded_double', sourceValue: 1.125, storedValue: 1.13 },
      { columnName: 'whole_double', sourceValue: 1.5, storedValue: 2 },
      { columnName: 'plain_time', sourceValue: '14:30:00.999', storedValue: '14:30:01' },
      { columnName: 'millisecond_time', sourceValue: '14:30:00.5', storedValue: '14:30:00.501' },
    ];
    for (const { columnName, sourceValue, storedValue } of genuinelyDifferentCases) {
      const columnCanonicalizer = canonicalizerByFieldPath.get(columnName);
      if (!columnCanonicalizer) throw new Error(`expected a canonicalizer for ${columnName}`);
      expect({
        columnName,
        sourceValue,
        equalsStoredValue: areFieldValuesCanonicallyEqual(columnCanonicalizer, sourceValue, storedValue),
      }).toEqual({ columnName, sourceValue, equalsStoredValue: false });
    }
  });
});
