/**
 * MySQL connector record writes against real MySQL 8.4 and MariaDB 11.4 (DEV-12035).
 *
 * The unit specs (`library/mysql/__tests__/mysql-record-writes.spec.ts`, `mysql-record-preparation.spec.ts`) prove
 * the SQL knex compiles and the values the preparation step produces. This spec proves what the SERVER does with
 * them, through the connector exactly as production builds it (the registry's `createConnector`, stored-credential
 * re-validation included):
 *
 *   - ids: AUTO_INCREMENT ids above 2^53 come back exact; ids are bound as exact integers, so updating …993
 *     never touches its neighbour …992 (the same JS number), and `'12abc'` never matches row 12; binary keys are
 *     addressed by their pulled base64; a `_ci` text key edited case-folded returns the stored spelling;
 *   - values: JSON documents keep their JSON type (never `'[object Object]'`); offsets become UTC wall clock;
 *     fractional seconds are TRUNCATED to the column precision on both flavors (MySQL alone would round);
 *     TIMESTAMP(6) keeps microseconds; DATE refuses a time of day; `''` into DECIMAL is NULL; a one-key JSON edit
 *     keeps its sibling keys; `ON UPDATE CURRENT_TIMESTAMP` fires;
 *   - guards: a vanished row fails the batch with RemoteRecordNotFound and rolls it back; a non-unique id column
 *     trips the multiple-rows guard with every row unchanged; MyISAM and non-AUTO_INCREMENT creates are refused
 *     after the catalog preflight but before any DML; a BLOB edit is refused before any SQL; a generated-column write
 *     surfaces the server's own rejection (3105 / MariaDB 1906) as a friendly message; a dropped table reports
 *     TableNotFound.
 *
 * Every table is created by the admin (root) connection as `scratch_mysql_it_writes_*` and dropped in
 * beforeAll / afterAll (`SKIP_CLEANUP=1` keeps them for inspection). The seeded companies / deals tables are never
 * touched.
 *
 * Run (from server/, with server/localdev/docker-compose.mysql.yml up):
 *   MYSQL_TEST_URL=mysql://test:test@127.0.0.1:3306/test_db MYSQL_TEST_ROOT_URL=mysql://root:root@127.0.0.1:3306/test_db \
 *   MARIADB_TEST_URL=mysql://test:test@127.0.0.1:3307/test_db MARIADB_TEST_ROOT_URL=mysql://root:root@127.0.0.1:3307/test_db \
 *   yarn test:integration test/integration/mysql-record-writes --runInBand
 */
import { Value } from '@sinclair/typebox/value';
import { ConnectorErrorCode, X_SCRATCH_NATIVE_COLUMN_TYPE, X_SCRATCH_READONLY } from '@spinner/shared-types';
import type mysql2Promise from 'mysql2/promise';
import { type Connector } from 'src/remote-service/connectors/connector';
import {
  NonWritableFieldEditError,
  nonWritableFieldEditErrorMessage,
  NonWritableFieldReason,
} from 'src/remote-service/connectors/error';
import { MySqlClientError, MySqlClientProblem } from 'src/remote-service/connectors/library/mysql/mysql-client-error';
import { MYSQL_DATA_ERROR_LEAD_SENTENCES } from 'src/remote-service/connectors/library/mysql/mysql-error-mapping';
import { unsupportedStorageEngineWriteMessage } from 'src/remote-service/connectors/library/mysql/mysql-table-writability';
import { dotPath, type BaseJsonTableSpec, type ConnectorFile } from 'src/remote-service/connectors/types';
import { type JsonSafeObject } from 'src/utils/objects';
import {
  buildMySqlConnectorCredentialsForIntegrationTest,
  createMySqlConnectorThroughRegistryForIntegrationTest,
  describeForEachConfiguredMySqlIntegrationFlavor,
  dropAllMySqlIntegrationTables,
  expectUserFacingErrorMessageToLeakNoNetworkOrSqlDetails,
  MYSQL_INTEGRATION_IDENTIFIER_PREFIX,
  openMySqlAdminConnection,
  waitForMySqlServerToAcceptConnections,
} from './mysql-integration-helpers';

jest.setTimeout(60_000);

const WAIT_FOR_MYSQL_SERVER_HOOK_TIMEOUT_MILLISECONDS = 120_000;

/** 2^53 + 1: the first integer a JS number (or a DOUBLE) can't tell apart from 2^53. */
const FIRST_ID_ABOVE_TWO_TO_THE_53 = '9007199254740993';
const TWO_TO_THE_53 = '9007199254740992';

function buildWritesSpecTableName(tableNameSuffix: string): string {
  return `${MYSQL_INTEGRATION_IDENTIFIER_PREFIX}writes_${tableNameSuffix}`;
}

/** Run the operation and return what it rejected with; fails the test when it resolves. */
async function captureRejectionOfOperation(operationExpectedToFail: Promise<unknown>): Promise<unknown> {
  try {
    await operationExpectedToFail;
  } catch (rejectionReason) {
    return rejectionReason;
  }
  throw new Error('Expected the operation to be rejected, but it resolved');
}

async function expectRejectionWithMySqlClientProblem(
  operationExpectedToFail: Promise<unknown>,
  expectedMySqlClientProblem: MySqlClientProblem,
): Promise<MySqlClientError> {
  const rejectionReason = await captureRejectionOfOperation(operationExpectedToFail);
  expect(rejectionReason).toBeInstanceOf(MySqlClientError);
  if (!(rejectionReason instanceof MySqlClientError)) {
    throw rejectionReason;
  }
  expect(rejectionReason.problem).toBe(expectedMySqlClientProblem);
  return rejectionReason;
}

/** The `errno` of a raw mysql2 server error (knex rethrows the driver's error object). */
function readMySqlServerErrorNumber(rejectionReason: unknown): number | undefined {
  if (typeof rejectionReason !== 'object' || rejectionReason === null || !('errno' in rejectionReason)) {
    return undefined;
  }
  const { errno } = rejectionReason as { errno: unknown };
  return typeof errno === 'number' ? errno : undefined;
}

/** An integer id as an exact admin-query binding: mysql2 renders a BigInt as an unquoted integer literal. */
function bindExactIntegerId(recordId: unknown): bigint {
  return BigInt(String(recordId));
}

/** One top-level column's JSON Schema (with its `x-scratch-*` annotations) from a fetched table spec. */
function readColumnSchemaOfTableSpec(tableSpec: BaseJsonTableSpec, columnName: string): Record<string, unknown> {
  const columnSchema = (tableSpec.schema as { properties?: Record<string, unknown> }).properties?.[columnName];
  if (typeof columnSchema !== 'object' || columnSchema === null) {
    throw new Error(`the table spec has no "${columnName}" column`);
  }
  return columnSchema as Record<string, unknown>;
}

/** `2026-03-05 14:30:05` (UTC wall clock, as MySQL prints DATETIME) → epoch milliseconds. */
function parseUtcWallClockDateTimeText(dateTimeText: string): number {
  return Date.parse(`${dateTimeText.replace(' ', 'T')}Z`);
}

