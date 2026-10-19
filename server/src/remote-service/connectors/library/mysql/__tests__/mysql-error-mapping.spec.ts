/**
 * Unit tests for the MySQL error mapper. Pure: every error is a fake object shaped exactly like what mysql2 / Node /
 * knex produce (shapes captured against MySQL 8.4 and MariaDB 11.4, see ../LOG.md), including knex's rewritten
 * `<sql> - <driver message>` message and Node's IP-bearing network messages. No database.
 */
import { ConnectorErrorCode } from '@spinner/shared-types';
import { WSLogger } from 'src/logger';
import { ConnectorAuthError, NonWritableFieldEditError } from '../../../error';
import { MySqlClientError, MySqlClientProblem } from '../mysql-client-error';
import {
  buildMySqlColumnPrivilegeDeniedMessage,
  buildMySqlConnectionClosedUnexpectedlyMessage,
  buildMySqlConnectionRefusedMessage,
  buildMySqlConnectionTimedOutMessage,
  buildMySqlDatabaseAccessDeniedMessage,
  buildMySqlDataErrorMessage,
  buildMySqlHostLookupTemporarilyFailedMessage,
  buildMySqlHostNotPrivilegedMessage,
  buildMySqlHostNotReachableFromScratchMessage,
  buildMySqlHostUnreachableMessage,
  buildMySqlInvalidSqlMessage,
  buildMySqlServerStoppedRespondingMessage,
  buildMySqlServerWithoutTlsSupportMessage,
  buildMySqlStatementTimeoutMessage,
  buildMySqlTablePrivilegeDeniedMessage,
  buildMySqlTlsCertificateHostnameMismatchMessage,
  buildMySqlTlsCertificateVerificationFailedMessage,
  buildMySqlTlsHandshakeFailedMessage,
  buildMySqlUnexpectedFailureMessage,
  buildMySqlUnexpectedProtocolResponseMessage,
  buildMySqlUnexpectedServerErrorMessage,
  buildMySqlUnknownDatabaseMessage,
  describeMySqlError,
  describeScratchNetworkAddressForAllowlisting,
  formatMySqlHostAndPortForDisplay,
  MYSQL_ACCOUNT_LOCKED_MESSAGE,
  MYSQL_CLEAR_TEXT_PASSWORD_AUTHENTICATION_UNSUPPORTED_MESSAGE,
  MYSQL_DATA_ERROR_LEAD_SENTENCES,
  MYSQL_DEADLOCK_MESSAGE,
  MYSQL_DUPLICATE_COLUMN_NAME_MESSAGE,
  MYSQL_DUPLICATE_FOREIGN_KEY_NAME_MESSAGE,
  MYSQL_ENCRYPTED_CONNECTION_REQUIRED_MESSAGE,
  MYSQL_FOREIGN_KEY_REJECTED_MESSAGE,
  MYSQL_HOST_BLOCKED_MESSAGE,
  MYSQL_IDENTIFIER_TOO_LONG_MESSAGE,
  MYSQL_INDEX_KEY_TOO_LONG_MESSAGE,
  MYSQL_LOCK_WAIT_TIMEOUT_MESSAGE,
  MYSQL_PACKET_TOO_LARGE_MESSAGE,
  MYSQL_PASSWORD_EXPIRED_MESSAGE,
  MYSQL_QUERY_INTERRUPTED_MESSAGE,
  MYSQL_READ_ONLY_SERVER_MESSAGE,
  MYSQL_ROW_SIZE_TOO_LARGE_MESSAGE,
  MYSQL_SERVER_MESSAGE_DISPLAY_MAX_CHARACTERS,
  MYSQL_SPECIFIC_PRIVILEGE_REQUIRED_MESSAGE,
  MYSQL_TABLE_ALREADY_EXISTS_MESSAGE,
  MYSQL_TABLE_NOT_FOUND_MESSAGE,
  MYSQL_TOO_MANY_CONNECTIONS_MESSAGE,
  MYSQL_UNEXPECTED_FAILURE_MESSAGE,
  MYSQL_UNSUPPORTED_AUTHENTICATION_METHOD_MESSAGE,
  MYSQL_USER_RESOURCE_LIMIT_REACHED_MESSAGE,
  type MySqlErrorCategory,
  type MySqlErrorMappingContext,
  redactMySqlServerMessageForDisplay,
} from '../mysql-error-mapping';

// Values that must never reach a user: Scratch's egress IP (MySQL echoes it as 'user'@'ip'), the IP the user's host
// resolved to (Node network messages), and a bound value (knex's rewritten message / mysql2's `sql`).
const SCRATCH_EGRESS_IP_SENTINEL = '203.0.113.9';
const RESOLVED_DATABASE_IP_SENTINEL = '10.1.2.3';
const BOUND_VALUE_SENTINEL = 'S3cretBoundValue-7c1f';
const VALUES_THAT_MUST_NEVER_BE_SHOWN = [
  SCRATCH_EGRESS_IP_SENTINEL,
  RESOLVED_DATABASE_IP_SENTINEL,
  BOUND_VALUE_SENTINEL,
];

const BASE_CONTEXT: MySqlErrorMappingContext = {
  host: 'db.example.com',
  port: 3306,
  databaseName: 'test_db',
  sslMode: 'REQUIRED',
  statementTimeoutMs: 300_000,
};
const BASE_HOST_AND_PORT = 'db.example.com:3306';

const SQL_WITH_BOUND_VALUE = `insert into \`test_db\`.\`deals\` (\`name\`) values ('${BOUND_VALUE_SENTINEL}')`;

// ---------------------------------------------------------------------------------------------------------------
// Fake error factories (shapes observed in the spike; see LOG.md "Errors")
// ---------------------------------------------------------------------------------------------------------------

interface FakeServerErrorFields {
  errno: number;
  code?: string;
  sqlState: string;
  sqlMessage: string;
}

/** A server error raised by a knex query: message rewritten to `<sql> - <sqlMessage>`, `sql` attached. */
function makeKnexQueryServerError(fields: FakeServerErrorFields): Error {
  const error = new Error(`${SQL_WITH_BOUND_VALUE} - ${fields.sqlMessage}`);
  return Object.assign(error, { ...fields, sql: SQL_WITH_BOUND_VALUE });
}

/** A server error raised during the handshake (no SQL): `message === sqlMessage`. */
function makeConnectPhaseServerError(fields: FakeServerErrorFields): Error {
  return Object.assign(new Error(fields.sqlMessage), fields);
}

/** A Node socket error as mysql2 surfaces it (message and `address` carry the resolved IP; errno is NEGATIVE). */
function makeNodeNetworkError(code: string, syscall = 'connect'): Error {
  return Object.assign(new Error(`${syscall} ${code} ${RESOLVED_DATABASE_IP_SENTINEL}:3306`), {
    errno: -61,
    code,
    syscall,
    address: RESOLVED_DATABASE_IP_SENTINEL,
    port: 3306,
    fatal: true,
  });
}

/** Node's happy-eyeballs failure (`localhost` → ::1 and 127.0.0.1): empty message, IPs only on inner errors. */
function makeAggregateConnectionRefusedError(options: { withOwnCode: boolean }): AggregateError {
  const innerErrors = ['::1', RESOLVED_DATABASE_IP_SENTINEL].map((address) =>
    Object.assign(new Error(`connect ECONNREFUSED ${address}:3306`), {
      errno: -61,
      code: 'ECONNREFUSED',
      syscall: 'connect',
      address,
      port: 3306,
    }),
  );
  const aggregateError = new AggregateError(innerErrors, '');
  return Object.assign(aggregateError, { fatal: true, ...(options.withOwnCode ? { code: 'ECONNREFUSED' } : {}) });
}

/** A mysql2 client-side error: `code` (+ `fatal`) on a plain Error. */
function makeMySql2CodedError(code: string, message: string, extraProperties: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, fatal: true, ...extraProperties });
}

/** mysql2's own connect timeout (`base/connection.js`): no address, `errorno` string. */
function makeMySql2ConnectTimeoutError(): Error {
  return makeMySql2CodedError('ETIMEDOUT', 'connect ETIMEDOUT', { errorno: 'ETIMEDOUT', syscall: 'connect' });
}

