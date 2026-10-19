/**
 * A short-lived knex client for one MySQL-protocol database (MySQL, MariaDB, TiDB, Vitess/PlanetScale, ...).
 * Created per connector operation and disposed afterwards (pool max 1) — never one per batch: every customer
 * database connection egresses through Scratch's shared Cloud NAT port budget.
 *
 * This file owns the connection lifecycle only: the allowlisted mysql2 options, the per-connection session setup
 * and flavor detection. Queries live in the catalog / record-read / record-write / schema-creation modules, which
 * take `client.knex`.
 *
 * Security properties (see the connector's STATE.md and the feasibility analysis on DEV-12035):
 * - mysql2 never sees a URL or a user-controlled option: the option object is built from an explicit allowlist
 *   ({@link buildMySql2ConnectionConfig}). mysql2's own URL parser would JSON-parse every query parameter into
 *   driver options (socketPath, multipleStatements, flags, ...).
 * - LOCAL INFILE is disabled (`-LOCAL_FILES`) and multi-statements are off.
 * - Every session gets an explicit `sql_mode` WITHOUT `NO_BACKSLASH_ESCAPES` / `ANSI_QUOTES`: mysql2 escapes bound
 *   strings with backslashes on the client, so a customer's `NO_BACKSLASH_ESCAPES` would turn `\'` back into a
 *   string terminator (SQL injection). `STRICT_TRANS_TABLES` makes bad writes fail instead of being truncated.
 * - `compileSqlOnError: false` keeps bound values out of knex's error messages (the error mapper never reads
 *   `error.message` anyway).
 * - The connection is described by an async provider so the future database host guard re-vets the host on every
 *   physical connection ({@link resolveMySqlNetworkRoute}).
 */
import knex, { type Knex } from 'knex';
import { type ConnectionOptions as MySql2ConnectionOptions } from 'mysql2';
import { WSLogger } from 'src/logger';
import { MySqlClientError, MySqlClientProblem } from './mysql-client-error';
import { buildMySql2SslOptions, type MySql2SslOptions } from './mysql-driver-ssl-options';
import { applyMySqlVerbatimIdentifierQuoting } from './mysql-identifier-quoting';
import { ScratchMySql2KnexDialectClient } from './mysql-knex-dialect-client';
import { type MySqlNetworkRoute, resolveMySqlNetworkRoute, type ResolveMySqlNetworkRoute } from './mysql-network-route';
import { decodeMySqlColumnValue } from './mysql-row-value-decoder';
import { classifyMySqlServerFlavor, type MySqlServerFlavor } from './mysql-server-flavor';
import { type MySqlConnectionOptions } from './mysql-types';

export const MYSQL_CONNECT_TIMEOUT_MS = 10_000;
/** Above mysql2's connect timeout so the real connect / TLS error surfaces instead of knex's generic pool timeout. */
export const MYSQL_POOL_CREATE_TIMEOUT_MS = 20_000;
export const MYSQL_ACQUIRE_CONNECTION_TIMEOUT_MS = 30_000;
/** Server-side statement timeout: allows OFFSET scans of large tables and unindexed filters, kills runaway queries. */
export const MYSQL_STATEMENT_TIMEOUT_MS = 300_000;
export const MYSQL_SESSION_TIME_ZONE = '+00:00';
export const MYSQL_SESSION_SQL_MODE = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
/** Before DDL: don't queue behind (and in front of) a customer's metadata lock for long. */
export const MYSQL_DDL_LOCK_WAIT_TIMEOUT_SECONDS = 5;

export type MySqlStatementTimeoutVariable = 'max_execution_time' | 'max_statement_time';

export interface MySqlConnectionTestResult {
  readonly currentDatabaseName: string | null;
  readonly serverVersion: string;
  readonly serverFlavor: MySqlServerFlavor;
}

export interface KnexMySqlClientDependencies {
  /** Defaults to {@link resolveMySqlNetworkRoute}; tests inject their own. */
  readonly resolveNetworkRoute?: ResolveMySqlNetworkRoute;
  readonly statementTimeoutMs?: number;
}

/** The minimal raw mysql2 (callback) connection surface the session setup needs, so tests can fake it. */
export interface MySqlRawQueryableConnection {
  query(sql: string, callback: (error: unknown, rows?: unknown) => void): unknown;
  destroy(): void;
}

export interface MySqlSessionInitializationResult {
  readonly serverVersion: string;
  readonly serverFlavor: MySqlServerFlavor;
  readonly appliedStatementTimeoutVariable: MySqlStatementTimeoutVariable | 'none';
}

/**
 * The ONLY place a mysql2 option object is built. Never sets `uri`, `socketPath`, `localAddress`,
 * `infileStreamFactory`, `enableCleartextPlugin`, `authPlugins`, `multipleStatements: true` or `debug`.
 * `password` is non-enumerable so it can't leak through a logged / serialized config.
 */
