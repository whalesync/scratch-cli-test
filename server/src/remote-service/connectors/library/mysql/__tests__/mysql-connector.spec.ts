/**
 * Unit spec for `MysqlConnector` (DEV-12035): the connector's own orchestration — metadata, registration,
 * credential re-validation, and how each operation drives the query modules — with NO database. The knex client
 * and every module that issues SQL are mocked, so no knex instance or mysql2 connection is ever created. The pure
 * modules the connector composes (spec builder, filter validator, record preparation, id binding, error mapping,
 * create-schema helpers) run for real.
 *
 * Real-server behaviour is covered by `server/test/integration/mysql-*.spec.ts`.
 */
import {
  IncrementalPullSupport,
  JSON_SCHEMA_LOCAL_DATE_TIME_FORMAT,
  PostgresColumnType,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_NATIVE_COLUMN_TYPE,
  type CreateFieldSpec,
  type DecryptedCredentials,
} from '@spinner/shared-types';
import {
  connectorRegistry,
  resolveIncrementalPullSupportForService,
  type ConnectorFactoryContext,
  type ConnectorRegistration,
} from '../../../connector-registry';
import { ConnectorInstantiationError, NonWritableFieldEditError } from '../../../error';
import { type NormalizedCreateFieldsPlan, type NormalizedCreateTablePlan } from '../../../schema-creation.types';
import { Service } from '../../../service-constants';
import {
  dotPath,
  type BaseJsonTableSpec,
  type ConnectorFile,
  type EntityId,
  type PullRecordFilesOptions,
} from '../../../types';
import { PG_INCREMENTAL_CLOCK_SKEW_MS } from '../../pg-common/pg-incremental';
import { KnexMySqlClient } from '../knex-mysql-client';
import { MySqlAuthParser } from '../mysql-auth-parser';
import { buildMySqlTableLookupKey } from '../mysql-catalog';
import {
  findAllColumnsInTable,
  findAllTables,
  findDatabaseNames,
  findMariaDbJsonAliasColumnNames,
  findPrimaryKeyColumnNames,
  findSingleColumnForeignKeysInTable,
  findSingleColumnUniqueIndexColumns,
  findTablesWithAutoIncrementPrimaryKey,
  findTablesWithSingleColumnUniqueIndex,
} from '../mysql-catalog-queries';
import {
  MYSQL_SYSTEM_DATABASE_NAMES,
  type MySqlCatalogColumn,
  type MySqlSingleColumnUniqueIndexColumn,
  type MySqlTableRow,
} from '../mysql-catalog-types';
import { MySqlClientError, MySqlClientProblem } from '../mysql-client-error';
import { MYSQL_CREDENTIAL_INPUT_KEYS } from '../mysql-connection-options';
import { LOCAL_MYSQL_PUBLISH_BATCH_SIZE_ENV, MysqlConnector } from '../mysql-connector';
import { MYSQL_SCHEMA_CREATION_CAPABILITIES, type MySqlForeignKeyResolution } from '../mysql-create-schema';
import { MySqlCredentialProblem, MySqlCredentialsInvalidError } from '../mysql-credential-errors';
import * as mysqlErrorMappingModule from '../mysql-error-mapping';
import { resolveMySqlFieldValueCanonicalizer } from '../mysql-field-value-canonicalizer';
import { buildMySqlJsonTableSpec, MYSQL_VIEW_DISABLED_REASON } from '../mysql-json-schema';
import { MYSQL_LOGO_DATA_URI } from '../mysql-logo';
import { selectTableRowsByIds, selectTableRowsPage } from '../mysql-record-reads';
import {
  deleteRecordsByPrimaryKey,
  insertRecordsReturningPersistedRows,
  updateRecordsByPrimaryKeyReturningPersistedRows,
} from '../mysql-record-writes';
import {
  addForeignKeyColumnWithConstraint,
  addNonForeignKeyColumn,
  createTableWithAutoIncrementPrimaryKey,
  resolveForeignKeyReferenceForTargetTable,
} from '../mysql-schema-creation-queries';
import { type MySqlServerFlavor } from '../mysql-server-flavor';
import { TABLE_WITHOUT_AUTO_INCREMENT_ID_CREATES_DISABLED_REASON } from '../mysql-table-writability';
import { type MySqlConnectionOptions, type MySqlTableReference } from '../mysql-types';

// Every module that talks to MySQL is replaced by jest's automock (each export becomes a `jest.fn()`), so the
// connector's calls into them are observable and no knex query builder ever runs.
jest.mock('../mysql-catalog-queries');
jest.mock('../mysql-record-reads');
jest.mock('../mysql-record-writes');
jest.mock('../mysql-schema-creation-queries');
// The knex client is a factory mock: constructing it must never build a knex instance or load the mysql2 driver.
// Its implementation is (re)installed in `beforeEach` after `jest.resetAllMocks()`.
jest.mock('../knex-mysql-client', () => ({
  MYSQL_STATEMENT_TIMEOUT_MS: 300_000,
  KnexMySqlClient: jest.fn(),
}));

// ---------------------------------------------------------------------------------------------------------------
// Fake per-operation client
// ---------------------------------------------------------------------------------------------------------------

/** The statement timeout the mocked client module exports (the real module's value). */
const MOCKED_MYSQL_STATEMENT_TIMEOUT_MS = 300_000;

/** What `withMySqlClient` hands each operation instead of a real `KnexMySqlClient`. */
interface FakeKnexMySqlClient {
  readonly constructedWithConnectionOptions: MySqlConnectionOptions;
  /** A stand-in for `client.knex`, identifiable so specs can assert which client's knex a query module received. */
  readonly knex: { readonly fakeKnexForClientNumber: number };
  detectedServerFlavor: MySqlServerFlavor | undefined;
  readonly getServerFlavor: jest.Mock<Promise<MySqlServerFlavor>, []>;
  readonly testQuery: jest.Mock<Promise<unknown>, []>;
  readonly prepareSessionForSchemaChanges: jest.Mock<Promise<void>, []>;
  readonly dispose: jest.Mock<Promise<void>, []>;
}

const fakeKnexMySqlClientsInCreationOrder: FakeKnexMySqlClient[] = [];
/** The flavor every fake client created from now on reports once it "connects". */
let serverFlavorReportedByNewFakeClients: MySqlServerFlavor = 'mysql';

function createFakeKnexMySqlClient(connectionOptions: MySqlConnectionOptions): FakeKnexMySqlClient {
  const fakeClient: FakeKnexMySqlClient = {
    constructedWithConnectionOptions: connectionOptions,
    knex: { fakeKnexForClientNumber: fakeKnexMySqlClientsInCreationOrder.length + 1 },
    detectedServerFlavor: undefined,
    getServerFlavor: jest.fn(() => {
      fakeClient.detectedServerFlavor = serverFlavorReportedByNewFakeClients;
      return Promise.resolve(serverFlavorReportedByNewFakeClients);
    }),
    testQuery: jest.fn(() => {
      fakeClient.detectedServerFlavor = serverFlavorReportedByNewFakeClients;
      return Promise.resolve({ currentDatabaseName: null, serverVersion: '8.4.11', serverFlavor: 'mysql' });
    }),
    prepareSessionForSchemaChanges: jest.fn(() => Promise.resolve()),
    dispose: jest.fn(() => Promise.resolve()),
  };
  fakeKnexMySqlClientsInCreationOrder.push(fakeClient);
  return fakeClient;
}

function onlyFakeKnexMySqlClientCreated(): FakeKnexMySqlClient {
  expect(fakeKnexMySqlClientsInCreationOrder).toHaveLength(1);
  return fakeKnexMySqlClientsInCreationOrder[0];
}

beforeEach(() => {
  jest.resetAllMocks();
  fakeKnexMySqlClientsInCreationOrder.length = 0;
  serverFlavorReportedByNewFakeClients = 'mysql';
  jest
    .mocked(KnexMySqlClient)
    .mockImplementation(
      (connectionOptions: MySqlConnectionOptions) =>
        createFakeKnexMySqlClient(connectionOptions) as unknown as KnexMySqlClient,
    );
});

// ---------------------------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------------------------

const APPLICATION_DATABASE_NAME = 'app_db';

const CONNECTION_OPTIONS_SCOPED_TO_APPLICATION_DATABASE: MySqlConnectionOptions = {
  host: 'db.example.com',
  port: 3306,
  databaseName: APPLICATION_DATABASE_NAME,
  username: 'scratch_app',
  password: 's3cret-password',
  sslMode: 'REQUIRED',
};

const CONNECTION_OPTIONS_WITHOUT_DATABASE: MySqlConnectionOptions = {
  host: 'db.example.com',
  port: 3306,
  username: 'scratch_app',
  password: 's3cret-password',
  sslMode: 'REQUIRED',
};

function buildConnectorScopedToApplicationDatabase(): MysqlConnector {
  return new MysqlConnector(CONNECTION_OPTIONS_SCOPED_TO_APPLICATION_DATABASE);
}

function buildCatalogColumn(overrides: Partial<MySqlCatalogColumn> & { columnName: string }): MySqlCatalogColumn {
  return {
    dataType: 'varchar',
    columnType: 'varchar(255)',
    isNullable: true,
    columnDefault: null,
    extra: '',
    generationExpression: null,
    privileges: 'select,insert,update,references',
    columnKey: '',
    characterMaximumLength: null,
    numericPrecision: null,
    numericScale: null,
    datetimePrecision: null,
    characterSetName: null,
    collationName: null,
    ordinalPosition: 1,
    ...overrides,
  };
}

function buildPrimaryKeyUniqueIndexColumn(
  overrides: Partial<MySqlSingleColumnUniqueIndexColumn> & { columnName: string; nativeType: string },
): MySqlSingleColumnUniqueIndexColumn {
  return {
    indexName: 'PRIMARY',
    isPrimaryKey: true,
    isNullable: false,
    isAutoIncrement: false,
    ordinalPosition: 1,
    ...overrides,
  };
}

/** `orders`: an AUTO_INCREMENT integer id plus one column per write-preparation rule. */
const ORDERS_TABLE_CATALOG_COLUMNS: MySqlCatalogColumn[] = [
  buildCatalogColumn({
    columnName: 'id',
    dataType: 'int',
    columnType: 'int unsigned',
    isNullable: false,
    extra: 'auto_increment',
    columnKey: 'PRI',
    ordinalPosition: 1,
  }),
  buildCatalogColumn({ columnName: 'name', isNullable: false, characterMaximumLength: 255, ordinalPosition: 2 }),
  buildCatalogColumn({ columnName: 'quantity', dataType: 'int', columnType: 'int', ordinalPosition: 3 }),
  buildCatalogColumn({ columnName: 'settings', dataType: 'json', columnType: 'json', ordinalPosition: 4 }),
  buildCatalogColumn({
    columnName: 'updated_at',
    dataType: 'timestamp',
    columnType: 'timestamp(3)',
    datetimePrecision: 3,
    ordinalPosition: 5,
  }),
  buildCatalogColumn({ columnName: 'shipped_on', dataType: 'date', columnType: 'date', ordinalPosition: 6 }),
  buildCatalogColumn({ columnName: 'photo', dataType: 'blob', columnType: 'blob', ordinalPosition: 7 }),
];

