/**
 * Unit tests for the connection half of the MySQL knex client: the allowlisted mysql2 option object, the
 * per-connection session setup (against a fake raw connection), and the knex pool / provider wiring (against a
 * mocked knex). No database, no driver connection.
 */
interface CapturedKnexConfig {
  client: unknown;
  connection: () => Promise<Record<string, unknown>>;
  compileSqlOnError: boolean;
  acquireConnectionTimeout: number;
  pool: {
    min: number;
    max: number;
    createTimeoutMillis: number;
    afterCreate: (rawConnection: unknown, done: (error: unknown, connection: unknown) => void) => void;
  };
}

const capturedKnexConfigs: CapturedKnexConfig[] = [];
const mockedKnexRaw = jest.fn();
const mockedKnexDestroy = jest.fn().mockResolvedValue(undefined);
const mockedKnexInstance = Object.assign(jest.fn(), {
  raw: mockedKnexRaw,
  destroy: mockedKnexDestroy,
  client: {
    alias: (first: string, second: string) => `${first} as ${second}`,
    config: {} as { wrapIdentifier?: unknown },
  },
});

jest.mock('knex', () => ({
  __esModule: true,
  default: jest.fn((config: CapturedKnexConfig) => {
    capturedKnexConfigs.push(config);
    return mockedKnexInstance;
  }),
}));

import { WSLogger } from 'src/logger';
import {
  buildMySql2ConnectionConfig,
  initializeMySqlSession,
  KnexMySqlClient,
  MYSQL_ACQUIRE_CONNECTION_TIMEOUT_MS,
  MYSQL_CONNECT_TIMEOUT_MS,
  MYSQL_POOL_CREATE_TIMEOUT_MS,
  MYSQL_SESSION_SQL_MODE,
  MYSQL_STATEMENT_TIMEOUT_MS,
  type MySqlRawQueryableConnection,
} from '../knex-mysql-client';
import { MySqlClientError, MySqlClientProblem } from '../mysql-client-error';
import { type MySql2SslOptions } from '../mysql-driver-ssl-options';
import { rejoinKnexAliasSplitMySqlIdentifier } from '../mysql-identifier-quoting';
import { ScratchMySql2KnexDialectClient } from '../mysql-knex-dialect-client';
import { type MySqlTypeCastField } from '../mysql-row-value-decoder';
import { type MySqlConnectionOptions } from '../mysql-types';

const connectionOptions: MySqlConnectionOptions = {
  host: 'db.example.com',
  port: 3307,
  databaseName: 'shop',
  username: 'scratch',
  password: 'p@ss:w/rd?',
  sslMode: 'REQUIRED',
};

function mysqlServerError(errno: number, code: string): Error {
  return Object.assign(new Error(`server error ${errno}`), { errno, code });
}

function mysqlNetworkError(code: string): Error {
  return Object.assign(new Error(`network error ${code}`), { code, fatal: true });
}

type FakeQueryResponse = { rows: unknown } | { error: Error };

/** A raw mysql2 callback connection that answers each statement from `respondToStatement`, asynchronously. */
function createFakeRawMySqlConnection(respondToStatement: (sql: string) => FakeQueryResponse) {
  const executedStatements: string[] = [];
  const rawConnection = {
    query: jest.fn((sql: string, callback: (error: unknown, rows?: unknown) => void) => {
      executedStatements.push(sql);
      const response = respondToStatement(sql);
      setImmediate(() => ('error' in response ? callback(response.error) : callback(null, response.rows)));
    }),
    destroy: jest.fn(),
  } satisfies MySqlRawQueryableConnection;
  return { rawConnection, executedStatements };
}

function respondAsServer(
  serverVersion: string,
  failingStatements: Record<string, Error> = {},
): (sql: string) => FakeQueryResponse {
  return (sql) => {
    const failingStatementPrefix = Object.keys(failingStatements).find((statementPrefix) =>
      sql.startsWith(statementPrefix),
    );
    if (failingStatementPrefix !== undefined) return { error: failingStatements[failingStatementPrefix] };
    if (sql.startsWith('SELECT VERSION()')) return { rows: [{ server_version: serverVersion }] };
    return { rows: { affectedRows: 0 } };
  };
}