/** Node's `tls.checkServerIdentity` failure after mysql2 overwrote its code: carries `reason`, `host`, `cert`. */
function makeTlsHostnameMismatchError(): Error {
  const reason = `IP: ${RESOLVED_DATABASE_IP_SENTINEL} is not in the cert's list: `;
  return makeMySql2CodedError('HANDSHAKE_SSL_ERROR', `Hostname/IP does not match certificate's altnames: ${reason}`, {
    reason,
    host: RESOLVED_DATABASE_IP_SENTINEL,
    cert: { subject: { CN: 'MySQL_Server_8.4.11_Auto_Generated_Server_Certificate' } },
  });
}

class FakeKnexTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnexTimeoutError';
  }
}

/** Mirrors the SSRF guards' convention (`SsrfError`): a public message plus server-only `internalDetails`. */
class FakeDatabaseHostGuardError extends Error {
  readonly internalDetails = `db.example.com resolved to ${RESOLVED_DATABASE_IP_SENTINEL} (private range 10.0.0.0/8)`;
  constructor() {
    super(`Database host refused: ${RESOLVED_DATABASE_IP_SENTINEL} is private`);
    this.name = 'DatabaseHostGuardError';
  }
}

// Server message fixtures (verbatim from MySQL 8.4 / MariaDB 11.4 unless noted).
const ACCESS_DENIED_SQL_MESSAGE = `Access denied for user 'test'@'${SCRATCH_EGRESS_IP_SENTINEL}' (using password: YES)`;
const DATA_TOO_LONG_SQL_MESSAGE = "Data too long for column 'u' at row 1";

function accessDeniedStyleServerError(errno: number, code: string | undefined, sqlMessage: string): Error {
  return makeConnectPhaseServerError({ errno, code, sqlState: '28000', sqlMessage });
}

// ---------------------------------------------------------------------------------------------------------------
// The mapping table
// ---------------------------------------------------------------------------------------------------------------

interface MappingTableRow {
  readonly label: string;
  readonly error: unknown;
  readonly contextOverrides?: Partial<MySqlErrorMappingContext>;
  readonly expectedUserFriendlyMessage: string;
  readonly expectedCategory: MySqlErrorCategory;
}

function dataErrorRow(
  errno: number,
  code: string | undefined,
  sqlState: string,
  sqlMessage: string,
  leadSentence: string,
  contextOverrides?: Partial<MySqlErrorMappingContext>,
): MappingTableRow {
  return {
    label: `${errno} ${code ?? '(no code)'}${contextOverrides?.serverFlavor ? ` on ${contextOverrides.serverFlavor}` : ''}`,
    error: makeKnexQueryServerError({ errno, code, sqlState, sqlMessage }),
    contextOverrides,
    expectedUserFriendlyMessage: `${leadSentence} Server message: ${sqlMessage}`,
    expectedCategory: 'data',
  };
}

function fixedServerErrorRow(
  errno: number,
  code: string | undefined,
  expectedUserFriendlyMessage: string,
  expectedCategory: MySqlErrorCategory,
  contextOverrides?: Partial<MySqlErrorMappingContext>,
): MappingTableRow {
  return {
    label: `${errno} ${code ?? '(no code)'}`,
    error: makeKnexQueryServerError({
      errno,
      code,
      sqlState: 'HY000',
      sqlMessage: `Server text for ${errno} naming 'test'@'${SCRATCH_EGRESS_IP_SENTINEL}' and ${BOUND_VALUE_SENTINEL}`,
    }),
    contextOverrides,
    expectedUserFriendlyMessage,
    expectedCategory,
  };
}

const CONNECT_PHASE_SERVER_ERROR_ROWS: MappingTableRow[] = [
  {
    label: '1045 wrong password, SSL Mode REQUIRED',
    error: accessDeniedStyleServerError(1045, 'ER_ACCESS_DENIED_ERROR', ACCESS_DENIED_SQL_MESSAGE),
    expectedUserFriendlyMessage: 'MySQL rejected the username or password. Check both fields and try again.',
    expectedCategory: 'credentials',
  },
  {
    label: '1045 wrong password, SSL Mode DISABLED (adds the TLS hint)',
    error: accessDeniedStyleServerError(1045, 'ER_ACCESS_DENIED_ERROR', ACCESS_DENIED_SQL_MESSAGE),
    contextOverrides: { sslMode: 'DISABLED' },
    expectedUserFriendlyMessage:
      'MySQL rejected the username or password. Check both fields and try again. If this user must connect over TLS, set SSL Mode to REQUIRED.',
    expectedCategory: 'credentials',
  },
  {
    label: '1044 scoped user, configured database',
    error: makeConnectPhaseServerError({
      errno: 1044,
      code: 'ER_DBACCESS_DENIED_ERROR',
      sqlState: '42000',
      sqlMessage: `Access denied for user 'test'@'${SCRATCH_EGRESS_IP_SENTINEL}' to database 'test_db'`,
    }),
    expectedUserFriendlyMessage: buildMySqlDatabaseAccessDeniedMessage('test_db'),
    expectedCategory: 'permission',
  },
  {
    label: '1044 without a configured database',
    error: makeConnectPhaseServerError({
      errno: 1044,
      code: 'ER_DBACCESS_DENIED_ERROR',
      sqlState: '42000',
      sqlMessage: `Access denied for user 'test'@'%' to database 'other_db'`,
    }),
    contextOverrides: { databaseName: undefined },
    expectedUserFriendlyMessage:
      "This MySQL user can't access that database. Grant it access, or connect with a user that has access.",
    expectedCategory: 'permission',
  },
  {
    label: '1049 unknown database',
    error: makeConnectPhaseServerError({
      errno: 1049,
      code: 'ER_BAD_DB_ERROR',
      sqlState: '42000',
      sqlMessage: "Unknown database 'test_db'",
    }),
    expectedUserFriendlyMessage:
      'The database "test_db" doesn\'t exist on this MySQL server. Check the Database field (names are case-sensitive on most servers).',
    expectedCategory: 'credentials',
  },
  {
    label: '1049 without a configured database',
    error: makeConnectPhaseServerError({
      errno: 1049,
      code: 'ER_BAD_DB_ERROR',
      sqlState: '42000',
      sqlMessage: "Unknown database 'x'",
    }),
    contextOverrides: { databaseName: undefined },
    expectedUserFriendlyMessage: buildMySqlUnknownDatabaseMessage(undefined),
    expectedCategory: 'credentials',
  },
  {
    label: '1130 host not privileged',
    error: makeConnectPhaseServerError({
      errno: 1130,
      code: 'ER_HOST_NOT_PRIVILEGED',
      sqlState: 'HY000',
      sqlMessage: `Host '${SCRATCH_EGRESS_IP_SENTINEL}' is not allowed to connect to this MySQL server`,
    }),
    expectedUserFriendlyMessage: buildMySqlHostNotPrivilegedMessage(BASE_HOST_AND_PORT),
    expectedCategory: 'network',
  },
  fixedServerErrorRow(1129, 'ER_HOST_IS_BLOCKED', MYSQL_HOST_BLOCKED_MESSAGE, 'network'),
  fixedServerErrorRow(1040, 'ER_CON_COUNT_ERROR', MYSQL_TOO_MANY_CONNECTIONS_MESSAGE, 'server'),
  fixedServerErrorRow(1203, 'ER_TOO_MANY_USER_CONNECTIONS', MYSQL_USER_RESOURCE_LIMIT_REACHED_MESSAGE, 'server'),
  fixedServerErrorRow(1226, 'ER_USER_LIMIT_REACHED', MYSQL_USER_RESOURCE_LIMIT_REACHED_MESSAGE, 'server'),
  fixedServerErrorRow(
    1251,
    'ER_NOT_SUPPORTED_AUTH_MODE',
    MYSQL_UNSUPPORTED_AUTHENTICATION_METHOD_MESSAGE,
    'credentials',
  ),
  fixedServerErrorRow(1820, 'ER_MUST_CHANGE_PASSWORD', MYSQL_PASSWORD_EXPIRED_MESSAGE, 'credentials'),
  fixedServerErrorRow(1862, 'ER_MUST_CHANGE_PASSWORD_LOGIN', MYSQL_PASSWORD_EXPIRED_MESSAGE, 'credentials'),
  fixedServerErrorRow(3118, 'ER_ACCOUNT_HAS_BEEN_LOCKED', MYSQL_ACCOUNT_LOCKED_MESSAGE, 'credentials'),
  fixedServerErrorRow(3955, undefined, MYSQL_ACCOUNT_LOCKED_MESSAGE, 'credentials'),
  fixedServerErrorRow(3159, 'ER_SECURE_TRANSPORT_REQUIRED', MYSQL_ENCRYPTED_CONNECTION_REQUIRED_MESSAGE, 'tls', {
    sslMode: 'DISABLED',
  }),
  fixedServerErrorRow(
    1043,
    'ER_HANDSHAKE_ERROR',
    buildMySqlUnexpectedProtocolResponseMessage(BASE_HOST_AND_PORT),
    'network',
  ),
];