export function buildMySql2ConnectionConfig(params: {
  connectionOptions: MySqlConnectionOptions;
  mysql2SslOptions: MySql2SslOptions | undefined;
  networkRoute: MySqlNetworkRoute;
}): MySql2ConnectionOptions {
  const { connectionOptions, mysql2SslOptions, networkRoute } = params;
  const mysql2ConnectionConfig: MySql2ConnectionOptions = {
    host: connectionOptions.host,
    port: connectionOptions.port,
    user: connectionOptions.username,
    ...(connectionOptions.databaseName !== undefined ? { database: connectionOptions.databaseName } : {}),
    ...(mysql2SslOptions ? { ssl: mysql2SslOptions } : {}),
    ...(networkRoute.createPinnedSocket ? { stream: networkRoute.createPinnedSocket } : {}),
    connectTimeout: MYSQL_CONNECT_TIMEOUT_MS,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    dateStrings: true,
    timezone: 'Z',
    typeCast: (field, readDefaultValue) => decodeMySqlColumnValue(field, readDefaultValue),
    flags: ['FOUND_ROWS', '-LOCAL_FILES'],
    multipleStatements: false,
    disableEval: true,
    connectAttributes: { program_name: 'scratch' },
  };
  Object.defineProperty(mysql2ConnectionConfig, 'password', {
    value: connectionOptions.password,
    enumerable: false,
  });
  return mysql2ConnectionConfig;
}

function runRawQuery(rawConnection: MySqlRawQueryableConnection, sql: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    rawConnection.query(sql, (error, rows) =>
      error ? reject(error instanceof Error ? error : new Error('MySQL session query failed')) : resolve(rows),
    );
  });
}

/** A MySQL server error (has an errno) as opposed to a network / protocol failure. */
function isMySqlServerError(error: unknown): error is { errno: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { errno?: unknown }).errno === 'number' &&
    (error as { errno: number }).errno > 0
  );
}

function statementTimeoutAssignment(variable: MySqlStatementTimeoutVariable, statementTimeoutMs: number): string {
  // MySQL: milliseconds, SELECT only. MariaDB: seconds (double), every statement.
  const value = variable === 'max_execution_time' ? statementTimeoutMs : statementTimeoutMs / 1000;
  return `SET SESSION ${variable} = ${value}`;
}

/**
 * Per-connection session setup, run by the pool's `afterCreate` on the raw mysql2 connection. Built only from
 * constants. Throws (after which the caller destroys the connection) when the time zone / sql_mode can't be set:
 * reads and writes depend on both. A statement-timeout variable the server doesn't know (flavor mis-detected behind
 * a proxy, TiDB/Vitess) is retried with the other variable, then logged and skipped.
 */
export async function initializeMySqlSession(
  rawConnection: MySqlRawQueryableConnection,
  options: { statementTimeoutMs: number },
): Promise<MySqlSessionInitializationResult> {
  if (!Number.isSafeInteger(options.statementTimeoutMs) || options.statementTimeoutMs <= 0) {
    throw new Error('MySQL statement timeout must be a positive integer number of milliseconds');
  }
  const versionRows = (await runRawQuery(rawConnection, 'SELECT VERSION() AS server_version')) as {
    server_version?: unknown;
  }[];
  const reportedServerVersion = versionRows?.[0]?.server_version;
  const serverVersion = typeof reportedServerVersion === 'string' ? reportedServerVersion : '';
  const serverFlavor = classifyMySqlServerFlavor(serverVersion);

  try {
    await runRawQuery(
      rawConnection,
      `SET SESSION time_zone = '${MYSQL_SESSION_TIME_ZONE}', SESSION sql_mode = '${MYSQL_SESSION_SQL_MODE}'`,
    );
  } catch (error) {
    // A network drop is a connection failure, not a session-setup problem: let the error mapper describe it.
    if (!isMySqlServerError(error)) throw error;
    const errno = ` (error ${error.errno})`;
    throw new MySqlClientError(
      MySqlClientProblem.SessionSetupFailed,
      `Scratch couldn't prepare the MySQL session (time zone and SQL mode)${errno}.`,
      { cause: error },
    );
  }

  const preferredStatementTimeoutVariable: MySqlStatementTimeoutVariable =
    serverFlavor === 'mariadb' ? 'max_statement_time' : 'max_execution_time';
  const fallbackStatementTimeoutVariable: MySqlStatementTimeoutVariable =
    preferredStatementTimeoutVariable === 'max_execution_time' ? 'max_statement_time' : 'max_execution_time';
  for (const statementTimeoutVariable of [preferredStatementTimeoutVariable, fallbackStatementTimeoutVariable]) {
    try {
      await runRawQuery(
        rawConnection,
        statementTimeoutAssignment(statementTimeoutVariable, options.statementTimeoutMs),
      );
      return { serverVersion, serverFlavor, appliedStatementTimeoutVariable: statementTimeoutVariable };
    } catch (error) {
      if (!isMySqlServerError(error)) throw error;
    }
  }
  WSLogger.warn({
    source: 'KnexMySqlClient',
    message: 'MySQL server accepted neither statement timeout variable; continuing without a server-side timeout',
    serverFlavor,
  });
  return { serverVersion, serverFlavor, appliedStatementTimeoutVariable: 'none' };
}