const EXPECTED_SESSION_TIME_ZONE_AND_SQL_MODE_STATEMENT = `SET SESSION time_zone = '+00:00', SESSION sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'`;

describe('buildMySql2ConnectionConfig', () => {
  const sslOptions: MySql2SslOptions = { rejectUnauthorized: false };

  it('builds only the allowlisted mysql2 options', () => {
    const mysql2ConnectionConfig = buildMySql2ConnectionConfig({
      connectionOptions,
      mysql2SslOptions: sslOptions,
      networkRoute: {},
    });
    expect(Object.keys(mysql2ConnectionConfig).sort()).toEqual(
      [
        'bigNumberStrings',
        'connectAttributes',
        'connectTimeout',
        'database',
        'dateStrings',
        'decimalNumbers',
        'disableEval',
        'flags',
        'host',
        'multipleStatements',
        'port',
        'ssl',
        'supportBigNumbers',
        'timezone',
        'typeCast',
        'user',
      ].sort(),
    );
  });

  it('never sets a URL, a socket path, LOCAL INFILE support, cleartext auth, custom auth plugins or debug', () => {
    const mysql2ConnectionConfig = buildMySql2ConnectionConfig({
      connectionOptions,
      mysql2SslOptions: sslOptions,
      networkRoute: {},
    }) as Record<string, unknown>;
    for (const forbiddenOptionName of [
      'uri',
      'socketPath',
      'localAddress',
      'infileStreamFactory',
      'enableCleartextPlugin',
      'authPlugins',
      'debug',
      'stream',
    ]) {
      expect(mysql2ConnectionConfig).not.toHaveProperty(forbiddenOptionName);
    }
    expect(mysql2ConnectionConfig.multipleStatements).toBe(false);
    expect(mysql2ConnectionConfig.flags).toEqual(['FOUND_ROWS', '-LOCAL_FILES']);
  });

  it('decodes values as strings and in UTC', () => {
    const mysql2ConnectionConfig = buildMySql2ConnectionConfig({
      connectionOptions,
      mysql2SslOptions: sslOptions,
      networkRoute: {},
    });
    expect(mysql2ConnectionConfig).toMatchObject({
      host: 'db.example.com',
      port: 3307,
      user: 'scratch',
      database: 'shop',
      connectTimeout: MYSQL_CONNECT_TIMEOUT_MS,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      dateStrings: true,
      timezone: 'Z',
    });
    expect(MYSQL_CONNECT_TIMEOUT_MS).toBe(10_000);
  });

  it('keeps the password readable by mysql2 but non-enumerable, so it never leaks through a serialized config', () => {
    const mysql2ConnectionConfig = buildMySql2ConnectionConfig({
      connectionOptions,
      mysql2SslOptions: sslOptions,
      networkRoute: {},
    });
    expect(mysql2ConnectionConfig.password).toBe('p@ss:w/rd?');
    expect(Object.getOwnPropertyDescriptor(mysql2ConnectionConfig, 'password')?.enumerable).toBe(false);
    expect(Object.keys(mysql2ConnectionConfig)).not.toContain('password');
    expect(JSON.stringify(mysql2ConnectionConfig)).not.toContain('p@ss:w/rd?');
  });

  it('omits the database when the connection lists every database', () => {
    const mysql2ConnectionConfig = buildMySql2ConnectionConfig({
      connectionOptions: { ...connectionOptions, databaseName: undefined },
      mysql2SslOptions: sslOptions,
      networkRoute: {},
    });
    expect(mysql2ConnectionConfig).not.toHaveProperty('database');
  });

  it('passes the ssl object through by reference, and omits ssl entirely for DISABLED', () => {
    expect(buildMySql2ConnectionConfig({ connectionOptions, mysql2SslOptions: sslOptions, networkRoute: {} }).ssl).toBe(
      sslOptions,
    );
    expect(
      buildMySql2ConnectionConfig({ connectionOptions, mysql2SslOptions: undefined, networkRoute: {} }),
    ).not.toHaveProperty('ssl');
  });

  it('sets a stream factory only when the network route provides one, keeping host as the hostname', () => {
    const createPinnedSocket = jest.fn();
    const mysql2ConnectionConfig = buildMySql2ConnectionConfig({
      connectionOptions,
      mysql2SslOptions: sslOptions,
      networkRoute: { createPinnedSocket },
    });
    expect(mysql2ConnectionConfig.stream).toBe(createPinnedSocket);
    expect(mysql2ConnectionConfig.host).toBe('db.example.com');
  });

  it('routes typeCast through the row value decoder', () => {
    const mysql2ConnectionConfig = buildMySql2ConnectionConfig({
      connectionOptions,
      mysql2SslOptions: sslOptions,
      networkRoute: {},
    });
    const timestampField: MySqlTypeCastField = {
      type: 'TIMESTAMP',
      length: 26,
      db: 'shop',
      name: 'updated_at',
      string: () => '2026-01-02 03:04:05.123456',
      buffer: () => null,
    };
    const readDefaultValue = jest.fn();
    const typeCast = mysql2ConnectionConfig.typeCast as (field: MySqlTypeCastField, next: () => unknown) => unknown;
    expect(typeCast(timestampField, readDefaultValue)).toBe('2026-01-02T03:04:05.123456Z');
    expect(readDefaultValue).not.toHaveBeenCalled();
  });
});