const NETWORK_AND_PROTOCOL_ROWS: MappingTableRow[] = [
  {
    label: 'ECONNREFUSED',
    error: makeNodeNetworkError('ECONNREFUSED'),
    expectedUserFriendlyMessage: buildMySqlConnectionRefusedMessage(BASE_HOST_AND_PORT),
    expectedCategory: 'network',
  },
  {
    label: 'ECONNREFUSED to an IPv6 host the user typed (bracketed)',
    error: makeNodeNetworkError('ECONNREFUSED'),
    contextOverrides: { host: '2001:db8::5', port: 3307 },
    expectedUserFriendlyMessage: buildMySqlConnectionRefusedMessage('[2001:db8::5]:3307'),
    expectedCategory: 'network',
  },
  {
    label: 'AggregateError with its own code (localhost, both address families refused)',
    error: makeAggregateConnectionRefusedError({ withOwnCode: true }),
    contextOverrides: { host: 'localhost', port: 1 },
    expectedUserFriendlyMessage: buildMySqlConnectionRefusedMessage('localhost:1'),
    expectedCategory: 'network',
  },
  {
    label: 'AggregateError whose code is only on the inner errors',
    error: makeAggregateConnectionRefusedError({ withOwnCode: false }),
    contextOverrides: { host: 'localhost', port: 1 },
    expectedUserFriendlyMessage: buildMySqlConnectionRefusedMessage('localhost:1'),
    expectedCategory: 'network',
  },
  {
    label: 'ETIMEDOUT from Node',
    error: makeNodeNetworkError('ETIMEDOUT'),
    expectedUserFriendlyMessage: buildMySqlConnectionTimedOutMessage(BASE_HOST_AND_PORT),
    expectedCategory: 'network',
  },
  {
    label: "ETIMEDOUT from mysql2's connectTimeout",
    error: makeMySql2ConnectTimeoutError(),
    expectedUserFriendlyMessage: buildMySqlConnectionTimedOutMessage(BASE_HOST_AND_PORT),
    expectedCategory: 'network',
  },
  {
    label: 'EHOSTUNREACH',
    error: makeNodeNetworkError('EHOSTUNREACH'),
    expectedUserFriendlyMessage: buildMySqlHostUnreachableMessage(BASE_HOST_AND_PORT),
    expectedCategory: 'network',
  },
  {
    label: 'ENETUNREACH',
    error: makeNodeNetworkError('ENETUNREACH'),
    expectedUserFriendlyMessage: buildMySqlHostUnreachableMessage(BASE_HOST_AND_PORT),
    expectedCategory: 'network',
  },
  {
    label: 'ENOTFOUND',
    error: Object.assign(makeNodeNetworkError('ENOTFOUND', 'getaddrinfo'), { hostname: 'no-such-host.invalid' }),
    contextOverrides: { host: 'no-such-host.invalid' },
    expectedUserFriendlyMessage:
      'Couldn\'t find a server named "no-such-host.invalid". Check the Host field for typos.',
    expectedCategory: 'network',
  },
  {
    label: 'EAI_AGAIN',
    error: makeNodeNetworkError('EAI_AGAIN', 'getaddrinfo'),
    expectedUserFriendlyMessage: buildMySqlHostLookupTemporarilyFailedMessage('db.example.com'),
    expectedCategory: 'network',
  },
  ...['ECONNRESET', 'EPIPE'].map(
    (code): MappingTableRow => ({
      label: code,
      error: makeNodeNetworkError(code, 'read'),
      expectedUserFriendlyMessage: buildMySqlConnectionClosedUnexpectedlyMessage(BASE_HOST_AND_PORT),
      expectedCategory: 'network',
    }),
  ),
  {
    label: 'PROTOCOL_CONNECTION_LOST',
    error: makeMySql2CodedError('PROTOCOL_CONNECTION_LOST', 'Connection lost: The server closed the connection.'),
    expectedUserFriendlyMessage: buildMySqlConnectionClosedUnexpectedlyMessage(BASE_HOST_AND_PORT),
    expectedCategory: 'network',
  },
  {
    label: 'ER_CLIENT_INTERACTION_TIMEOUT delivered code-only (mysql2 protocolError path)',
    error: makeMySql2CodedError('ER_CLIENT_INTERACTION_TIMEOUT', 'The client was disconnected by the server'),
    expectedUserFriendlyMessage: buildMySqlConnectionClosedUnexpectedlyMessage(BASE_HOST_AND_PORT),
    expectedCategory: 'network',
  },
  {
    label: 'PROTOCOL_SEQUENCE_TIMEOUT',
    error: makeMySql2CodedError('PROTOCOL_SEQUENCE_TIMEOUT', 'Query inactivity timeout', { syscall: 'query' }),
    expectedUserFriendlyMessage: buildMySqlServerStoppedRespondingMessage(BASE_HOST_AND_PORT),
    expectedCategory: 'network',
  },
  ...['PROTOCOL_ERROR', 'PROTOCOL_UNEXPECTED_PACKET', 'HANDSHAKE_UNKNOWN_ERROR'].map(
    (code): MappingTableRow => ({
      label: code,
      error: makeMySql2CodedError(code, 'Unexpected packet during handshake phase'),
      expectedUserFriendlyMessage: buildMySqlUnexpectedProtocolResponseMessage(BASE_HOST_AND_PORT),
      expectedCategory: 'network',
    }),
  ),
  {
    label: 'KnexTimeoutError (pool acquire timeout)',
    error: new FakeKnexTimeoutError(
      'Knex: Timeout acquiring a connection. The pool is probably full. Are you missing a .transacting(trx) call?',
    ),
    expectedUserFriendlyMessage: buildMySqlConnectionTimedOutMessage(BASE_HOST_AND_PORT),
    expectedCategory: 'network',
  },
  {
    label: 'knex pool timeout text on an error whose class name was lost',
    error: new Error('Knex: Timeout acquiring a connection. The pool is probably full.'),
    expectedUserFriendlyMessage: buildMySqlConnectionTimedOutMessage(BASE_HOST_AND_PORT),
    expectedCategory: 'network',
  },
];