export class KnexMySqlClient {
  readonly knex: Knex;
  private detectedServerFlavorValue: MySqlServerFlavor | undefined;
  private detectedServerVersionValue: string | undefined;

  constructor(
    private readonly connectionOptions: MySqlConnectionOptions,
    dependencies?: KnexMySqlClientDependencies,
  ) {
    const resolveNetworkRoute = dependencies?.resolveNetworkRoute ?? resolveMySqlNetworkRoute;
    const statementTimeoutMs = dependencies?.statementTimeoutMs ?? MYSQL_STATEMENT_TIMEOUT_MS;
    // One ssl object per client (never shared across accounts, never frozen): reconnects within this operation
    // reuse mysql2's SecureContext.
    const mysql2SslOptions = buildMySql2SslOptions(connectionOptions.sslMode, connectionOptions.sslCaCertificatePem);

    this.knex = knex({
      client: ScratchMySql2KnexDialectClient,
      // A provider (function) instead of a static object: knex calls it for every new physical connection because
      // it returns `expirationChecker: () => true` (knex deletes that key before mysql2 sees it).
      connection: async () => {
        const networkRoute = await resolveNetworkRoute({ host: connectionOptions.host, port: connectionOptions.port });
        const mysql2ConnectionConfig = buildMySql2ConnectionConfig({
          connectionOptions,
          mysql2SslOptions,
          networkRoute,
        });
        return Object.assign(mysql2ConnectionConfig, { expirationChecker: () => true }) as Knex.StaticConnectionConfig;
      },
      compileSqlOnError: false,
      acquireConnectionTimeout: MYSQL_ACQUIRE_CONNECTION_TIMEOUT_MS,
      pool: {
        min: 0,
        max: 1,
        createTimeoutMillis: MYSQL_POOL_CREATE_TIMEOUT_MS,
        afterCreate: (
          rawConnection: MySqlRawQueryableConnection,
          done: (error: unknown, connection: unknown) => void,
        ) => {
          initializeMySqlSession(rawConnection, { statementTimeoutMs }).then(
            (sessionInitialization) => {
              this.detectedServerFlavorValue = sessionInitialization.serverFlavor;
              this.detectedServerVersionValue = sessionInitialization.serverVersion;
              done(null, rawConnection);
            },
            (error: unknown) => {
              // knex never hands a connection whose afterCreate failed back to the pool, so close it here.
              try {
                rawConnection.destroy();
              } catch {
                // already closed
              }
              done(error, rawConnection);
            },
          );
        },
      },
    });
    applyMySqlVerbatimIdentifierQuoting(this.knex);
  }

  get databaseName(): string | undefined {
    return this.connectionOptions.databaseName;
  }

  get detectedServerFlavor(): MySqlServerFlavor | undefined {
    return this.detectedServerFlavorValue;
  }

  get detectedServerVersion(): string | undefined {
    return this.detectedServerVersionValue;
  }

  /** The server flavor, connecting once (so the session setup runs) if nothing has connected yet. */
  async getServerFlavor(): Promise<MySqlServerFlavor> {
    if (this.detectedServerFlavorValue === undefined) {
      await this.knex.raw('SELECT 1');
    }
    return this.detectedServerFlavorValue ?? 'mysql';
  }

  async testQuery(): Promise<MySqlConnectionTestResult> {
    const [rows] = (await this.knex.raw('SELECT DATABASE() AS current_database_name, VERSION() AS server_version')) as [
      { current_database_name: string | null; server_version: string }[],
      unknown,
    ];
    const serverVersion = String(rows[0]?.server_version ?? '');
    return {
      currentDatabaseName: rows[0]?.current_database_name ?? null,
      serverVersion,
      serverFlavor: this.detectedServerFlavorValue ?? classifyMySqlServerFlavor(serverVersion),
    };
  }

  /**
   * Run right before DDL on this client's single pooled connection: bound how long a CREATE/ALTER waits for a
   * metadata lock (the default is a year, and a waiting ALTER queues every later query on the customer's table),
   * and lift MariaDB's `max_statement_time`, which unlike MySQL's `max_execution_time` also kills DDL. Failures
   * are tolerated (TiDB / Vitess reject some session variables).
   */
  async prepareSessionForSchemaChanges(): Promise<void> {
    const serverFlavor = await this.getServerFlavor();
    const sessionAssignments = [`SET SESSION lock_wait_timeout = ${MYSQL_DDL_LOCK_WAIT_TIMEOUT_SECONDS}`];
    if (serverFlavor === 'mariadb') sessionAssignments.push('SET SESSION max_statement_time = 0');
    for (const sessionAssignment of sessionAssignments) {
      try {
        await this.knex.raw(sessionAssignment);
      } catch (error) {
        if (!isMySqlServerError(error)) throw error;
      }
    }
  }

  async dispose(): Promise<void> {
    await this.knex.destroy();
  }
}