function buildTableSpecFromCatalog(params: {
  tableName: string;
  columns: MySqlCatalogColumn[];
  idColumn: MySqlSingleColumnUniqueIndexColumn;
}): BaseJsonTableSpec {
  return buildMySqlJsonTableSpec({
    entityId: {
      wsId: `${APPLICATION_DATABASE_NAME}__${params.tableName}`,
      remoteId: [APPLICATION_DATABASE_NAME, params.tableName],
    },
    table: { databaseName: APPLICATION_DATABASE_NAME, tableName: params.tableName },
    columns: params.columns,
    primaryKeyColumnNames: [params.idColumn.columnName],
    singleColumnUniqueIndexColumns: [params.idColumn],
    foreignKeys: [],
    mariaDbJsonAliasColumnNames: new Set(),
  });
}

function buildOrdersTableSpec(): BaseJsonTableSpec {
  return buildTableSpecFromCatalog({
    tableName: 'orders',
    columns: ORDERS_TABLE_CATALOG_COLUMNS,
    idColumn: buildPrimaryKeyUniqueIndexColumn({ columnName: 'id', nativeType: 'int unsigned', isAutoIncrement: true }),
  });
}

const ORDERS_TABLE_COLUMN_NAMES = ['id', 'name', 'quantity', 'settings', 'updated_at', 'shipped_on', 'photo'];

/** `customers`: addressed by a text (VARCHAR) primary key. */
function buildCustomersTableSpecWithTextId(): BaseJsonTableSpec {
  return buildTableSpecFromCatalog({
    tableName: 'customers',
    columns: [
      buildCatalogColumn({ columnName: 'customer_code', isNullable: false, columnKey: 'PRI', ordinalPosition: 1 }),
      buildCatalogColumn({ columnName: 'display_name', ordinalPosition: 2 }),
    ],
    idColumn: buildPrimaryKeyUniqueIndexColumn({ columnName: 'customer_code', nativeType: 'varchar(255)' }),
  });
}

/** `devices`: addressed by a BINARY(16) primary key (pulled as base64). */
function buildDevicesTableSpecWithBinaryId(): BaseJsonTableSpec {
  return buildTableSpecFromCatalog({
    tableName: 'devices',
    columns: [
      buildCatalogColumn({
        columnName: 'device_uuid',
        dataType: 'binary',
        columnType: 'binary(16)',
        isNullable: false,
        columnKey: 'PRI',
        ordinalPosition: 1,
      }),
      buildCatalogColumn({ columnName: 'label', ordinalPosition: 2 }),
    ],
    idColumn: buildPrimaryKeyUniqueIndexColumn({ columnName: 'device_uuid', nativeType: 'binary(16)' }),
  });
}

/** `attachments`: has a LONGBLOB column, so a pull reads small pages. */
function buildAttachmentsTableSpecWithLongBlob(): BaseJsonTableSpec {
  return buildTableSpecFromCatalog({
    tableName: 'attachments',
    columns: [
      buildCatalogColumn({
        columnName: 'id',
        dataType: 'bigint',
        columnType: 'bigint unsigned',
        isNullable: false,
        extra: 'auto_increment',
        columnKey: 'PRI',
        ordinalPosition: 1,
      }),
      buildCatalogColumn({ columnName: 'content', dataType: 'longblob', columnType: 'longblob', ordinalPosition: 2 }),
    ],
    idColumn: buildPrimaryKeyUniqueIndexColumn({
      columnName: 'id',
      nativeType: 'bigint unsigned',
      isAutoIncrement: true,
    }),
  });
}

function buildOrderRows(rowCount: number, firstId: number): Record<string, unknown>[] {
  return Array.from({ length: rowCount }, (_, rowIndex) => ({ id: firstId + rowIndex, name: `Order ${rowIndex}` }));
}

/**
 * The spec DataFolderService builds when the user picks the ID field (idFieldOverride): the same schema with `idPath`
 * replaced. Nothing in it says whether that column is unique, which is why a pull asks the catalog.
 */
function withIdFieldOverriddenTo(tableSpec: BaseJsonTableSpec, idFieldOverrideColumnName: string): BaseJsonTableSpec {
  return { ...tableSpec, idPath: dotPath(idFieldOverrideColumnName) };
}

/** The MySqlClientError a connector call rejected with (the test fails if the call resolved or threw anything else). */
async function readMySqlClientErrorRejection(connectorCall: Promise<unknown>): Promise<MySqlClientError> {
  const rejection = await connectorCall.then(
    () => {
      throw new Error('Expected the connector call to reject, but it resolved');
    },
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(MySqlClientError);
  return rejection as MySqlClientError;
}

/** The catalog's answer for `orders` (and `attachments`): only the AUTO_INCREMENT `id` has a single-column unique index. */
function mockIdAsTheOnlySingleColumnUniqueIndexColumn(): void {
  jest
    .mocked(findSingleColumnUniqueIndexColumns)
    .mockResolvedValue([
      buildPrimaryKeyUniqueIndexColumn({ columnName: 'id', nativeType: 'int unsigned', isAutoIncrement: true }),
    ]);
}

interface DeferredPromise<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function createDeferredPromise<T>(): DeferredPromise<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise(value) };
}

async function flushPendingPromiseCallbacks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A MySQL server error shaped like mysql2's (as rethrown by knex, whose `message` embeds the SQL). */
function buildFakeMySqlServerError(params: {
  errno: number;
  code: string;
  sqlState: string;
  sqlMessage: string;
  sql?: string;
}): Error {
  const knexStyleMessage = params.sql ? `${params.sql} - ${params.sqlMessage}` : params.sqlMessage;
  return Object.assign(new Error(knexStyleMessage), params);
}

function getMySqlRegistration(): ConnectorRegistration {
  const mySqlRegistration = connectorRegistry.get(Service.MYSQL);
  if (!mySqlRegistration) throw new Error('MySQL connector did not register itself');
  return mySqlRegistration;
}

// ---------------------------------------------------------------------------------------------------------------
// Metadata and registration
// ---------------------------------------------------------------------------------------------------------------

describe('MysqlConnector metadata', () => {
  it('is visible, supports schema creation and incremental pulls, and uses database/row terminology', () => {
    expect(MysqlConnector.displayName).toBe('MySQL');
    expect(MysqlConnector.metadata).toMatchObject({
      displayName: 'MySQL',
      visible: true,
      supportsSchemaCreation: true,
      incrementalPull: true,
      record: 'row',
      records: 'rows',
      base: 'database',
      bases: 'databases',
      createDestination: 'database',
      createDestinations: 'databases',
    });
  });

  it('asks for a required connection string first, then an optional CA certificate, both masked', () => {
    const credentialFields = MysqlConnector.metadata.credentialFields?.user_provided_params ?? [];

    expect(credentialFields.map((credentialField) => credentialField.key)).toEqual([
      'connectionString',
      'sslCaCertificate',
    ]);
    // Every form key is one the parser accepts (it also accepts the discrete settings, from the CLI and the API).
    for (const credentialField of credentialFields) {
      expect(MYSQL_CREDENTIAL_INPUT_KEYS).toContain(credentialField.key);
    }
    const requiredFieldKeys = credentialFields
      .filter((credentialField) => credentialField.required)
      .map((credentialField) => credentialField.key);
    expect(requiredFieldKeys).toEqual(['connectionString']);
    // Secrets are masked in the form.
    const secretFieldKeys = credentialFields
      .filter((credentialField) => credentialField.type === 'password')
      .map((credentialField) => credentialField.key);
    expect(secretFieldKeys).toEqual(['connectionString', 'sslCaCertificate']);
  });

  it('offers a modifiedAtField picker limited to TIMESTAMP (date-time) and DATETIME (date-time-local) columns', () => {
    expect(MysqlConnector.advancedSettings).toEqual([
      expect.objectContaining({
        key: 'modifiedAtField',
        type: 'field-select',
        fieldSelectFormats: ['date-time', JSON_SCHEMA_LOCAL_DATE_TIME_FORMAT],
      }),
    ]);
    expect(JSON_SCHEMA_LOCAL_DATE_TIME_FORMAT).toBe('date-time-local');
  });

  it('inlines its logo as an SVG data URI (no static-bucket upload needed while hidden)', () => {
    expect(MysqlConnector.metadata.logo).toBe(MYSQL_LOGO_DATA_URI);
    const svgDataUriPrefix = 'data:image/svg+xml;base64,';
    expect(MYSQL_LOGO_DATA_URI.startsWith(svgDataUriPrefix)).toBe(true);
    const decodedLogoMarkup = Buffer.from(MYSQL_LOGO_DATA_URI.slice(svgDataUriPrefix.length), 'base64').toString(
      'utf8',
    );
    expect(decodedLogoMarkup.startsWith('<svg')).toBe(true);
  });

  it('declares the connector-level capabilities the pipeline asks about', () => {
    const connector = buildConnectorScopedToApplicationDatabase();

    expect(connector.service).toBe(Service.MYSQL);
    expect(connector.supportsFilters()).toBe(true);
    expect(connector.supportsFieldSelection()).toBe(true);
    expect(connector.supportsSchemaCreation()).toBe(true);
    expect(connector.getSchemaCreationCapabilities()).toBe(MYSQL_SCHEMA_CREATION_CAPABILITIES);
  });

  it('offers no destination deep link — a MySQL database has no web UI', () => {
    expect(typeof buildConnectorScopedToApplicationDatabase().buildCreateDestinationRemoteWebUrl).toBe('undefined');
  });
});

describe('MySQL connector registration', () => {
  it('registers Service.MYSQL with user-provided params only and the connector static metadata', () => {
    const mySqlRegistration = getMySqlRegistration();

    expect(mySqlRegistration.service).toBe(Service.MYSQL);
    expect(mySqlRegistration.supportedAuthMethods).toEqual(['user_provided_params']);
    expect(mySqlRegistration.metadata).toBe(MysqlConnector.metadata);
    expect(mySqlRegistration.advancedSettings).toBe(MysqlConnector.advancedSettings);
  });

  it('creates a MySqlAuthParser for new connections', () => {
    const authParser = getMySqlRegistration().createAuthParser?.();

    expect(authParser).toBeInstanceOf(MySqlAuthParser);
    expect(authParser?.service).toBe(Service.MYSQL);
  });

  it('registers the MySQL field-value canonicalizer (Live Export re-runs compare like MySQL stores)', () => {
    expect(getMySqlRegistration().resolveFieldValueCanonicalizer).toBe(resolveMySqlFieldValueCanonicalizer);
  });

  it.each<[string, PullRecordFilesOptions, IncrementalPullSupport]>([
    ['a declared modifiedAtField', { modifiedAtField: 'updated_at' }, IncrementalPullSupport.SUPPORTED],
    ['no modifiedAtField', {}, IncrementalPullSupport.NEEDS_CONFIGURATION],
    ['a blank modifiedAtField', { modifiedAtField: '   ' }, IncrementalPullSupport.NEEDS_CONFIGURATION],
  ])('resolves incremental-pull support without a connection: %s', (_label, folderOptions, expectedSupport) => {
    const tableId = [APPLICATION_DATABASE_NAME, 'orders'];

    expect(
      getMySqlRegistration().resolveIncrementalPullSupport?.({ options: folderOptions, tableSpec: null, tableId }),
    ).toBe(expectedSupport);
    expect(
      resolveIncrementalPullSupportForService({
        service: Service.MYSQL,
        options: folderOptions,
        tableSpec: null,
        tableId,
      }),
    ).toBe(expectedSupport);
    // The live connector answers the same question the same way.
    expect(buildConnectorScopedToApplicationDatabase().incrementalPullSupport(folderOptions, null)).toBe(
      expectedSupport,
    );
  });
});