const TLS_AND_AUTH_PLUGIN_ROWS: MappingTableRow[] = [
  {
    label: 'HANDSHAKE_SSL_ERROR under VERIFY_CA (self-signed chain)',
    error: makeMySql2CodedError('HANDSHAKE_SSL_ERROR', 'self-signed certificate in certificate chain'),
    contextOverrides: { sslMode: 'VERIFY_CA' },
    expectedUserFriendlyMessage:
      "Scratch couldn't verify the TLS certificate of the MySQL server at db.example.com:3306 (SSL Mode VERIFY_CA). Make sure the CA Certificate field holds your provider's CA certificate, or use SSL Mode REQUIRED to encrypt the connection without verifying the certificate.",
    expectedCategory: 'tls',
  },
  {
    label: 'HANDSHAKE_SSL_ERROR under VERIFY_IDENTITY, chain failure',
    error: makeMySql2CodedError('HANDSHAKE_SSL_ERROR', 'unable to get local issuer certificate'),
    contextOverrides: { sslMode: 'VERIFY_IDENTITY' },
    expectedUserFriendlyMessage: buildMySqlTlsCertificateVerificationFailedMessage(
      BASE_HOST_AND_PORT,
      'VERIFY_IDENTITY',
    ),
    expectedCategory: 'tls',
  },
  {
    label: 'HANDSHAKE_SSL_ERROR under VERIFY_IDENTITY, hostname mismatch (hostname typed)',
    error: makeTlsHostnameMismatchError(),
    contextOverrides: { sslMode: 'VERIFY_IDENTITY' },
    expectedUserFriendlyMessage:
      'The MySQL server\'s TLS certificate isn\'t issued for "db.example.com" (SSL Mode VERIFY_IDENTITY). Connect with the hostname on the certificate, or use SSL Mode VERIFY_CA.',
    expectedCategory: 'tls',
  },
  {
    label: 'HANDSHAKE_SSL_ERROR under VERIFY_IDENTITY, hostname mismatch (IP typed)',
    error: makeTlsHostnameMismatchError(),
    contextOverrides: { sslMode: 'VERIFY_IDENTITY', host: '198.51.100.7' },
    expectedUserFriendlyMessage: buildMySqlTlsCertificateHostnameMismatchMessage('198.51.100.7'),
    expectedCategory: 'tls',
  },
  {
    label: 'HANDSHAKE_SSL_ERROR under REQUIRED (protocol-level TLS failure)',
    error: makeMySql2CodedError('HANDSHAKE_SSL_ERROR', 'wrong version number'),
    expectedUserFriendlyMessage: buildMySqlTlsHandshakeFailedMessage(BASE_HOST_AND_PORT, 'REQUIRED'),
    expectedCategory: 'tls',
  },
  {
    label: 'HANDSHAKE_NO_SSL_SUPPORT',
    error: makeMySql2CodedError('HANDSHAKE_NO_SSL_SUPPORT', 'Server does not support secure connection'),
    expectedUserFriendlyMessage: buildMySqlServerWithoutTlsSupportMessage(BASE_HOST_AND_PORT),
    expectedCategory: 'tls',
  },
  {
    label: 'AUTH_SWITCH_PLUGIN_ERROR (MariaDB ed25519)',
    error: makeMySql2CodedError(
      'AUTH_SWITCH_PLUGIN_ERROR',
      'Server requests authentication using unknown plugin client_ed25519. See TODO: add plugins doco here on how to configure or author authentication plugins.',
    ),
    expectedUserFriendlyMessage: MYSQL_UNSUPPORTED_AUTHENTICATION_METHOD_MESSAGE,
    expectedCategory: 'credentials',
  },
  {
    label: 'MYSQL_CLEAR_PASSWORD_NOT_ENABLED (IAM / Entra token sign-in)',
    error: makeMySql2CodedError(
      'MYSQL_CLEAR_PASSWORD_NOT_ENABLED',
      'Server requested authentication using mysql_clear_password, which sends the password in plaintext',
    ),
    expectedUserFriendlyMessage: MYSQL_CLEAR_TEXT_PASSWORD_AUTHENTICATION_UNSUPPORTED_MESSAGE,
    expectedCategory: 'credentials',
  },
];

