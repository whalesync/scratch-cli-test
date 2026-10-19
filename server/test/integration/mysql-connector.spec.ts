/**
 * MySQL connector integration test (the CONNECTOR_GUIDE's `<service>-connector.spec.ts`): discovery, pulls and a
 * create / update / delete smoke test, run through the connector exactly as production builds it (the registry's
 * `createConnector`, stored-credential re-validation included) against real MySQL 8.4 and MariaDB 11.4 servers.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * What this validates that the unit specs (mocked knex, pure builders) can't
 * ═══════════════════════════════════════════════════════════════════════════
 *   1. listTables' preview flags on real catalogs: a view is disabled, a MyISAM table is pull-only, a table whose
 *      primary key is a UUID default can't take creates, a composite-primary-key-only table is disabled, and
 *      (MariaDB) a SYSTEM VERSIONED table is fully usable.
 *   2. fetchJsonTableSpec's per-column annotations (family, format, read-only, native type) on both catalogs,
 *      including MariaDB's JSON-as-LONGTEXT alias, the INVISIBLE-column policy and a foreign key's target.
 *   3. Every MySQL type is pulled as the PLAN's type table says: BIGINT past 2^53 and DECIMAL(65,30) as verbatim
 *      strings, a TIMESTAMP written from a +05:00 session rendered as UTC `…Z`, DATETIME / DATE and zero dates
 *      verbatim, binaries as base64, BIT as a number, the SRID-prefixed geometry, JSON with emoji and pg-parity
 *      precision loss above 2^53 — plus column names `a.b`, `Marked as done`, `Featured?` and one with a backtick.
 *   4. Every pulled record validates against the spec's own JSON schema; the only format findings are zero dates.
 *   5. OFFSET pagination over more than 1,000 rows returns every row exactly once, and resumes from `nextOffset`.
 *   6. A filter with a top-level OR combined with an incremental `since` stays parenthesized.
 *   7. pullRecordFilesByIds matches a BIGINT id exactly (2^53+1, not 2^53) and skips missing ids, and never sends
 *      a non-integer id such as '12abc' (which MySQL would coerce to 12); a BINARY(16) id matches by its base64.
 *   8. Creates return the re-selected rows with their AUTO_INCREMENT ids, an update driven by a sparse
 *      `changedFields` diff writes whole JSON values, and deletes tolerate rows that are already gone.
 *   9. (MySQL) a table with a generated invisible primary key is addressed and pulled by `my_row_id`.
 *
 * The write-guard edge cases (multi-row ids, strict mode, MyISAM refusal, ...) live in mysql-record-writes.spec.ts,
 * DDL in mysql-create-schema.spec.ts and the job-level incremental pull in mysql-incremental-pull.spec.ts.
 *
 * Tables are hermetic (`scratch_mysql_it_connector_*`, created by the admin connection) and dropped before and after
 * the run; set SKIP_CLEANUP=1 to keep them for inspection. The seeded companies / deals tables are never touched.
 *
 * Run (from server/, with server/localdev/docker-compose.mysql.yml up):
 *   MYSQL_TEST_URL=mysql://test:test@127.0.0.1:3306/test_db MYSQL_TEST_ROOT_URL=mysql://root:root@127.0.0.1:3306/test_db \
 *   MARIADB_TEST_URL=mysql://test:test@127.0.0.1:3307/test_db MARIADB_TEST_ROOT_URL=mysql://root:root@127.0.0.1:3307/test_db \
 *   yarn test:integration test/integration/mysql-connector --runInBand
 */