describe('MySQL registration createConnector', () => {
  const VALID_STORED_CREDENTIALS: DecryptedCredentials = {
    databaseHost: 'db.example.com',
    databasePort: '3307',
    databaseName: APPLICATION_DATABASE_NAME,
    username: 'scratch_app',
    password: 's3cret-password',
    sslMode: 'REQUIRED',
  };

  // `decryptedCredentials` is the whole account row spread with the decrypted blob, so unrelated keys ride along.
  const VALID_STORED_CREDENTIAL_BLOB_WITH_UNRELATED_KEYS: DecryptedCredentials = {
    ...VALID_STORED_CREDENTIALS,
    apiKey: 'unrelated-key-from-another-connector',
  };

  function buildConnectorFactoryContext(overrides: Partial<ConnectorFactoryContext>): ConnectorFactoryContext {
    return {
      connectorAccount: { id: 'coa_mysql_unit', authType: 'user_provided_params', extras: null, version: 1 },
      decryptedCredentials: VALID_STORED_CREDENTIAL_BLOB_WITH_UNRELATED_KEYS,
      createOAuthAccessTokenProvider: jest.fn(),
      createRateLimiter: jest.fn(),
      getFolderOptionsByTableId: jest.fn(),
      listFolderTableIds: jest.fn(),
      isFeatureEnabled: jest.fn(),
      ...overrides,
    };
  }

  it('throws ConnectorInstantiationError when there is no connector account', async () => {
    const creation = getMySqlRegistration().createConnector(buildConnectorFactoryContext({ connectorAccount: null }));

    await expect(creation).rejects.toBeInstanceOf(ConnectorInstantiationError);
    await expect(creation).rejects.toMatchObject({ service: Service.MYSQL });
  });

  it('builds a connector from the stored discrete keys without any I/O, ignoring unrelated keys', async () => {
    const connector = await getMySqlRegistration().createConnector(buildConnectorFactoryContext({}));

    expect(connector).toBeInstanceOf(MysqlConnector);
    expect(KnexMySqlClient).not.toHaveBeenCalled();

    // The validated options reach the client at the first operation.
    await connector.testConnection();
    expect(onlyFakeKnexMySqlClientCreated().constructedWithConnectionOptions).toEqual({
      host: 'db.example.com',
      port: 3307,
      databaseName: APPLICATION_DATABASE_NAME,
      username: 'scratch_app',
      password: 's3cret-password',
      sslMode: 'REQUIRED',
    });
  });

  it('refuses a stored connection string with a safe credentials error that never echoes it', async () => {
    const storedConnectionString = 'mysql://scratch_app:hunter2-secret@203.0.113.9:3306/app_db';
    const creation = getMySqlRegistration().createConnector(
      buildConnectorFactoryContext({
        decryptedCredentials: { ...VALID_STORED_CREDENTIALS, connectionString: storedConnectionString },
      }),
    );

    await expect(creation).rejects.toBeInstanceOf(MySqlCredentialsInvalidError);
    const credentialsError = await creation.catch((error: unknown) => error);
    expect(credentialsError).toMatchObject({ problem: MySqlCredentialProblem.StoredConnectionStringNotSupported });
    const { message, userFriendlyMessage } = credentialsError as MySqlCredentialsInvalidError;
    expect(message).toBe(userFriendlyMessage);
    for (const secretFragment of ['hunter2-secret', '203.0.113.9', storedConnectionString]) {
      expect(message).not.toContain(secretFragment);
    }
    expect(KnexMySqlClient).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['a numeric port', { databasePort: 3307 }, 'Port'],
    ['an object password', { password: { value: 'hunter2-secret' } }, 'Password'],
    ['a numeric connection string', { connectionString: 12345 }, 'Connection String'],
  ])(
    'refuses %s (a raw PATCH can store non-text values) naming only the field',
    async (_label, nonTextOverrides, expectedFieldLabel) => {
      const storedCredentialsWithNonTextValue = {
        ...VALID_STORED_CREDENTIALS,
        ...nonTextOverrides,
      } as unknown as DecryptedCredentials;
      const creation = getMySqlRegistration().createConnector(
        buildConnectorFactoryContext({ decryptedCredentials: storedCredentialsWithNonTextValue }),
      );

      await expect(creation).rejects.toBeInstanceOf(MySqlCredentialsInvalidError);
      const credentialsError = (await creation.catch((error: unknown) => error)) as MySqlCredentialsInvalidError;
      expect(credentialsError.problem).toBe(MySqlCredentialProblem.StoredSettingNotText);
      expect(credentialsError.userFriendlyMessage).toContain(expectedFieldLabel);
      expect(credentialsError.userFriendlyMessage).not.toContain('hunter2-secret');
    },
  );

  it('refuses a connection with no saved settings', async () => {
    const creation = getMySqlRegistration().createConnector(
      buildConnectorFactoryContext({ decryptedCredentials: null }),
    );

    await expect(creation).rejects.toMatchObject({ problem: MySqlCredentialProblem.StoredCredentialsMissing });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------------------------------------------

describe('MysqlConnector client lifecycle', () => {
  it('testConnection runs the test query on a fresh client and disposes it', async () => {
    await buildConnectorScopedToApplicationDatabase().testConnection();

    const fakeClient = onlyFakeKnexMySqlClientCreated();
    expect(fakeClient.testQuery).toHaveBeenCalledTimes(1);
    expect(fakeClient.dispose).toHaveBeenCalledTimes(1);
  });

  it('never lets a dispose failure mask the operation error (or fail a successful operation)', async () => {
    const connector = buildConnectorScopedToApplicationDatabase();
    const operationError = new Error('the operation failed');
    jest.mocked(KnexMySqlClient).mockImplementationOnce((connectionOptions: MySqlConnectionOptions) => {
      const fakeClient = createFakeKnexMySqlClient(connectionOptions);
      fakeClient.testQuery.mockRejectedValue(operationError);
      fakeClient.dispose.mockRejectedValue(new Error('dispose failed'));
      return fakeClient as unknown as KnexMySqlClient;
    });

    await expect(connector.testConnection()).rejects.toBe(operationError);

    jest.mocked(KnexMySqlClient).mockImplementationOnce((connectionOptions: MySqlConnectionOptions) => {
      const fakeClient = createFakeKnexMySqlClient(connectionOptions);
      fakeClient.dispose.mockRejectedValue(new Error('dispose failed'));
      return fakeClient as unknown as KnexMySqlClient;
    });
    await expect(connector.testConnection()).resolves.toBeUndefined();
  });

  it('creates one client per operation (never one per batch) and disconnect is a no-op', async () => {
    const connector = buildConnectorScopedToApplicationDatabase();
    mockIdAsTheOnlySingleColumnUniqueIndexColumn();
    jest.mocked(selectTableRowsPage).mockResolvedValueOnce(buildOrderRows(500, 1)).mockResolvedValueOnce([]);

    await connector.pullRecordFiles(buildOrdersTableSpec(), jest.fn(), {}, {});
    await connector.disconnect();

    // The id-uniqueness lookup and both pages ran on the same (only) client.
    expect(findSingleColumnUniqueIndexColumns).toHaveBeenCalledTimes(1);
    expect(selectTableRowsPage).toHaveBeenCalledTimes(2);
    const fakeClient = onlyFakeKnexMySqlClientCreated();
    expect(fakeClient.dispose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------------------------------------------

describe('MysqlConnector.listTables', () => {
  const ORDERS_TABLE_ROW: MySqlTableRow = {
    databaseName: APPLICATION_DATABASE_NAME,
    tableName: 'orders',
    tableType: 'BASE TABLE',
    storageEngine: 'InnoDB',
  };
  const INVOICES_TABLE_ROW: MySqlTableRow = {
    databaseName: APPLICATION_DATABASE_NAME,
    tableName: 'invoices',
    tableType: 'BASE TABLE',
    storageEngine: 'InnoDB',
  };
  const ORDER_TOTALS_VIEW_ROW: MySqlTableRow = {
    databaseName: APPLICATION_DATABASE_NAME,
    tableName: 'order_totals',
    tableType: 'VIEW',
    storageEngine: null,
  };

  it('runs the three discovery queries one after another on the operation client (the pool has one connection)', async () => {
    const pendingTablesQuery = createDeferredPromise<MySqlTableRow[]>();
    const pendingUniqueIndexQuery = createDeferredPromise<Set<string>>();
    jest.mocked(findAllTables).mockReturnValue(pendingTablesQuery.promise);
    jest.mocked(findTablesWithSingleColumnUniqueIndex).mockReturnValue(pendingUniqueIndexQuery.promise);
    jest.mocked(findTablesWithAutoIncrementPrimaryKey).mockResolvedValue(new Set());

    const listTablesResult = buildConnectorScopedToApplicationDatabase().listTables();
    await flushPendingPromiseCallbacks();
    expect(findAllTables).toHaveBeenCalledTimes(1);
    expect(findTablesWithSingleColumnUniqueIndex).not.toHaveBeenCalled();

    pendingTablesQuery.resolve([]);
    await flushPendingPromiseCallbacks();
    expect(findTablesWithSingleColumnUniqueIndex).toHaveBeenCalledTimes(1);
    expect(findTablesWithAutoIncrementPrimaryKey).not.toHaveBeenCalled();

    pendingUniqueIndexQuery.resolve(new Set());
    await expect(listTablesResult).resolves.toEqual([]);
    expect(findTablesWithAutoIncrementPrimaryKey).toHaveBeenCalledTimes(1);

    const fakeClient = onlyFakeKnexMySqlClientCreated();
    for (const discoveryQuery of [
      findAllTables,
      findTablesWithSingleColumnUniqueIndex,
      findTablesWithAutoIncrementPrimaryKey,
    ]) {
      expect(discoveryQuery).toHaveBeenCalledWith(fakeClient.knex, expect.anything());
    }
    expect(fakeClient.dispose).toHaveBeenCalledTimes(1);
  });

  it.each<[string, MySqlConnectionOptions, string | undefined]>([
    ['limits discovery to the configured database', CONNECTION_OPTIONS_SCOPED_TO_APPLICATION_DATABASE, 'app_db'],
    ['looks at every non-system database without one', CONNECTION_OPTIONS_WITHOUT_DATABASE, undefined],
  ])('%s', async (_label, connectionOptions, expectedOnlyDatabaseName) => {
    jest.mocked(findAllTables).mockResolvedValue([]);
    jest.mocked(findTablesWithSingleColumnUniqueIndex).mockResolvedValue(new Set());
    jest.mocked(findTablesWithAutoIncrementPrimaryKey).mockResolvedValue(new Set());

    await new MysqlConnector(connectionOptions).listTables();

    const expectedDiscoveryScope = {
      excludedDatabaseNames: MYSQL_SYSTEM_DATABASE_NAMES,
      onlyDatabaseName: expectedOnlyDatabaseName,
    };
    const fakeClient = onlyFakeKnexMySqlClientCreated();
    expect(findAllTables).toHaveBeenCalledWith(fakeClient.knex, expectedDiscoveryScope);
    expect(findTablesWithSingleColumnUniqueIndex).toHaveBeenCalledWith(fakeClient.knex, expectedDiscoveryScope);
    expect(findTablesWithAutoIncrementPrimaryKey).toHaveBeenCalledWith(fakeClient.knex, expectedDiscoveryScope);
  });

  it('feeds each lookup set into the right preview rule', async () => {
    jest.mocked(findAllTables).mockResolvedValue([ORDERS_TABLE_ROW, INVOICES_TABLE_ROW, ORDER_TOTALS_VIEW_ROW]);
    // Both tables are addressable; only `orders` has an AUTO_INCREMENT id.
    jest
      .mocked(findTablesWithSingleColumnUniqueIndex)
      .mockResolvedValue(
        new Set([
          buildMySqlTableLookupKey(APPLICATION_DATABASE_NAME, 'orders'),
          buildMySqlTableLookupKey(APPLICATION_DATABASE_NAME, 'invoices'),
        ]),
      );
    jest
      .mocked(findTablesWithAutoIncrementPrimaryKey)
      .mockResolvedValue(new Set([buildMySqlTableLookupKey(APPLICATION_DATABASE_NAME, 'orders')]));

    const [ordersPreview, invoicesPreview, orderTotalsPreview] =
      await buildConnectorScopedToApplicationDatabase().listTables();

    expect(ordersPreview.id.remoteId).toEqual([APPLICATION_DATABASE_NAME, 'orders']);
    expect(ordersPreview.disabled).toBeUndefined();
    expect(ordersPreview.disabledCreates).toBeUndefined();
    expect(invoicesPreview.disabled).toBeUndefined();
    expect(invoicesPreview).toMatchObject({
      disabledCreates: true,
      disabledReason: TABLE_WITHOUT_AUTO_INCREMENT_ID_CREATES_DISABLED_REASON,
    });
    expect(orderTotalsPreview).toMatchObject({ disabled: true, disabledReason: MYSQL_VIEW_DISABLED_REASON });
  });
});

describe('MysqlConnector.listCreateDestinations', () => {
  it('lists the visible non-system databases (scoped to the configured one) as create destinations', async () => {
    jest.mocked(findDatabaseNames).mockResolvedValue([APPLICATION_DATABASE_NAME]);

    const createDestinations = await buildConnectorScopedToApplicationDatabase().listCreateDestinations();

    expect(createDestinations).toEqual([
      { id: APPLICATION_DATABASE_NAME, name: APPLICATION_DATABASE_NAME, created: true },
    ]);
    expect(findDatabaseNames).toHaveBeenCalledWith(onlyFakeKnexMySqlClientCreated().knex, {
      excludedDatabaseNames: MYSQL_SYSTEM_DATABASE_NAMES,
      onlyDatabaseName: APPLICATION_DATABASE_NAME,
    });
  });
});

describe('MysqlConnector.fetchJsonTableSpec', () => {
  const ORDERS_ENTITY_ID: EntityId = { wsId: 'app_db__orders', remoteId: [APPLICATION_DATABASE_NAME, 'orders'] };
  const ORDERS_TABLE_REFERENCE: MySqlTableReference = { databaseName: APPLICATION_DATABASE_NAME, tableName: 'orders' };
  const NOTES_COLUMN = buildCatalogColumn({
    columnName: 'notes',
    dataType: 'longtext',
    columnType: 'longtext',
    ordinalPosition: 2,
  });

  function mockOrdersCatalog(): void {
    jest.mocked(findAllColumnsInTable).mockResolvedValue([ORDERS_TABLE_CATALOG_COLUMNS[0], NOTES_COLUMN]);
    jest.mocked(findPrimaryKeyColumnNames).mockResolvedValue(['id']);
    jest
      .mocked(findSingleColumnUniqueIndexColumns)
      .mockResolvedValue([
        buildPrimaryKeyUniqueIndexColumn({ columnName: 'id', nativeType: 'int unsigned', isAutoIncrement: true }),
      ]);
    jest.mocked(findSingleColumnForeignKeysInTable).mockResolvedValue([]);
    jest.mocked(findMariaDbJsonAliasColumnNames).mockResolvedValue(new Set(['notes']));
  }

  it.each<MySqlServerFlavor>(['mysql', 'tidb', 'vitess'])(
    'never runs the MariaDB JSON-alias query against %s',
    async (serverFlavor) => {
      serverFlavorReportedByNewFakeClients = serverFlavor;
      mockOrdersCatalog();

      const tableSpec = await buildConnectorScopedToApplicationDatabase().fetchJsonTableSpec(ORDERS_ENTITY_ID);

      const fakeClient = onlyFakeKnexMySqlClientCreated();
      expect(fakeClient.getServerFlavor).toHaveBeenCalledTimes(1);
      expect(findMariaDbJsonAliasColumnNames).not.toHaveBeenCalled();
      for (const catalogQuery of [
        findAllColumnsInTable,
        findPrimaryKeyColumnNames,
        findSingleColumnUniqueIndexColumns,
        findSingleColumnForeignKeysInTable,
      ]) {
        expect(catalogQuery).toHaveBeenCalledWith(fakeClient.knex, ORDERS_TABLE_REFERENCE);
      }
      expect(tableSpec.id).toBe(ORDERS_ENTITY_ID);
      expect(tableSpec.idPath).toBe('id');
      const notesColumnSchema = (tableSpec.schema.properties as Record<string, Record<string, unknown>>).notes;
      expect(notesColumnSchema[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe(PostgresColumnType.TEXT);
      expect(notesColumnSchema[X_SCRATCH_NATIVE_COLUMN_TYPE]).toMatchObject({ typeSystem: 'mysql', type: 'longtext' });
      expect(fakeClient.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it('asks MariaDB which columns are JSON documents and types them as JSON', async () => {
    serverFlavorReportedByNewFakeClients = 'mariadb';
    mockOrdersCatalog();

    const tableSpec = await buildConnectorScopedToApplicationDatabase().fetchJsonTableSpec(ORDERS_ENTITY_ID);

    expect(findMariaDbJsonAliasColumnNames).toHaveBeenCalledTimes(1);
    expect(findMariaDbJsonAliasColumnNames).toHaveBeenCalledWith(
      onlyFakeKnexMySqlClientCreated().knex,
      ORDERS_TABLE_REFERENCE,
    );
    const notesColumnSchema = (tableSpec.schema.properties as Record<string, Record<string, unknown>>).notes;
    expect(notesColumnSchema[X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe(PostgresColumnType.JSONB);
    expect(notesColumnSchema[X_SCRATCH_NATIVE_COLUMN_TYPE]).toMatchObject({ typeSystem: 'mysql', type: 'json' });
  });

  it("resolves a bare [table] remote id against the configured database, and refuses it when there isn't one", async () => {
    mockOrdersCatalog();
    const bareOrdersEntityId: EntityId = { wsId: 'orders', remoteId: ['orders'] };

    await buildConnectorScopedToApplicationDatabase().fetchJsonTableSpec(bareOrdersEntityId);
    expect(findAllColumnsInTable).toHaveBeenCalledWith(expect.anything(), ORDERS_TABLE_REFERENCE);

    await expect(
      new MysqlConnector(CONNECTION_OPTIONS_WITHOUT_DATABASE).fetchJsonTableSpec(bareOrdersEntityId),
    ).rejects.toMatchObject({ problem: MySqlClientProblem.TableNotFound });
    // Only the first (scoped) connector ever created a client.
    expect(fakeKnexMySqlClientsInCreationOrder).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------------------------------------------

describe('MysqlConnector.pullRecordFiles', () => {
  beforeEach(() => {
    mockIdAsTheOnlySingleColumnUniqueIndexColumn();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejects an unsafe filter before creating a client or running any query', async () => {
    const pullCallback = jest.fn();

    const pull = buildConnectorScopedToApplicationDatabase().pullRecordFiles(
      buildOrdersTableSpec(),
      pullCallback,
      {},
      { filter: "name = 'x'; DROP TABLE orders" },
    );

    await expect(pull).rejects.toBeInstanceOf(MySqlClientError);
    await expect(pull).rejects.toMatchObject({ problem: MySqlClientProblem.InvalidFilter });
    expect(KnexMySqlClient).not.toHaveBeenCalled();
    expect(findSingleColumnUniqueIndexColumns).not.toHaveBeenCalled();
    expect(selectTableRowsPage).not.toHaveBeenCalled();
    expect(pullCallback).not.toHaveBeenCalled();
  });

  it('rejects an unusable modifiedAtField before creating a client', async () => {
    const pull = buildConnectorScopedToApplicationDatabase().pullRecordFiles(
      buildOrdersTableSpec(),
      jest.fn(),
      {},
      { pullMode: 'incremental', modifiedAtField: 'shipped_on', since: new Date('2026-03-04T08:30:15.250Z') },
    );

    // A DATE column has no time of day, so it can't drive an incremental pull.
    await expect(pull).rejects.toMatchObject({ problem: MySqlClientProblem.InvalidModifiedAtField });
    expect(KnexMySqlClient).not.toHaveBeenCalled();
  });

  it('pages a full pull by the id column with the spec columns, trimmed filter and offsets, stopping on a short page', async () => {
    jest
      .mocked(selectTableRowsPage)
      .mockResolvedValueOnce(buildOrderRows(500, 1))
      .mockResolvedValueOnce(buildOrderRows(3, 501));
    const pullCallback = jest.fn(() => Promise.resolve());

    const pullResult = await buildConnectorScopedToApplicationDatabase().pullRecordFiles(
      buildOrdersTableSpec(),
      pullCallback,
      {},
      { filter: "   name = 'Widget' OR quantity > 2  " },
    );

    expect(pullResult).toEqual({});
    const fakeClient = onlyFakeKnexMySqlClientCreated();
    // One catalog lookup on the pull's own client decides whether the id column needs the duplicate-id check.
    expect(jest.mocked(findSingleColumnUniqueIndexColumns).mock.calls).toEqual([
      [fakeClient.knex, { databaseName: APPLICATION_DATABASE_NAME, tableName: 'orders' }],
    ]);
    expect(jest.mocked(selectTableRowsPage).mock.calls).toEqual([
      [
        fakeClient.knex,
        {
          table: { databaseName: APPLICATION_DATABASE_NAME, tableName: 'orders' },
          selectedColumnNames: ORDERS_TABLE_COLUMN_NAMES,
          idColumnName: 'id',
          pageSize: 500,
          pageOffset: 0,
          whereFilter: "name = 'Widget' OR quantity > 2",
          modifiedSince: undefined,
        },
      ],
      [fakeClient.knex, expect.objectContaining({ pageOffset: 500 })],
    ]);
    expect(pullCallback.mock.calls).toEqual([
      [{ files: buildOrderRows(500, 1), connectorProgress: { nextOffset: 500 } }],
      [{ files: buildOrderRows(3, 501), connectorProgress: { nextOffset: 503 } }],
    ]);
  });

  it('stops without a callback when a page comes back empty, and treats a blank filter as none', async () => {
    jest.mocked(selectTableRowsPage).mockResolvedValueOnce([]);
    const pullCallback = jest.fn();

    await buildConnectorScopedToApplicationDatabase().pullRecordFiles(
      buildOrdersTableSpec(),
      pullCallback,
      {},
      {
        filter: '   ',
      },
    );

    expect(selectTableRowsPage).toHaveBeenCalledTimes(1);
    expect(selectTableRowsPage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ whereFilter: undefined }),
    );
    expect(pullCallback).not.toHaveBeenCalled();
  });

  it('resumes from the checkpointed progress.nextOffset', async () => {
    jest.mocked(selectTableRowsPage).mockResolvedValueOnce(buildOrderRows(2, 1201));
    const pullCallback = jest.fn(() => Promise.resolve());

    await buildConnectorScopedToApplicationDatabase().pullRecordFiles(
      buildOrdersTableSpec(),
      pullCallback,
      { nextOffset: 1200 },
      {},
    );

    expect(selectTableRowsPage).toHaveBeenCalledTimes(1);
    expect(selectTableRowsPage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ pageOffset: 1200 }));
    expect(pullCallback).toHaveBeenCalledWith({
      files: buildOrderRows(2, 1201),
      connectorProgress: { nextOffset: 1202 },
    });
  });

  it('reads small pages from a table with a LONGBLOB column', async () => {
    jest.mocked(selectTableRowsPage).mockResolvedValueOnce([]);

    await buildConnectorScopedToApplicationDatabase().pullRecordFiles(
      buildAttachmentsTableSpecWithLongBlob(),
      jest.fn(),
      {},
      {},
    );

    expect(selectTableRowsPage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ pageSize: 50 }));
  });

  it('captures the watermark before the first query and bounds by the watermark minus 60s as a UTC literal', async () => {
    const pullStartedAt = new Date('2026-03-05T12:00:00.000Z');
    jest.useFakeTimers({
      now: pullStartedAt,
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    // The first page takes a while: rows changed during it must be re-pulled next time, so the watermark must be
    // the time BEFORE the query, not after it.
    jest.mocked(selectTableRowsPage).mockImplementationOnce(() => {
      jest.setSystemTime(new Date('2026-03-05T12:00:07.000Z'));
      return Promise.resolve(buildOrderRows(1, 1));
    });
    const previousPullWatermark = new Date('2026-03-04T08:30:15.250Z');

    const pullResult = await buildConnectorScopedToApplicationDatabase().pullRecordFiles(
      buildOrdersTableSpec(),
      jest.fn(() => Promise.resolve()),
      {},
      { pullMode: 'incremental', modifiedAtField: 'updated_at', since: previousPullWatermark },
    );

    expect(pullResult).toEqual({ newWatermark: pullStartedAt });
    expect(PG_INCREMENTAL_CLOCK_SKEW_MS).toBe(60_000);
    expect(selectTableRowsPage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        modifiedSince: { columnName: 'updated_at', exclusiveLowerBoundUtcLiteral: '2026-03-04 08:29:15.250000' },
      }),
    );
  });

  it('keeps the filter AND the incremental bound together', async () => {
    jest.mocked(selectTableRowsPage).mockResolvedValueOnce([]);

    await buildConnectorScopedToApplicationDatabase().pullRecordFiles(
      buildOrdersTableSpec(),
      jest.fn(),
      {},
      {
        pullMode: 'incremental',
        modifiedAtField: 'updated_at',
        since: new Date('2026-03-04T08:30:15.250Z'),
        filter: "name = 'a' OR name = 'b'",
      },
    );

    expect(selectTableRowsPage).toHaveBeenCalledTimes(1);
    expect(jest.mocked(selectTableRowsPage).mock.calls[0][1]).toMatchObject({
      whereFilter: "name = 'a' OR name = 'b'",
      modifiedSince: { columnName: 'updated_at' },
    });
  });

  it.each<[string, PullRecordFilesOptions]>([
    ['no since watermark yet', { pullMode: 'incremental', modifiedAtField: 'updated_at', since: null }],
    ['no modifiedAtField', { pullMode: 'incremental', since: new Date('2026-03-04T08:30:15.250Z') }],
    ['a full pull mode', { pullMode: 'full', modifiedAtField: 'updated_at', since: new Date('2026-03-04T08:30:15Z') }],
  ])('demotes to a full pull (no bound, no watermark) with %s', async (_label, pullOptions) => {
    jest.mocked(selectTableRowsPage).mockResolvedValueOnce([]);

    const pullResult = await buildConnectorScopedToApplicationDatabase().pullRecordFiles(
      buildOrdersTableSpec(),
      jest.fn(),
      {},
      pullOptions,
    );

    expect(pullResult).toEqual({});
    expect(selectTableRowsPage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ modifiedSince: undefined }),
    );
  });

  describe('duplicate-id guard for an ID field without a unique index', () => {
    /** Row data must never reach the message (job errors are stored and logged verbatim). */
    const REPEATED_ROW_VALUE_THAT_MUST_NOT_BE_QUOTED = 'Widget sold to jane@example.com';

    async function collectPulledPages(tableSpec: BaseJsonTableSpec): Promise<{
      pullOutcome: Promise<unknown>;
      pagesHandedToCallback: ConnectorFile[][];
    }> {
      const pagesHandedToCallback: ConnectorFile[][] = [];
      const pullOutcome = buildConnectorScopedToApplicationDatabase().pullRecordFiles(
        tableSpec,
        ({ files }) => {
          pagesHandedToCallback.push(files);
          return Promise.resolve();
        },
        {},
        {},
      );
      // Settle before asserting, and keep the rejection observable by the caller.
      await pullOutcome.catch(() => undefined);
      return { pullOutcome, pagesHandedToCallback };
    }

    it('fails with PulledDuplicateId when two rows of one page repeat the id, before that page is handed on', async () => {
      jest.mocked(selectTableRowsPage).mockResolvedValueOnce([
        { id: 1, name: 'Unique first' },
        { id: 2, name: REPEATED_ROW_VALUE_THAT_MUST_NOT_BE_QUOTED },
        { id: 3, name: REPEATED_ROW_VALUE_THAT_MUST_NOT_BE_QUOTED },
      ]);

      const { pullOutcome, pagesHandedToCallback } = await collectPulledPages(
        withIdFieldOverriddenTo(buildOrdersTableSpec(), 'name'),
      );

      const pullError = await readMySqlClientErrorRejection(pullOutcome);
      expect(pullError.problem).toBe(MySqlClientProblem.PulledDuplicateId);
      expect(pullError.errorCode).toBeUndefined();
      expect(pullError.message).toContain(`The ID field "name" isn't unique`);
      expect(pullError.message).toContain('Choose a column whose values are unique for every row');
      expect(pullError.userFriendlyMessage).toBe(pullError.message);
      expect(pullError.message).not.toContain(REPEATED_ROW_VALUE_THAT_MUST_NOT_BE_QUOTED);
      expect(pagesHandedToCallback).toEqual([]);
      // The failing client is still disposed.
      expect(onlyFakeKnexMySqlClientCreated().dispose).toHaveBeenCalledTimes(1);
    });

    it("catches a repeat across a page boundary by carrying the previous page's last id", async () => {
      const firstPageRows = Array.from({ length: 500 }, (_, rowIndex) => ({ id: rowIndex + 1, name: `n-${rowIndex}` }));
      jest
        .mocked(selectTableRowsPage)
        .mockResolvedValueOnce(firstPageRows)
        // The first row of page 2 repeats the last row of page 1 (e.g. `n-499` twice in a column ordered by name).
        .mockResolvedValueOnce([
          { id: 777, name: 'n-499' },
          { id: 501, name: 'n-500' },
        ]);

      const { pullOutcome, pagesHandedToCallback } = await collectPulledPages(
        withIdFieldOverriddenTo(buildOrdersTableSpec(), 'name'),
      );

      await expect(pullOutcome).rejects.toMatchObject({ problem: MySqlClientProblem.PulledDuplicateId });
      // Page 1 was fine and already delivered; page 2 never is.
      expect(pagesHandedToCallback).toEqual([firstPageRows]);
      expect(selectTableRowsPage).toHaveBeenCalledTimes(2);
    });

    it('treats several rows without an id (NULL) as a repeat: they would collapse into one record too', async () => {
      jest.mocked(selectTableRowsPage).mockResolvedValueOnce([
        { id: 1, name: null },
        { id: 2, name: null },
      ]);

      const { pullOutcome } = await collectPulledPages(withIdFieldOverriddenTo(buildOrdersTableSpec(), 'name'));

      const pullError = await readMySqlClientErrorRejection(pullOutcome);
      expect(pullError.problem).toBe(MySqlClientProblem.PulledDuplicateId);
      expect(pullError.message).toContain('have no value (NULL)');
    });

    it('compares integer ids by value, so the same number pulled as text and as a number is a repeat', async () => {
      // `quantity` is an INT column: its binding kind is `integer`, whose canonical text normalizes `'7'` and `7`.
      jest.mocked(selectTableRowsPage).mockResolvedValueOnce([
        { id: 1, quantity: 7 },
        { id: 2, quantity: '7' },
      ]);

      const { pullOutcome } = await collectPulledPages(withIdFieldOverriddenTo(buildOrdersTableSpec(), 'quantity'));

      await expect(pullOutcome).rejects.toMatchObject({ problem: MySqlClientProblem.PulledDuplicateId });
    });

    it('pulls an ID field without a unique index normally while its values stay distinct, across pages', async () => {
      const firstPageRows = Array.from({ length: 500 }, (_, rowIndex) => ({ id: rowIndex + 1, name: `n-${rowIndex}` }));
      const secondPageRows = [
        { id: 501, name: 'n-500' },
        { id: 502, name: null },
      ];
      jest.mocked(selectTableRowsPage).mockResolvedValueOnce(firstPageRows).mockResolvedValueOnce(secondPageRows);

      const { pullOutcome, pagesHandedToCallback } = await collectPulledPages(
        withIdFieldOverriddenTo(buildOrdersTableSpec(), 'name'),
      );

      await expect(pullOutcome).resolves.toEqual({});
      expect(pagesHandedToCallback).toEqual([firstPageRows, secondPageRows]);
      expect(selectTableRowsPage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ idColumnName: 'name' }),
      );
    });

    it('never checks a unique-indexed id: a row re-delivered across a page boundary by a concurrent insert must not fail the pull', async () => {
      // A row inserted before the current OFFSET mid-pull shifts every later row by one, so page 2 starts with
      // page 1's last row again. The pipeline keys files by id, so the re-delivery is harmless.
      const firstPageRows = buildOrderRows(500, 1);
      const secondPageRows = [{ id: 500, name: 'Order 499' }, ...buildOrderRows(2, 501)];
      jest.mocked(selectTableRowsPage).mockResolvedValueOnce(firstPageRows).mockResolvedValueOnce(secondPageRows);

      const { pullOutcome, pagesHandedToCallback } = await collectPulledPages(buildOrdersTableSpec());

      await expect(pullOutcome).resolves.toEqual({});
      expect(pagesHandedToCallback).toEqual([firstPageRows, secondPageRows]);
    });
  });
});

describe('MysqlConnector.pullRecordFilesByIds', () => {
  it('binds integer ids as BigInt, skips ids that cannot match an integer key, and batches 500 ids per query', async () => {
    const matchableIds = Array.from({ length: 1001 }, (_, idIndex) => String(idIndex + 1));
    const requestedIds = ['abc', ...matchableIds.slice(0, 10), '12abc', ...matchableIds.slice(10), '1.5'];
    jest
      .mocked(selectTableRowsByIds)
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 1001 }]);
    const pullCallback = jest.fn(() => Promise.resolve());

    await buildConnectorScopedToApplicationDatabase().pullRecordFilesByIds(
      buildOrdersTableSpec(),
      requestedIds,
      pullCallback,
    );

    const selectByIdsCalls = jest.mocked(selectTableRowsByIds).mock.calls;
    expect(selectByIdsCalls.map(([, request]) => request.idBindingValues.length)).toEqual([500, 500, 1]);
    const allBoundIdValues = selectByIdsCalls.flatMap(([, request]) => request.idBindingValues);
    expect(allBoundIdValues).toEqual(matchableIds.map((matchableId) => BigInt(matchableId)));
    const fakeClient = onlyFakeKnexMySqlClientCreated();
    expect(selectByIdsCalls[0]).toEqual([
      fakeClient.knex,
      expect.objectContaining({
        table: { databaseName: APPLICATION_DATABASE_NAME, tableName: 'orders' },
        selectedColumnNames: ORDERS_TABLE_COLUMN_NAMES,
        idColumnName: 'id',
      }),
    ]);
    // Only batches that found rows reach the callback.
    expect(pullCallback.mock.calls).toEqual([[{ files: [{ id: 1 }] }], [{ files: [{ id: 1001 }] }]]);
    expect(fakeClient.dispose).toHaveBeenCalledTimes(1);
  });

  it('binds text ids as strings and binary ids as the decoded bytes', async () => {
    jest.mocked(selectTableRowsByIds).mockResolvedValue([]);
    const connector = buildConnectorScopedToApplicationDatabase();

    await connector.pullRecordFilesByIds(buildCustomersTableSpecWithTextId(), ['CUST-1', '007'], jest.fn());
    await connector.pullRecordFilesByIds(
      buildDevicesTableSpecWithBinaryId(),
      [Buffer.from('device-0001').toString('base64'), 'not base64!'],
      jest.fn(),
    );

    const [textIdCall, binaryIdCall] = jest.mocked(selectTableRowsByIds).mock.calls;
    expect(textIdCall[1].idBindingValues).toEqual(['CUST-1', '007']);
    expect(binaryIdCall[1].idBindingValues).toEqual([Buffer.from('device-0001')]);
  });

  it('fails with PulledDuplicateId when one id matches several rows (an ID field that is not unique)', async () => {
    jest.mocked(selectTableRowsByIds).mockResolvedValueOnce([
      { id: 1, name: 'Widget' },
      { id: 2, name: 'Widget' },
    ]);
    const pullCallback = jest.fn(() => Promise.resolve());

    const pullByIds = buildConnectorScopedToApplicationDatabase().pullRecordFilesByIds(
      withIdFieldOverriddenTo(buildOrdersTableSpec(), 'name'),
      ['Widget'],
      pullCallback,
    );

    const pullByIdsError = await readMySqlClientErrorRejection(pullByIds);
    expect(pullByIdsError.problem).toBe(MySqlClientProblem.PulledDuplicateId);
    expect(pullByIdsError.message).toContain(`The ID field "name" isn't unique`);
    expect(pullCallback).not.toHaveBeenCalled();
    // By-id pulls need no catalog lookup: one SELECT is a consistent snapshot, so any repeat in it is real.
    expect(findSingleColumnUniqueIndexColumns).not.toHaveBeenCalled();
  });

  it('accepts the same row returned by two batches (an id asked for twice), checking repeats per batch only', async () => {
    const requestedIds = ['1', ...Array.from({ length: 499 }, (_, idIndex) => String(idIndex + 2)), '1'];
    jest
      .mocked(selectTableRowsByIds)
      .mockResolvedValueOnce([{ id: 1, name: 'Widget' }])
      .mockResolvedValueOnce([{ id: 1, name: 'Widget' }]);
    const pullCallback = jest.fn(() => Promise.resolve());

    await buildConnectorScopedToApplicationDatabase().pullRecordFilesByIds(
      buildOrdersTableSpec(),
      requestedIds,
      pullCallback,
    );

    expect(selectTableRowsByIds).toHaveBeenCalledTimes(2);
    expect(pullCallback.mock.calls).toEqual([
      [{ files: [{ id: 1, name: 'Widget' }] }],
      [{ files: [{ id: 1, name: 'Widget' }] }],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Create / update / delete
// ---------------------------------------------------------------------------------------------------------------

describe('MysqlConnector record writes', () => {
  const ORDERS_WRITE_TARGET = {
    databaseName: APPLICATION_DATABASE_NAME,
    tableName: 'orders',
    primaryKeyColumnName: 'id',
    primaryKeyBindingKind: 'integer',
    readBackColumnNames: ORDERS_TABLE_COLUMN_NAMES,
  };

  it('creates records with the write target from the spec and values prepared for MySQL', async () => {
    const persistedRow = { id: 41, name: 'Widget', quantity: null, settings: { color: 'red' } };
    jest.mocked(insertRecordsReturningPersistedRows).mockResolvedValue([persistedRow]);
    const recordToCreate: ConnectorFile = {
      name: 'Widget',
      quantity: '',
      settings: { color: 'red' },
      updated_at: '2026-03-05T14:30:00.123456Z',
      shipped_on: '2026-03-05',
    };

    const createdRecords = await buildConnectorScopedToApplicationDatabase().createRecords(buildOrdersTableSpec(), [
      recordToCreate,
    ]);

    expect(createdRecords).toEqual([persistedRow]);
    expect(insertRecordsReturningPersistedRows).toHaveBeenCalledWith(
      onlyFakeKnexMySqlClientCreated().knex,
      ORDERS_WRITE_TARGET,
      [
        {
          name: 'Widget',
          // '' can't be stored in an INT under strict mode: it is written as NULL.
          quantity: null,
          // JSON documents are serialized (mysql2 would bind an object as '[object Object]').
          settings: '{"color":"red"}',
          // An instant becomes the UTC wall clock, truncated to the column precision.
          updated_at: '2026-03-05 14:30:00.123',
          shipped_on: '2026-03-05',
        },
      ],
    );
    // The caller's file is never mutated.
    expect(recordToCreate.quantity).toBe('');
  });

  it('refuses a value for a column pulled in a non-writable representation before connecting', async () => {
    const creation = buildConnectorScopedToApplicationDatabase().createRecords(buildOrdersTableSpec(), [
      { name: 'Widget', photo: Buffer.from('png bytes').toString('base64') },
    ]);

    await expect(creation).rejects.toBeInstanceOf(NonWritableFieldEditError);
    expect(KnexMySqlClient).not.toHaveBeenCalled();
    expect(insertRecordsReturningPersistedRows).not.toHaveBeenCalled();
  });

  it('refuses a malformed temporal value before connecting', async () => {
    const creation = buildConnectorScopedToApplicationDatabase().createRecords(buildOrdersTableSpec(), [
      { name: 'Widget', shipped_on: '2026-03-05T14:30:00Z' },
    ]);

    await expect(creation).rejects.toMatchObject({ problem: MySqlClientProblem.InvalidTemporalValue });
    expect(KnexMySqlClient).not.toHaveBeenCalled();
  });

  it('updates with the WHOLE top-level value of each sparse changed field, never the sparse diff', async () => {
    jest.mocked(updateRecordsByPrimaryKeyReturningPersistedRows).mockResolvedValue([{ id: 7 }, { id: 8 }]);
    const editedFiles: ConnectorFile[] = [
      { id: 7, name: 'Gadget', quantity: 3, settings: { color: 'blue', size: 'L', tags: ['a'] } },
      { id: 8, name: 'Gizmo', quantity: 5 },
    ];
    // The pipeline's changedFields is a deep sparse diff: only `settings.color` changed on record 7.
    const sparseChangedFields: (Record<string, unknown> | undefined)[] = [{ settings: { color: 'blue' } }, undefined];

    const updatedRecords = await buildConnectorScopedToApplicationDatabase().updateRecords(
      buildOrdersTableSpec(),
      editedFiles,
      sparseChangedFields,
    );

    expect(updatedRecords).toEqual([{ id: 7 }, { id: 8 }]);
    expect(updateRecordsByPrimaryKeyReturningPersistedRows).toHaveBeenCalledWith(
      onlyFakeKnexMySqlClientCreated().knex,
      ORDERS_WRITE_TARGET,
      [
        { recordId: 7, changedColumnValues: { settings: '{"color":"blue","size":"L","tags":["a"]}' } },
        // No changedFields: every column of the file except the id.
        { recordId: 8, changedColumnValues: { name: 'Gizmo', quantity: 5 } },
      ],
    );
  });

  describe('an edited id column', () => {
    /** `customers` is keyed by a VARCHAR the user can edit (it isn't AUTO_INCREMENT, so it isn't read-only). */
    const customerFileWithEditedId: ConnectorFile = { customer_code: 'CUST-B', display_name: 'Edited A' };

    it('rejects a partial change set that edits the id before creating a client (IdColumnEdited, no errorCode)', async () => {
      // Record CUST-A's file now says CUST-B: `UPDATE … WHERE customer_code = 'CUST-B'` would overwrite CUST-B's row.
      const update = buildConnectorScopedToApplicationDatabase().updateRecords(
        buildCustomersTableSpecWithTextId(),
        [customerFileWithEditedId],
        [{ customer_code: 'CUST-B' }],
      );

      const updateError = await readMySqlClientErrorRejection(update);
      expect(updateError.problem).toBe(MySqlClientProblem.IdColumnEdited);
      // Not RemoteRecordNotFound: the row still exists, so "run a full sync" wouldn't help.
      expect(updateError.errorCode).toBeUndefined();
      expect(updateError.message).toContain('The ID field "customer_code" was edited');
      expect(updateError.message).toContain('Revert the edit.');
      expect(updateError.userFriendlyMessage).toBe(updateError.message);
      expect(KnexMySqlClient).not.toHaveBeenCalled();
      expect(updateRecordsByPrimaryKeyReturningPersistedRows).not.toHaveBeenCalled();
    });

    it("rejects the whole batch when any record's partial change set edits the id (the runner retries per record)", async () => {
      const update = buildConnectorScopedToApplicationDatabase().updateRecords(
        buildOrdersTableSpec(),
        [
          { id: 7, name: 'Unchanged id' },
          { id: 99, name: 'Edited id', quantity: 1 },
        ],
        [{ name: 'Unchanged id' }, { id: 99, name: 'Edited id' }],
      );

      const updateError = await readMySqlClientErrorRejection(update);
      expect(updateError.problem).toBe(MySqlClientProblem.IdColumnEdited);
      expect(updateError.message).toContain('The ID field "id" was edited');
      expect(KnexMySqlClient).not.toHaveBeenCalled();
    });

    it("updates a whole-record change set (the pipeline's fallback when the published copy is unreadable) by the file's id", async () => {
      jest
        .mocked(updateRecordsByPrimaryKeyReturningPersistedRows)
        .mockResolvedValue([{ customer_code: 'CUST-A', display_name: 'Renamed' }]);
      const customerFile: ConnectorFile = { customer_code: 'CUST-A', display_name: 'Renamed' };

      const updatedRecords = await buildConnectorScopedToApplicationDatabase().updateRecords(
        buildCustomersTableSpecWithTextId(),
        [customerFile],
        // Every key of the file, the id included: the fallback can't say whether the id changed, so it isn't refused.
        [{ ...customerFile }],
      );

      expect(updatedRecords).toEqual([{ customer_code: 'CUST-A', display_name: 'Renamed' }]);
      expect(updateRecordsByPrimaryKeyReturningPersistedRows).toHaveBeenCalledWith(
        onlyFakeKnexMySqlClientCreated().knex,
        expect.objectContaining({ primaryKeyColumnName: 'customer_code', primaryKeyBindingKind: 'text' }),
        [{ recordId: 'CUST-A', changedColumnValues: { display_name: 'Renamed' } }],
      );
    });
  });

  it('deletes by the id column and skips the client entirely for an empty batch', async () => {
    jest.mocked(deleteRecordsByPrimaryKey).mockResolvedValue({ deletedRowCount: 2 });
    const connector = buildConnectorScopedToApplicationDatabase();

    await connector.deleteRecords(buildOrdersTableSpec(), []);
    expect(KnexMySqlClient).not.toHaveBeenCalled();

    await connector.deleteRecords(buildOrdersTableSpec(), [{ id: 7, name: 'Gadget' }, { id: '9007199254740993' }]);
    expect(deleteRecordsByPrimaryKey).toHaveBeenCalledWith(onlyFakeKnexMySqlClientCreated().knex, ORDERS_WRITE_TARGET, [
      7,
      '9007199254740993',
    ]);
  });

  it.each<[string, () => BaseJsonTableSpec, string, string]>([
    ['a VARCHAR id', buildCustomersTableSpecWithTextId, 'customer_code', 'text'],
    ['a BINARY(16) id', buildDevicesTableSpecWithBinaryId, 'device_uuid', 'base64Binary'],
  ])(
    'derives the id binding kind of %s from its native type annotation',
    async (_label, buildTableSpec, expectedPrimaryKeyColumnName, expectedPrimaryKeyBindingKind) => {
      jest.mocked(deleteRecordsByPrimaryKey).mockResolvedValue({ deletedRowCount: 1 });
      const tableSpec = buildTableSpec();

      await buildConnectorScopedToApplicationDatabase().deleteRecords(tableSpec, [
        { [expectedPrimaryKeyColumnName]: 'some-id' },
      ]);

      expect(deleteRecordsByPrimaryKey).toHaveBeenCalledWith(
        expect.anything(),
        {
          databaseName: APPLICATION_DATABASE_NAME,
          tableName: tableSpec.name,
          primaryKeyColumnName: expectedPrimaryKeyColumnName,
          primaryKeyBindingKind: expectedPrimaryKeyBindingKind,
          readBackColumnNames: Object.keys(tableSpec.schema.properties as Record<string, unknown>),
        },
        ['some-id'],
      );
    },
  );

  describe('getBatchSize', () => {
    const originalLocalPublishBatchSize = process.env[LOCAL_MYSQL_PUBLISH_BATCH_SIZE_ENV];

    afterEach(() => {
      if (originalLocalPublishBatchSize === undefined) {
        delete process.env[LOCAL_MYSQL_PUBLISH_BATCH_SIZE_ENV];
      } else {
        process.env[LOCAL_MYSQL_PUBLISH_BATCH_SIZE_ENV] = originalLocalPublishBatchSize;
      }
    });

    it.each<[string, string | undefined, number]>([
      ['defaults to 100 without an override', undefined, 100],
      ['honours LOCAL_MYSQL_PUBLISH_BATCH_SIZE', '7', 7],
      ['ignores a non-numeric override', 'lots', 100],
      ['ignores a zero override', '0', 100],
    ])('%s', (_label, localPublishBatchSize, expectedBatchSize) => {
      expect(LOCAL_MYSQL_PUBLISH_BATCH_SIZE_ENV).toBe('LOCAL_MYSQL_PUBLISH_BATCH_SIZE');
      if (localPublishBatchSize === undefined) {
        delete process.env[LOCAL_MYSQL_PUBLISH_BATCH_SIZE_ENV];
      } else {
        process.env[LOCAL_MYSQL_PUBLISH_BATCH_SIZE_ENV] = localPublishBatchSize;
      }
      const connector = buildConnectorScopedToApplicationDatabase();

      expect(connector.getBatchSize('create')).toBe(expectedBatchSize);
      expect(connector.getBatchSize('update')).toBe(expectedBatchSize);
      expect(connector.getBatchSize('delete')).toBe(expectedBatchSize);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Schema creation
// ---------------------------------------------------------------------------------------------------------------

const CUSTOMERS_TABLE_REFERENCE: MySqlTableReference = {
  databaseName: APPLICATION_DATABASE_NAME,
  tableName: 'customers',
};

function buildTextField(name: string): CreateFieldSpec {
  return { name, fieldType: { kind: 'text' } };
}

function buildForeignKeyField(name: string, targetRemoteTableId: string[], allowMultiple?: boolean): CreateFieldSpec {
  return {
    name,
    fieldType: {
      kind: 'foreignKey',
      target: { existingRemoteTableId: targetRemoteTableId },
      ...(allowMultiple !== undefined ? { allowMultiple } : {}),
    },
  };
}

function buildResolvedForeignKeyToCustomers(): MySqlForeignKeyResolution {
  return {
    kind: 'resolved',
    targetTable: CUSTOMERS_TABLE_REFERENCE,
    targetColumnName: 'id',
    foreignKeyColumnTypeDefinition: 'bigint unsigned',
  };
}

describe('MysqlConnector.createTable', () => {
  function buildCreateTablePlan(overrides: Partial<NormalizedCreateTablePlan>): NormalizedCreateTablePlan {
    return {
      ref: 'orders-ref',
      name: 'Orders',
      remoteParentId: [APPLICATION_DATABASE_NAME],
      fields: [buildTextField('title'), buildTextField('notes')],
      deferredFkFields: [],
      ...overrides,
    };
  }

  it.each<[string, MySqlConnectionOptions, Partial<NormalizedCreateTablePlan>, string]>([
    [
      'no database is chosen or configured',
      CONNECTION_OPTIONS_WITHOUT_DATABASE,
      { remoteParentId: undefined },
      'Choose a database to create the table in.',
    ],
    [
      'the database is a system database',
      CONNECTION_OPTIONS_WITHOUT_DATABASE,
      { remoteParentId: ['mysql'] },
      '"mysql" is a MySQL system database; choose another database.',
    ],
    [
      'the database is outside the one the connection is limited to',
      CONNECTION_OPTIONS_SCOPED_TO_APPLICATION_DATABASE,
      { remoteParentId: ['analytics'] },
      'This connection is limited to the "app_db" database, so the table can\'t be created in "analytics".',
    ],
    [
      'the table name ends with a space',
      CONNECTION_OPTIONS_SCOPED_TO_APPLICATION_DATABASE,
      { name: 'Orders ' },
      'the table name "Orders " ends with a space, which MySQL doesn\'t allow in a name — remove the trailing space in the plan',
    ],
    [
      'the table name is longer than 64 characters',
      CONNECTION_OPTIONS_SCOPED_TO_APPLICATION_DATABASE,
      { name: 'o'.repeat(65) },
      `the table name "${'o'.repeat(65)}" is 65 characters long; MySQL allows at most 64 — shorten it in the plan`,
    ],
  ])(
    'fails every field without connecting when %s',
    async (_label, connectionOptions, planOverrides, expectedError) => {
      const plan = buildCreateTablePlan(planOverrides);

      const createTableResult = await new MysqlConnector(connectionOptions).createTable(plan);

      expect(createTableResult).toEqual({
        ref: 'orders-ref',
        name: plan.name,
        status: 'failed',
        fields: [
          { name: 'title', status: 'failed' },
          { name: 'notes', status: 'failed' },
        ],
        error: expectedError,
      });
      expect(KnexMySqlClient).not.toHaveBeenCalled();
    },
  );

  it('creates the table in the configured database when the plan names no parent, reporting the stored names', async () => {
    const storedOrdersTable: MySqlTableReference = { databaseName: APPLICATION_DATABASE_NAME, tableName: 'orders' };
    jest
      .mocked(createTableWithAutoIncrementPrimaryKey)
      .mockResolvedValue({ skipReasonByFieldName: new Map(), storedTable: storedOrdersTable });

    const createTableResult = await buildConnectorScopedToApplicationDatabase().createTable(
      buildCreateTablePlan({ remoteParentId: undefined }),
    );

    expect(createTableWithAutoIncrementPrimaryKey).toHaveBeenCalledWith(
      onlyFakeKnexMySqlClientCreated(),
      { databaseName: APPLICATION_DATABASE_NAME, tableName: 'Orders' },
      [buildTextField('title'), buildTextField('notes')],
    );
    // lower_case_table_names: the remote id is MySQL's stored spelling, so it equals listTables' remote id.
    expect(createTableResult).toEqual({
      ref: 'orders-ref',
      name: 'orders',
      status: 'created',
      remoteTableId: [APPLICATION_DATABASE_NAME, 'orders'],
      fields: [
        { name: 'title', status: 'created', remoteFieldId: 'title' },
        { name: 'notes', status: 'created', remoteFieldId: 'notes' },
      ],
    });
  });

  it('resolves every foreign-key target before any DDL, then adds each foreign key to the stored table on its own', async () => {
    const storedOrdersTable: MySqlTableReference = { databaseName: APPLICATION_DATABASE_NAME, tableName: 'orders' };
    jest
      .mocked(createTableWithAutoIncrementPrimaryKey)
      .mockResolvedValue({ skipReasonByFieldName: new Map(), storedTable: storedOrdersTable });
    jest.mocked(resolveForeignKeyReferenceForTargetTable).mockResolvedValue(buildResolvedForeignKeyToCustomers());
    jest.mocked(addForeignKeyColumnWithConstraint).mockResolvedValue(undefined);
    const customerForeignKeyField = buildForeignKeyField('customer', [APPLICATION_DATABASE_NAME, 'customers']);
    const billedToForeignKeyField = buildForeignKeyField('billed_to', [APPLICATION_DATABASE_NAME, 'customers']);

    const createTableResult = await buildConnectorScopedToApplicationDatabase().createTable(
      buildCreateTablePlan({
        fields: [buildTextField('title'), customerForeignKeyField, billedToForeignKeyField],
      }),
    );

    const fakeClient = onlyFakeKnexMySqlClientCreated();
    expect(resolveForeignKeyReferenceForTargetTable).toHaveBeenCalledTimes(2);
    expect(resolveForeignKeyReferenceForTargetTable).toHaveBeenCalledWith(fakeClient.knex, CUSTOMERS_TABLE_REFERENCE);
    const lastForeignKeyResolutionOrder = Math.max(
      ...jest.mocked(resolveForeignKeyReferenceForTargetTable).mock.invocationCallOrder,
    );
    expect(lastForeignKeyResolutionOrder).toBeLessThan(
      jest.mocked(createTableWithAutoIncrementPrimaryKey).mock.invocationCallOrder[0],
    );
    // Foreign keys are never part of the CREATE TABLE.
    expect(createTableWithAutoIncrementPrimaryKey).toHaveBeenCalledWith(fakeClient, expect.anything(), [
      buildTextField('title'),
    ]);
    expect(jest.mocked(addForeignKeyColumnWithConstraint).mock.calls).toEqual([
      [fakeClient, storedOrdersTable, customerForeignKeyField, buildResolvedForeignKeyToCustomers()],
      [fakeClient, storedOrdersTable, billedToForeignKeyField, buildResolvedForeignKeyToCustomers()],
    ]);
    expect(createTableResult.status).toBe('created');
  });

  it('reports partial with a prefixed skip for an unresolvable target and a failure for a rejected constraint', async () => {
    jest.mocked(createTableWithAutoIncrementPrimaryKey).mockResolvedValue({
      skipReasonByFieldName: new Map([['photo', 'binary columns are not supported']]),
      storedTable: { databaseName: APPLICATION_DATABASE_NAME, tableName: 'orders' },
    });
    jest
      .mocked(resolveForeignKeyReferenceForTargetTable)
      .mockImplementation((_knex, targetTable) =>
        Promise.resolve(
          targetTable.tableName === 'customers'
            ? buildResolvedForeignKeyToCustomers()
            : { kind: 'unresolvable', reason: 'the linked table "app_db"."ghosts" doesn\'t exist' },
        ),
      );
    jest.mocked(addForeignKeyColumnWithConstraint).mockRejectedValue(
      buildFakeMySqlServerError({
        errno: 3780,
        code: 'ER_FK_INCOMPATIBLE_COLUMNS',
        sqlState: 'HY000',
        sqlMessage: "Referencing column 'customer' and referenced column 'id' are incompatible.",
      }),
    );

    const createTableResult = await buildConnectorScopedToApplicationDatabase().createTable(
      buildCreateTablePlan({
        fields: [
          buildTextField('title'),
          buildTextField('photo'),
          buildForeignKeyField('customer', [APPLICATION_DATABASE_NAME, 'customers']),
          buildForeignKeyField('ghost', [APPLICATION_DATABASE_NAME, 'ghosts']),
          buildForeignKeyField('tags', [APPLICATION_DATABASE_NAME, 'customers'], true),
        ],
      }),
    );

    expect(createTableResult.status).toBe('partial');
    expect(createTableResult.remoteTableId).toEqual([APPLICATION_DATABASE_NAME, 'orders']);
    const [titleResult, photoResult, customerResult, ghostResult, tagsResult] = createTableResult.fields;
    expect(titleResult).toEqual({ name: 'title', status: 'created', remoteFieldId: 'title' });
    expect(photoResult).toEqual({ name: 'photo', status: 'skipped', error: 'binary columns are not supported' });
    expect(customerResult.status).toBe('failed');
    expect(customerResult.error).toMatch(/^Couldn't create foreign key "customer" on "app_db"\."orders": /);
    expect(ghostResult).toEqual({
      name: 'ghost',
      status: 'skipped',
      error: 'couldn\'t create foreign key "ghost": the linked table "app_db"."ghosts" doesn\'t exist',
    });
    expect(tagsResult.status).toBe('skipped');
    expect(tagsResult.error).toContain('allowMultiple');
    // allowMultiple is refused without asking the database about its target.
    expect(resolveForeignKeyReferenceForTargetTable).toHaveBeenCalledTimes(2);
    expect(addForeignKeyColumnWithConstraint).toHaveBeenCalledTimes(1);
  });

  it('skips a foreign key whose target was never resolved to an existing table, without querying', async () => {
    jest.mocked(createTableWithAutoIncrementPrimaryKey).mockResolvedValue({
      skipReasonByFieldName: new Map(),
      storedTable: { databaseName: APPLICATION_DATABASE_NAME, tableName: 'orders' },
    });
    const pendingForeignKeyField: CreateFieldSpec = {
      name: 'account',
      fieldType: { kind: 'foreignKey', target: { ref: 'accounts-ref' } },
    };

    const createTableResult = await buildConnectorScopedToApplicationDatabase().createTable(
      buildCreateTablePlan({ fields: [buildTextField('title'), pendingForeignKeyField] }),
    );

    expect(resolveForeignKeyReferenceForTargetTable).not.toHaveBeenCalled();
    expect(createTableResult.status).toBe('partial');
    expect(createTableResult.fields[1]).toEqual({
      name: 'account',
      status: 'skipped',
      error: 'couldn\'t create foreign key "account": its target was not resolved to an existing table',
    });
  });

  it('fails the whole table with a clear message when the table already exists (1050)', async () => {
    jest.mocked(createTableWithAutoIncrementPrimaryKey).mockRejectedValue(
      buildFakeMySqlServerError({
        errno: 1050,
        code: 'ER_TABLE_EXISTS_ERROR',
        sqlState: '42S01',
        sqlMessage: "Table 'Orders' already exists",
        sql: 'create table `app_db`.`Orders` (`id` bigint unsigned not null auto_increment primary key)',
      }),
    );

    const createTableResult = await buildConnectorScopedToApplicationDatabase().createTable(buildCreateTablePlan({}));

    expect(createTableResult.status).toBe('failed');
    expect(createTableResult.fields.every((fieldResult) => fieldResult.status === 'failed')).toBe(true);
    expect(createTableResult.error).toContain('A table named "Orders" already exists in the "app_db" database.');
    expect(createTableResult.error).not.toMatch(/create table/i);
    expect(onlyFakeKnexMySqlClientCreated().dispose).toHaveBeenCalledTimes(1);
  });
});

describe('MysqlConnector.createFields', () => {
  const ORDERS_REMOTE_TABLE_ID = [APPLICATION_DATABASE_NAME, 'orders'];
  const ORDERS_TABLE_REFERENCE: MySqlTableReference = { databaseName: APPLICATION_DATABASE_NAME, tableName: 'orders' };

  it('adds each field with its own statement so one failure never affects the others', async () => {
    jest
      .mocked(addNonForeignKeyColumn)
      .mockRejectedValueOnce(
        buildFakeMySqlServerError({
          errno: 1060,
          code: 'ER_DUP_FIELDNAME',
          sqlState: '42S21',
          sqlMessage: "Duplicate column name 'title'",
        }),
      )
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ skipReason: 'multiSelect fields are not supported' });
    jest.mocked(resolveForeignKeyReferenceForTargetTable).mockResolvedValue(buildResolvedForeignKeyToCustomers());
    jest.mocked(addForeignKeyColumnWithConstraint).mockResolvedValue(undefined);
    const fieldsPlan: NormalizedCreateFieldsPlan = {
      remoteTableId: ORDERS_REMOTE_TABLE_ID,
      fields: [
        buildTextField('title'),
        buildTextField('notes'),
        buildTextField('labels'),
        buildForeignKeyField('parent_order', [APPLICATION_DATABASE_NAME, 'customers']),
      ],
    };

    const createFieldResults = await buildConnectorScopedToApplicationDatabase().createFields(fieldsPlan);

    expect(createFieldResults).toEqual([
      { name: 'title', status: 'failed', error: 'A column named "title" already exists on "app_db"."orders".' },
      { name: 'notes', status: 'created', remoteFieldId: 'notes' },
      { name: 'labels', status: 'skipped', error: 'multiSelect fields are not supported' },
      { name: 'parent_order', status: 'created', remoteFieldId: 'parent_order' },
    ]);
    const fakeClient = onlyFakeKnexMySqlClientCreated();
    expect(jest.mocked(addNonForeignKeyColumn).mock.calls.map(([client, table]) => [client, table])).toEqual([
      [fakeClient, ORDERS_TABLE_REFERENCE],
      [fakeClient, ORDERS_TABLE_REFERENCE],
      [fakeClient, ORDERS_TABLE_REFERENCE],
    ]);
    expect(addForeignKeyColumnWithConstraint).toHaveBeenCalledWith(
      fakeClient,
      ORDERS_TABLE_REFERENCE,
      fieldsPlan.fields[3],
      buildResolvedForeignKeyToCustomers(),
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Error details
// ---------------------------------------------------------------------------------------------------------------

describe('MysqlConnector.extractConnectorErrorDetails', () => {
  const CLIENT_IP_IN_SERVER_MESSAGE = '203.0.113.77';

  function buildWrongPasswordServerError(): Error {
    return buildFakeMySqlServerError({
      errno: 1045,
      code: 'ER_ACCESS_DENIED_ERROR',
      sqlState: '28000',
      sqlMessage: `Access denied for user 'scratch_app'@'${CLIENT_IP_IN_SERVER_MESSAGE}' (using password: YES)`,
      sql: 'select `id`, `name` from `app_db`.`orders` order by `id` asc limit 500',
    });
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('delegates to describeMySqlError with the connection context and the flavor the last operation detected', async () => {
    const describeMySqlErrorSpy = jest.spyOn(mysqlErrorMappingModule, 'describeMySqlError');
    serverFlavorReportedByNewFakeClients = 'mariadb';
    const connector = new MysqlConnector({ ...CONNECTION_OPTIONS_SCOPED_TO_APPLICATION_DATABASE, sslMode: 'DISABLED' });
    await connector.testConnection();
    const wrongPasswordServerError = buildWrongPasswordServerError();

    const errorDetails = connector.extractConnectorErrorDetails(wrongPasswordServerError);

    expect(describeMySqlErrorSpy).toHaveBeenCalledWith(wrongPasswordServerError, {
      host: 'db.example.com',
      port: 3306,
      databaseName: APPLICATION_DATABASE_NAME,
      sslMode: 'DISABLED',
      serverFlavor: 'mariadb',
      statementTimeoutMs: MOCKED_MYSQL_STATEMENT_TIMEOUT_MS,
    });
    expect(errorDetails).toEqual(describeMySqlErrorSpy.mock.results[0].value);
    // The DISABLED context reaches the message: it adds the TLS hint.
    expect(errorDetails.userFriendlyMessage).toBe(mysqlErrorMappingModule.buildMySqlAccessDeniedMessage('DISABLED'));
  });

  it("never leaks the server's message, the client IP or the SQL for a wrong-password error", () => {
    const errorDetails = buildConnectorScopedToApplicationDatabase().extractConnectorErrorDetails(
      buildWrongPasswordServerError(),
    );

    expect(errorDetails.userFriendlyMessage).toBe(mysqlErrorMappingModule.buildMySqlAccessDeniedMessage('REQUIRED'));
    const everythingUserFacing = `${errorDetails.userFriendlyMessage}\n${errorDetails.description ?? ''}`;
    for (const leakedFragment of [CLIENT_IP_IN_SERVER_MESSAGE, 'Access denied for user', 'using password', 'select']) {
      expect(everythingUserFacing).not.toContain(leakedFragment);
    }
    expect(JSON.stringify(errorDetails.additionalContext ?? {})).not.toContain(CLIENT_IP_IN_SERVER_MESSAGE);
  });

  it('passes connector-raised errors through unchanged', () => {
    const invalidFilterError = new MySqlClientError(MySqlClientProblem.InvalidFilter, 'That filter is not allowed.');

    expect(buildConnectorScopedToApplicationDatabase().extractConnectorErrorDetails(invalidFilterError)).toMatchObject({
      userFriendlyMessage: 'That filter is not allowed.',
    });
  });
});