const QUERY_PHASE_SERVER_ERROR_ROWS: MappingTableRow[] = [
  // Timeouts (the message states the configured limit in minutes).
  {
    label: '3024 ER_QUERY_TIMEOUT (MySQL max_execution_time)',
    error: makeKnexQueryServerError({
      errno: 3024,
      code: 'ER_QUERY_TIMEOUT',
      sqlState: 'HY000',
      sqlMessage: 'Query execution was interrupted, maximum statement execution time exceeded',
    }),
    contextOverrides: { serverFlavor: 'mysql' },
    expectedUserFriendlyMessage:
      "The MySQL query ran longer than 5 minutes (Scratch's limit per query) and the server stopped it. If this happened during a pull, add a filter to pull fewer rows; otherwise try again when the server is less busy.",
    expectedCategory: 'timeout',
  },
  ...(['mariadb', undefined, 'mysql'] as const).map(
    (serverFlavor): MappingTableRow => ({
      label: `1969 MariaDB max_statement_time (no code), flavor ${serverFlavor ?? 'unknown'}`,
      error: makeKnexQueryServerError({
        errno: 1969,
        sqlState: '70100',
        sqlMessage: 'Query execution was interrupted (max_statement_time exceeded)',
      }),
      contextOverrides: { serverFlavor },
      expectedUserFriendlyMessage: buildMySqlStatementTimeoutMessage(300_000),
      expectedCategory: 'timeout',
    }),
  ),
  fixedServerErrorRow(1317, 'ER_QUERY_INTERRUPTED', MYSQL_QUERY_INTERRUPTED_MESSAGE, 'timeout'),

  // Locks and read-only servers.
  fixedServerErrorRow(1205, 'ER_LOCK_WAIT_TIMEOUT', MYSQL_LOCK_WAIT_TIMEOUT_MESSAGE, 'lock'),
  fixedServerErrorRow(1213, 'ER_LOCK_DEADLOCK', MYSQL_DEADLOCK_MESSAGE, 'lock'),
  fixedServerErrorRow(1290, 'ER_OPTION_PREVENTS_STATEMENT', MYSQL_READ_ONLY_SERVER_MESSAGE, 'read_only'),
  fixedServerErrorRow(1792, 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION', MYSQL_READ_ONLY_SERVER_MESSAGE, 'read_only'),
  fixedServerErrorRow(1836, 'ER_READ_ONLY_MODE', MYSQL_READ_ONLY_SERVER_MESSAGE, 'read_only'),

  // Privileges: the verb comes from an allowlist; the rest of the text (which names 'user'@'ip') never shows.
  {
    label: '1142 SELECT command denied (MySQL wording)',
    error: makeKnexQueryServerError({
      errno: 1142,
      code: 'ER_TABLEACCESS_DENIED_ERROR',
      sqlState: '42000',
      sqlMessage: `SELECT command denied to user 'test'@'${SCRATCH_EGRESS_IP_SENTINEL}' for table 'user'`,
    }),
    expectedUserFriendlyMessage:
      "This MySQL user doesn't have the SELECT privilege on this table. Grant SELECT to pull, INSERT, UPDATE and DELETE to publish, and CREATE, ALTER and REFERENCES to create tables.",
    expectedCategory: 'permission',
  },
  {
    label: '1142 INSERT command denied (MariaDB wording)',
    error: makeKnexQueryServerError({
      errno: 1142,
      code: 'ER_TABLEACCESS_DENIED_ERROR',
      sqlState: '42000',
      sqlMessage: `INSERT command denied to user 'test'@'${SCRATCH_EGRESS_IP_SENTINEL}' for table \`test_db\`.\`deals\``,
    }),
    expectedUserFriendlyMessage: buildMySqlTablePrivilegeDeniedMessage('INSERT'),
    expectedCategory: 'permission',
  },
  {
    label: '1142 with a verb outside the allowlist',
    error: makeKnexQueryServerError({
      errno: 1142,
      code: 'ER_TABLEACCESS_DENIED_ERROR',
      sqlState: '42000',
      sqlMessage: `SHOW VIEW command denied to user 'test'@'${SCRATCH_EGRESS_IP_SENTINEL}' for table 'v'`,
    }),
    expectedUserFriendlyMessage: buildMySqlTablePrivilegeDeniedMessage(undefined),
    expectedCategory: 'permission',
  },
  {
    label: '1143 UPDATE command denied on a column',
    error: makeKnexQueryServerError({
      errno: 1143,
      code: 'ER_COLUMNACCESS_DENIED_ERROR',
      sqlState: '42000',
      sqlMessage: `UPDATE command denied to user 'test'@'${SCRATCH_EGRESS_IP_SENTINEL}' for column 'amount' in table 'deals'`,
    }),
    expectedUserFriendlyMessage: buildMySqlColumnPrivilegeDeniedMessage('UPDATE'),
    expectedCategory: 'permission',
  },
  fixedServerErrorRow(1227, 'ER_SPECIFIC_ACCESS_DENIED_ERROR', MYSQL_SPECIFIC_PRIVILEGE_REQUIRED_MESSAGE, 'permission'),

  // Tables and columns.
  fixedServerErrorRow(1146, 'ER_NO_SUCH_TABLE', MYSQL_TABLE_NOT_FOUND_MESSAGE, 'schema'),
  {
    label: '1054 unknown column (echoes the column name)',
    error: makeKnexQueryServerError({
      errno: 1054,
      code: 'ER_BAD_FIELD_ERROR',
      sqlState: '42S22',
      sqlMessage: "Unknown column 'nope' in 'field list'",
    }),
    expectedUserFriendlyMessage: `${MYSQL_DATA_ERROR_LEAD_SENTENCES.unknownColumn} Server message: Unknown column 'nope' in 'field list'`,
    expectedCategory: 'schema',
  },

  // The data-error echo allowlist.
  {
    label: '1406 literal expectation',
    error: makeKnexQueryServerError({
      errno: 1406,
      code: 'ER_DATA_TOO_LONG',
      sqlState: '22001',
      sqlMessage: DATA_TOO_LONG_SQL_MESSAGE,
    }),
    expectedUserFriendlyMessage:
      "A value is too long for its column. Server message: Data too long for column 'u' at row 1",
    expectedCategory: 'data',
  },
  dataErrorRow(
    1062,
    'ER_DUP_ENTRY',
    '23000',
    "Duplicate entry 'a' for key 'deals.u'",
    MYSQL_DATA_ERROR_LEAD_SENTENCES.duplicateUniqueValue,
  ),
  dataErrorRow(
    1048,
    'ER_BAD_NULL_ERROR',
    '23000',
    "Column 'n' cannot be null",
    MYSQL_DATA_ERROR_LEAD_SENTENCES.requiredColumnNull,
  ),
  dataErrorRow(
    1364,
    'ER_NO_DEFAULT_FOR_FIELD',
    'HY000',
    "Field 'n' doesn't have a default value",
    MYSQL_DATA_ERROR_LEAD_SENTENCES.requiredColumnWithoutDefault,
  ),
  dataErrorRow(
    1264,
    'ER_WARN_DATA_OUT_OF_RANGE',
    '22003',
    "Out of range value for column 't' at row 1",
    MYSQL_DATA_ERROR_LEAD_SENTENCES.numberOutOfRange,
  ),
  dataErrorRow(
    1265,
    'WARN_DATA_TRUNCATED',
    '01000',
    "Data truncated for column 'status' at row 1",
    MYSQL_DATA_ERROR_LEAD_SENTENCES.valueDoesNotFitColumn,
  ),
  dataErrorRow(
    1292,
    'ER_TRUNCATED_WRONG_VALUE',
    '22007',
    "Incorrect datetime value: '2026-13-45 12:34:56' for column 'd' at row 1",
    MYSQL_DATA_ERROR_LEAD_SENTENCES.incorrectDateTimeOrNumber,
  ),
  dataErrorRow(
    1366,
    'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD',
    '22007',
    "Incorrect integer value: 'abc' for column `test_db`.`deals`.`n` at row 1",
    MYSQL_DATA_ERROR_LEAD_SENTENCES.valueDoesNotMatchColumnType,
  ),
  dataErrorRow(
    1451,
    'ER_ROW_IS_REFERENCED_2',
    '23000',
    'Cannot delete or update a parent row: a foreign key constraint fails (`test_db`.`deals`, CONSTRAINT `fk` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`))',
    MYSQL_DATA_ERROR_LEAD_SENTENCES.rowStillReferenced,
  ),
  dataErrorRow(
    1452,
    'ER_NO_REFERENCED_ROW_2',
    '23000',
    'Cannot add or update a child row: a foreign key constraint fails (`test_db`.`deals`, CONSTRAINT `fk` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`))',
    MYSQL_DATA_ERROR_LEAD_SENTENCES.referencedRowMissing,
  ),
  dataErrorRow(
    3105,
    'ER_NON_DEFAULT_VALUE_FOR_GENERATED_COLUMN',
    'HY000',
    "The value specified for generated column 'g' in table 'deals' is not allowed.",
    MYSQL_DATA_ERROR_LEAD_SENTENCES.generatedColumnWritten,
    { serverFlavor: 'mysql' },
  ),
  dataErrorRow(
    3819,
    'ER_CHECK_CONSTRAINT_VIOLATED',
    'HY000',
    "Check constraint 'deals_chk_1' is violated.",
    MYSQL_DATA_ERROR_LEAD_SENTENCES.checkConstraintViolated,
    { serverFlavor: 'mysql' },
  ),
  dataErrorRow(
    3140,
    'ER_INVALID_JSON_TEXT',
    '22032',
    'Invalid JSON text: "Invalid value." at position 1 in value for column \'deals.j\'.',
    MYSQL_DATA_ERROR_LEAD_SENTENCES.invalidJson,
    { serverFlavor: 'mysql' },
  ),
  dataErrorRow(
    1906,
    undefined,
    'HY000',
    "The value specified for generated column 'g' in table 'deals' has been ignored",
    MYSQL_DATA_ERROR_LEAD_SENTENCES.generatedColumnWritten,
    { serverFlavor: 'mariadb' },
  ),
  dataErrorRow(
    4025,
    'ER_INNODB_AUTOEXTEND_SIZE_OUT_OF_RANGE', // mysql2's (MySQL) name for MariaDB's ER_CONSTRAINT_FAILED
    '23000',
    'CONSTRAINT `deals.j` failed for `test_db`.`deals`',
    MYSQL_DATA_ERROR_LEAD_SENTENCES.mariaDbConstraintViolated,
    { serverFlavor: 'mariadb' },
  ),
  {
    label: '4025 with an unknown flavor and SQLSTATE 23000 is read as MariaDB',
    error: makeKnexQueryServerError({
      errno: 4025,
      code: 'ER_INNODB_AUTOEXTEND_SIZE_OUT_OF_RANGE',
      sqlState: '23000',
      sqlMessage: 'CONSTRAINT `deals.c` failed for `test_db`.`deals`',
    }),
    expectedUserFriendlyMessage: `${MYSQL_DATA_ERROR_LEAD_SENTENCES.mariaDbConstraintViolated} Server message: CONSTRAINT \`deals.c\` failed for \`test_db\`.\`deals\``,
    expectedCategory: 'data',
  },
  {
    label: '4025 on MySQL is its own (InnoDB DDL) error: generic, no echo',
    error: makeKnexQueryServerError({
      errno: 4025,
      code: 'ER_INNODB_AUTOEXTEND_SIZE_OUT_OF_RANGE',
      sqlState: 'HY000',
      sqlMessage: `AUTOEXTEND_SIZE value ${BOUND_VALUE_SENTINEL} out of range`,
    }),
    contextOverrides: { serverFlavor: 'mysql' },
    expectedUserFriendlyMessage: buildMySqlUnexpectedServerErrorMessage(4025, 'ER_INNODB_AUTOEXTEND_SIZE_OUT_OF_RANGE'),
    expectedCategory: 'server',
  },
  fixedServerErrorRow(1217, 'ER_ROW_IS_REFERENCED', MYSQL_DATA_ERROR_LEAD_SENTENCES.rowStillReferenced, 'data'),
  fixedServerErrorRow(1216, 'ER_NO_REFERENCED_ROW', MYSQL_DATA_ERROR_LEAD_SENTENCES.referencedRowMissing, 'data'),
  fixedServerErrorRow(1153, 'ER_NET_PACKET_TOO_LARGE', MYSQL_PACKET_TOO_LARGE_MESSAGE, 'data'),

  // Schema creation fallbacks.
  fixedServerErrorRow(1050, 'ER_TABLE_EXISTS_ERROR', MYSQL_TABLE_ALREADY_EXISTS_MESSAGE, 'schema'),
  fixedServerErrorRow(1060, 'ER_DUP_FIELDNAME', MYSQL_DUPLICATE_COLUMN_NAME_MESSAGE, 'schema'),
  fixedServerErrorRow(1059, 'ER_TOO_LONG_IDENT', MYSQL_IDENTIFIER_TOO_LONG_MESSAGE, 'schema'),
  fixedServerErrorRow(1071, 'ER_TOO_LONG_KEY', MYSQL_INDEX_KEY_TOO_LONG_MESSAGE, 'schema'),
  fixedServerErrorRow(1117, 'ER_TOO_MANY_FIELDS', MYSQL_ROW_SIZE_TOO_LARGE_MESSAGE, 'schema'),
  fixedServerErrorRow(1118, 'ER_TOO_BIG_ROWSIZE', MYSQL_ROW_SIZE_TOO_LARGE_MESSAGE, 'schema'),
  ...(
    [
      [1005, 'ER_CANT_CREATE_TABLE'],
      [1215, 'ER_CANNOT_ADD_FOREIGN'],
      [1822, 'ER_FK_NO_INDEX_PARENT'],
      [1824, 'ER_FK_CANNOT_OPEN_PARENT'],
      [3780, 'ER_FK_INCOMPATIBLE_COLUMNS'],
      [6125, undefined],
    ] as const
  ).map(([errno, code]) => fixedServerErrorRow(errno, code, MYSQL_FOREIGN_KEY_REJECTED_MESSAGE, 'schema')),
  fixedServerErrorRow(1826, 'ER_FK_DUP_NAME', MYSQL_DUPLICATE_FOREIGN_KEY_NAME_MESSAGE, 'schema'),

  // Syntax errors quote the SQL: never echoed.
  fixedServerErrorRow(1064, 'ER_PARSE_ERROR', buildMySqlInvalidSqlMessage(1064), 'server'),
  fixedServerErrorRow(1149, 'ER_SYNTAX_ERROR', buildMySqlInvalidSqlMessage(1149), 'server'),

  // Unmapped server errors: errno (+ code when trustworthy), never the text.
  fixedServerErrorRow(
    1234,
    'ER_WRONG_USAGE',
    'MySQL returned an unexpected error (error 1234, ER_WRONG_USAGE).',
    'server',
  ),
  fixedServerErrorRow(4078, 'ER_SOMETHING_MYSQL_NAMED', buildMySqlUnexpectedServerErrorMessage(4078), 'server', {
    serverFlavor: 'mariadb',
  }),
];

const GENERIC_FALLBACK_ROWS: MappingTableRow[] = [
  {
    label: 'a plain Error with an IP-bearing message and no code',
    error: new Error(`connect ECONNREFUSED ${RESOLVED_DATABASE_IP_SENTINEL}:3306`),
    expectedUserFriendlyMessage: MYSQL_UNEXPECTED_FAILURE_MESSAGE,
    expectedCategory: 'unknown',
  },
  {
    label: 'a TypeError from our own code',
    error: new TypeError(`Cannot read properties of undefined (reading '${BOUND_VALUE_SENTINEL}')`),
    expectedUserFriendlyMessage: MYSQL_UNEXPECTED_FAILURE_MESSAGE,
    expectedCategory: 'unknown',
  },
  {
    label: 'an unknown but well-formed network code',
    error: makeNodeNetworkError('EADDRNOTAVAIL'),
    expectedUserFriendlyMessage: buildMySqlUnexpectedFailureMessage('EADDRNOTAVAIL'),
    expectedCategory: 'unknown',
  },
  {
    label: 'a malformed code (dropped, never echoed)',
    error: Object.assign(new Error('boom'), { code: `bad code ${RESOLVED_DATABASE_IP_SENTINEL}` }),
    expectedUserFriendlyMessage: MYSQL_UNEXPECTED_FAILURE_MESSAGE,
    expectedCategory: 'unknown',
  },
  {
    label: 'a string',
    error: `connect ECONNREFUSED ${RESOLVED_DATABASE_IP_SENTINEL}:3306`,
    expectedUserFriendlyMessage: MYSQL_UNEXPECTED_FAILURE_MESSAGE,
    expectedCategory: 'unknown',
  },
  ...[undefined, null, 42, {}, []].map(
    (thrownValue): MappingTableRow => ({
      label: `thrown value ${JSON.stringify(thrownValue) ?? 'undefined'}`,
      error: thrownValue,
      expectedUserFriendlyMessage: MYSQL_UNEXPECTED_FAILURE_MESSAGE,
      expectedCategory: 'unknown',
    }),
  ),
];

const ALL_MAPPING_TABLE_ROWS: MappingTableRow[] = [
  ...CONNECT_PHASE_SERVER_ERROR_ROWS,
  ...NETWORK_AND_PROTOCOL_ROWS,
  ...TLS_AND_AUTH_PLUGIN_ROWS,
  ...QUERY_PHASE_SERVER_ERROR_ROWS,
  ...GENERIC_FALLBACK_ROWS,
];

function contextFor(row: { contextOverrides?: Partial<MySqlErrorMappingContext> }): MySqlErrorMappingContext {
  return { ...BASE_CONTEXT, ...row.contextOverrides };
}

/** Every string a user could see from one mapping result. */
function userVisibleTextsOf(details: ReturnType<typeof describeMySqlError>): string[] {
  return [details.userFriendlyMessage, details.description ?? '', JSON.stringify(details.additionalContext ?? {})];
}

function readStringProperty(value: unknown, propertyName: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const propertyValue = (value as Record<string, unknown>)[propertyName];
  return typeof propertyValue === 'string' ? propertyValue : undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

describe('describeMySqlError', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(WSLogger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe('mapping table', () => {
    it.each(ALL_MAPPING_TABLE_ROWS.map((row) => [row.label, row] as const))('%s', (_label, row) => {
      const details = describeMySqlError(row.error, contextFor(row));

      expect(details.userFriendlyMessage).toBe(row.expectedUserFriendlyMessage);
      expect(details.additionalContext?.category).toBe(row.expectedCategory);
      expect(details.errorCode).toBeUndefined();
      for (const userVisibleText of userVisibleTextsOf(details)) {
        for (const valueThatMustNeverBeShown of VALUES_THAT_MUST_NEVER_BE_SHOWN) {
          expect(userVisibleText).not.toContain(valueThatMustNeverBeShown);
        }
      }
    });
  });

  describe('output metadata', () => {
    it('describes a server error with its errno, code and SQLSTATE only', () => {
      const details = describeMySqlError(
        accessDeniedStyleServerError(1045, 'ER_ACCESS_DENIED_ERROR', ACCESS_DENIED_SQL_MESSAGE),
        BASE_CONTEXT,
      );

      expect(details.description).toBe('MySQL error 1045 (ER_ACCESS_DENIED_ERROR)');
      expect(details.additionalContext).toEqual({
        category: 'credentials',
        errno: 1045,
        code: 'ER_ACCESS_DENIED_ERROR',
        sqlState: '28000',
      });
    });

    it("omits mysql2's MySQL code name for a MariaDB-only errno", () => {
      const details = describeMySqlError(
        makeKnexQueryServerError({
          errno: 4025,
          code: 'ER_INNODB_AUTOEXTEND_SIZE_OUT_OF_RANGE',
          sqlState: '23000',
          sqlMessage: 'CONSTRAINT `t.c` failed for `db`.`t`',
        }),
        { ...BASE_CONTEXT, serverFlavor: 'mariadb' },
      );

      expect(details.description).toBe('MySQL error 4025');
      expect(details.additionalContext).toEqual({
        category: 'data',
        errno: 4025,
        sqlState: '23000',
        serverFlavor: 'mariadb',
      });
    });

    it('describes a network error by code and syscall, never by address', () => {
      const details = describeMySqlError(makeNodeNetworkError('ECONNREFUSED'), BASE_CONTEXT);

      expect(details.description).toBe('MySQL connection error (ECONNREFUSED)');
      expect(details.additionalContext).toEqual({ category: 'network', code: 'ECONNREFUSED', syscall: 'connect' });
      expect(details.additionalContext).not.toHaveProperty('address');
      expect(details.additionalContext).not.toHaveProperty('errno');
    });

    it('never reports an AggregateError inner address', () => {
      const details = describeMySqlError(makeAggregateConnectionRefusedError({ withOwnCode: false }), {
        ...BASE_CONTEXT,
        host: 'localhost',
      });

      expect(JSON.stringify(details)).not.toContain('::1');
      expect(JSON.stringify(details)).not.toContain(RESOLVED_DATABASE_IP_SENTINEL);
    });

    it('states the statement timeout in the unit that fits', () => {
      const timeoutError = makeKnexQueryServerError({
        errno: 3024,
        code: 'ER_QUERY_TIMEOUT',
        sqlState: 'HY000',
        sqlMessage: 'Query execution was interrupted, maximum statement execution time exceeded',
      });

      expect(
        describeMySqlError(timeoutError, { ...BASE_CONTEXT, statementTimeoutMs: 60_000 }).userFriendlyMessage,
      ).toContain('longer than 1 minute (');
      expect(
        describeMySqlError(timeoutError, { ...BASE_CONTEXT, statementTimeoutMs: 1_500 }).userFriendlyMessage,
      ).toContain('longer than 1.5 seconds (');
      expect(
        describeMySqlError(timeoutError, { ...BASE_CONTEXT, statementTimeoutMs: 0 }).userFriendlyMessage,
      ).toContain("ran longer than Scratch's limit per query and");
    });

    it('tells users to allowlist Scratch through the egress-address seam', () => {
      expect(describeScratchNetworkAddressForAllowlisting()).toBe("Scratch's IP address");
      expect(buildMySqlHostNotPrivilegedMessage(BASE_HOST_AND_PORT)).toContain("Allow Scratch's IP address");
      expect(buildMySqlConnectionTimedOutMessage(BASE_HOST_AND_PORT)).toContain("allows Scratch's IP address");
    });

    it('resolves a code-only server error through its code name', () => {
      const details = describeMySqlError(
        makeMySql2CodedError('ER_LOCK_DEADLOCK', 'Deadlock found when trying to get lock'),
        BASE_CONTEXT,
      );

      expect(details.userFriendlyMessage).toBe(MYSQL_DEADLOCK_MESSAGE);
      expect(details.additionalContext).toMatchObject({ errno: 1213, code: 'ER_LOCK_DEADLOCK' });
    });
  });

  describe('pass-through of errors the connector raised itself', () => {
    it('passes a MySqlClientError through and copies its errorCode', () => {
      const recordNotFoundError = new MySqlClientError(
        MySqlClientProblem.RecordNotFound,
        'The row with id 7 no longer exists in "test_db"."deals".',
        { errorCode: ConnectorErrorCode.RemoteRecordNotFound },
      );

      expect(describeMySqlError(recordNotFoundError, BASE_CONTEXT)).toEqual({
        userFriendlyMessage: 'The row with id 7 no longer exists in "test_db"."deals".',
        description: 'The row with id 7 no longer exists in "test_db"."deals".',
        additionalContext: { category: 'connector', mySqlClientProblem: MySqlClientProblem.RecordNotFound },
        errorCode: ConnectorErrorCode.RemoteRecordNotFound,
      });
    });

    it('omits errorCode when the MySqlClientError has none', () => {
      const details = describeMySqlError(
        new MySqlClientError(MySqlClientProblem.InvalidFilter, 'The filter may not contain ";".'),
        BASE_CONTEXT,
      );

      expect(details.userFriendlyMessage).toBe('The filter may not contain ";".');
      expect(details).not.toHaveProperty('errorCode');
    });

    it('passes the interim deployed-environment tripwire through', () => {
      const tripwireError = new MySqlClientError(
        MySqlClientProblem.DatabaseHostGuardUnavailable,
        "MySQL connections aren't available in this environment yet.",
      );

      expect(describeMySqlError(tripwireError, BASE_CONTEXT).userFriendlyMessage).toBe(
        "MySQL connections aren't available in this environment yet.",
      );
    });

    it('passes a NonWritableFieldEditError through', () => {
      const nonWritableFieldEditError = new NonWritableFieldEditError(
        'Field "g" is read-only and can\'t be published.',
      );

      const details = describeMySqlError(nonWritableFieldEditError, BASE_CONTEXT);

      expect(details.userFriendlyMessage).toBe('Field "g" is read-only and can\'t be published.');
      expect(details.description).toBe('Field "g" is read-only and can\'t be published.');
    });

    it('passes a credentials error (ConnectorAuthError) through using userFriendlyMessage, not message', () => {
      const credentialsError = new ConnectorAuthError(
        `internal: raw input mysql://u:${BOUND_VALUE_SENTINEL}@h`,
        'Enter the port as a whole number between 1 and 65535.',
        'MYSQL',
      );

      const details = describeMySqlError(credentialsError, BASE_CONTEXT);

      expect(details.userFriendlyMessage).toBe('Enter the port as a whole number between 1 and 65535.');
      expect(JSON.stringify(details)).not.toContain(BOUND_VALUE_SENTINEL);
    });

    it('copies only a known ConnectorErrorCode from other user-friendly errors', () => {
      const withKnownErrorCode = Object.assign(new NonWritableFieldEditError('gone'), {
        errorCode: ConnectorErrorCode.RemoteRecordNotFound,
      });
      const withUnknownErrorCode = Object.assign(new NonWritableFieldEditError('gone'), { errorCode: 'made_up' });

      expect(describeMySqlError(withKnownErrorCode, BASE_CONTEXT).errorCode).toBe(
        ConnectorErrorCode.RemoteRecordNotFound,
      );
      expect(describeMySqlError(withUnknownErrorCode, BASE_CONTEXT)).not.toHaveProperty('errorCode');
    });
  });

  describe('database host guard refusals (duck-typed internalDetails)', () => {
    it('shows a generic message naming only the typed host, and logs the internal details', () => {
      const hostGuardError = new FakeDatabaseHostGuardError();

      const details = describeMySqlError(hostGuardError, BASE_CONTEXT);

      expect(details.userFriendlyMessage).toBe(buildMySqlHostNotReachableFromScratchMessage(BASE_HOST_AND_PORT));
      expect(details.userFriendlyMessage).toBe(
        "Couldn't connect to db.example.com:3306. Make sure the database is publicly reachable from the internet and that its firewall allows Scratch's IP address.",
      );
      expect(details.additionalContext).toEqual({ category: 'host_guard' });
      expect(JSON.stringify(details)).not.toContain(RESOLVED_DATABASE_IP_SENTINEL);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ internalDetails: hostGuardError.internalDetails }),
      );
    });

    it('also logs internalDetails carried by a user-friendly error, keeping its own message', () => {
      const userFriendlyErrorWithInternalDetails = Object.assign(new NonWritableFieldEditError('Safe message.'), {
        internalDetails: `resolved ${RESOLVED_DATABASE_IP_SENTINEL}`,
      });

      expect(describeMySqlError(userFriendlyErrorWithInternalDetails, BASE_CONTEXT).userFriendlyMessage).toBe(
        'Safe message.',
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ internalDetails: `resolved ${RESOLVED_DATABASE_IP_SENTINEL}` }),
      );
    });

    it('does not log for ordinary errors', () => {
      describeMySqlError(makeNodeNetworkError('ECONNREFUSED'), BASE_CONTEXT);

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('totality', () => {
    it('never throws, even for an error whose properties throw', () => {
      const hostileError = new Proxy(new Error('hostile'), {
        get(target, propertyName) {
          if (propertyName === 'code' || propertyName === 'errno') throw new Error('getter exploded');
          return Reflect.get(target, propertyName) as unknown;
        },
      });

      expect(describeMySqlError(hostileError, BASE_CONTEXT)).toEqual({
        userFriendlyMessage: MYSQL_UNEXPECTED_FAILURE_MESSAGE,
        description: MYSQL_UNEXPECTED_FAILURE_MESSAGE,
        additionalContext: { category: 'unknown' },
      });
    });
  });

  describe('property: no output ever contains the thrown error message, SQL, bound values or IPs', () => {
    /** Deterministic PRNG (mulberry32) so failures reproduce. */
    function createSeededRandom(seed: number): () => number {
      let state = seed >>> 0;
      return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
        mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
      };
    }

    const ERRNOS_TO_SAMPLE = [
      1005, 1040, 1043, 1044, 1045, 1048, 1049, 1050, 1054, 1059, 1060, 1062, 1064, 1071, 1117, 1118, 1129, 1130, 1142,
      1143, 1146, 1149, 1153, 1203, 1205, 1213, 1215, 1216, 1217, 1226, 1227, 1251, 1264, 1265, 1290, 1292, 1317, 1364,
      1366, 1406, 1451, 1452, 1792, 1820, 1822, 1824, 1826, 1836, 1862, 1906, 1969, 3024, 3105, 3118, 3140, 3159, 3780,
      3819, 3955, 4025, 4031, 6125, 1105, 1193, 1234, 2013, 4078, 8027, 9005,
    ];
    const SERVER_MESSAGE_TEMPLATES = [
      `Access denied for user 'scratch'@'${SCRATCH_EGRESS_IP_SENTINEL}' (using password: YES)`,
      `Duplicate entry '${SCRATCH_EGRESS_IP_SENTINEL}' for key 'hosts.ip'`,
      `Data too long for column 'note' at row 1 near ${RESOLVED_DATABASE_IP_SENTINEL}`,
      `Incorrect integer value: '::ffff:${RESOLVED_DATABASE_IP_SENTINEL}' for column 'n' at row 1`,
      "You have an error in your SQL syntax; check the manual near 'SELEKT 1' at line 1",
      `Host '${SCRATCH_EGRESS_IP_SENTINEL}' is not allowed to connect to this MySQL server`,
    ];
    const CLIENT_SIDE_CODES = [
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ECONNRESET',
      'EPIPE',
      'PROTOCOL_CONNECTION_LOST',
      'PROTOCOL_SEQUENCE_TIMEOUT',
      'HANDSHAKE_SSL_ERROR',
      'HANDSHAKE_NO_SSL_SUPPORT',
      'AUTH_SWITCH_PLUGIN_ERROR',
      'MYSQL_CLEAR_PASSWORD_NOT_ENABLED',
      'EADDRNOTAVAIL',
    ];
    const SSL_MODES = ['DISABLED', 'REQUIRED', 'VERIFY_CA', 'VERIFY_IDENTITY'] as const;
    const SERVER_FLAVORS = [undefined, 'mysql', 'mariadb', 'tidb', 'vitess'] as const;

    function pick<T>(random: () => number, choices: readonly T[]): T {
      return choices[Math.floor(random() * choices.length)];
    }

    function generateErrorAndContext(random: () => number): { error: unknown; context: MySqlErrorMappingContext } {
      const context: MySqlErrorMappingContext = {
        ...BASE_CONTEXT,
        sslMode: pick(random, SSL_MODES),
        serverFlavor: pick(random, SERVER_FLAVORS),
        databaseName: random() < 0.5 ? 'test_db' : undefined,
      };
      if (random() < 0.6) {
        const sqlMessage = pick(random, SERVER_MESSAGE_TEMPLATES);
        const errno = pick(random, ERRNOS_TO_SAMPLE);
        const error =
          random() < 0.7
            ? makeKnexQueryServerError({ errno, code: 'ER_SAMPLED', sqlState: 'HY000', sqlMessage })
            : // Connect-phase errors are the only ones whose message equals sqlMessage; restrict them to the
              // connect-phase errnos, which never echo (the data-error echo is by design, see the table).
              makeConnectPhaseServerError({
                errno: pick(random, [1044, 1045, 1049, 1129, 1130, 1040, 1203, 1251, 1862, 3118, 3159, 1043]),
                sqlState: '28000',
                sqlMessage,
              });
        return { error, context };
      }
      const code = pick(random, CLIENT_SIDE_CODES);
      const error =
        code === 'HANDSHAKE_SSL_ERROR' && random() < 0.5
          ? makeTlsHostnameMismatchError()
          : random() < 0.2
            ? makeAggregateConnectionRefusedError({ withOwnCode: random() < 0.5 })
            : makeNodeNetworkError(code);
      return { error, context };
    }

    const GENERATED_FIXTURE_COUNT = 400;
    const everyFixtureError = [
      ...ALL_MAPPING_TABLE_ROWS.map((row) => ({ error: row.error, context: contextFor(row) })),
      ...Array.from({ length: GENERATED_FIXTURE_COUNT }, (_unused, index) =>
        generateErrorAndContext(createSeededRandom(20260929 + index)),
      ),
    ];

    it(`holds for every table fixture and ${GENERATED_FIXTURE_COUNT} generated errors`, () => {
      const violations: string[] = [];
      let generatedDataErrorEchoCount = 0;
      everyFixtureError.forEach((fixture, fixtureIndex) => {
        const details = describeMySqlError(fixture.error, fixture.context);
        const thrownMessage = readStringProperty(fixture.error, 'message');
        const thrownSql = readStringProperty(fixture.error, 'sql');
        if (details.userFriendlyMessage.includes(' Server message: ')) generatedDataErrorEchoCount += 1;
        const forbiddenFragments = [
          ...(thrownMessage ? [thrownMessage] : []),
          ...(thrownSql ? [thrownSql] : []),
          ...VALUES_THAT_MUST_NEVER_BE_SHOWN,
        ];
        for (const userVisibleText of userVisibleTextsOf(details)) {
          for (const forbiddenFragment of forbiddenFragments) {
            if (userVisibleText.includes(forbiddenFragment)) {
              violations.push(`fixture #${fixtureIndex}: output contains ${JSON.stringify(forbiddenFragment)}`);
            }
          }
        }
      });

      expect(violations).toEqual([]);
      // Guard against a vacuous property: the generated set must exercise the sqlMessage echo path.
      expect(generatedDataErrorEchoCount).toBeGreaterThan(20);
    });
  });
});