import { FormatRegistry, type TObject, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  JSON_SCHEMA_LOCAL_DATE_TIME_FORMAT,
  PostgresColumnType,
  X_SCRATCH_AGENT_INSTRUCTIONS,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_MAX_LENGTH,
  X_SCRATCH_NATIVE_COLUMN_TYPE,
  X_SCRATCH_READONLY,
  type NativeColumnTypeAnnotation,
} from '@spinner/shared-types';
import { type Connection as MySqlAdminConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { type Connector } from 'src/remote-service/connectors/connector';
import { sanitizeForTableWsId } from 'src/remote-service/connectors/ids';
import { MySqlClientError, MySqlClientProblem } from 'src/remote-service/connectors/library/mysql/mysql-client-error';
import {
  MYSQL_TABLE_WITHOUT_SINGLE_COLUMN_UNIQUE_KEY_DISABLED_REASON,
  MYSQL_VIEW_DISABLED_REASON,
} from 'src/remote-service/connectors/library/mysql/mysql-json-schema';
import {
  TABLE_WITHOUT_AUTO_INCREMENT_ID_CREATES_DISABLED_REASON,
  unsupportedStorageEngineMessage,
} from 'src/remote-service/connectors/library/mysql/mysql-table-writability';
import {
  dotPath,
  type BaseJsonTableSpec,
  type ConnectorFile,
  type EntityId,
  type PullRecordFilesOptions,
  type PullRecordFilesResult,
  type TablePreview,
} from 'src/remote-service/connectors/types';
import { type JsonSafeObject } from 'src/utils/objects';
import {
  buildMySqlConnectorCredentialsForIntegrationTest,
  createMySqlConnectorThroughRegistryForIntegrationTest,
  describeForEachConfiguredMySqlIntegrationFlavor,
  MYSQL_INTEGRATION_IDENTIFIER_PREFIX,
  openMySqlAdminConnection,
  waitForMySqlServerToAcceptConnections,
  type MySqlIntegrationFlavor,
} from './mysql-integration-helpers';

jest.setTimeout(60_000);

// ---------------------------------------------------------------------------------------------------------------
// Fixture names and values
// ---------------------------------------------------------------------------------------------------------------

/** Every table and view this spec creates starts with this (and only this spec's cleanup drops them). */
const CONNECTOR_SPEC_TABLE_NAME_PREFIX = `${MYSQL_INTEGRATION_IDENTIFIER_PREFIX}connector_`;
const ALL_TYPES_TABLE_NAME = `${CONNECTOR_SPEC_TABLE_NAME_PREFIX}all_types`;
const ALL_TYPES_VIEW_NAME = `${CONNECTOR_SPEC_TABLE_NAME_PREFIX}all_types_view`;
const MYISAM_TABLE_NAME = `${CONNECTOR_SPEC_TABLE_NAME_PREFIX}myisam`;
const UUID_DEFAULT_PRIMARY_KEY_TABLE_NAME = `${CONNECTOR_SPEC_TABLE_NAME_PREFIX}uuid_default_pk`;
const COMPOSITE_PRIMARY_KEY_ONLY_TABLE_NAME = `${CONNECTOR_SPEC_TABLE_NAME_PREFIX}composite_pk`;
const SYSTEM_VERSIONED_TABLE_NAME = `${CONNECTOR_SPEC_TABLE_NAME_PREFIX}system_versioned`;
const FOREIGN_KEY_PARENT_TABLE_NAME = `${CONNECTOR_SPEC_TABLE_NAME_PREFIX}fk_parent`;
const FOREIGN_KEY_CHILD_TABLE_NAME = `${CONNECTOR_SPEC_TABLE_NAME_PREFIX}fk_child`;
/** MySQL foreign-key constraint names are unique per database, so this one carries the spec prefix too. */
const FOREIGN_KEY_CHILD_TO_PARENT_CONSTRAINT_NAME = `${CONNECTOR_SPEC_TABLE_NAME_PREFIX}fk_child_parent`;
const PAGINATION_TABLE_NAME = `${CONNECTOR_SPEC_TABLE_NAME_PREFIX}pagination`;
const FILTERED_INCREMENTAL_TABLE_NAME = `${CONNECTOR_SPEC_TABLE_NAME_PREFIX}filtered_incremental`;
const BIGINT_PRIMARY_KEY_TABLE_NAME = `${CONNECTOR_SPEC_TABLE_NAME_PREFIX}bigint_pk`;
const BINARY_PRIMARY_KEY_TABLE_NAME = `${CONNECTOR_SPEC_TABLE_NAME_PREFIX}binary_pk`;
/** A UUID-shaped BINARY(16) key, the common "UUID stored as bytes" layout. */
const BINARY_PRIMARY_KEY_ROW_ID_HEX = '00112233445566778899AABBCCDDEEFF';
const GENERATED_INVISIBLE_PRIMARY_KEY_TABLE_NAME = `${CONNECTOR_SPEC_TABLE_NAME_PREFIX}gipk`;
/** Keyed by a VARCHAR the user can edit (not AUTO_INCREMENT, so not read-only): the id-edit guard's table. */
const EDITABLE_VARCHAR_PRIMARY_KEY_TABLE_NAME = `${CONNECTOR_SPEC_TABLE_NAME_PREFIX}editable_varchar_pk`;
/** 1,200 rows whose `status` repeats three values: the review's "non-unique ID field" scenario. */
const LOW_CARDINALITY_STATUS_TABLE_NAME = `${CONNECTOR_SPEC_TABLE_NAME_PREFIX}low_cardinality_status`;
const LOW_CARDINALITY_STATUS_TABLE_ROW_COUNT = 1_200;
/**
 * 501 rows whose `code` is unique except that the last two rows (in `code` order) share `c0499`, so the repeat
 * straddles the first 500-row page boundary; `distinct_label` has no index but never repeats.
 */
const PAGE_BOUNDARY_REPEAT_TABLE_NAME = `${CONNECTOR_SPEC_TABLE_NAME_PREFIX}page_boundary_repeat`;

/** More than two default (500-row) pages, so the pull needs three OFFSET pages and the last one is short. */
const PAGINATION_TABLE_ROW_COUNT = 1_234;
const MYSQL_DEFAULT_READ_PAGE_SIZE_EXPECTED = 500;

const SHORT_TEXT_WITH_EMOJI_CJK_NEWLINE_AND_APOSTROPHE = "Emoji 🎉, CJK 日本語,\na newline and it's done";
/** MySQL's UPPER() of the text above (emoji and CJK have no case), as the STORED generated column computes it. */
const SHORT_TEXT_UPPER_CASED_BY_THE_GENERATED_COLUMN = "EMOJI 🎉, CJK 日本語,\nA NEWLINE AND IT'S DONE";
const LONG_TEXT_WITH_EMOJI_CJK_AND_QUOTES = 'Line one 📚\n第二行\nit\'s the "third" line\ttabbed';
/** 35 integer digits + 30 fraction digits = DECIMAL(65,30)'s full precision; a double would keep ~17 digits. */
const DECIMAL_65_30_TEXT = '12345678901234567890123456789012345.123456789012345678901234567890';
/** 2^53 + 1 = 9007199254740993 inside the document: JSON.parse rounds it to 2^53, exactly as the Postgres connector. */
const PAYLOAD_JSON_TEXT_WITH_EMOJI_AND_INTEGER_ABOVE_TWO_TO_THE_53 =
  '{"emoji": "🎉 party", "big": 9007199254740993, "nested": {"list": [1, 2, 3]}}';
const TWO_TO_THE_53_TEXT = '9007199254740992';
const TWO_TO_THE_53_PLUS_ONE_TEXT = '9007199254740993';
const BIGINT_UNSIGNED_MAX_TEXT = '18446744073709551615';

const ALL_TYPES_TABLE_COLUMN_DEFINITIONS_SQL = `
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  big_signed BIGINT NULL,
  big_unsigned BIGINT UNSIGNED NULL,
  exact_decimal DECIMAL(65,30) NULL,
  approximate_double DOUBLE NULL,
  tiny_flag TINYINT(1) NULL,
  small_year YEAR NULL,
  short_text VARCHAR(255) NULL,
  long_text TEXT NULL,
  status_enum ENUM('draft','published','archived') NULL,
  tag_set SET('red','green','blue') NULL,
  payload_json JSON NULL,
  calendar_date DATE NULL,
  wall_clock_datetime DATETIME(3) NULL,
  instant_timestamp TIMESTAMP(3) NULL DEFAULT NULL,
  binary_blob BLOB NULL,
  fixed_binary BINARY(4) NULL,
  bit_flags BIT(8) NULL,
  location_point POINT NULL,
  generated_upper_text VARCHAR(255) AS (UPPER(short_text)) STORED,
  hidden_note VARCHAR(50) NULL INVISIBLE,
  \`a.b\` INT NULL,
  \`Marked as done\` TINYINT(1) NULL,
  \`Featured?\` VARCHAR(20) NULL,
  \`back\`\`tick\` VARCHAR(20) NULL`;

// ---------------------------------------------------------------------------------------------------------------
// Schema validation (TypeBox, the repo's pattern — see wordpress-json-schema.spec.ts)
// ---------------------------------------------------------------------------------------------------------------

/**
 * TypeBox fails an unregistered `format` outright, while the real enforce-schema validator (the Rust `jsonschema`
 * crate) downgrades a format failure to a warning. So validation runs in two passes: structure with every format
 * accepted (must be clean), then formats alone (the findings are the "warnings").
 */
let schemaFormatAssertionMode: 'structure-only' | 'formats-asserted' = 'structure-only';
const ISO_CALENDAR_DATE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const RFC_3339_DATE_TIME_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
FormatRegistry.Set(
  'date',
  (value) => schemaFormatAssertionMode === 'structure-only' || ISO_CALENDAR_DATE_PATTERN.test(value),
);
FormatRegistry.Set(
  'date-time',
  (value) => schemaFormatAssertionMode === 'structure-only' || RFC_3339_DATE_TIME_PATTERN.test(value),
);
// Asserts nothing, exactly like the Rust crate and Ajv treat a format they don't recognize (that's its purpose).
FormatRegistry.Set(JSON_SCHEMA_LOCAL_DATE_TIME_FORMAT, () => true);

function readTableSpecColumnSchemas(tableSpec: BaseJsonTableSpec): Record<string, TSchema> {
  return (tableSpec.schema as TObject).properties;
}

/** Structural violations (formats accepted), as `<id> <path>: <message>` lines. */
function listStructuralSchemaViolations(tableSpec: BaseJsonTableSpec, recordFiles: ConnectorFile[]): string[] {
  schemaFormatAssertionMode = 'structure-only';
  return recordFiles.flatMap((recordFile) =>
    [...Value.Errors(tableSpec.schema, recordFile)].map(
      (validationError) =>
        `${String(recordFile[tableSpec.idPath])} ${validationError.path}: ${validationError.message}`,
    ),
  );
}

/** Column values that fail only their `format` (run after a clean structural pass), as `<id>.<column> = <json>`. */
function listSchemaFormatWarnings(tableSpec: BaseJsonTableSpec, recordFiles: ConnectorFile[]): string[] {
  const columnSchemaByColumnName = readTableSpecColumnSchemas(tableSpec);
  schemaFormatAssertionMode = 'formats-asserted';
  try {
    return recordFiles.flatMap((recordFile) =>
      Object.entries(recordFile)
        .filter(([columnName, value]) => {
          const columnSchema = columnSchemaByColumnName[columnName];
          return columnSchema !== undefined && !Value.Check(columnSchema, value);
        })
        .map(
          ([columnName, value]) => `${String(recordFile[tableSpec.idPath])}.${columnName} = ${JSON.stringify(value)}`,
        ),
    );
  } finally {
    schemaFormatAssertionMode = 'structure-only';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Spec reading helpers
// ---------------------------------------------------------------------------------------------------------------

/** The value schema inside the `anyOf [value, null]` wrap the spec builder adds to a nullable column. */
function unwrapNullableColumnValueSchema(columnSchema: TSchema): Record<string, unknown> {
  const anyOfVariants: unknown = (columnSchema as { anyOf?: unknown }).anyOf;
  if (Array.isArray(anyOfVariants) && anyOfVariants.length === 2) {
    const [valueVariant, nullVariant] = anyOfVariants as Record<string, unknown>[];
    if (nullVariant.type === 'null') return valueVariant;
  }
  return columnSchema as Record<string, unknown>;
}

interface ObservedColumnAnnotations {
  family: unknown;
  format?: unknown;
  contentEncoding?: unknown;
  isReadOnly: boolean;
  nativeType: string;
  isRecreatableVerbatim: boolean;
}

function readObservedColumnAnnotations(columnSchema: TSchema): ObservedColumnAnnotations {
  const annotatedColumnSchema = columnSchema as Record<string, unknown>;
  const valueSchema = unwrapNullableColumnValueSchema(columnSchema);
  const nativeTypeAnnotation = annotatedColumnSchema[X_SCRATCH_NATIVE_COLUMN_TYPE] as NativeColumnTypeAnnotation;
  expect(nativeTypeAnnotation.typeSystem).toBe('mysql');
  return {
    family: annotatedColumnSchema[X_SCRATCH_CONNECTOR_DATA_TYPE],
    ...(valueSchema.format !== undefined ? { format: valueSchema.format } : {}),
    ...(valueSchema.contentEncoding !== undefined ? { contentEncoding: valueSchema.contentEncoding } : {}),
    isReadOnly: annotatedColumnSchema[X_SCRATCH_READONLY] === true,
    nativeType: nativeTypeAnnotation.type,
    isRecreatableVerbatim: nativeTypeAnnotation.isRecreatableVerbatim,
  };
}

/** The flags a table preview uses to gate reads and writes (undefined = not set). */
function pickTablePreviewAvailabilityFlags(tablePreview: TablePreview | undefined): Partial<TablePreview> {
  return {
    disabled: tablePreview?.disabled,
    disabledCreates: tablePreview?.disabledCreates,
    disabledUpdates: tablePreview?.disabledUpdates,
    disabledDeletes: tablePreview?.disabledDeletes,
    disabledReason: tablePreview?.disabledReason,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Pull helpers
// ---------------------------------------------------------------------------------------------------------------

interface PulledRecordFilePages {
  recordFilesPerPage: ConnectorFile[][];
  connectorProgressAfterEachPage: (JsonSafeObject | undefined)[];
  pullResult: PullRecordFilesResult;
}

async function pullEveryRecordFilePage(
  connector: Connector<string, JsonSafeObject>,
  tableSpec: BaseJsonTableSpec,
  pullOptions: PullRecordFilesOptions = {},
  resumeFromConnectorProgress: JsonSafeObject = {},
): Promise<PulledRecordFilePages> {
  const recordFilesPerPage: ConnectorFile[][] = [];
  const connectorProgressAfterEachPage: (JsonSafeObject | undefined)[] = [];
  const pullResult = await connector.pullRecordFiles(
    tableSpec,
    ({ files, connectorProgress }) => {
      recordFilesPerPage.push(files);
      connectorProgressAfterEachPage.push(connectorProgress);
      return Promise.resolve();
    },
    resumeFromConnectorProgress,
    pullOptions,
  );
  return { recordFilesPerPage, connectorProgressAfterEachPage, pullResult };
}

async function pullEveryRecordFile(
  connector: Connector<string, JsonSafeObject>,
  tableSpec: BaseJsonTableSpec,
  pullOptions: PullRecordFilesOptions = {},
): Promise<ConnectorFile[]> {
  const { recordFilesPerPage } = await pullEveryRecordFilePage(connector, tableSpec, pullOptions);
  return recordFilesPerPage.flat();
}

function findRecordFileById(recordFiles: ConnectorFile[], idColumnName: string, recordId: unknown): ConnectorFile {
  const matchingRecordFile = recordFiles.find((recordFile) => recordFile[idColumnName] === recordId);
  if (!matchingRecordFile) {
    throw new Error(`No pulled record has ${idColumnName} = ${JSON.stringify(recordId)}`);
  }
  return matchingRecordFile;
}

// ---------------------------------------------------------------------------------------------------------------
// Admin-connection fixture helpers
// ---------------------------------------------------------------------------------------------------------------

/** Backtick-quote an identifier for admin SQL (doubling any backtick inside it). */
function quoteMySqlIdentifierForAdminSql(identifier: string): string {
  return `\`${identifier.replace(/`/g, '``')}\``;
}

function readAdminCatalogText(value: unknown): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

/** Drop only this spec's tables and views (other MySQL specs may be using theirs), foreign-key checks off. */
async function dropThisSpecsTablesAndViews(adminConnection: MySqlAdminConnection, databaseName: string): Promise<void> {
  const likePatternForThisSpecsPrefix = `${CONNECTOR_SPEC_TABLE_NAME_PREFIX.replace(/_/g, '\\_')}%`;
  const [thisSpecsTables] = await adminConnection.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS table_name, TABLE_TYPE AS table_type FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE ?`,
    [databaseName, likePatternForThisSpecsPrefix],
  );
  await adminConnection.query('SET SESSION FOREIGN_KEY_CHECKS = 0');
  try {
    for (const thisSpecsTable of thisSpecsTables) {
      const qualifiedName = `${quoteMySqlIdentifierForAdminSql(databaseName)}.${quoteMySqlIdentifierForAdminSql(readAdminCatalogText(thisSpecsTable.table_name))}`;
      const dropStatement =
        readAdminCatalogText(thisSpecsTable.table_type) === 'VIEW'
          ? `DROP VIEW IF EXISTS ${qualifiedName}`
          : `DROP TABLE IF EXISTS ${qualifiedName}`;
      await adminConnection.query(dropStatement);
    }
  } finally {
    await adminConnection.query('SET SESSION FOREIGN_KEY_CHECKS = 1');
  }
}

/** Run `operation` with the admin session's sql_mode set to `temporarySqlMode`, restoring the original after. */
async function withAdminSessionSqlMode<T>(
  adminConnection: MySqlAdminConnection,
  temporarySqlMode: string,
  operation: () => Promise<T>,
): Promise<T> {
  const [sqlModeRows] = await adminConnection.query<RowDataPacket[]>('SELECT @@SESSION.sql_mode AS original_sql_mode');
  const originalSqlMode = readAdminCatalogText(sqlModeRows[0].original_sql_mode);
  await adminConnection.query('SET SESSION sql_mode = ?', [temporarySqlMode]);
  try {
    return await operation();
  } finally {
    await adminConnection.query('SET SESSION sql_mode = ?', [originalSqlMode]);
  }
}

/** Run `operation` with the admin session's time_zone set to `temporaryTimeZone`, then back to UTC. */
async function withAdminSessionTimeZone<T>(
  adminConnection: MySqlAdminConnection,
  temporaryTimeZone: string,
  operation: () => Promise<T>,
): Promise<T> {
  await adminConnection.query('SET SESSION time_zone = ?', [temporaryTimeZone]);
  try {
    return await operation();
  } finally {
    await adminConnection.query("SET SESSION time_zone = '+00:00'");
  }
}

/** The AUTO_INCREMENT ids of the three all-types fixture rows. */
interface AllTypesFixtureRowIds {
  fullyPopulatedRowId: number;
  zeroDatesAndEmptyValuesRowId: number;
  allNullRowId: number;
}

/**
 * Three rows: every column populated (TIMESTAMP / DATETIME written from a +05:00 session), zero dates and empty
 * values (written with sql_mode='' — the only way legacy data like this gets in), and every column NULL.
 */
async function insertAllTypesFixtureRows(
  adminConnection: MySqlAdminConnection,
  qualifiedAllTypesTableName: string,
): Promise<AllTypesFixtureRowIds> {
  const fullyPopulatedRowId = await withAdminSessionTimeZone(adminConnection, '+05:00', async () => {
    // Binary, BIT and spatial literals are inline SQL; text goes through bound values. The `?`-containing column
    // names are set by a separate statement without bound values.
    const [insertResult] = await adminConnection.query<ResultSetHeader>(
      `INSERT INTO ${qualifiedAllTypesTableName}
         (big_signed, big_unsigned, exact_decimal, approximate_double, tiny_flag, small_year, short_text, long_text,
          status_enum, tag_set, payload_json, calendar_date, wall_clock_datetime, instant_timestamp, binary_blob,
          fixed_binary, bit_flags, location_point, hidden_note)
       VALUES (${TWO_TO_THE_53_PLUS_ONE_TEXT}, ${BIGINT_UNSIGNED_MAX_TEXT}, ?, 0.1, 1, 1901, ?, ?,
          'published', 'red,blue', ?, '2026-01-02', '2026-01-02 03:04:05.678', '2026-01-02 08:04:05.678', X'00FF10',
          X'DEADBEEF', b'10100101', ST_GeomFromText('POINT(1 2)', 4326), 'never pulled')`,
      [
        DECIMAL_65_30_TEXT,
        SHORT_TEXT_WITH_EMOJI_CJK_NEWLINE_AND_APOSTROPHE,
        LONG_TEXT_WITH_EMOJI_CJK_AND_QUOTES,
        PAYLOAD_JSON_TEXT_WITH_EMOJI_AND_INTEGER_ABOVE_TWO_TO_THE_53,
      ],
    );
    return insertResult.insertId;
  });
  await adminConnection.query(
    `UPDATE ${qualifiedAllTypesTableName}
     SET \`a.b\` = 7, \`Marked as done\` = 1, \`Featured?\` = 'yes', \`back\`\`tick\` = 'tick'
     WHERE id = ${fullyPopulatedRowId}`,
  );

  const zeroDatesAndEmptyValuesRowId = await withAdminSessionSqlMode(adminConnection, '', async () => {
    const [insertResult] = await adminConnection.query<ResultSetHeader>(
      `INSERT INTO ${qualifiedAllTypesTableName}
         (big_signed, short_text, status_enum, tag_set, calendar_date, wall_clock_datetime, instant_timestamp)
       VALUES (${TWO_TO_THE_53_TEXT}, '', 'not-a-member', '', '0000-00-00', '0000-00-00 00:00:00',
          '0000-00-00 00:00:00')`,
    );
    return insertResult.insertId;
  });

  const [allNullInsertResult] = await adminConnection.query<ResultSetHeader>(
    `INSERT INTO ${qualifiedAllTypesTableName} () VALUES ()`,
  );
  return { fullyPopulatedRowId, zeroDatesAndEmptyValuesRowId, allNullRowId: allNullInsertResult.insertId };
}

interface ConnectorSpecFixtures {
  allTypesFixtureRowIds: AllTypesFixtureRowIds;
  /** The stored bytes of the fully populated row's POINT, as MySQL reports them (`HEX()`). */
  fullyPopulatedRowLocationPointHex: string;
  paginationTableIdsInOrder: number[];
}

async function createConnectorSpecFixtures(
  adminConnection: MySqlAdminConnection,
  databaseName: string,
  flavor: MySqlIntegrationFlavor,
): Promise<ConnectorSpecFixtures> {
  const qualify = (tableName: string): string =>
    `${quoteMySqlIdentifierForAdminSql(databaseName)}.${quoteMySqlIdentifierForAdminSql(tableName)}`;

  await adminConnection.query(
    `CREATE TABLE ${qualify(ALL_TYPES_TABLE_NAME)} (${ALL_TYPES_TABLE_COLUMN_DEFINITIONS_SQL}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );
  const allTypesFixtureRowIds = await insertAllTypesFixtureRows(adminConnection, qualify(ALL_TYPES_TABLE_NAME));
  const [locationPointRows] = await adminConnection.query<RowDataPacket[]>(
    `SELECT HEX(location_point) AS location_point_hex FROM ${qualify(ALL_TYPES_TABLE_NAME)}
     WHERE id = ${allTypesFixtureRowIds.fullyPopulatedRowId}`,
  );
  const fullyPopulatedRowLocationPointHex = readAdminCatalogText(locationPointRows[0].location_point_hex);

  await adminConnection.query(
    `CREATE VIEW ${qualify(ALL_TYPES_VIEW_NAME)} AS SELECT id, short_text FROM ${qualify(ALL_TYPES_TABLE_NAME)}`,
  );
  await adminConnection.query(
    `CREATE TABLE ${qualify(MYISAM_TABLE_NAME)} (id INT AUTO_INCREMENT PRIMARY KEY, label VARCHAR(20)) ENGINE=MyISAM`,
  );
  await adminConnection.query(
    `CREATE TABLE ${qualify(UUID_DEFAULT_PRIMARY_KEY_TABLE_NAME)}
       (id CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY, label VARCHAR(20)) ENGINE=InnoDB`,
  );
  await adminConnection.query(
    `CREATE TABLE ${qualify(COMPOSITE_PRIMARY_KEY_ONLY_TABLE_NAME)}
       (tenant_id INT NOT NULL, line_number INT NOT NULL, label VARCHAR(20), PRIMARY KEY (tenant_id, line_number))
     ENGINE=InnoDB`,
  );
  if (flavor.flavorName === 'mariadb') {
    await adminConnection.query(
      `CREATE TABLE ${qualify(SYSTEM_VERSIONED_TABLE_NAME)} (id INT AUTO_INCREMENT PRIMARY KEY, label VARCHAR(20))
       ENGINE=InnoDB WITH SYSTEM VERSIONING`,
    );
    await adminConnection.query(`INSERT INTO ${qualify(SYSTEM_VERSIONED_TABLE_NAME)} (label) VALUES ('versioned')`);
  }

  await adminConnection.query(
    `CREATE TABLE ${qualify(FOREIGN_KEY_PARENT_TABLE_NAME)} (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100))
     ENGINE=InnoDB`,
  );
  await adminConnection.query(
    `CREATE TABLE ${qualify(FOREIGN_KEY_CHILD_TABLE_NAME)} (
       id INT AUTO_INCREMENT PRIMARY KEY,
       name VARCHAR(100),
       parent_id INT NULL,
       CONSTRAINT ${quoteMySqlIdentifierForAdminSql(FOREIGN_KEY_CHILD_TO_PARENT_CONSTRAINT_NAME)}
         FOREIGN KEY (parent_id) REFERENCES ${qualify(FOREIGN_KEY_PARENT_TABLE_NAME)} (id)
     ) ENGINE=InnoDB`,
  );

  await adminConnection.query(
    `CREATE TABLE ${qualify(PAGINATION_TABLE_NAME)} (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, sequence_number INT NOT NULL)
     ENGINE=InnoDB`,
  );
  const sequenceNumberRows = Array.from({ length: PAGINATION_TABLE_ROW_COUNT }, (_unused, rowIndex) => [rowIndex + 1]);
  await adminConnection.query(`INSERT INTO ${qualify(PAGINATION_TABLE_NAME)} (sequence_number) VALUES ?`, [
    sequenceNumberRows,
  ]);
  const [paginationIdRows] = await adminConnection.query<RowDataPacket[]>(
    `SELECT id FROM ${qualify(PAGINATION_TABLE_NAME)} ORDER BY id`,
  );
  const paginationTableIdsInOrder = paginationIdRows.map((paginationIdRow) => Number(paginationIdRow.id));

  await adminConnection.query(
    `CREATE TABLE ${qualify(FILTERED_INCREMENTAL_TABLE_NAME)}
       (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, stage VARCHAR(20) NOT NULL, modified_at TIMESTAMP(3) NULL DEFAULT NULL)
     ENGINE=InnoDB`,
  );
  // The admin session is UTC, so these TIMESTAMP literals are UTC instants.
  await adminConnection.query(
    `INSERT INTO ${qualify(FILTERED_INCREMENTAL_TABLE_NAME)} (stage, modified_at) VALUES
       ('lead', '2020-01-01 00:00:00'), ('lead', '2030-01-01 00:00:00'),
       ('qualified', '2020-01-01 00:00:00'), ('qualified', '2030-01-01 00:00:00'),
       ('won', '2030-01-01 00:00:00'), ('lead', NULL)`,
  );

  await adminConnection.query(
    `CREATE TABLE ${qualify(BIGINT_PRIMARY_KEY_TABLE_NAME)} (id BIGINT NOT NULL PRIMARY KEY, label VARCHAR(50) NOT NULL)
     ENGINE=InnoDB`,
  );
  // Row 12 is the trap for the unmatchable id '12abc': MySQL and MariaDB both coerce the STRING '12abc' to 12.
  await adminConnection.query(
    `INSERT INTO ${qualify(BIGINT_PRIMARY_KEY_TABLE_NAME)} (id, label) VALUES
       (12, 'twelve'),
       (${TWO_TO_THE_53_TEXT}, 'two to the 53'), (${TWO_TO_THE_53_PLUS_ONE_TEXT}, 'two to the 53 plus one')`,
  );

  await adminConnection.query(
    `CREATE TABLE ${qualify(BINARY_PRIMARY_KEY_TABLE_NAME)} (id BINARY(16) NOT NULL PRIMARY KEY, label VARCHAR(50) NOT NULL)
     ENGINE=InnoDB`,
  );
  await adminConnection.query(
    `INSERT INTO ${qualify(BINARY_PRIMARY_KEY_TABLE_NAME)} (id, label) VALUES
       (X'${BINARY_PRIMARY_KEY_ROW_ID_HEX}', 'binary keyed row')`,
  );

  if (flavor.flavorName === 'mysql') {
    // MySQL 8.0.30+ adds `my_row_id BIGINT UNSIGNED AUTO_INCREMENT INVISIBLE PRIMARY KEY` (on by default on Azure).
    await adminConnection.query('SET SESSION sql_generate_invisible_primary_key = ON');
    try {
      await adminConnection.query(
        `CREATE TABLE ${qualify(GENERATED_INVISIBLE_PRIMARY_KEY_TABLE_NAME)} (label VARCHAR(20) NOT NULL) ENGINE=InnoDB`,
      );
    } finally {
      await adminConnection.query('SET SESSION sql_generate_invisible_primary_key = OFF');
    }
    await adminConnection.query(
      `INSERT INTO ${qualify(GENERATED_INVISIBLE_PRIMARY_KEY_TABLE_NAME)} (label) VALUES ('first'), ('second')`,
    );
  }

  return { allTypesFixtureRowIds, fullyPopulatedRowLocationPointHex, paginationTableIdsInOrder };
}

// ---------------------------------------------------------------------------------------------------------------
// Expectations that differ by flavor
// ---------------------------------------------------------------------------------------------------------------

interface ExpectedColumnAnnotations {
  family: PostgresColumnType;
  format?: string;
  contentEncoding?: string;
  isReadOnly: boolean;
  nativeType: string;
  isRecreatableVerbatim: boolean;
}

/**
 * The all-types table's spec, column by column. `hidden_note` (INVISIBLE, not the id) must be absent. MariaDB
 * reports integer display widths (`int(10) unsigned`, `year(4)`); its JSON is a LONGTEXT alias annotated as `json`.
 */
function expectedAllTypesColumnAnnotations(flavor: MySqlIntegrationFlavor): Record<string, ExpectedColumnAnnotations> {
  const nativeTypeSpelledBy = (mysqlSpelling: string, mariaDbSpelling: string): string =>
    flavor.flavorName === 'mariadb' ? mariaDbSpelling : mysqlSpelling;
  const writable = { isReadOnly: false, isRecreatableVerbatim: true };
  const writableButNotRecreatable = { isReadOnly: false, isRecreatableVerbatim: false };
  const readOnlyNotRecreatable = { isReadOnly: true, isRecreatableVerbatim: false };
  return {
    id: {
      family: PostgresColumnType.NUMERIC,
      nativeType: nativeTypeSpelledBy('int unsigned', 'int(10) unsigned'),
      isReadOnly: true, // AUTO_INCREMENT
      isRecreatableVerbatim: true,
    },
    big_signed: {
      family: PostgresColumnType.NUMERIC_STRING,
      nativeType: nativeTypeSpelledBy('bigint', 'bigint(20)'),
      ...writable,
    },
    big_unsigned: {
      family: PostgresColumnType.NUMERIC_STRING,
      nativeType: nativeTypeSpelledBy('bigint unsigned', 'bigint(20) unsigned'),
      ...writable,
    },
    exact_decimal: { family: PostgresColumnType.NUMERIC_STRING, nativeType: 'decimal(65,30)', ...writable },
    approximate_double: { family: PostgresColumnType.NUMERIC, nativeType: 'double', ...writable },
    tiny_flag: { family: PostgresColumnType.NUMERIC, nativeType: 'tinyint(1)', ...writable },
    small_year: { family: PostgresColumnType.NUMERIC, nativeType: nativeTypeSpelledBy('year', 'year(4)'), ...writable },
    short_text: { family: PostgresColumnType.TEXT, nativeType: 'varchar(255)', ...writable },
    long_text: { family: PostgresColumnType.TEXT, nativeType: 'text', ...writable },
    status_enum: {
      family: PostgresColumnType.TEXT,
      nativeType: "enum('draft','published','archived')",
      ...writableButNotRecreatable,
    },
    tag_set: { family: PostgresColumnType.TEXT, nativeType: "set('red','green','blue')", ...writableButNotRecreatable },
    payload_json: { family: PostgresColumnType.JSONB, nativeType: 'json', ...writable },
    calendar_date: { family: PostgresColumnType.TIMESTAMP, format: 'date', nativeType: 'date', ...writable },
    wall_clock_datetime: {
      family: PostgresColumnType.TIMESTAMP,
      format: JSON_SCHEMA_LOCAL_DATE_TIME_FORMAT,
      nativeType: 'datetime(3)',
      ...writable,
    },
    instant_timestamp: {
      family: PostgresColumnType.TIMESTAMP,
      format: 'date-time',
      nativeType: 'timestamp(3)',
      ...writable,
    },
    binary_blob: {
      family: PostgresColumnType.TEXT,
      contentEncoding: 'base64',
      nativeType: 'blob',
      ...readOnlyNotRecreatable,
    },
    fixed_binary: {
      family: PostgresColumnType.TEXT,
      contentEncoding: 'base64',
      nativeType: 'binary(4)',
      ...readOnlyNotRecreatable,
    },
    bit_flags: { family: PostgresColumnType.NUMERIC, nativeType: 'bit(8)', ...readOnlyNotRecreatable },
    location_point: {
      family: PostgresColumnType.TEXT,
      contentEncoding: 'base64',
      nativeType: 'point',
      ...readOnlyNotRecreatable,
    },
    generated_upper_text: {
      family: PostgresColumnType.TEXT,
      nativeType: 'varchar(255)',
      isReadOnly: true, // STORED GENERATED
      isRecreatableVerbatim: true,
    },
    'a.b': { family: PostgresColumnType.NUMERIC, nativeType: nativeTypeSpelledBy('int', 'int(11)'), ...writable },
    'Marked as done': { family: PostgresColumnType.NUMERIC, nativeType: 'tinyint(1)', ...writable },
    'Featured?': { family: PostgresColumnType.TEXT, nativeType: 'varchar(20)', ...writable },
    'back`tick': { family: PostgresColumnType.TEXT, nativeType: 'varchar(20)', ...writable },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------------------------------------------

describeForEachConfiguredMySqlIntegrationFlavor('MySQL connector — discovery, pull and CRUD', (flavor) => {
  const databaseName = flavor.applicationUserServerAddress.databaseName;
  const serverGeneratesInvisiblePrimaryKeys = flavor.flavorName === 'mysql';
  const serverSupportsSystemVersionedTables = flavor.flavorName === 'mariadb';
  const itWhen = (condition: boolean): jest.It => (condition ? it : it.skip);

  let adminConnection: MySqlAdminConnection | undefined;
  let connector: Connector<string, JsonSafeObject>;
  let fixtures: ConnectorSpecFixtures;

  const entityIdForTable = (tableName: string): EntityId => ({
    wsId: sanitizeForTableWsId(`${databaseName}__${tableName}`),
    remoteId: [databaseName, tableName],
  });
  const fetchTableSpec = (tableName: string): Promise<BaseJsonTableSpec> =>
    connector.fetchJsonTableSpec(entityIdForTable(tableName));
  const requireAdminConnection = (): MySqlAdminConnection => {
    if (!adminConnection) throw new Error('The admin connection was not opened (see beforeAll)');
    return adminConnection;
  };
  const qualifyForAdminSql = (tableName: string): string =>
    `${quoteMySqlIdentifierForAdminSql(databaseName)}.${quoteMySqlIdentifierForAdminSql(tableName)}`;

  beforeAll(async () => {
    if (flavor.rootUserServerAddress.databaseName !== databaseName) {
      throw new Error('The *_TEST_URL and *_TEST_ROOT_URL of a flavor must name the same database');
    }
    await waitForMySqlServerToAcceptConnections(flavor.rootUserServerAddress);
    adminConnection = await openMySqlAdminConnection(flavor.rootUserServerAddress);
    await dropThisSpecsTablesAndViews(adminConnection, databaseName);
    fixtures = await createConnectorSpecFixtures(adminConnection, databaseName, flavor);
    connector = await createMySqlConnectorThroughRegistryForIntegrationTest(
      buildMySqlConnectorCredentialsForIntegrationTest(flavor.applicationUserServerAddress),
    );
  }, 150_000);

  afterAll(async () => {
    if (!adminConnection) return;
    try {
      // Set SKIP_CLEANUP=1 locally to leave the fixture tables in place for inspection.
      if (process.env.SKIP_CLEANUP !== '1') {
        await dropThisSpecsTablesAndViews(adminConnection, databaseName);
      }
    } finally {
      await adminConnection.end();
    }
  });

  // -------------------------------------------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------------------------------------------

  describe('listTables', () => {
    let tablePreviews: TablePreview[];
    const findTablePreview = (tableName: string): TablePreview | undefined =>
      tablePreviews.find(
        (tablePreview) => tablePreview.id.remoteId[0] === databaseName && tablePreview.id.remoteId[1] === tableName,
      );

    beforeAll(async () => {
      tablePreviews = await connector.listTables();
    });

    it('lists only the configured database, never a system schema', () => {
      expect(tablePreviews.length).toBeGreaterThan(0);
      expect(new Set(tablePreviews.map((tablePreview) => tablePreview.id.remoteId[0]))).toEqual(
        new Set([databaseName]),
      );
    });

    it('lists an InnoDB table with an AUTO_INCREMENT id as fully usable, with a [database, table] remote id', () => {
      expect(findTablePreview(ALL_TYPES_TABLE_NAME)).toEqual({
        id: entityIdForTable(ALL_TYPES_TABLE_NAME),
        displayName: ALL_TYPES_TABLE_NAME,
        parentPath: databaseName,
        metadata: {
          database: databaseName,
          tableType: 'BASE TABLE',
          storageEngine: 'InnoDB',
          description: `Table "${ALL_TYPES_TABLE_NAME}" in database "${databaseName}"`,
        },
      });
    });

    it('disables a view', () => {
      expect(findTablePreview(ALL_TYPES_VIEW_NAME)?.metadata?.tableType).toBe('VIEW');
      expect(pickTablePreviewAvailabilityFlags(findTablePreview(ALL_TYPES_VIEW_NAME))).toEqual({
        disabled: true,
        disabledReason: MYSQL_VIEW_DISABLED_REASON,
      });
    });

    it('makes a MyISAM table pull-only (no creates, updates or deletes)', () => {
      expect(pickTablePreviewAvailabilityFlags(findTablePreview(MYISAM_TABLE_NAME))).toEqual({
        disabledCreates: true,
        disabledUpdates: true,
        disabledDeletes: true,
        disabledReason: unsupportedStorageEngineMessage('MyISAM'),
      });
    });

    it('disables creates only for a table whose primary key is a UUID default (only AUTO_INCREMENT counts)', () => {
      expect(pickTablePreviewAvailabilityFlags(findTablePreview(UUID_DEFAULT_PRIMARY_KEY_TABLE_NAME))).toEqual({
        disabledCreates: true,
        disabledReason: TABLE_WITHOUT_AUTO_INCREMENT_ID_CREATES_DISABLED_REASON,
      });
    });

    it('disables a table whose only key is a composite primary key', () => {
      expect(pickTablePreviewAvailabilityFlags(findTablePreview(COMPOSITE_PRIMARY_KEY_ONLY_TABLE_NAME))).toEqual({
        disabled: true,
        disabledReason: MYSQL_TABLE_WITHOUT_SINGLE_COLUMN_UNIQUE_KEY_DISABLED_REASON,
      });
    });

    itWhen(serverSupportsSystemVersionedTables)(
      '(MariaDB) lists a SYSTEM VERSIONED table as fully usable, keyed by its own primary key',
      async () => {
        const systemVersionedPreview = findTablePreview(SYSTEM_VERSIONED_TABLE_NAME);
        expect(systemVersionedPreview?.metadata?.tableType).toBe('SYSTEM VERSIONED');
        expect(pickTablePreviewAvailabilityFlags(systemVersionedPreview)).toEqual({});

        const systemVersionedSpec = await fetchTableSpec(SYSTEM_VERSIONED_TABLE_NAME);
        expect(systemVersionedSpec.idPath).toBe('id');
        const pulledRecordFiles = await pullEveryRecordFile(connector, systemVersionedSpec);
        // The implicit ROW START / ROW END period columns are invisible, so they're neither in the spec nor pulled.
        expect(pulledRecordFiles).toEqual([{ id: 1, label: 'versioned' }]);
      },
    );

    itWhen(serverGeneratesInvisiblePrimaryKeys)(
      '(MySQL) lists a generated-invisible-primary-key table as fully usable',
      () => {
        expect(pickTablePreviewAvailabilityFlags(findTablePreview(GENERATED_INVISIBLE_PRIMARY_KEY_TABLE_NAME))).toEqual(
          {},
        );
      },
    );
  });

  describe('fetchJsonTableSpec', () => {
    it('annotates every visible column of the all-types table with its family, format, read-only flag and native type', async () => {
      const allTypesSpec = await fetchTableSpec(ALL_TYPES_TABLE_NAME);

      const observedColumnAnnotations = Object.fromEntries(
        Object.entries(readTableSpecColumnSchemas(allTypesSpec)).map(([columnName, columnSchema]) => [
          columnName,
          readObservedColumnAnnotations(columnSchema),
        ]),
      );
      // Exact key set too: the INVISIBLE `hidden_note` column is left out.
      expect(observedColumnAnnotations).toEqual(expectedAllTypesColumnAnnotations(flavor));

      expect(allTypesSpec).toMatchObject({
        id: entityIdForTable(ALL_TYPES_TABLE_NAME),
        name: ALL_TYPES_TABLE_NAME,
        idPath: 'id',
        basePath: [databaseName],
      });
      expect(allTypesSpec.idPathRequiresUserSelection).toBeUndefined();
      expect((allTypesSpec.schema as { $id?: unknown }).$id).toBe(`mysql/${databaseName}.${ALL_TYPES_TABLE_NAME}`);
    });

    it('carries ENUM members, SET guidance and the VARCHAR length on the column schemas', async () => {
      const columnSchemas = readTableSpecColumnSchemas(await fetchTableSpec(ALL_TYPES_TABLE_NAME));

      const enumMemberSchemas = unwrapNullableColumnValueSchema(columnSchemas.status_enum).anyOf as {
        const: unknown;
      }[];
      // `''` is MySQL's invalid-ENUM marker (index 0) that legacy non-strict writes store.
      expect(enumMemberSchemas.map((enumMemberSchema) => enumMemberSchema.const)).toEqual([
        'draft',
        'published',
        'archived',
        '',
      ]);
      expect((columnSchemas.tag_set as Record<string, unknown>)[X_SCRATCH_AGENT_INSTRUCTIONS]).toEqual(
        expect.stringContaining('"red", "green", "blue"'),
      );
      expect((columnSchemas.short_text as Record<string, unknown>)[X_SCRATCH_MAX_LENGTH]).toBe(255);
      expect((columnSchemas.long_text as Record<string, unknown>)[X_SCRATCH_MAX_LENGTH]).toBeUndefined();
    });

    it("types the JSON column as a JSON document even where the catalog calls it LONGTEXT (MariaDB's alias)", async () => {
      const [jsonColumnCatalogRows] = await requireAdminConnection().query<RowDataPacket[]>(
        `SELECT DATA_TYPE AS data_type FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = 'payload_json'`,
        [databaseName, ALL_TYPES_TABLE_NAME],
      );
      expect(readAdminCatalogText(jsonColumnCatalogRows[0].data_type)).toBe(
        flavor.serverStoresJsonColumnsAsLongtextAlias ? 'longtext' : 'json',
      );

      const payloadJsonSchema = readTableSpecColumnSchemas(await fetchTableSpec(ALL_TYPES_TABLE_NAME))
        .payload_json as Record<string, unknown>;
      expect(payloadJsonSchema[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe(PostgresColumnType.JSONB);
      expect((payloadJsonSchema[X_SCRATCH_NATIVE_COLUMN_TYPE] as NativeColumnTypeAnnotation).type).toBe('json');
    });

    it("annotates a foreign key with its target, whose remote id deep-equals the parent's listTables id", async () => {
      const childSpec = await fetchTableSpec(FOREIGN_KEY_CHILD_TABLE_NAME);
      const parentIdSchema = readTableSpecColumnSchemas(childSpec).parent_id as Record<string, unknown>;
      expect(parentIdSchema[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({
        linkedTableId: `${databaseName}.${FOREIGN_KEY_PARENT_TABLE_NAME}`,
        linkedTableRemoteId: [databaseName, FOREIGN_KEY_PARENT_TABLE_NAME],
      });
      const parentPreview = (await connector.listTables()).find(
        (tablePreview) => tablePreview.id.remoteId[1] === FOREIGN_KEY_PARENT_TABLE_NAME,
      );
      expect(parentPreview?.id.remoteId).toEqual(
        (parentIdSchema[X_SCRATCH_FOREIGN_KEY_OPTIONS] as { linkedTableRemoteId: string[] }).linkedTableRemoteId,
      );
      // The SQL title convention: the first text column named name / title / display_name / label.
      expect(childSpec.titlePath).toBe('name');
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  // Pulls
  // -------------------------------------------------------------------------------------------------------------

  describe('pullRecordFiles over the all-types table', () => {
    let allTypesSpec: BaseJsonTableSpec;
    let pulledAllTypesRecordFiles: ConnectorFile[];

    beforeAll(async () => {
      allTypesSpec = await fetchTableSpec(ALL_TYPES_TABLE_NAME);
      pulledAllTypesRecordFiles = await pullEveryRecordFile(connector, allTypesSpec);
    });

    it('pulls every row, ordered by id', () => {
      const { fullyPopulatedRowId, zeroDatesAndEmptyValuesRowId, allNullRowId } = fixtures.allTypesFixtureRowIds;
      expect(pulledAllTypesRecordFiles.map((recordFile) => recordFile.id)).toEqual([
        fullyPopulatedRowId,
        zeroDatesAndEmptyValuesRowId,
        allNullRowId,
      ]);
    });

    it('pulls the fully populated row exactly as the type table says (and never the INVISIBLE column)', () => {
      const { fullyPopulatedRowId } = fixtures.allTypesFixtureRowIds;
      const pulledLocationPointBytes = Buffer.from(fixtures.fullyPopulatedRowLocationPointHex, 'hex');
      // MySQL's internal geometry: a 4-byte little-endian SRID (4326 = E6 10 00 00), then the WKB point.
      expect(fixtures.fullyPopulatedRowLocationPointHex.slice(0, 8).toUpperCase()).toBe('E6100000');

      expect(findRecordFileById(pulledAllTypesRecordFiles, 'id', fullyPopulatedRowId)).toEqual({
        id: fullyPopulatedRowId,
        big_signed: TWO_TO_THE_53_PLUS_ONE_TEXT,
        big_unsigned: BIGINT_UNSIGNED_MAX_TEXT,
        exact_decimal: DECIMAL_65_30_TEXT,
        approximate_double: 0.1,
        tiny_flag: 1, // a number, not `true`: TINYINT(1) can hold 0..127
        small_year: 1901,
        short_text: SHORT_TEXT_WITH_EMOJI_CJK_NEWLINE_AND_APOSTROPHE,
        long_text: LONG_TEXT_WITH_EMOJI_CJK_AND_QUOTES,
        status_enum: 'published',
        tag_set: 'red,blue',
        payload_json: { emoji: '🎉 party', big: 2 ** 53, nested: { list: [1, 2, 3] } },
        calendar_date: '2026-01-02',
        // DATETIME is a naive wall clock: verbatim, NOT shifted by the +05:00 session that wrote it.
        wall_clock_datetime: '2026-01-02 03:04:05.678',
        // TIMESTAMP is an instant: 08:04:05.678 written at +05:00 is 03:04:05.678 UTC.
        instant_timestamp: '2026-01-02T03:04:05.678Z',
        binary_blob: 'AP8Q', // 0x00FF10
        fixed_binary: '3q2+7w==', // 0xDEADBEEF
        bit_flags: 165, // b'10100101'
        location_point: pulledLocationPointBytes.toString('base64'),
        generated_upper_text: SHORT_TEXT_UPPER_CASED_BY_THE_GENERATED_COLUMN,
        'a.b': 7,
        'Marked as done': 1,
        'Featured?': 'yes',
        'back`tick': 'tick',
      });
    });

    it('keeps zero dates, the empty SET and the invalid-ENUM marker verbatim', () => {
      const { zeroDatesAndEmptyValuesRowId } = fixtures.allTypesFixtureRowIds;
      expect(findRecordFileById(pulledAllTypesRecordFiles, 'id', zeroDatesAndEmptyValuesRowId)).toMatchObject({
        big_signed: TWO_TO_THE_53_TEXT,
        short_text: '',
        status_enum: '',
        tag_set: '', // the empty SET is '', not null
        calendar_date: '0000-00-00',
        wall_clock_datetime: '0000-00-00 00:00:00.000',
        instant_timestamp: '0000-00-00 00:00:00.000', // not an instant, so not rewritten to …Z
        generated_upper_text: '',
      });
    });

    it('pulls NULL as null in every column', () => {
      const { allNullRowId } = fixtures.allTypesFixtureRowIds;
      const allNullRecordFile = findRecordFileById(pulledAllTypesRecordFiles, 'id', allNullRowId);
      const nonIdValues = Object.entries(allNullRecordFile)
        .filter(([columnName]) => columnName !== 'id')
        .map(([, value]) => value);
      expect(nonIdValues.length).toBe(Object.keys(expectedAllTypesColumnAnnotations(flavor)).length - 1);
      expect(nonIdValues.every((value) => value === null)).toBe(true);
    });

    it("validates every pulled record against the spec's schema; the only format findings are the zero dates", () => {
      expect(listStructuralSchemaViolations(allTypesSpec, pulledAllTypesRecordFiles)).toEqual([]);
      const { zeroDatesAndEmptyValuesRowId } = fixtures.allTypesFixtureRowIds;
      // The zero DATETIME carries the non-asserting `date-time-local` format, so it raises no finding.
      expect(listSchemaFormatWarnings(allTypesSpec, pulledAllTypesRecordFiles)).toEqual([
        `${zeroDatesAndEmptyValuesRowId}.calendar_date = "0000-00-00"`,
        `${zeroDatesAndEmptyValuesRowId}.instant_timestamp = "0000-00-00 00:00:00.000"`,
      ]);
    });
  });

  describe('pagination, filters and incremental pulls', () => {
    it('pages over more than 1,000 rows with the default page size: every row exactly once, in id order', async () => {
      const paginationSpec = await fetchTableSpec(PAGINATION_TABLE_NAME);
      const { recordFilesPerPage, connectorProgressAfterEachPage, pullResult } = await pullEveryRecordFilePage(
        connector,
        paginationSpec,
      );

      expect(recordFilesPerPage.map((recordFilesOnPage) => recordFilesOnPage.length)).toEqual([
        MYSQL_DEFAULT_READ_PAGE_SIZE_EXPECTED,
        MYSQL_DEFAULT_READ_PAGE_SIZE_EXPECTED,
        PAGINATION_TABLE_ROW_COUNT - 2 * MYSQL_DEFAULT_READ_PAGE_SIZE_EXPECTED,
      ]);
      expect(connectorProgressAfterEachPage).toEqual([
        { nextOffset: MYSQL_DEFAULT_READ_PAGE_SIZE_EXPECTED },
        { nextOffset: 2 * MYSQL_DEFAULT_READ_PAGE_SIZE_EXPECTED },
        { nextOffset: PAGINATION_TABLE_ROW_COUNT },
      ]);
      const pulledIdsInOrder = recordFilesPerPage.flat().map((recordFile) => recordFile.id);
      expect(new Set(pulledIdsInOrder).size).toBe(PAGINATION_TABLE_ROW_COUNT);
      expect(pulledIdsInOrder).toEqual(fixtures.paginationTableIdsInOrder);
      // A full pull reports no watermark.
      expect(pullResult).toEqual({});
    });

    it('resumes a stalled pull from its checkpointed nextOffset', async () => {
      const paginationSpec = await fetchTableSpec(PAGINATION_TABLE_NAME);
      const resumeOffset = 2 * MYSQL_DEFAULT_READ_PAGE_SIZE_EXPECTED;
      const { recordFilesPerPage } = await pullEveryRecordFilePage(
        connector,
        paginationSpec,
        {},
        { nextOffset: resumeOffset },
      );
      expect(recordFilesPerPage.flat().map((recordFile) => recordFile.id)).toEqual(
        fixtures.paginationTableIdsInOrder.slice(resumeOffset),
      );
    });

    it('keeps a top-level OR filter parenthesized when an incremental since is added', async () => {
      const filteredIncrementalSpec = await fetchTableSpec(FILTERED_INCREMENTAL_TABLE_NAME);
      const leadOrQualifiedFilter = "stage = 'lead' OR stage = 'qualified'";

      // The filter alone: every lead / qualified row, including the one whose modified_at is NULL.
      const filteredFullPull = await pullEveryRecordFile(connector, filteredIncrementalSpec, {
        filter: leadOrQualifiedFilter,
      });
      expect(filteredFullPull.map((recordFile) => [recordFile.stage, recordFile.modified_at])).toEqual([
        ['lead', '2020-01-01T00:00:00.000Z'],
        ['lead', '2030-01-01T00:00:00.000Z'],
        ['qualified', '2020-01-01T00:00:00.000Z'],
        ['qualified', '2030-01-01T00:00:00.000Z'],
        ['lead', null],
      ]);

      // Filter AND window. Unparenthesized (`stage = 'lead' OR stage = 'qualified' AND modified_at > ?`), the old
      // lead row would leak in. NULL modified-at rows are never pulled incrementally (Postgres parity).
      const pullStartedAt = new Date();
      const { recordFilesPerPage, pullResult } = await pullEveryRecordFilePage(connector, filteredIncrementalSpec, {
        filter: leadOrQualifiedFilter,
        pullMode: 'incremental',
        since: new Date('2025-01-01T00:00:00.000Z'),
        modifiedAtField: 'modified_at',
      });
      const pullFinishedAt = new Date();
      expect(recordFilesPerPage.flat().map((recordFile) => [recordFile.stage, recordFile.modified_at])).toEqual([
        ['lead', '2030-01-01T00:00:00.000Z'],
        ['qualified', '2030-01-01T00:00:00.000Z'],
      ]);
      // The watermark is captured before the first query.
      expect(pullResult.newWatermark).toBeInstanceOf(Date);
      expect(pullResult.newWatermark?.getTime()).toBeGreaterThanOrEqual(pullStartedAt.getTime());
      expect(pullResult.newWatermark?.getTime()).toBeLessThanOrEqual(pullFinishedAt.getTime());
    });

    it('rejects a filter carrying a second statement before running any SQL', async () => {
      const filteredIncrementalSpec = await fetchTableSpec(FILTERED_INCREMENTAL_TABLE_NAME);
      const receivedPages: ConnectorFile[][] = [];
      await expect(
        connector.pullRecordFiles(
          filteredIncrementalSpec,
          ({ files }) => {
            receivedPages.push(files);
            return Promise.resolve();
          },
          {},
          { filter: `stage = 'lead'; DELETE FROM ${FILTERED_INCREMENTAL_TABLE_NAME}` },
        ),
      ).rejects.toMatchObject({ problem: MySqlClientProblem.InvalidFilter });
      expect(receivedPages).toEqual([]);
    });
  });

  describe('pullRecordFilesByIds', () => {
    it('matches a BIGINT id exactly (2^53+1, not its 2^53 neighbour) and silently skips missing or unmatchable ids', async () => {
      const bigintPrimaryKeySpec = await fetchTableSpec(BIGINT_PRIMARY_KEY_TABLE_NAME);
      const receivedPages: ConnectorFile[][] = [];
      await connector.pullRecordFilesByIds(
        bigintPrimaryKeySpec,
        // '424242' has no row. '12abc' isn't an integer, so it's never sent: bound as text, MySQL would coerce it
        // to 12 and return the `twelve` row.
        [TWO_TO_THE_53_PLUS_ONE_TEXT, '424242', '12abc'],
        ({ files }) => {
          receivedPages.push(files);
          return Promise.resolve();
        },
      );
      expect(receivedPages.flat()).toEqual([{ id: TWO_TO_THE_53_PLUS_ONE_TEXT, label: 'two to the 53 plus one' }]);
    });

    it('matches a BINARY(16) id by the base64 it was pulled as (bound back as the exact bytes)', async () => {
      const binaryPrimaryKeySpec = await fetchTableSpec(BINARY_PRIMARY_KEY_TABLE_NAME);
      const binaryPrimaryKeyRowIdBase64 = Buffer.from(BINARY_PRIMARY_KEY_ROW_ID_HEX, 'hex').toString('base64');
      const pulledRecordFiles = await pullEveryRecordFile(connector, binaryPrimaryKeySpec);
      expect(pulledRecordFiles).toEqual([{ id: binaryPrimaryKeyRowIdBase64, label: 'binary keyed row' }]);

      const receivedPages: ConnectorFile[][] = [];
      await connector.pullRecordFilesByIds(
        binaryPrimaryKeySpec,
        // The pulled id, a well-formed id with no row, and text that isn't base64 (never sent).
        [binaryPrimaryKeyRowIdBase64, Buffer.alloc(16).toString('base64'), 'not base64!'],
        ({ files }) => {
          receivedPages.push(files);
          return Promise.resolve();
        },
      );
      expect(receivedPages.flat()).toEqual([{ id: binaryPrimaryKeyRowIdBase64, label: 'binary keyed row' }]);
    });
  });

  itWhen(serverGeneratesInvisiblePrimaryKeys)(
    '(MySQL) addresses and pulls a generated-invisible-primary-key table by my_row_id',
    async () => {
      const generatedInvisiblePrimaryKeySpec = await fetchTableSpec(GENERATED_INVISIBLE_PRIMARY_KEY_TABLE_NAME);
      expect(generatedInvisiblePrimaryKeySpec.idPath).toBe('my_row_id');
      expect(generatedInvisiblePrimaryKeySpec.idPathRequiresUserSelection).toBeUndefined();
      const myRowIdSchema = readTableSpecColumnSchemas(generatedInvisiblePrimaryKeySpec).my_row_id as Record<
        string,
        unknown
      >;
      expect(myRowIdSchema[X_SCRATCH_READONLY]).toBe(true);
      expect(myRowIdSchema[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe(PostgresColumnType.NUMERIC_STRING);

      // `SELECT *` would drop the invisible id; the explicit column list keeps it (BIGINT UNSIGNED → string).
      expect(await pullEveryRecordFile(connector, generatedInvisiblePrimaryKeySpec)).toEqual([
        { my_row_id: '1', label: 'first' },
        { my_row_id: '2', label: 'second' },
      ]);
    },
  );

  // -------------------------------------------------------------------------------------------------------------
  // Create / update / delete smoke test (the write guards are covered by mysql-record-writes.spec.ts)
  // -------------------------------------------------------------------------------------------------------------

  describe('create / update / delete smoke test on the all-types table', () => {
    let allTypesSpec: BaseJsonTableSpec;
    let createdFullRecordFile: ConnectorFile;
    let createdMinimalRecordFile: ConnectorFile;

    const readPayloadJsonAsStoredByMySql = async (rowId: unknown): Promise<{ jsonType: string; document: unknown }> => {
      const [storedRows] = await requireAdminConnection().query<RowDataPacket[]>(
        `SELECT JSON_TYPE(payload_json) AS json_type, CAST(payload_json AS CHAR) AS payload_json_text
         FROM ${qualifyForAdminSql(ALL_TYPES_TABLE_NAME)} WHERE id = ?`,
        [Number(rowId)],
      );
      return {
        jsonType: readAdminCatalogText(storedRows[0].json_type),
        document: JSON.parse(readAdminCatalogText(storedRows[0].payload_json_text)) as unknown,
      };
    };

    beforeAll(async () => {
      allTypesSpec = await fetchTableSpec(ALL_TYPES_TABLE_NAME);
    });

    it('creates rows and returns them as re-selected from MySQL, with their AUTO_INCREMENT ids', async () => {
      const createdRecordFiles = await connector.createRecords(allTypesSpec, [
        {
          big_signed: TWO_TO_THE_53_PLUS_ONE_TEXT,
          exact_decimal: '1.5',
          approximate_double: 2.5,
          tiny_flag: 0,
          small_year: 2026,
          short_text: 'Created 🎉 by Scratch',
          status_enum: 'draft',
          tag_set: 'green,red',
          payload_json: { created: true, list: [1, 2] },
          calendar_date: '2026-03-05',
          wall_clock_datetime: '2026-03-05 14:30:00.123',
          instant_timestamp: '2026-03-05T14:30:00.123Z',
          'a.b': 8,
          'Marked as done': 0,
          'Featured?': 'no',
          'back`tick': 'tock',
        },
        { short_text: 'minimal row' },
      ]);

      expect(createdRecordFiles).toHaveLength(2);
      [createdFullRecordFile, createdMinimalRecordFile] = createdRecordFiles;
      const highestFixtureRowId = fixtures.allTypesFixtureRowIds.allNullRowId;
      expect(createdFullRecordFile.id).toEqual(expect.any(Number));
      expect(createdFullRecordFile.id as number).toBeGreaterThan(highestFixtureRowId);
      expect(createdMinimalRecordFile.id as number).toBeGreaterThan(createdFullRecordFile.id as number);

      // Values MySQL computed or normalized prove the rows were read back, not echoed.
      expect(createdFullRecordFile).toMatchObject({
        big_signed: TWO_TO_THE_53_PLUS_ONE_TEXT,
        exact_decimal: '1.500000000000000000000000000000',
        tag_set: 'red,green', // SET members come back in declared order
        payload_json: { created: true, list: [1, 2] },
        wall_clock_datetime: '2026-03-05 14:30:00.123',
        instant_timestamp: '2026-03-05T14:30:00.123Z',
        generated_upper_text: 'CREATED 🎉 BY SCRATCH',
        'a.b': 8,
        'Featured?': 'no',
        'back`tick': 'tock',
      });
      expect(createdMinimalRecordFile).toMatchObject({
        short_text: 'minimal row',
        generated_upper_text: 'MINIMAL ROW',
        payload_json: null,
      });
      // The JSON object was sent as a document, never as '[object Object]'.
      expect(await readPayloadJsonAsStoredByMySql(createdFullRecordFile.id)).toEqual({
        jsonType: 'OBJECT',
        document: { created: true, list: [1, 2] },
      });
    });

    it('writes whole top-level values for a sparse changedFields diff and returns the re-selected row', async () => {
      const editedFullRecordFile: ConnectorFile = {
        ...createdFullRecordFile,
        short_text: 'Updated ✅',
        payload_json: { created: true, list: [1, 2, 3] },
        'Featured?': 'yes',
        'back`tick': 'tick',
      };
      // The publish pipeline's deep sparse diff: only the changed array inside the document. Writing it as-is
      // would replace the stored document and lose `created`. Read-only columns (the generated one, the id) are
      // in the file but not in the diff, so they're never sent (MySQL rejects writes to a generated column).
      const sparseChangedFields = {
        short_text: 'Updated ✅',
        payload_json: { list: [1, 2, 3] },
        'Featured?': 'yes',
        'back`tick': 'tick',
      };

      const [updatedRecordFile] = await connector.updateRecords(
        allTypesSpec,
        [editedFullRecordFile],
        [sparseChangedFields],
      );

      expect(updatedRecordFile).toEqual({
        ...createdFullRecordFile, // every untouched column keeps its value
        short_text: 'Updated ✅',
        payload_json: { created: true, list: [1, 2, 3] },
        generated_upper_text: 'UPDATED ✅', // recomputed by MySQL
        'Featured?': 'yes',
        'back`tick': 'tick',
      });
      expect(await readPayloadJsonAsStoredByMySql(createdFullRecordFile.id)).toEqual({
        jsonType: 'OBJECT',
        document: { created: true, list: [1, 2, 3] },
      });
    });

    it('deletes rows, and tolerates deleting rows that are already gone', async () => {
      const createdRowIds = [Number(createdFullRecordFile.id), Number(createdMinimalRecordFile.id)];
      const countRemainingCreatedRows = async (): Promise<number> => {
        const [remainingRows] = await requireAdminConnection().query<RowDataPacket[]>(
          `SELECT COUNT(*) AS remaining_row_count FROM ${qualifyForAdminSql(ALL_TYPES_TABLE_NAME)} WHERE id IN (?)`,
          [createdRowIds],
        );
        return Number(remainingRows[0].remaining_row_count);
      };

      await connector.deleteRecords(allTypesSpec, [createdFullRecordFile, createdMinimalRecordFile]);
      expect(await countRemainingCreatedRows()).toBe(0);

      await expect(
        connector.deleteRecords(allTypesSpec, [createdFullRecordFile, createdMinimalRecordFile]),
      ).resolves.toBeUndefined();

      // The fixture rows are untouched.
      const pulledIdsAfterDeletes = (await pullEveryRecordFile(connector, allTypesSpec)).map(
        (recordFile) => recordFile.id,
      );
      const { fullyPopulatedRowId, zeroDatesAndEmptyValuesRowId, allNullRowId } = fixtures.allTypesFixtureRowIds;
      expect(pulledIdsAfterDeletes).toEqual([fullyPopulatedRowId, zeroDatesAndEmptyValuesRowId, allNullRowId]);
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  // Id guards: an edited id on update, a repeated id on pull
  // -------------------------------------------------------------------------------------------------------------

  /** The rejection of a connector call, asserted to be a MySqlClientError (fails if the call resolved). */
  const readMySqlClientErrorRejection = async (connectorCall: Promise<unknown>): Promise<MySqlClientError> => {
    const rejection = await connectorCall.then(
      () => {
        throw new Error('Expected the connector call to reject, but it resolved');
      },
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(MySqlClientError);
    return rejection as MySqlClientError;
  };

  describe('an edited id column on update', () => {
    let editableVarcharPrimaryKeySpec: BaseJsonTableSpec;

    const readEditableVarcharPrimaryKeyRowsAsStored = async (): Promise<Record<string, unknown>[]> => {
      const [storedRows] = await requireAdminConnection().query<RowDataPacket[]>(
        `SELECT sku, name, color FROM ${qualifyForAdminSql(EDITABLE_VARCHAR_PRIMARY_KEY_TABLE_NAME)} ORDER BY sku`,
      );
      return storedRows.map((storedRow) => ({ ...storedRow }));
    };

    beforeAll(async () => {
      // utf8mb4_0900_ai_ci / MariaDB's default collation are case-insensitive, so 'a' would also address row 'A'.
      await requireAdminConnection().query(
        `CREATE TABLE ${qualifyForAdminSql(EDITABLE_VARCHAR_PRIMARY_KEY_TABLE_NAME)}
           (sku VARCHAR(10) NOT NULL PRIMARY KEY, name VARCHAR(20) NOT NULL, color VARCHAR(10) NULL)
         ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
      await requireAdminConnection().query(
        `INSERT INTO ${qualifyForAdminSql(EDITABLE_VARCHAR_PRIMARY_KEY_TABLE_NAME)} (sku, name, color)
         VALUES ('A', 'apple', 'red'), ('B', 'banana', 'yellow')`,
      );
      editableVarcharPrimaryKeySpec = await fetchTableSpec(EDITABLE_VARCHAR_PRIMARY_KEY_TABLE_NAME);
    });

    it('refuses a partial change set that moves record A onto row B, and leaves both rows untouched', async () => {
      expect(editableVarcharPrimaryKeySpec.idPath).toBe('sku');
      // Record A's file edited to sku 'B': addressed by the file's id, the UPDATE would overwrite row B.
      const updateError = await readMySqlClientErrorRejection(
        connector.updateRecords(
          editableVarcharPrimaryKeySpec,
          [{ sku: 'B', name: 'EDITED-A', color: 'red' }],
          [{ sku: 'B', name: 'EDITED-A' }],
        ),
      );

      expect(updateError.problem).toBe(MySqlClientProblem.IdColumnEdited);
      expect(updateError.errorCode).toBeUndefined();
      expect(updateError.message).toContain('The ID field "sku" was edited');
      expect(connector.extractConnectorErrorDetails(updateError).userFriendlyMessage).toBe(updateError.message);
      expect(await readEditableVarcharPrimaryKeyRowsAsStored()).toEqual([
        { sku: 'A', name: 'apple', color: 'red' },
        { sku: 'B', name: 'banana', color: 'yellow' },
      ]);
    });

    it('refuses a case-only id edit too (a case-insensitive collation would silently keep the old id)', async () => {
      const updateError = await readMySqlClientErrorRejection(
        connector.updateRecords(
          editableVarcharPrimaryKeySpec,
          [{ sku: 'a', name: 'case-edit', color: 'red' }],
          [{ sku: 'a', name: 'case-edit' }],
        ),
      );

      expect(updateError.problem).toBe(MySqlClientProblem.IdColumnEdited);
      expect(await readEditableVarcharPrimaryKeyRowsAsStored()).toEqual([
        { sku: 'A', name: 'apple', color: 'red' },
        { sku: 'B', name: 'banana', color: 'yellow' },
      ]);
    });

    it("still updates a whole-record change set (the pipeline's fallback when the published copy is unreadable)", async () => {
      const recordFileOfRowA: ConnectorFile = { sku: 'A', name: 'apple v2', color: 'green' };

      const [updatedRecordFile] = await connector.updateRecords(
        editableVarcharPrimaryKeySpec,
        [recordFileOfRowA],
        [{ ...recordFileOfRowA }],
      );

      expect(updatedRecordFile).toEqual(recordFileOfRowA);
      expect(await readEditableVarcharPrimaryKeyRowsAsStored()).toEqual([
        { sku: 'A', name: 'apple v2', color: 'green' },
        { sku: 'B', name: 'banana', color: 'yellow' },
      ]);
    });
  });

  describe('an ID field without a unique index (idFieldOverride) on pull', () => {
    let lowCardinalityStatusSpec: BaseJsonTableSpec;
    let pageBoundaryRepeatSpec: BaseJsonTableSpec;

    /** What DataFolderService does with the table picker's idFieldOverride: only `idPath` changes. */
    const withIdFieldOverriddenTo = (tableSpec: BaseJsonTableSpec, columnName: string): BaseJsonTableSpec => ({
      ...tableSpec,
      idPath: dotPath(columnName),
    });

    const pullPagesUntilSettled = async (
      tableSpec: BaseJsonTableSpec,
    ): Promise<{ pullOutcome: Promise<PullRecordFilesResult>; pagesHandedToCallback: ConnectorFile[][] }> => {
      const pagesHandedToCallback: ConnectorFile[][] = [];
      const pullOutcome = connector.pullRecordFiles(
        tableSpec,
        ({ files }) => {
          pagesHandedToCallback.push(files);
          return Promise.resolve();
        },
        {},
        {},
      );
      await pullOutcome.catch(() => undefined);
      return { pullOutcome, pagesHandedToCallback };
    };

    beforeAll(async () => {
      // No index on `status`, exactly as the reviewer's probe: the picker accepts any column as the ID field.
      await requireAdminConnection().query(
        `CREATE TABLE ${qualifyForAdminSql(LOW_CARDINALITY_STATUS_TABLE_NAME)}
           (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, status VARCHAR(10) NOT NULL, payload VARCHAR(20) NOT NULL)
         ENGINE=InnoDB`,
      );
      const lowCardinalityStatusRows = Array.from({ length: LOW_CARDINALITY_STATUS_TABLE_ROW_COUNT }, (_, rowIndex) => [
        ['draft', 'published', 'archived'][rowIndex % 3],
        `payload-${rowIndex}`,
      ]);
      await requireAdminConnection().query(
        `INSERT INTO ${qualifyForAdminSql(LOW_CARDINALITY_STATUS_TABLE_NAME)} (status, payload) VALUES ?`,
        [lowCardinalityStatusRows],
      );

      await requireAdminConnection().query(
        `CREATE TABLE ${qualifyForAdminSql(PAGE_BOUNDARY_REPEAT_TABLE_NAME)}
           (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, code VARCHAR(10) NOT NULL, distinct_label VARCHAR(20) NOT NULL)
         ENGINE=InnoDB`,
      );
      const pageBoundaryRepeatRows = Array.from(
        { length: MYSQL_DEFAULT_READ_PAGE_SIZE_EXPECTED + 1 },
        (_, rowIndex) => [
          `c${String(Math.min(rowIndex, MYSQL_DEFAULT_READ_PAGE_SIZE_EXPECTED - 1)).padStart(4, '0')}`,
          `label-${rowIndex}`,
        ],
      );
      await requireAdminConnection().query(
        `INSERT INTO ${qualifyForAdminSql(PAGE_BOUNDARY_REPEAT_TABLE_NAME)} (code, distinct_label) VALUES ?`,
        [pageBoundaryRepeatRows],
      );

      lowCardinalityStatusSpec = await fetchTableSpec(LOW_CARDINALITY_STATUS_TABLE_NAME);
      pageBoundaryRepeatSpec = await fetchTableSpec(PAGE_BOUNDARY_REPEAT_TABLE_NAME);
    });

    it('fails a full pull by a three-valued status column with PulledDuplicateId before writing any page', async () => {
      const { pullOutcome, pagesHandedToCallback } = await pullPagesUntilSettled(
        withIdFieldOverriddenTo(lowCardinalityStatusSpec, 'status'),
      );

      const pullError = await readMySqlClientErrorRejection(pullOutcome);
      expect(pullError.problem).toBe(MySqlClientProblem.PulledDuplicateId);
      expect(pullError.message).toContain(`The ID field "status" isn't unique`);
      expect(pullError.message).not.toMatch(/draft|published|archived/);
      expect(pagesHandedToCallback).toEqual([]);
    });

    it('fails a by-id pull whose id matches several rows', async () => {
      const receivedPages: ConnectorFile[][] = [];
      const pullByIdsError = await readMySqlClientErrorRejection(
        connector.pullRecordFilesByIds(
          withIdFieldOverriddenTo(lowCardinalityStatusSpec, 'status'),
          ['draft'],
          ({ files }) => {
            receivedPages.push(files);
            return Promise.resolve();
          },
        ),
      );

      expect(pullByIdsError.problem).toBe(MySqlClientProblem.PulledDuplicateId);
      expect(receivedPages).toEqual([]);
    });

    it('catches a repeat that straddles the 500-row page boundary, after delivering the clean first page', async () => {
      const { pullOutcome, pagesHandedToCallback } = await pullPagesUntilSettled(
        withIdFieldOverriddenTo(pageBoundaryRepeatSpec, 'code'),
      );

      const pullError = await readMySqlClientErrorRejection(pullOutcome);
      expect(pullError.problem).toBe(MySqlClientProblem.PulledDuplicateId);
      expect(pagesHandedToCallback.map((page) => page.length)).toEqual([MYSQL_DEFAULT_READ_PAGE_SIZE_EXPECTED]);
      expect(pagesHandedToCallback[0][MYSQL_DEFAULT_READ_PAGE_SIZE_EXPECTED - 1].code).toBe('c0499');
    });

    it('pulls every row by an unindexed ID field whose values never repeat', async () => {
      const { pullOutcome, pagesHandedToCallback } = await pullPagesUntilSettled(
        withIdFieldOverriddenTo(pageBoundaryRepeatSpec, 'distinct_label'),
      );

      await expect(pullOutcome).resolves.toEqual({});
      const pulledDistinctLabels = pagesHandedToCallback.flat().map((recordFile) => recordFile.distinct_label);
      expect(new Set(pulledDistinctLabels).size).toBe(MYSQL_DEFAULT_READ_PAGE_SIZE_EXPECTED + 1);
    });

    it('keeps pulling the default unique-indexed id of the same tables', async () => {
      const pulledRecordFiles = await pullEveryRecordFile(connector, lowCardinalityStatusSpec);
      expect(lowCardinalityStatusSpec.idPath).toBe('id');
      expect(new Set(pulledRecordFiles.map((recordFile) => recordFile.id)).size).toBe(
        LOW_CARDINALITY_STATUS_TABLE_ROW_COUNT,
      );
    });
  });
});