describe('initializeMySqlSession', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(WSLogger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('detects MySQL, pins time zone and sql_mode, and sets max_execution_time in milliseconds', async () => {
    const { rawConnection, executedStatements } = createFakeRawMySqlConnection(respondAsServer('8.4.11'));
    await expect(initializeMySqlSession(rawConnection, { statementTimeoutMs: 300_000 })).resolves.toEqual({
      serverVersion: '8.4.11',
      serverFlavor: 'mysql',
      appliedStatementTimeoutVariable: 'max_execution_time',
    });
    expect(executedStatements).toEqual([
      'SELECT VERSION() AS server_version',
      EXPECTED_SESSION_TIME_ZONE_AND_SQL_MODE_STATEMENT,
      'SET SESSION max_execution_time = 300000',
    ]);
    expect(rawConnection.destroy).not.toHaveBeenCalled();
  });

  it('detects MariaDB and sets max_statement_time in seconds', async () => {
    const { rawConnection, executedStatements } = createFakeRawMySqlConnection(
      respondAsServer('11.4.13-MariaDB-ubu2404'),
    );
    await expect(initializeMySqlSession(rawConnection, { statementTimeoutMs: 1_500 })).resolves.toEqual({
      serverVersion: '11.4.13-MariaDB-ubu2404',
      serverFlavor: 'mariadb',
      appliedStatementTimeoutVariable: 'max_statement_time',
    });
    expect(executedStatements[2]).toBe('SET SESSION max_statement_time = 1.5');
  });

  it('never enables NO_BACKSLASH_ESCAPES or ANSI_QUOTES (client-side escaping depends on both being off)', () => {
    expect(MYSQL_SESSION_SQL_MODE).not.toMatch(/NO_BACKSLASH_ESCAPES|ANSI_QUOTES/);
    expect(MYSQL_SESSION_SQL_MODE).toContain('STRICT_TRANS_TABLES');
  });

  it('falls back to the other timeout variable when the server rejects the first (flavor hidden behind a proxy)', async () => {
    const { rawConnection, executedStatements } = createFakeRawMySqlConnection(
      respondAsServer('8.0.35', {
        'SET SESSION max_execution_time': mysqlServerError(1193, 'ER_UNKNOWN_SYSTEM_VARIABLE'),
      }),
    );
    await expect(initializeMySqlSession(rawConnection, { statementTimeoutMs: 300_000 })).resolves.toMatchObject({
      appliedStatementTimeoutVariable: 'max_statement_time',
    });
    expect(executedStatements.slice(2)).toEqual([
      'SET SESSION max_execution_time = 300000',
      'SET SESSION max_statement_time = 300',
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('continues without a server-side timeout (and warns) when the server rejects both variables', async () => {
    const { rawConnection } = createFakeRawMySqlConnection(
      respondAsServer('8.0.11-TiDB-v7.5.0', {
        'SET SESSION max_execution_time': mysqlServerError(1193, 'ER_UNKNOWN_SYSTEM_VARIABLE'),
        'SET SESSION max_statement_time': mysqlServerError(1193, 'ER_UNKNOWN_SYSTEM_VARIABLE'),
      }),
    );
    await expect(initializeMySqlSession(rawConnection, { statementTimeoutMs: 300_000 })).resolves.toEqual({
      serverVersion: '8.0.11-TiDB-v7.5.0',
      serverFlavor: 'tidb',
      appliedStatementTimeoutVariable: 'none',
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('rethrows a network error from the timeout statement instead of trying the other variable', async () => {
    const lostConnectionError = mysqlNetworkError('PROTOCOL_CONNECTION_LOST');
    const { rawConnection, executedStatements } = createFakeRawMySqlConnection(
      respondAsServer('8.4.11', { 'SET SESSION max_execution_time': lostConnectionError }),
    );
    await expect(initializeMySqlSession(rawConnection, { statementTimeoutMs: 300_000 })).rejects.toBe(
      lostConnectionError,
    );
    expect(executedStatements).toHaveLength(3);
  });

  it('fails with SessionSetupFailed (naming only the errno) when the time zone / sql_mode cannot be set', async () => {
    const unknownTimeZoneError = mysqlServerError(1298, 'ER_UNKNOWN_TIME_ZONE');
    const { rawConnection, executedStatements } = createFakeRawMySqlConnection(
      respondAsServer('8.4.11', { 'SET SESSION time_zone': unknownTimeZoneError }),
    );
    const sessionSetupFailure = await initializeMySqlSession(rawConnection, { statementTimeoutMs: 300_000 }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(sessionSetupFailure).toBeInstanceOf(MySqlClientError);
    expect((sessionSetupFailure as MySqlClientError).problem).toBe(MySqlClientProblem.SessionSetupFailed);
    expect((sessionSetupFailure as MySqlClientError).userFriendlyMessage).toContain('(error 1298)');
    expect((sessionSetupFailure as MySqlClientError).userFriendlyMessage).not.toContain('server error');
    expect((sessionSetupFailure as MySqlClientError).cause).toBe(unknownTimeZoneError);
    expect(executedStatements).toHaveLength(2);
  });

  it('rethrows a connection drop during the time zone / sql_mode statement unchanged (a network failure, not a setup problem)', async () => {
    const connectionDropError = mysqlNetworkError('ECONNRESET');
    const { rawConnection } = createFakeRawMySqlConnection(
      respondAsServer('8.4.11', { 'SET SESSION time_zone': connectionDropError }),
    );
    await expect(initializeMySqlSession(rawConnection, { statementTimeoutMs: 300_000 })).rejects.toBe(
      connectionDropError,
    );
  });

  it('propagates a failing version query unchanged', async () => {
    const versionQueryError = mysqlNetworkError('ECONNRESET');
    const { rawConnection } = createFakeRawMySqlConnection(
      respondAsServer('', { 'SELECT VERSION()': versionQueryError }),
    );
    await expect(initializeMySqlSession(rawConnection, { statementTimeoutMs: 300_000 })).rejects.toBe(
      versionQueryError,
    );
  });

  it('treats a missing version as MySQL', async () => {
    const { rawConnection } = createFakeRawMySqlConnection((sql) =>
      sql.startsWith('SELECT VERSION()') ? { rows: [] } : { rows: {} },
    );
    await expect(initializeMySqlSession(rawConnection, { statementTimeoutMs: 300_000 })).resolves.toMatchObject({
      serverVersion: '',
      serverFlavor: 'mysql',
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects the statement timeout %p before running any statement',
    async (statementTimeoutMs) => {
      const { rawConnection } = createFakeRawMySqlConnection(respondAsServer('8.4.11'));
      await expect(initializeMySqlSession(rawConnection, { statementTimeoutMs })).rejects.toThrow(
        'MySQL statement timeout must be a positive integer',
      );
      expect(rawConnection.query).not.toHaveBeenCalled();
    },
  );
});

describe('KnexMySqlClient (knex mocked)', () => {
  const resolveNetworkRoute = jest.fn().mockResolvedValue({});

  beforeEach(() => {
    jest.clearAllMocks();
    capturedKnexConfigs.length = 0;
    mockedKnexInstance.client.config = {};
  });

  function constructClient(): { client: KnexMySqlClient; knexConfig: CapturedKnexConfig } {
    const client = new KnexMySqlClient(connectionOptions, { resolveNetworkRoute });
    const knexConfig = capturedKnexConfigs[capturedKnexConfigs.length - 1];
    if (!knexConfig) throw new Error('knex was not constructed');
    return { client, knexConfig };
  }

  function runAfterCreate(
    knexConfig: CapturedKnexConfig,
    rawConnection: MySqlRawQueryableConnection,
  ): Promise<{ error: unknown; connection: unknown }> {
    return new Promise((resolve) => {
      knexConfig.pool.afterCreate(rawConnection, (error, connection) => resolve({ error, connection }));
    });
  }

  it('creates a single-connection pool with the injected mysql2 dialect and quiet error SQL', () => {
    const { knexConfig } = constructClient();
    expect(knexConfig.client).toBe(ScratchMySql2KnexDialectClient);
    expect(knexConfig.compileSqlOnError).toBe(false);
    expect(knexConfig.acquireConnectionTimeout).toBe(MYSQL_ACQUIRE_CONNECTION_TIMEOUT_MS);
    expect(knexConfig.pool).toMatchObject({ min: 0, max: 1, createTimeoutMillis: MYSQL_POOL_CREATE_TIMEOUT_MS });
    expect(MYSQL_POOL_CREATE_TIMEOUT_MS).toBeGreaterThan(MYSQL_CONNECT_TIMEOUT_MS);
    expect(MYSQL_ACQUIRE_CONNECTION_TIMEOUT_MS).toBeGreaterThan(MYSQL_POOL_CREATE_TIMEOUT_MS);
  });

  it('installs the verbatim identifier hooks on the knex instance', () => {
    constructClient();
    expect(typeof mockedKnexInstance.client.config.wrapIdentifier).toBe('function');
    expect(mockedKnexInstance.client.alias).toBe(rejoinKnexAliasSplitMySqlIdentifier);
  });

  it('resolves the network route and rebuilds the options for every physical connection', async () => {
    const { knexConfig } = constructClient();
    const firstConnectionConfig = await knexConfig.connection();
    const secondConnectionConfig = await knexConfig.connection();
    expect(resolveNetworkRoute).toHaveBeenCalledTimes(2);
    expect(resolveNetworkRoute).toHaveBeenCalledWith({ host: 'db.example.com', port: 3307 });
    expect(secondConnectionConfig).not.toBe(firstConnectionConfig);
    // One ssl object per client: reconnects within the operation reuse it; it's never shared across clients.
    expect(secondConnectionConfig.ssl).toBe(firstConnectionConfig.ssl);
    expect(firstConnectionConfig.ssl).toEqual({ rejectUnauthorized: false });
    // knex re-calls the provider only when it returns an expiration checker saying "expired".
    expect((firstConnectionConfig.expirationChecker as () => boolean)()).toBe(true);
    expect(Object.keys(firstConnectionConfig)).not.toContain('password');
    expect(firstConnectionConfig.password).toBe('p@ss:w/rd?');
  });

  it('gives every client its own ssl object', async () => {
    const firstClientConfig = await constructClient().knexConfig.connection();
    const secondClientConfig = await constructClient().knexConfig.connection();
    expect(secondClientConfig.ssl).not.toBe(firstClientConfig.ssl);
  });

  it('propagates a refused network route from the provider', async () => {
    const networkRouteRefusal = new Error('network route refused');
    resolveNetworkRoute.mockRejectedValueOnce(networkRouteRefusal);
    const { knexConfig } = constructClient();
    await expect(knexConfig.connection()).rejects.toBe(networkRouteRefusal);
  });

  it('records the detected flavor after a successful session setup', async () => {
    const { client, knexConfig } = constructClient();
    const { rawConnection } = createFakeRawMySqlConnection(respondAsServer('11.4.13-MariaDB'));
    const afterCreateOutcome = await runAfterCreate(knexConfig, rawConnection);
    expect(afterCreateOutcome).toEqual({ error: null, connection: rawConnection });
    expect(client.detectedServerFlavor).toBe('mariadb');
    expect(client.detectedServerVersion).toBe('11.4.13-MariaDB');
    await expect(client.getServerFlavor()).resolves.toBe('mariadb');
    expect(mockedKnexRaw).not.toHaveBeenCalled();
  });

  it('destroys the raw connection before reporting a failed session setup to the pool', async () => {
    const { knexConfig } = constructClient();
    const { rawConnection } = createFakeRawMySqlConnection(
      respondAsServer('8.4.11', { 'SET SESSION time_zone': mysqlServerError(1298, 'ER_UNKNOWN_TIME_ZONE') }),
    );
    const destroyCallOrder: string[] = [];
    rawConnection.destroy.mockImplementation(() => destroyCallOrder.push('destroy'));
    const afterCreateOutcome = await new Promise<{ error: unknown }>((resolve) => {
      knexConfig.pool.afterCreate(rawConnection, (error) => {
        destroyCallOrder.push('done');
        resolve({ error });
      });
    });
    expect(destroyCallOrder).toEqual(['destroy', 'done']);
    expect(afterCreateOutcome.error).toBeInstanceOf(MySqlClientError);
  });

  it('connects once (SELECT 1) to learn the flavor when nothing has connected yet', async () => {
    const { client } = constructClient();
    mockedKnexRaw.mockResolvedValueOnce([[{ 1: 1 }], []]);
    await expect(client.getServerFlavor()).resolves.toBe('mysql');
    expect(mockedKnexRaw).toHaveBeenCalledWith('SELECT 1');
  });

  it("unwraps knex's [rows, fields] raw result in testQuery", async () => {
    const { client } = constructClient();
    mockedKnexRaw.mockResolvedValueOnce([[{ current_database_name: 'shop', server_version: '8.4.11' }], []]);
    await expect(client.testQuery()).resolves.toEqual({
      currentDatabaseName: 'shop',
      serverVersion: '8.4.11',
      serverFlavor: 'mysql',
    });
  });

  it('bounds metadata-lock waits before DDL and lifts MariaDB statement timeouts, tolerating server errors', async () => {
    const { client, knexConfig } = constructClient();
    await runAfterCreate(knexConfig, createFakeRawMySqlConnection(respondAsServer('11.4.13-MariaDB')).rawConnection);
    mockedKnexRaw.mockRejectedValueOnce(mysqlServerError(1227, 'ER_SPECIFIC_ACCESS_DENIED_ERROR'));
    mockedKnexRaw.mockResolvedValueOnce([[], []]);
    await expect(client.prepareSessionForSchemaChanges()).resolves.toBeUndefined();
    expect(mockedKnexRaw.mock.calls.map(([sql]) => sql as string)).toEqual([
      'SET SESSION lock_wait_timeout = 5',
      'SET SESSION max_statement_time = 0',
    ]);
  });

  it('rethrows a network error while preparing for DDL', async () => {
    const { client, knexConfig } = constructClient();
    await runAfterCreate(knexConfig, createFakeRawMySqlConnection(respondAsServer('8.4.11')).rawConnection);
    const lostConnectionError = mysqlNetworkError('PROTOCOL_CONNECTION_LOST');
    mockedKnexRaw.mockRejectedValueOnce(lostConnectionError);
    await expect(client.prepareSessionForSchemaChanges()).rejects.toBe(lostConnectionError);
  });

  it('destroys the knex pool on dispose', async () => {
    const { client } = constructClient();
    await client.dispose();
    expect(mockedKnexDestroy).toHaveBeenCalledTimes(1);
  });

  it('uses the default five-minute statement timeout', () => {
    expect(MYSQL_STATEMENT_TIMEOUT_MS).toBe(300_000);
  });
});