describe('redactMySqlServerMessageForDisplay', () => {
  it.each([
    [
      "the account in 'user'@'host' form",
      `Access denied for user 'test'@'${SCRATCH_EGRESS_IP_SENTINEL}' (using password: YES)`,
      "Access denied for user 'test'@'[host]' (using password: YES)",
    ],
    ['a hostname account host', "user 'svc'@'ip-10-0-0-1.ec2.internal'", "user 'svc'@'[host]'"],
    ['an IPv4 literal', "Duplicate entry '10.0.0.1' for key 'ip'", "Duplicate entry '[address]' for key 'ip'"],
    ['an IPv4 literal ending a sentence', 'Refused from 10.0.0.1.', 'Refused from [address].'],
    ['an IPv4 literal with a port', 'peer 10.0.0.1:3306 closed', 'peer [address]:3306 closed'],
    ['an IPv6 literal', "Duplicate entry '2001:db8::1' for key 'ip'", "Duplicate entry '[address]' for key 'ip'"],
    ['IPv6 loopback', 'from ::1 now', 'from [address] now'],
    ['an IPv6 literal with a zone', 'from fe80::1%eth0 now', 'from [address] now'],
    ['an IPv4-mapped IPv6 literal', "value '::ffff:10.0.0.1'", "value '[address]'"],
    ['control characters', 'line one\nline two\u0000end', 'line one line two end'],
  ])('redacts %s', (_label, serverMessage, expectedRedactedMessage) => {
    expect(redactMySqlServerMessageForDisplay(serverMessage)).toBe(expectedRedactedMessage);
  });

  it.each([
    ['a time of day', "Incorrect datetime value: '2026-01-02 12:34:56' for column 'd'"],
    ['a version-like dotted number', 'Incorrect value 1.2.3.4.5 for column v'],
    ['a MAC address', "Duplicate entry 'aa:bb:cc:dd:ee:ff' for key 'mac'"],
    ['a decimal', "Out of range value 12345.678 for column 'amount'"],
  ])('keeps %s', (_label, serverMessage) => {
    expect(redactMySqlServerMessageForDisplay(serverMessage)).toBe(serverMessage);
  });

  it('caps the text with an ellipsis, counting code points', () => {
    const longServerMessage = `Data too long: '${'x'.repeat(500)}'`;
    const redactedMessage = redactMySqlServerMessageForDisplay(longServerMessage);

    expect(Array.from(redactedMessage)).toHaveLength(MYSQL_SERVER_MESSAGE_DISPLAY_MAX_CHARACTERS);
    expect(redactedMessage.endsWith('…')).toBe(true);

    const exactlyAtLimit = 'y'.repeat(MYSQL_SERVER_MESSAGE_DISPLAY_MAX_CHARACTERS);
    expect(redactMySqlServerMessageForDisplay(exactlyAtLimit)).toBe(exactlyAtLimit);

    const emojiServerMessage = '😀'.repeat(MYSQL_SERVER_MESSAGE_DISPLAY_MAX_CHARACTERS + 10);
    const redactedEmojiMessage = redactMySqlServerMessageForDisplay(emojiServerMessage);
    expect(Array.from(redactedEmojiMessage)).toHaveLength(MYSQL_SERVER_MESSAGE_DISPLAY_MAX_CHARACTERS);
    expect(redactedEmojiMessage).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('redacts before truncating, so a cut can never expose part of an address', () => {
    const serverMessage = `${'x'.repeat(290)} ${SCRATCH_EGRESS_IP_SENTINEL} tail`;

    expect(redactMySqlServerMessageForDisplay(serverMessage)).not.toContain('203.0');
  });
});

describe('buildMySqlDataErrorMessage', () => {
  it('appends the redacted server text to the lead sentence', () => {
    expect(
      buildMySqlDataErrorMessage(
        MYSQL_DATA_ERROR_LEAD_SENTENCES.duplicateUniqueValue,
        `Duplicate entry '${SCRATCH_EGRESS_IP_SENTINEL}' for key 'hosts.ip'`,
      ),
    ).toBe(
      "Another row already has this value in a column that must be unique. Server message: Duplicate entry '[address]' for key 'hosts.ip'",
    );
  });

  it('is just the lead sentence without server text', () => {
    expect(buildMySqlDataErrorMessage(MYSQL_DATA_ERROR_LEAD_SENTENCES.invalidJson, undefined)).toBe(
      MYSQL_DATA_ERROR_LEAD_SENTENCES.invalidJson,
    );
    expect(buildMySqlDataErrorMessage(MYSQL_DATA_ERROR_LEAD_SENTENCES.invalidJson, ' \n ')).toBe(
      MYSQL_DATA_ERROR_LEAD_SENTENCES.invalidJson,
    );
  });
});

describe('formatMySqlHostAndPortForDisplay', () => {
  it.each([
    ['db.example.com', 3306, 'db.example.com:3306'],
    ['198.51.100.7', 3307, '198.51.100.7:3307'],
    ['2001:db8::5', 3306, '[2001:db8::5]:3306'],
    ['db\n.example.com', 3306, 'db .example.com:3306'],
    ['db.example.com', Number.NaN, 'db.example.com'],
  ])('formats %p:%p as %p', (host, port, expectedDisplay) => {
    expect(formatMySqlHostAndPortForDisplay(host, port)).toBe(expectedDisplay);
  });
});