describeForEachConfiguredMySqlIntegrationFlavor('MySQL connector record writes', (flavor) => {
  const databaseName = flavor.applicationUserServerAddress.databaseName;
  let adminConnection: mysql2Promise.Connection;
  let connector: Connector<string, JsonSafeObject>;

  beforeAll(async () => {
    await waitForMySqlServerToAcceptConnections(flavor.rootUserServerAddress);
    adminConnection = await openMySqlAdminConnection(flavor.rootUserServerAddress);
    await dropAllMySqlIntegrationTables(adminConnection, databaseName);
    connector = await createMySqlConnectorThroughRegistryForIntegrationTest(
      buildMySqlConnectorCredentialsForIntegrationTest(flavor.applicationUserServerAddress),
    );
  }, WAIT_FOR_MYSQL_SERVER_HOOK_TIMEOUT_MILLISECONDS);

  afterAll(async () => {
    if (!adminConnection) return;
    if (process.env.SKIP_CLEANUP !== '1') {
      await dropAllMySqlIntegrationTables(adminConnection, databaseName);
    }
    await adminConnection.end();
  });

  // ── helpers bound to this flavor ────────────────────────────────────────────────────────────────────────────

  /** `CREATE TABLE <db>.<table> (<columnDefinitionsAndTableOptions>)` as root; the name is bound with `??`. */
  async function createTableAsAdmin(tableName: string, columnDefinitionsAndTableOptions: string): Promise<void> {
    await adminConnection.query(`DROP TABLE IF EXISTS ??.??`, [databaseName, tableName]);
    await adminConnection.query(`CREATE TABLE ??.?? ${columnDefinitionsAndTableOptions}`, [databaseName, tableName]);
  }

  /** Rows as plain objects with `unknown` values (mysql2's RowDataPacket indexes as `any`). */
  async function selectRowsAsAdmin(sql: string, values: unknown[] = []): Promise<Record<string, unknown>[]> {
    const [selectedRows] = await adminConnection.query<mysql2Promise.RowDataPacket[]>(sql, values);
    return selectedRows.map((selectedRow): Record<string, unknown> => ({ ...selectedRow }));
  }

  async function countRowsAsAdmin(tableName: string): Promise<number> {
    const [countRow] = await selectRowsAsAdmin('SELECT COUNT(*) AS row_count FROM ??.??', [databaseName, tableName]);
    return Number(countRow.row_count);
  }

  async function fetchTableSpecThroughConnector(tableName: string): Promise<BaseJsonTableSpec> {
    return connector.fetchJsonTableSpec({ wsId: tableName, remoteId: [databaseName, tableName] });
  }

  async function pullAllRowsThroughConnector(tableSpec: BaseJsonTableSpec): Promise<ConnectorFile[]> {
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

  /** The table most tests write to: one column per value-preparation rule, ids starting above 2^53. */
  const VALUE_RULES_TABLE_DEFINITION = `(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      label VARCHAR(100) NULL,
      json_document JSON NULL,
      wall_clock_millis DATETIME(3) NULL,
      wall_clock_seconds DATETIME NULL,
      instant_micros TIMESTAMP(6) NULL DEFAULT NULL,
      calendar_date DATE NULL,
      amount DECIMAL(10,2) NULL,
      row_updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 AUTO_INCREMENT=${FIRST_ID_ABOVE_TWO_TO_THE_53}`;

  async function createValueRulesTableAndFetchSpec(tableNameSuffix: string): Promise<{
    tableName: string;
    tableSpec: BaseJsonTableSpec;
  }> {
    const tableName = buildWritesSpecTableName(tableNameSuffix);
    await createTableAsAdmin(tableName, VALUE_RULES_TABLE_DEFINITION);
    return { tableName, tableSpec: await fetchTableSpecThroughConnector(tableName) };
  }

  // ── creates: ids and values ─────────────────────────────────────────────────────────────────────────────────

  it('creates rows with the exact AUTO_INCREMENT ids above 2^53, returned as strings in input order', async () => {
    const { tableName, tableSpec } = await createValueRulesTableAndFetchSpec('big_ids');

    const createdRecordFiles = await connector.createRecords(tableSpec, [
      { label: 'first' },
      { label: 'second' },
      { label: 'third' },
    ]);

    expect(createdRecordFiles.map((createdRecordFile) => createdRecordFile.id)).toEqual([
      '9007199254740993',
      '9007199254740994',
      '9007199254740995',
    ]);
    expect(createdRecordFiles.map((createdRecordFile) => createdRecordFile.label)).toEqual([
      'first',
      'second',
      'third',
    ]);
    const storedRows = await selectRowsAsAdmin('SELECT id, label FROM ??.?? ORDER BY id', [databaseName, tableName]);
    expect(storedRows.map((storedRow) => [storedRow.id, storedRow.label])).toEqual([
      ['9007199254740993', 'first'],
      ['9007199254740994', 'second'],
      ['9007199254740995', 'third'],
    ]);
  });

  it('stores JSON objects, arrays, strings and numbers as those JSON types, never as "[object Object]"', async () => {
    const { tableName, tableSpec } = await createValueRulesTableAndFetchSpec('json_types');
    const jsonDocumentsByLabel: Record<string, unknown> = {
      object: { nested: { flag: true, list: [1, 2] }, text: 'é 🎉 "quoted"' },
      array: ['x', 2, { inner: null }],
      string: 'just text',
      number: 42,
    };

    const createdRecordFiles = await connector.createRecords(
      tableSpec,
      Object.entries(jsonDocumentsByLabel).map(([label, jsonDocument]) => ({ label, json_document: jsonDocument })),
    );

    // The read-back is decoded exactly like a pull: the parsed document, not text.
    for (const createdRecordFile of createdRecordFiles) {
      expect(createdRecordFile.json_document).toEqual(jsonDocumentsByLabel[String(createdRecordFile.label)]);
    }
    const storedRows = await selectRowsAsAdmin(
      'SELECT label, JSON_TYPE(json_document) AS json_type, CAST(json_document AS CHAR) AS json_text FROM ??.?? ORDER BY id',
      [databaseName, tableName],
    );
    expect(storedRows.map((storedRow) => [storedRow.label, storedRow.json_type])).toEqual([
      ['object', 'OBJECT'],
      ['array', 'ARRAY'],
      ['string', 'STRING'],
      ['number', 'INTEGER'],
    ]);
    for (const storedRow of storedRows) {
      const storedJsonText = String(storedRow.json_text);
      expect(storedJsonText).not.toContain('[object Object]');
      expect(JSON.parse(storedJsonText)).toEqual(jsonDocumentsByLabel[String(storedRow.label)]);
    }

    // MariaDB's JSON is a LONGTEXT alias; discovery still reports it as a JSON column.
    const [jsonColumnCatalogRow] = await selectRowsAsAdmin(
      `SELECT DATA_TYPE AS data_type FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = 'json_document'`,
      [databaseName, tableName],
    );
    expect(String(jsonColumnCatalogRow.data_type).toLowerCase()).toBe(
      flavor.serverStoresJsonColumnsAsLongtextAlias ? 'longtext' : 'json',
    );
    expect(readColumnSchemaOfTableSpec(tableSpec, 'json_document')[X_SCRATCH_NATIVE_COLUMN_TYPE]).toMatchObject({
      typeSystem: 'mysql',
      type: 'json',
    });
  });

  it('stores offset date-times as UTC wall clock and truncates fractions to the column precision on both flavors', async () => {
    const { tableName, tableSpec } = await createValueRulesTableAndFetchSpec('temporal');

    const [createdRecordFile, yearEndRecordFile] = await connector.createRecords(tableSpec, [
      {
        label: 'offsets',
        wall_clock_millis: '2026-03-05T14:30:00.123456-05:00',
        wall_clock_seconds: '2026-03-05 14:30:05.678',
        instant_micros: '2026-12-31T23:30:00.123456+01:00',
        calendar_date: '2026-03-05T00:00:00+05:00',
      },
      // A rounding server would carry .999 into the next second, day AND year.
      { label: 'year end', wall_clock_seconds: '2026-12-31 23:59:59.999' },
    ]);

    expect(createdRecordFile).toMatchObject({
      wall_clock_millis: '2026-03-05 19:30:00.123',
      wall_clock_seconds: '2026-03-05 14:30:05',
      instant_micros: '2026-12-31T22:30:00.123456Z',
      calendar_date: '2026-03-05',
    });
    expect(yearEndRecordFile.wall_clock_seconds).toBe('2026-12-31 23:59:59');
    const storedRows = await selectRowsAsAdmin(
      `SELECT wall_clock_millis, wall_clock_seconds, instant_micros, calendar_date FROM ??.?? ORDER BY id`,
      [databaseName, tableName],
    );
    expect(storedRows).toEqual([
      {
        wall_clock_millis: '2026-03-05 19:30:00.123',
        wall_clock_seconds: '2026-03-05 14:30:05',
        instant_micros: '2026-12-31 22:30:00.123456',
        calendar_date: '2026-03-05',
      },
      {
        wall_clock_millis: null,
        wall_clock_seconds: '2026-12-31 23:59:59',
        instant_micros: null,
        calendar_date: null,
      },
    ]);

    // Why the connector truncates itself: written directly, MySQL ROUNDS a fraction into DATETIME(0), MariaDB
    // truncates (LOG.md). Only the connector's own truncation gives both flavors the same stored value.
    await adminConnection.query(
      "INSERT INTO ??.?? (label, wall_clock_seconds) VALUES ('direct', '2026-03-05 14:30:05.678')",
      [databaseName, tableName],
    );
    const [directlyWrittenRow] = await selectRowsAsAdmin(
      "SELECT wall_clock_seconds FROM ??.?? WHERE label = 'direct'",
      [databaseName, tableName],
    );
    expect(directlyWrittenRow.wall_clock_seconds).toBe(
      flavor.flavorName === 'mysql' ? '2026-03-05 14:30:06' : '2026-03-05 14:30:05',
    );

    // TIMESTAMP(6) round-trip: writing back the pulled RFC 3339 text keeps every microsecond.
    const [updatedRecordFile] = await connector.updateRecords(
      tableSpec,
      [createdRecordFile],
      [{ instant_micros: createdRecordFile.instant_micros }],
    );
    expect(updatedRecordFile.instant_micros).toBe('2026-12-31T22:30:00.123456Z');
    const [roundTrippedRow] = await selectRowsAsAdmin('SELECT instant_micros FROM ??.?? WHERE id = ?', [
      databaseName,
      tableName,
      bindExactIntegerId(createdRecordFile.id),
    ]);
    expect(roundTrippedRow.instant_micros).toBe('2026-12-31 22:30:00.123456');
  });

  it('rejects a DATE value with a time of day with a friendly message before any SQL runs', async () => {
    const { tableName, tableSpec } = await createValueRulesTableAndFetchSpec('date_with_time');

    const temporalValueError = await expectRejectionWithMySqlClientProblem(
      connector.createRecords(tableSpec, [{ label: 'rejected', calendar_date: '2026-03-05T10:00:00Z' }]),
      MySqlClientProblem.InvalidTemporalValue,
    );

    expect(temporalValueError.userFriendlyMessage).toBe(
      'Column "calendar_date": "2026-03-05T10:00:00Z" includes a time of day, but this is a DATE column. Send a calendar date (YYYY-MM-DD), or change the column to DATETIME.',
    );
    expect(connector.extractConnectorErrorDetails(temporalValueError).userFriendlyMessage).toBe(
      temporalValueError.userFriendlyMessage,
    );
    expect(await countRowsAsAdmin(tableName)).toBe(0);
    // No INSERT reached the server: a failed InnoDB insert still consumes an AUTO_INCREMENT value.
    const [nextCreatedRecordFile] = await connector.createRecords(tableSpec, [{ label: 'accepted' }]);
    expect(nextCreatedRecordFile.id).toBe(FIRST_ID_ABOVE_TWO_TO_THE_53);

    // Why the connector refuses: written directly, both flavors store a date-time in a DATE column with only a note,
    // silently dropping the time of day.
    await adminConnection.query("INSERT INTO ??.?? (label, calendar_date) VALUES ('direct', '2026-03-05 10:00:00')", [
      databaseName,
      tableName,
    ]);
    const [directlyWrittenRow] = await selectRowsAsAdmin("SELECT calendar_date FROM ??.?? WHERE label = 'direct'", [
      databaseName,
      tableName,
    ]);
    expect(directlyWrittenRow.calendar_date).toBe('2026-03-05');
  });

  it("writes '' into a DECIMAL column as NULL (create and update)", async () => {
    const { tableName, tableSpec } = await createValueRulesTableAndFetchSpec('empty_decimal');

    const [createdRecordFile] = await connector.createRecords(tableSpec, [{ label: 'empty amount', amount: '' }]);
    expect(createdRecordFile.amount).toBeNull();

    await adminConnection.query('UPDATE ??.?? SET amount = 12.5 WHERE id = ?', [
      databaseName,
      tableName,
      bindExactIntegerId(createdRecordFile.id),
    ]);
    const [updatedRecordFile] = await connector.updateRecords(
      tableSpec,
      [{ ...createdRecordFile, amount: '' }],
      [{ amount: '' }],
    );
    expect(updatedRecordFile.amount).toBeNull();
    const [storedRow] = await selectRowsAsAdmin('SELECT amount FROM ??.?? WHERE id = ?', [
      databaseName,
      tableName,
      bindExactIntegerId(createdRecordFile.id),
    ]);
    expect(storedRow.amount).toBeNull();
  });

  // ── updates ─────────────────────────────────────────────────────────────────────────────────────────────────

  it('a one-key edit inside a JSON document (sparse changedFields) writes the whole document, keeping sibling keys', async () => {
    const { tableName, tableSpec } = await createValueRulesTableAndFetchSpec('sparse_json');
    const [createdRecordFile] = await connector.createRecords(tableSpec, [
      {
        label: 'document',
        json_document: { nested: { edited: 1, untouched: [1, 2] }, sibling: 'kept é🎉' },
      },
    ]);
    const editedJsonDocument = { nested: { edited: 2, untouched: [1, 2] }, sibling: 'kept é🎉' };

    // The publish pipeline's changedFields is a DEEP sparse diff: only the edited leaf.
    const [updatedRecordFile] = await connector.updateRecords(
      tableSpec,
      [{ ...createdRecordFile, json_document: editedJsonDocument }],
      [{ json_document: { nested: { edited: 2 } } }],
    );

    expect(updatedRecordFile.json_document).toEqual(editedJsonDocument);
    const [storedRow] = await selectRowsAsAdmin(
      'SELECT CAST(json_document AS CHAR) AS json_text FROM ??.?? WHERE id = ?',
      [databaseName, tableName, bindExactIntegerId(createdRecordFile.id)],
    );
    expect(JSON.parse(String(storedRow.json_text))).toEqual(editedJsonDocument);
  });

  it('bumps ON UPDATE CURRENT_TIMESTAMP (in UTC) on a real change, and a no-op update still returns the row', async () => {
    const { tableName, tableSpec } = await createValueRulesTableAndFetchSpec('on_update');
    const [createdRecordFile] = await connector.createRecords(tableSpec, [{ label: 'before' }]);
    await adminConnection.query("UPDATE ??.?? SET row_updated_at = '2000-01-01 00:00:00' WHERE id = ?", [
      databaseName,
      tableName,
      bindExactIntegerId(createdRecordFile.id),
    ]);

    const [updatedRecordFile] = await connector.updateRecords(
      tableSpec,
      [{ ...createdRecordFile, label: 'after' }],
      [{ label: 'after' }],
    );

    const [storedRow] = await selectRowsAsAdmin('SELECT label, row_updated_at FROM ??.?? WHERE id = ?', [
      databaseName,
      tableName,
      bindExactIntegerId(createdRecordFile.id),
    ]);
    expect(storedRow.label).toBe('after');
    expect(storedRow.row_updated_at).not.toBe('2000-01-01 00:00:00');
    // The read-back ran inside the write transaction, so it already carries the server-set value.
    expect(updatedRecordFile.row_updated_at).toBe(storedRow.row_updated_at);
    // The connector's session runs in UTC, so a DATETIME ON UPDATE column receives UTC wall clock.
    const bumpedMillisecondsFromNow = Math.abs(
      parseUtcWallClockDateTimeText(String(storedRow.row_updated_at)) - Date.now(),
    );
    expect(bumpedMillisecondsFromNow).toBeLessThan(10 * 60_000);

    // No-op update: FOUND_ROWS makes MySQL report the matched row, so the connector returns it (no RecordNotFound),
    // and ON UPDATE doesn't fire because nothing changed.
    const [noOpUpdatedRecordFile] = await connector.updateRecords(tableSpec, [updatedRecordFile], [{ label: 'after' }]);
    expect(noOpUpdatedRecordFile).toMatchObject({
      id: createdRecordFile.id,
      label: 'after',
      row_updated_at: storedRow.row_updated_at,
    });
  });

  it('updating and deleting id 9007199254740993 touch only that row, never its neighbour 9007199254740992', async () => {
    const { tableName, tableSpec } = await createValueRulesTableAndFetchSpec('bigint_neighbours');
    await adminConnection.query("INSERT INTO ??.?? (id, label) VALUES (?, 'neighbour'), (?, 'target')", [
      databaseName,
      tableName,
      bindExactIntegerId(TWO_TO_THE_53),
      bindExactIntegerId(FIRST_ID_ABOVE_TWO_TO_THE_53),
    ]);
    // Both ids are the same JS number (and the same DOUBLE), so any path that turned the id into a number would
    // address the neighbour. (MySQL 8.4 / MariaDB 11.4 compare an all-digits TEXT constant with an integer column
    // exactly, so it's the '12abc' case below, not this one, where text binding goes wrong on these versions.)
    expect(Number(FIRST_ID_ABOVE_TWO_TO_THE_53)).toBe(Number(TWO_TO_THE_53));

    const [updatedRecordFile] = await connector.updateRecords(
      tableSpec,
      [{ id: FIRST_ID_ABOVE_TWO_TO_THE_53, label: 'target edited' }],
      [{ label: 'target edited' }],
    );
    expect(updatedRecordFile).toMatchObject({ id: FIRST_ID_ABOVE_TWO_TO_THE_53, label: 'target edited' });

    await connector.deleteRecords(tableSpec, [{ id: FIRST_ID_ABOVE_TWO_TO_THE_53 }]);
    const remainingRows = await selectRowsAsAdmin('SELECT id, label FROM ??.?? ORDER BY id', [databaseName, tableName]);
    expect(remainingRows.map((remainingRow) => [remainingRow.id, remainingRow.label])).toEqual([
      [TWO_TO_THE_53, 'neighbour'],
    ]);
  });

  it('an update whose row was deleted fails with RemoteRecordNotFound and rolls back the whole batch', async () => {
    const { tableName, tableSpec } = await createValueRulesTableAndFetchSpec('vanished_row');
    const [siblingRecordFile, vanishedRecordFile] = await connector.createRecords(tableSpec, [
      { label: 'sibling' },
      { label: 'vanished' },
    ]);
    await adminConnection.query('DELETE FROM ??.?? WHERE id = ?', [
      databaseName,
      tableName,
      bindExactIntegerId(vanishedRecordFile.id),
    ]);

    // The sibling's UPDATE runs first and succeeds; the vanished row's 0-row UPDATE then fails the batch.
    const recordNotFoundError = await expectRejectionWithMySqlClientProblem(
      connector.updateRecords(
        tableSpec,
        [
          { ...siblingRecordFile, label: 'sibling edited' },
          { ...vanishedRecordFile, label: 'vanished edited' },
        ],
        [{ label: 'sibling edited' }, { label: 'vanished edited' }],
      ),
      MySqlClientProblem.RecordNotFound,
    );

    const recordNotFoundErrorDetails = connector.extractConnectorErrorDetails(recordNotFoundError);
    expect(recordNotFoundErrorDetails.errorCode).toBe(ConnectorErrorCode.RemoteRecordNotFound);
    expect(recordNotFoundErrorDetails.errorCode).toBe('remote_record_not_found');
    expect(recordNotFoundErrorDetails.userFriendlyMessage).toContain('Nothing in this batch was changed.');
    expectUserFacingErrorMessageToLeakNoNetworkOrSqlDetails(recordNotFoundErrorDetails.userFriendlyMessage);
    const remainingRows = await selectRowsAsAdmin('SELECT id, label FROM ??.??', [databaseName, tableName]);
    expect(remainingRows.map((remainingRow) => [remainingRow.id, remainingRow.label])).toEqual([
      [siblingRecordFile.id, 'sibling'],
    ]);
  });

  it("a non-integer id such as '12abc' matches no row: update fails with RecordNotFound, delete skips it", async () => {
    const tableName = buildWritesSpecTableName('non_integer_id');
    await createTableAsAdmin(
      tableName,
      '(id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, label VARCHAR(50) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    );
    await adminConnection.query("INSERT INTO ??.?? (id, label) VALUES (12, 'twelve')", [databaseName, tableName]);
    const tableSpec = await fetchTableSpecThroughConnector(tableName);
    // The danger: compared as text, '12abc' IS row 12 on both flavors.
    const [textComparisonRow] = await selectRowsAsAdmin("SELECT COUNT(*) AS row_count FROM ??.?? WHERE id = '12abc'", [
      databaseName,
      tableName,
    ]);
    expect(Number(textComparisonRow.row_count)).toBe(1);

    const recordNotFoundError = await expectRejectionWithMySqlClientProblem(
      connector.updateRecords(tableSpec, [{ id: '12abc', label: 'hijacked' }], [{ label: 'hijacked' }]),
      MySqlClientProblem.RecordNotFound,
    );
    // The "can't match any row" wording: the id was refused before an UPDATE was built.
    expect(recordNotFoundError.userFriendlyMessage).toContain(
      `this record's id isn't a valid "id" value, so it can't match any row`,
    );
    expect(recordNotFoundError.errorCode).toBe(ConnectorErrorCode.RemoteRecordNotFound);

    await connector.deleteRecords(tableSpec, [{ id: '12abc' }]);

    const remainingRows = await selectRowsAsAdmin('SELECT id, label FROM ??.??', [databaseName, tableName]);
    expect(remainingRows.map((remainingRow) => [remainingRow.id, remainingRow.label])).toEqual([[12, 'twelve']]);
  });

  it('a non-unique id column trips the multiple-rows guard for update and delete, leaving every row unchanged', async () => {
    const tableName = buildWritesSpecTableName('non_unique_id');
    await createTableAsAdmin(
      tableName,
      '(code VARCHAR(10) NOT NULL, note VARCHAR(20) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    );
    await adminConnection.query(
      "INSERT INTO ??.?? (code, note) VALUES ('dup', 'one'), ('dup', 'two'), ('solo', 'three')",
      [databaseName, tableName],
    );
    const discoveredTableSpec = await fetchTableSpecThroughConnector(tableName);
    // No unique key: discovery says so instead of guessing, and the user's id override is what addresses rows.
    expect(discoveredTableSpec.idPathRequiresUserSelection).toBe(true);
    const tableSpecWithUserChosenNonUniqueId: BaseJsonTableSpec = { ...discoveredTableSpec, idPath: dotPath('code') };
    delete tableSpecWithUserChosenNonUniqueId.idPathRequiresUserSelection;
    const rowsBeforeWrites = await selectRowsAsAdmin('SELECT code, note FROM ??.?? ORDER BY note', [
      databaseName,
      tableName,
    ]);

    // 'solo' is updated first and matches one row; 'dup' then matches two → the whole batch rolls back.
    const updateGuardError = await expectRejectionWithMySqlClientProblem(
      connector.updateRecords(
        tableSpecWithUserChosenNonUniqueId,
        [
          { code: 'solo', note: 'solo edited' },
          { code: 'dup', note: 'dup edited' },
        ],
        [{ note: 'solo edited' }, { note: 'dup edited' }],
      ),
      MySqlClientProblem.UpdateMatchedMultipleRows,
    );
    expect(updateGuardError.userFriendlyMessage).toContain('Nothing in this batch was changed.');
    expect(await selectRowsAsAdmin('SELECT code, note FROM ??.?? ORDER BY note', [databaseName, tableName])).toEqual(
      rowsBeforeWrites,
    );

    const deleteGuardError = await expectRejectionWithMySqlClientProblem(
      connector.deleteRecords(tableSpecWithUserChosenNonUniqueId, [{ code: 'solo' }, { code: 'dup' }]),
      MySqlClientProblem.DeleteMatchedMultipleRows,
    );
    expect(deleteGuardError.userFriendlyMessage).toContain('Nothing in this batch was deleted.');
    expect(await selectRowsAsAdmin('SELECT code, note FROM ??.?? ORDER BY note', [databaseName, tableName])).toEqual(
      rowsBeforeWrites,
    );
  });

  // ── tables the connector refuses to write ───────────────────────────────────────────────────────────────────

  it('refuses creates, updates and deletes on a MyISAM table before any DML (MyISAM could not roll one back)', async () => {
    const tableName = buildWritesSpecTableName('myisam');
    await createTableAsAdmin(tableName, '(id INT AUTO_INCREMENT PRIMARY KEY, label VARCHAR(20) NULL) ENGINE=MyISAM');
    await adminConnection.query("INSERT INTO ??.?? (id, label) VALUES (1, 'keep')", [databaseName, tableName]);
    const tableSpec = await fetchTableSpecThroughConnector(tableName);
    const expectedMessage = unsupportedStorageEngineWriteMessage({ databaseName, tableName }, 'MyISAM');

    const refusedWriteErrors = [
      await expectRejectionWithMySqlClientProblem(
        connector.createRecords(tableSpec, [{ label: 'new' }]),
        MySqlClientProblem.UnsupportedStorageEngine,
      ),
      await expectRejectionWithMySqlClientProblem(
        connector.updateRecords(tableSpec, [{ id: 1, label: 'changed' }], [{ label: 'changed' }]),
        MySqlClientProblem.UnsupportedStorageEngine,
      ),
      await expectRejectionWithMySqlClientProblem(
        connector.deleteRecords(tableSpec, [{ id: 1 }]),
        MySqlClientProblem.UnsupportedStorageEngine,
      ),
    ];

    for (const refusedWriteError of refusedWriteErrors) {
      expect(refusedWriteError.userFriendlyMessage).toBe(expectedMessage);
    }
    const remainingRows = await selectRowsAsAdmin('SELECT id, label FROM ??.??', [databaseName, tableName]);
    expect(remainingRows.map((remainingRow) => [remainingRow.id, remainingRow.label])).toEqual([[1, 'keep']]);
  });

  it('refuses creates with CreateRequiresAutoIncrementId when the id column is not AUTO_INCREMENT', async () => {
    const tableWithoutAutoIncrementName = buildWritesSpecTableName('no_auto_increment');
    await createTableAsAdmin(
      tableWithoutAutoIncrementName,
      '(code VARCHAR(20) PRIMARY KEY, note VARCHAR(20) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    );
    const tableWithAutoIncrementElsewhereName = buildWritesSpecTableName('auto_increment_not_id');
    await createTableAsAdmin(
      tableWithAutoIncrementElsewhereName,
      '(code VARCHAR(20) PRIMARY KEY, sequence_number INT NOT NULL AUTO_INCREMENT UNIQUE, note VARCHAR(20) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    );

    const noAutoIncrementError = await expectRejectionWithMySqlClientProblem(
      connector.createRecords(await fetchTableSpecThroughConnector(tableWithoutAutoIncrementName), [
        { code: 'new', note: 'x' },
      ]),
      MySqlClientProblem.CreateRequiresAutoIncrementId,
    );
    expect(noAutoIncrementError.userFriendlyMessage).toContain('it has no AUTO_INCREMENT id column');

    const autoIncrementElsewhereError = await expectRejectionWithMySqlClientProblem(
      connector.createRecords(await fetchTableSpecThroughConnector(tableWithAutoIncrementElsewhereName), [
        { code: 'new', note: 'x' },
      ]),
      MySqlClientProblem.CreateRequiresAutoIncrementId,
    );
    expect(autoIncrementElsewhereError.userFriendlyMessage).toContain(
      'its id column "code" isn\'t generated by MySQL. Use the AUTO_INCREMENT column "sequence_number"',
    );

    expect(await countRowsAsAdmin(tableWithoutAutoIncrementName)).toBe(0);
    expect(await countRowsAsAdmin(tableWithAutoIncrementElsewhereName)).toBe(0);
  });

  it('writes to a table dropped after its spec was fetched fail with TableNotFound', async () => {
    const { tableName, tableSpec } = await createValueRulesTableAndFetchSpec('dropped');
    await adminConnection.query('DROP TABLE ??.??', [databaseName, tableName]);

    const tableNotFoundErrors = [
      await expectRejectionWithMySqlClientProblem(
        connector.createRecords(tableSpec, [{ label: 'new' }]),
        MySqlClientProblem.TableNotFound,
      ),
      await expectRejectionWithMySqlClientProblem(
        connector.updateRecords(tableSpec, [{ id: FIRST_ID_ABOVE_TWO_TO_THE_53, label: 'x' }], [{ label: 'x' }]),
        MySqlClientProblem.TableNotFound,
      ),
      await expectRejectionWithMySqlClientProblem(
        connector.deleteRecords(tableSpec, [{ id: FIRST_ID_ABOVE_TWO_TO_THE_53 }]),
        MySqlClientProblem.TableNotFound,
      ),
    ];

    for (const tableNotFoundError of tableNotFoundErrors) {
      expect(tableNotFoundError.userFriendlyMessage).toBe(
        `Can't write to "${databaseName}"."${tableName}": the table doesn't exist in MySQL any more (was it renamed or dropped?).`,
      );
    }
  });

  // ── key types ───────────────────────────────────────────────────────────────────────────────────────────────

  it('addresses a BINARY(16) primary key by its pulled base64 id for update and delete', async () => {
    const tableName = buildWritesSpecTableName('binary_key');
    await createTableAsAdmin(
      tableName,
      '(id BINARY(16) PRIMARY KEY, label VARCHAR(20) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    );
    await adminConnection.query(
      "INSERT INTO ??.?? (id, label) VALUES (UNHEX('00112233445566778899AABBCCDDEEFF'), 'target'), (UNHEX('FF112233445566778899AABBCCDDEEFF'), 'other')",
      [databaseName, tableName],
    );
    const tableSpec = await fetchTableSpecThroughConnector(tableName);
    const pulledTargetRecordFile = (await pullAllRowsThroughConnector(tableSpec)).find(
      (pulledRecordFile) => pulledRecordFile.label === 'target',
    );
    const expectedBase64TargetId = Buffer.from('00112233445566778899AABBCCDDEEFF', 'hex').toString('base64');
    expect(pulledTargetRecordFile?.id).toBe(expectedBase64TargetId);
    if (!pulledTargetRecordFile) throw new Error('the target row was not pulled');

    const [updatedRecordFile] = await connector.updateRecords(
      tableSpec,
      [{ ...pulledTargetRecordFile, label: 'target edited' }],
      [{ label: 'target edited' }],
    );
    expect(updatedRecordFile).toEqual({ id: expectedBase64TargetId, label: 'target edited' });

    await connector.deleteRecords(tableSpec, [updatedRecordFile]);
    const remainingRows = await selectRowsAsAdmin('SELECT HEX(id) AS id_hex, label FROM ??.??', [
      databaseName,
      tableName,
    ]);
    expect(remainingRows.map((remainingRow) => [remainingRow.id_hex, remainingRow.label])).toEqual([
      ['FF112233445566778899AABBCCDDEEFF', 'other'],
    ]);
  });

  it("updates a case-insensitive (_ci) VARCHAR key sent as 'abc' and returns the stored 'ABC' row", async () => {
    const tableName = buildWritesSpecTableName('ci_key');
    await createTableAsAdmin(
      tableName,
      '(code VARCHAR(20) PRIMARY KEY, note VARCHAR(20) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci',
    );
    await adminConnection.query("INSERT INTO ??.?? (code, note) VALUES ('ABC', 'upper')", [databaseName, tableName]);
    const tableSpec = await fetchTableSpecThroughConnector(tableName);

    const updatedRecordFiles = await connector.updateRecords(
      tableSpec,
      [{ code: 'abc', note: 'folded' }],
      [{ note: 'folded' }],
    );

    expect(updatedRecordFiles).toEqual([{ code: 'ABC', note: 'folded' }]);
    const storedRows = await selectRowsAsAdmin('SELECT code, note FROM ??.??', [databaseName, tableName]);
    expect(storedRows.map((storedRow) => [storedRow.code, storedRow.note])).toEqual([['ABC', 'folded']]);
  });

  // ── columns that can't be written ───────────────────────────────────────────────────────────────────────────

  it('an edit to a BLOB column fails with NonWritableFieldEditError before any SQL; unrelated edits still work', async () => {
    const tableName = buildWritesSpecTableName('blob');
    await createTableAsAdmin(
      tableName,
      '(id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, label VARCHAR(20) NULL, binary_payload BLOB NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    );
    await adminConnection.query("INSERT INTO ??.?? (id, label, binary_payload) VALUES (1, 'row', X'00FF10')", [
      databaseName,
      tableName,
    ]);
    const tableSpec = await fetchTableSpecThroughConnector(tableName);
    const [pulledRecordFile] = await pullAllRowsThroughConnector(tableSpec);
    expect(pulledRecordFile.binary_payload).toBe('AP8Q');
    const expectedNonWritableMessage = nonWritableFieldEditErrorMessage({
      [NonWritableFieldReason.NotYetSupported]: ['binary_payload'],
    });

    for (const refusedBlobWrite of [
      connector.updateRecords(
        tableSpec,
        [{ ...pulledRecordFile, binary_payload: 'AAEC' }],
        [{ binary_payload: 'AAEC' }],
      ),
      connector.createRecords(tableSpec, [{ label: 'new', binary_payload: 'AAEC' }]),
    ]) {
      const nonWritableFieldError = await captureRejectionOfOperation(refusedBlobWrite);
      expect(nonWritableFieldError).toBeInstanceOf(NonWritableFieldEditError);
      expect(connector.extractConnectorErrorDetails(nonWritableFieldError).userFriendlyMessage).toBe(
        expectedNonWritableMessage,
      );
    }

    // The file still carries the pulled base64, but only the changed keys are written.
    const [updatedRecordFile] = await connector.updateRecords(
      tableSpec,
      [{ ...pulledRecordFile, label: 'relabelled' }],
      [{ label: 'relabelled' }],
    );
    expect(updatedRecordFile).toEqual({ id: 1, label: 'relabelled', binary_payload: 'AP8Q' });
    const storedRows = await selectRowsAsAdmin('SELECT HEX(binary_payload) AS payload_hex FROM ??.??', [
      databaseName,
      tableName,
    ]);
    expect(storedRows.map((storedRow) => storedRow.payload_hex)).toEqual(['00FF10']);
  });

  it("writing a generated column surfaces the server's own rejection as a friendly message", async () => {
    const tableName = buildWritesSpecTableName('generated_column');
    await createTableAsAdmin(
      tableName,
      `(id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, label VARCHAR(20) NULL,
        label_length INT GENERATED ALWAYS AS (CHAR_LENGTH(label)) VIRTUAL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
    await adminConnection.query("INSERT INTO ??.?? (id, label) VALUES (1, 'four')", [databaseName, tableName]);
    const tableSpec = await fetchTableSpecThroughConnector(tableName);
    expect(readColumnSchemaOfTableSpec(tableSpec, 'label_length')[X_SCRATCH_READONLY]).toBe(true);

    // Not pre-stripped: "send the data and let the service reject it".
    const generatedColumnRejection = await captureRejectionOfOperation(
      connector.updateRecords(
        tableSpec,
        [{ id: 1, label: 'four changed', label_length: 99 }],
        [{ label: 'four changed', label_length: 99 }],
      ),
    );

    expect(readMySqlServerErrorNumber(generatedColumnRejection)).toBe(flavor.flavorName === 'mysql' ? 3105 : 1906);
    const generatedColumnErrorDetails = connector.extractConnectorErrorDetails(generatedColumnRejection);
    expect(
      generatedColumnErrorDetails.userFriendlyMessage.startsWith(
        MYSQL_DATA_ERROR_LEAD_SENTENCES.generatedColumnWritten,
      ),
    ).toBe(true);
    expect(generatedColumnErrorDetails.userFriendlyMessage).toContain('label_length');
    expectUserFacingErrorMessageToLeakNoNetworkOrSqlDetails(generatedColumnErrorDetails.userFriendlyMessage);
    const storedRows = await selectRowsAsAdmin('SELECT label, label_length FROM ??.??', [databaseName, tableName]);
    expect(storedRows.map((storedRow) => [storedRow.label, storedRow.label_length])).toEqual([['four', 4]]);
  });

  // ── id columns whose pulled rendering isn't MySQL's own literal (DEV-12035 review: id binding and types) ────────

  /** A targeted file pull (pull-files job): the ids arrive as the FileIndex's text, whatever the column type. */
  async function pullRecordFilesByIdsThroughConnector(
    tableSpec: BaseJsonTableSpec,
    recordIds: string[],
  ): Promise<ConnectorFile[]> {
    const pulledRecordFiles: ConnectorFile[] = [];
    await connector.pullRecordFilesByIds(tableSpec, recordIds, ({ files }) => {
      pulledRecordFiles.push(...files);
      return Promise.resolve();
    });
    return pulledRecordFiles;
  }

  it.each([
    {
      keyColumnType: 'TIMESTAMP(3)',
      tableNameSuffix: 'timestamp_key',
      storedTargetKey: '2026-01-02 03:04:05.678',
      storedOtherKey: '2026-01-02 03:04:05.679',
      // TIMESTAMP is pulled as RFC 3339 UTC, which MySQL rejects (1292) / MariaDB never matches as a WHERE literal.
      expectedPulledTargetId: '2026-01-02T03:04:05.678Z',
    },
    {
      keyColumnType: 'DATETIME(3)',
      tableNameSuffix: 'datetime_key',
      storedTargetKey: '2026-01-02 03:04:05.678',
      storedOtherKey: '2026-01-02 03:04:05.679',
      expectedPulledTargetId: '2026-01-02 03:04:05.678',
    },
    {
      keyColumnType: 'DATE',
      tableNameSuffix: 'date_key',
      storedTargetKey: '2026-01-02',
      storedOtherKey: '2026-01-03',
      expectedPulledTargetId: '2026-01-02',
    },
  ])(
    'addresses a $keyColumnType primary key by its pulled id: by-id pull, update and delete (the row is really gone)',
    async ({ keyColumnType, tableNameSuffix, storedTargetKey, storedOtherKey, expectedPulledTargetId }) => {
      const tableName = buildWritesSpecTableName(tableNameSuffix);
      await createTableAsAdmin(
        tableName,
        `(recorded_at ${keyColumnType} NOT NULL PRIMARY KEY, label VARCHAR(20) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
      await adminConnection.query("INSERT INTO ??.?? (recorded_at, label) VALUES (?, 'target'), (?, 'other')", [
        databaseName,
        tableName,
        storedTargetKey,
        storedOtherKey,
      ]);
      const tableSpec = await fetchTableSpecThroughConnector(tableName);
      expect(tableSpec.idPath).toBe('recorded_at');
      // An edited id would address another row, so the id column is never offered for editing.
      expect(readColumnSchemaOfTableSpec(tableSpec, 'recorded_at')[X_SCRATCH_READONLY]).toBe(true);

      const pulledTargetRecordFile = (await pullAllRowsThroughConnector(tableSpec)).find(
        (pulledRecordFile) => pulledRecordFile.label === 'target',
      );
      expect(pulledTargetRecordFile?.recorded_at).toBe(expectedPulledTargetId);
      if (!pulledTargetRecordFile) throw new Error('the target row was not pulled');

      const recordFilesPulledById = await pullRecordFilesByIdsThroughConnector(tableSpec, [expectedPulledTargetId]);
      expect(recordFilesPulledById).toEqual([{ recorded_at: expectedPulledTargetId, label: 'target' }]);

      const updatedRecordFiles = await connector.updateRecords(
        tableSpec,
        [{ ...pulledTargetRecordFile, label: 'target edited' }],
        [{ label: 'target edited' }],
      );
      expect(updatedRecordFiles).toEqual([{ recorded_at: expectedPulledTargetId, label: 'target edited' }]);

      await connector.deleteRecords(tableSpec, updatedRecordFiles);
      const remainingRows = await selectRowsAsAdmin('SELECT recorded_at, label FROM ??.??', [databaseName, tableName]);
      expect(remainingRows.map((remainingRow) => [remainingRow.recorded_at, remainingRow.label])).toEqual([
        [storedOtherKey, 'other'],
      ]);
    },
  );

  it('finds, updates and deletes a BIT(8) primary key row by its pulled numeric id, also when sent as text', async () => {
    const tableName = buildWritesSpecTableName('bit_key');
    await createTableAsAdmin(
      tableName,
      '(flags BIT(8) NOT NULL PRIMARY KEY, label VARCHAR(20) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    );
    await adminConnection.query("INSERT INTO ??.?? (flags, label) VALUES (b'101', 'target'), (b'110', 'other')", [
      databaseName,
      tableName,
    ]);
    const tableSpec = await fetchTableSpecThroughConnector(tableName);
    expect(tableSpec.idPath).toBe('flags');
    const pulledTargetRecordFile = (await pullAllRowsThroughConnector(tableSpec)).find(
      (pulledRecordFile) => pulledRecordFile.label === 'target',
    );
    expect(pulledTargetRecordFile?.flags).toBe(5);
    if (!pulledTargetRecordFile) throw new Error('the target row was not pulled');

    // By-id pulls always get text ids; the quoted '5' would compare as the byte 0x35 and match nothing.
    expect(await pullRecordFilesByIdsThroughConnector(tableSpec, ['5'])).toEqual([{ flags: 5, label: 'target' }]);

    const updatedRecordFiles = await connector.updateRecords(
      tableSpec,
      [{ ...pulledTargetRecordFile, label: 'target edited' }],
      [{ label: 'target edited' }],
    );
    expect(updatedRecordFiles).toEqual([{ flags: 5, label: 'target edited' }]);
    await connector.deleteRecords(tableSpec, updatedRecordFiles);
    const remainingRows = await selectRowsAsAdmin('SELECT flags + 0 AS flags_value, label FROM ??.??', [
      databaseName,
      tableName,
    ]);
    expect(remainingRows.map((remainingRow) => [String(remainingRow.flags_value), remainingRow.label])).toEqual([
      ['6', 'other'],
    ]);
  });

  it('never addresses rows by a FLOAT key: another unique column wins, or the spec asks the user to choose', async () => {
    const floatKeyOnlyTableName = buildWritesSpecTableName('float_key_only');
    await createTableAsAdmin(
      floatKeyOnlyTableName,
      '(measurement FLOAT NOT NULL PRIMARY KEY, label VARCHAR(20) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
    );
    const floatKeyOnlyTableSpec = await fetchTableSpecThroughConnector(floatKeyOnlyTableName);
    expect(floatKeyOnlyTableSpec.idPathRequiresUserSelection).toBe(true);

    const floatKeyWithUniqueCodeTableName = buildWritesSpecTableName('float_key_unique_code');
    await createTableAsAdmin(
      floatKeyWithUniqueCodeTableName,
      `(measurement FLOAT NOT NULL PRIMARY KEY, reading_code VARCHAR(20) NOT NULL UNIQUE, label VARCHAR(20) NULL)
       ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
    await adminConnection.query(
      "INSERT INTO ??.?? (measurement, reading_code, label) VALUES (1.1, 'r-1', 'target'), (2.2, 'r-2', 'other')",
      [databaseName, floatKeyWithUniqueCodeTableName],
    );
    const floatKeyWithUniqueCodeTableSpec = await fetchTableSpecThroughConnector(floatKeyWithUniqueCodeTableName);
    expect(floatKeyWithUniqueCodeTableSpec.idPath).toBe('reading_code');
    expect(floatKeyWithUniqueCodeTableSpec.idPathRequiresUserSelection).toBeUndefined();

    // The rows the FLOAT id could never find (its pulled 1.1 isn't the stored float32) are found by the code.
    const [recordFilePulledById] = await pullRecordFilesByIdsThroughConnector(floatKeyWithUniqueCodeTableSpec, ['r-1']);
    expect(recordFilePulledById).toEqual({ measurement: 1.1, reading_code: 'r-1', label: 'target' });
    await connector.deleteRecords(floatKeyWithUniqueCodeTableSpec, [recordFilePulledById]);
    expect(await countRowsAsAdmin(floatKeyWithUniqueCodeTableName)).toBe(1);
  });

  it('pulls a binary-charset ENUM / SET as base64 that validates against its read-only base64 schema', async () => {
    const tableName = buildWritesSpecTableName('binary_charset_enum_set');
    // DEFAULT CHARSET=binary keeps ENUM / SET as ENUM / SET (MySQL reports CHARACTER_SET_NAME NULL, MariaDB 'binary').
    await createTableAsAdmin(
      tableName,
      "(id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, choice ENUM('p','q') NULL, choices SET('m','n') NULL) ENGINE=InnoDB DEFAULT CHARSET=binary",
    );
    await adminConnection.query("INSERT INTO ??.?? (id, choice, choices) VALUES (1, 'q', 'm,n')", [
      databaseName,
      tableName,
    ]);
    const tableSpec = await fetchTableSpecThroughConnector(tableName);
    for (const [columnName, columnType] of [
      ['choice', "enum('p','q')"],
      ['choices', "set('m','n')"],
    ]) {
      const binaryColumnSchema = readColumnSchemaOfTableSpec(tableSpec, columnName);
      expect(binaryColumnSchema[X_SCRATCH_READONLY]).toBe(true);
      expect(binaryColumnSchema[X_SCRATCH_NATIVE_COLUMN_TYPE]).toEqual({
        typeSystem: 'mysql',
        type: `${columnType} character set binary`,
        isRecreatableVerbatim: false,
      });
      expect(JSON.stringify(binaryColumnSchema)).toContain('"contentEncoding":"base64"');
    }

    const [pulledRecordFile] = await pullAllRowsThroughConnector(tableSpec);
    expect(pulledRecordFile).toEqual({
      id: 1,
      choice: Buffer.from('q').toString('base64'),
      choices: Buffer.from('m,n').toString('base64'),
    });
    expect([...Value.Errors(tableSpec.schema, pulledRecordFile)]).toEqual([]);

    // Writing the base64 text back would store the text's bytes, not the member: refused before any SQL.
    const nonWritableFieldError = await captureRejectionOfOperation(
      connector.updateRecords(tableSpec, [{ ...pulledRecordFile, choice: 'cA==' }], [{ choice: 'cA==' }]),
    );
    expect(nonWritableFieldError).toBeInstanceOf(NonWritableFieldEditError);
    const storedRows = await selectRowsAsAdmin('SELECT CAST(choice AS CHAR) AS choice_text FROM ??.??', [
      databaseName,
      tableName,
    ]);
    expect(storedRows.map((storedRow) => storedRow.choice_text)).toEqual(['q']);
  });

  it("doesn't offer a latin1 VARCHAR for verbatim recreation (a utf8mb4 copy reserves 4x the row width)", async () => {
    const tableName = buildWritesSpecTableName('latin1_varchar');
    await createTableAsAdmin(
      tableName,
      `(id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, legacy_name VARCHAR(255) CHARACTER SET latin1 NULL,
        modern_name VARCHAR(255) NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
    const tableSpec = await fetchTableSpecThroughConnector(tableName);
    expect(readColumnSchemaOfTableSpec(tableSpec, 'legacy_name')[X_SCRATCH_NATIVE_COLUMN_TYPE]).toEqual({
      typeSystem: 'mysql',
      type: 'varchar(255)',
      isRecreatableVerbatim: false,
    });
    expect(readColumnSchemaOfTableSpec(tableSpec, 'modern_name')[X_SCRATCH_NATIVE_COLUMN_TYPE]).toEqual({
      typeSystem: 'mysql',
      type: 'varchar(255)',
      isRecreatableVerbatim: true,
    });
  });
});
