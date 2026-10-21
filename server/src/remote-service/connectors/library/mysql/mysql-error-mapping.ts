/**
 * What users see when a MySQL operation fails: every MySQL server, network, TLS, authentication and knex failure
 * becomes a fixed, actionable sentence.
 *
 * Both `userFriendlyMessage` AND `description` reach users (the HTTP error body carries `description` as its
 * `error` field, jobs and the publish runner persist `userFriendlyMessage`, the CLI prints both), so both are built
 * only from:
 *  - fixed sentences in this file,
 *  - the host / port / database the USER typed (from the mapping context — never a resolved IP),
 *  - sanitized metadata (`errno`, `code`, `sqlState`),
 *  - for an allowlist of data errors only, the server's `sqlMessage`, redacted and capped.
 *
 * What this module never does, on purpose:
 *  - read `error.message`, `error.sql` or `error.stack`: knex rewrites `error.message` to `<sql> - <driver message>`
 *    (`knex/lib/execution/internal/query-executioner.js`), mysql2 attaches `sql` (with bound values inlined), and
 *    Node network messages carry the resolved IP (`connect ECONNREFUSED 10.1.2.3:3306`). The one exception is a
 *    prefix check against knex's own constant pool-timeout text, see {@link isKnexConnectionAcquireTimeout}.
 *  - call `Connector.fallbackErrorDetails`: it echoes `error.message` into both fields.
 *  - echo `sqlMessage` for authentication / permission errors (1044, 1045, 1130, 1142, 1143): MySQL phrases them as
 *    `Access denied for user 'test'@'203.0.113.9'`, which names Scratch's egress IP.
 */
import { ConnectorErrorCode } from '@spinner/shared-types';
import { isIP } from 'node:net';
import { WSLogger } from 'src/logger';
import { assertUnreachable } from 'src/utils/asserts';
import { isUserFriendlyError } from '../../error';
import { type ConnectorErrorDetails } from '../../types';
import { MySqlClientError } from './mysql-client-error';
import { type MySqlServerFlavor } from './mysql-server-flavor';
import { type MySqlSslMode } from './mysql-types';

// ---------------------------------------------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------------------------------------------

export interface MySqlErrorMappingContext {
  /** The host exactly as the user typed it. The only host a message may name — never a resolved IP. */
  readonly host: string;
  readonly port: number;
  /** The configured database, when the connection is scoped to one. */
  readonly databaseName?: string;
  readonly sslMode: MySqlSslMode;
  /**
   * The flavor detected on the operation's connection. Undefined when the failure happened before the session setup
   * ran (every connect-phase error). Needed because mysql2 names errnos after MySQL's table, and MariaDB reuses some
   * numbers ≥ 4000 for different errors (MariaDB 4025 is a CHECK violation; mysql2 calls it
   * ER_INNODB_AUTOEXTEND_SIZE_OUT_OF_RANGE).
   */
  readonly serverFlavor?: MySqlServerFlavor;
  /** The server-side statement timeout the session applied (`MYSQL_STATEMENT_TIMEOUT_MS` in production). */
  readonly statementTimeoutMs: number;
}

/** Coarse classification carried in `additionalContext.category` (safe metadata for logs and future generic hooks). */
export type MySqlErrorCategory =
  | 'connector'
  | 'host_guard'
  | 'credentials'
  | 'permission'
  | 'network'
  | 'tls'
  | 'timeout'
  | 'lock'
  | 'read_only'
  | 'data'
  | 'schema'
  | 'server'
  | 'unknown';

/**
 * The static outbound IP of Scratch's production servers (the europe-west1 Cloud NAT address,
 * `terraform output nat_egress_ip` in `terraform/envs/eu-production`). Customer databases see every connection,
 * Live Export runs included, coming from it. Scratch's test environment leaves from a different address, so its
 * messages name the production one.
 */
export const SCRATCH_PRODUCTION_EGRESS_IP_ADDRESS = '35.233.96.253';

/**
 * How users should describe Scratch's network address when allowlisting it: every message that tells users to
 * allowlist Scratch goes through here. It names the address and not the product, because Whalesync's Live Export
 * shows the same messages to its users.
 */
export function describeScratchNetworkAddressForAllowlisting(): string {
  return `the IP address ${SCRATCH_PRODUCTION_EGRESS_IP_ADDRESS}`;
}

/** Longest `sqlMessage` excerpt (in characters, after redaction) appended to a data-error message. */
export const MYSQL_SERVER_MESSAGE_DISPLAY_MAX_CHARACTERS = 300;

/** Joins a data error's fixed lead sentence and the redacted server text. */
export const MYSQL_SERVER_MESSAGE_LABEL = 'Server message:';

/**
 * Make a MySQL `sqlMessage` safe to show: `'user'@'host'` → `'user'@'[host]'`, IPv4 / IPv6 literals → `[address]`,
 * control characters → spaces, and at most {@link MYSQL_SERVER_MESSAGE_DISPLAY_MAX_CHARACTERS} characters (the last
 * one an ellipsis when cut). Deliberately conservative: an IP-shaped value in the user's own data (a duplicate
 * `ip_address` entry) is redacted too.
 */
export function redactMySqlServerMessageForDisplay(sqlMessage: string): string {
  const redactedServerMessage = sqlMessage
    .replace(CONTROL_CHARACTER_RUN_PATTERN, ' ')
    .replace(MYSQL_ACCOUNT_USER_AT_HOST_PATTERN, `$1@'[host]'`)
    .replace(IPV6_ADDRESS_CANDIDATE_PATTERN, (candidate) => (isIpv6AddressLiteral(candidate) ? '[address]' : candidate))
    .replace(IPV4_ADDRESS_PATTERN, '[address]')
    .trim();
  return truncateForDisplay(redactedServerMessage, MYSQL_SERVER_MESSAGE_DISPLAY_MAX_CHARACTERS);
}

/** `db.example.com:3306`, `[2001:db8::1]:3306` — the user's own host, with IPv6 literals bracketed. */
export function formatMySqlHostAndPortForDisplay(host: string, port: number): string {
  const hostForDisplay = sanitizeUserTypedTextForDisplay(host, MAXIMUM_DISPLAYED_HOST_CHARACTERS);
  const bracketedHostForDisplay = isIP(hostForDisplay) === 6 ? `[${hostForDisplay}]` : hostForDisplay;
  return Number.isSafeInteger(port) && port > 0 ? `${bracketedHostForDisplay}:${port}` : bracketedHostForDisplay;
}

/**
 * Translate any error thrown while talking to MySQL into safe, user-facing details. Total: never throws, whatever
 * `error` is (a hostile getter or Proxy falls back to the generic message).
 *
 * Order: (1) errors the connector raised itself pass through; (2) the database host guard's refusal (duck-typed
 * `internalDetails`); (3) knex's connection-pool timeout; (4) MySQL server errors, keyed by errno (or mysql2's code
 * name when a server error arrives without one); (5) network / TLS / protocol / auth-plugin codes; (6) a generic
 * message with no server text.
 */
export function describeMySqlError(error: unknown, context: MySqlErrorMappingContext): ConnectorErrorDetails {
  try {
    return describeMySqlErrorWithoutSafetyNet(error, context);
  } catch {
    return buildErrorDetails({ category: 'unknown', userFriendlyMessage: MYSQL_UNEXPECTED_FAILURE_MESSAGE });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// User-facing messages (exported so unit and integration specs compare against the exact text)
// ---------------------------------------------------------------------------------------------------------------

// Generic fallbacks.
export const MYSQL_UNEXPECTED_FAILURE_MESSAGE =
  "Couldn't complete the MySQL request. Try again, and contact support if it keeps happening.";

export function buildMySqlUnexpectedFailureMessage(clientSideErrorCode: string): string {
  return `Couldn't complete the MySQL request (${clientSideErrorCode}). Try again, and contact support if it keeps happening.`;
}

export function buildMySqlUnexpectedServerErrorMessage(errno: number, displayedErrorCodeName?: string): string {
  const errorIdentification = displayedErrorCodeName ? `error ${errno}, ${displayedErrorCodeName}` : `error ${errno}`;
  return `MySQL returned an unexpected error (${errorIdentification}).`;
}

// Reaching the server.
export function buildMySqlHostNotReachableFromScratchMessage(hostAndPortForDisplay: string): string {
  return `Couldn't connect to ${hostAndPortForDisplay}. Make sure the database is publicly reachable from the internet and that its firewall allows ${describeScratchNetworkAddressForAllowlisting()}.`;
}

export function buildMySqlConnectionTimedOutMessage(hostAndPortForDisplay: string): string {
  return `Timed out connecting to ${hostAndPortForDisplay}. Make sure the database is publicly reachable from the internet, that its firewall or security group allows ${describeScratchNetworkAddressForAllowlisting()}, and that the port is the MySQL port (usually 3306).`;
}

export function buildMySqlHostUnreachableMessage(hostAndPortForDisplay: string): string {
  return `Couldn't reach ${hostAndPortForDisplay} over the network. Make sure the database is publicly reachable from the internet and that its firewall allows ${describeScratchNetworkAddressForAllowlisting()}.`;
}

export function buildMySqlConnectionRefusedMessage(hostAndPortForDisplay: string): string {
  return `Nothing accepted the connection at ${hostAndPortForDisplay}. Check the host and port in the connection string, and that the MySQL server is running and accepts connections from the internet.`;
}

export function buildMySqlHostNotFoundMessage(hostForDisplay: string): string {
  return `Couldn't find a server named "${hostForDisplay}". Check the connection string's host for typos.`;
}

export function buildMySqlHostLookupTemporarilyFailedMessage(hostForDisplay: string): string {
  return `Looking up the server name "${hostForDisplay}" failed temporarily. Try again in a moment.`;
}

export function buildMySqlConnectionClosedUnexpectedlyMessage(hostAndPortForDisplay: string): string {
  return `The MySQL server at ${hostAndPortForDisplay} closed the connection unexpectedly. Try again; if it keeps happening, check the connection string's ssl-mode and the server's connection limits.`;
}

export function buildMySqlServerStoppedRespondingMessage(hostAndPortForDisplay: string): string {
  return `The MySQL server at ${hostAndPortForDisplay} stopped responding. Try again in a moment.`;
}

export function buildMySqlUnexpectedProtocolResponseMessage(hostAndPortForDisplay: string): string {
  return `The server at ${hostAndPortForDisplay} didn't respond like a MySQL server. Check the port in the connection string (MySQL usually listens on 3306) and its ssl-mode.`;
}

// TLS.
export function buildMySqlTlsCertificateVerificationFailedMessage(
  hostAndPortForDisplay: string,
  sslMode: MySqlSslMode,
): string {
  return `Scratch couldn't verify the TLS certificate of the MySQL server at ${hostAndPortForDisplay} (SSL mode ${sslMode}). Make sure the CA certificate field holds your provider's CA certificate, or, to encrypt the connection without verifying the certificate, remove the CA certificate and add ?ssl-mode=REQUIRED to the connection string.`;
}

export function buildMySqlTlsCertificateHostnameMismatchMessage(hostForDisplay: string): string {
  if (isIP(hostForDisplay) !== 0) {
    return `The MySQL server's TLS certificate doesn't match "${hostForDisplay}" (SSL mode VERIFY_IDENTITY). VERIFY_IDENTITY checks the certificate against a hostname, so put the hostname on the certificate in the connection string instead of an IP address, or use ssl-mode=VERIFY_CA.`;
  }
  return `The MySQL server's TLS certificate isn't issued for "${hostForDisplay}" (SSL mode VERIFY_IDENTITY). Put the hostname on the certificate in the connection string, or use ssl-mode=VERIFY_CA.`;
}

export function buildMySqlTlsHandshakeFailedMessage(hostAndPortForDisplay: string, sslMode: MySqlSslMode): string {
  return `The TLS handshake with the MySQL server at ${hostAndPortForDisplay} failed (SSL mode ${sslMode}). Make sure the server supports TLS 1.2 or newer, then try again.`;
}

export function buildMySqlServerWithoutTlsSupportMessage(hostAndPortForDisplay: string): string {
  return `The MySQL server at ${hostAndPortForDisplay} doesn't support encrypted (TLS) connections. Enable TLS on the server, or, only if you accept sending data unencrypted, add ?ssl-mode=DISABLED to the connection string.`;
}

export const MYSQL_ENCRYPTED_CONNECTION_REQUIRED_MESSAGE =
  'The MySQL server only accepts encrypted connections. Remove the option that turns SSL off (such as ssl-mode=DISABLED) from the connection string; Scratch encrypts connections by default.';

// Authentication and account state.
export function buildMySqlAccessDeniedMessage(sslMode: MySqlSslMode): string {
  const encryptedConnectionHint =
    sslMode === 'DISABLED'
      ? ' If this user must connect over TLS, use ssl-mode=REQUIRED in the connection string.'
      : '';
  return `MySQL rejected the username or password. Check both in the connection string and try again.${encryptedConnectionHint}`;
}

export function buildMySqlHostNotPrivilegedMessage(hostAndPortForDisplay: string): string {
  return `The MySQL server at ${hostAndPortForDisplay} doesn't let this user connect from ${describeScratchNetworkAddressForAllowlisting()}. Allow that address for this MySQL user (for example create it as 'user'@'%') and in the server's firewall, then try again.`;
}

export const MYSQL_HOST_BLOCKED_MESSAGE = `The MySQL server blocked ${describeScratchNetworkAddressForAllowlisting()} after too many failed connection attempts. Run FLUSH HOSTS on the server (or raise max_connect_errors), then try again.`;

export const MYSQL_UNSUPPORTED_AUTHENTICATION_METHOD_MESSAGE =
  "The MySQL server asked for an authentication method Scratch doesn't support (such as MariaDB's ed25519 or parsec). Connect with a user that uses mysql_native_password or caching_sha2_password.";

export const MYSQL_CLEAR_TEXT_PASSWORD_AUTHENTICATION_UNSUPPORTED_MESSAGE =
  "The MySQL server asked for the password in clear text (used by IAM, Microsoft Entra, LDAP and PAM sign-in), which Scratch doesn't support. Connect with a standard MySQL user and password.";

export const MYSQL_PASSWORD_EXPIRED_MESSAGE =
  "This MySQL user's password has expired. Reset it on the server, then update the password on this connection.";

export const MYSQL_ACCOUNT_LOCKED_MESSAGE =
  'This MySQL user account is locked (or temporarily locked after too many failed logins). Unlock it on the server, or connect with another user.';

export function buildMySqlDatabaseAccessDeniedMessage(databaseName: string | undefined): string {
  const databaseNameForDisplay = sanitizeOptionalUserTypedTextForDisplay(databaseName);
  if (databaseNameForDisplay === undefined) {
    return "This MySQL user can't access that database. Grant it access, or connect with a user that has access.";
  }
  return `This MySQL user can't access the database "${databaseNameForDisplay}". Check the database name in the connection string (names are case-sensitive on most servers) and grant the user access to that database, or leave the database out of the connection string to see the databases it can use.`;
}

export function buildMySqlUnknownDatabaseMessage(databaseName: string | undefined): string {
  const databaseNameForDisplay = sanitizeOptionalUserTypedTextForDisplay(databaseName);
  if (databaseNameForDisplay === undefined) {
    return "That database doesn't exist on this MySQL server.";
  }
  return `The database "${databaseNameForDisplay}" doesn't exist on this MySQL server. Check the database name in the connection string (names are case-sensitive on most servers).`;
}

// Connection limits.
export const MYSQL_TOO_MANY_CONNECTIONS_MESSAGE =
  "The MySQL server has too many open connections. Try again shortly, or raise the server's max_connections.";

export const MYSQL_USER_RESOURCE_LIMIT_REACHED_MESSAGE =
  "This MySQL user has reached its connection or query limit. Try again later, or raise the user's limits.";

// Privileges.
const PRIVILEGE_GRANT_ADVICE =
  'Grant SELECT to pull, INSERT, UPDATE and DELETE to publish, and CREATE, ALTER and REFERENCES to create tables.';

export function buildMySqlTablePrivilegeDeniedMessage(deniedPrivilegeName: string | undefined): string {
  const missingPermissionDescription = deniedPrivilegeName ? `the ${deniedPrivilegeName} privilege` : 'permission';
  return `This MySQL user doesn't have ${missingPermissionDescription} on this table. ${PRIVILEGE_GRANT_ADVICE}`;
}

export function buildMySqlColumnPrivilegeDeniedMessage(deniedPrivilegeName: string | undefined): string {
  const missingPermissionDescription = deniedPrivilegeName ? `the ${deniedPrivilegeName} privilege` : 'permission';
  return `This MySQL user doesn't have ${missingPermissionDescription} on one of this table's columns. ${PRIVILEGE_GRANT_ADVICE}`;
}

export const MYSQL_SPECIFIC_PRIVILEGE_REQUIRED_MESSAGE =
  'This MySQL user lacks a privilege this operation needs. Grant the missing privilege, or connect with a user that has it.';

// Locks, read-only servers, timeouts.
export const MYSQL_LOCK_WAIT_TIMEOUT_MESSAGE =
  'MySQL timed out waiting for a lock held by another transaction or session. Try again when the table is less busy.';

export const MYSQL_DEADLOCK_MESSAGE =
  'MySQL rolled back this change because it deadlocked with another transaction. Try again.';

export const MYSQL_READ_ONLY_SERVER_MESSAGE =
  "The MySQL server refused the change because it's read-only (for example a read replica or an Aurora reader endpoint). Connect to the primary (writer) endpoint to publish.";

export function buildMySqlStatementTimeoutMessage(statementTimeoutMs: number): string {
  const statementTimeoutForDisplay = describeDurationForDisplay(statementTimeoutMs);
  const limitDescription = statementTimeoutForDisplay
    ? `longer than ${statementTimeoutForDisplay} (Scratch's limit per query)`
    : "longer than Scratch's limit per query";
  return `The MySQL query ran ${limitDescription} and the server stopped it. If this happened during a pull, add a filter to pull fewer rows; otherwise try again when the server is less busy.`;
}

export const MYSQL_QUERY_INTERRUPTED_MESSAGE =
  'The MySQL server interrupted the query before it finished (it may have hit a server time limit or been cancelled). Try again, or add a filter to pull fewer rows.';

// Tables, columns and data. Data errors append the redacted server message (it names the column and value).
export const MYSQL_TABLE_NOT_FOUND_MESSAGE =
  "The table doesn't exist in MySQL any more (it may have been renamed or dropped since the last pull).";

export const MYSQL_DATA_ERROR_LEAD_SENTENCES = {
  unknownColumn:
    "A column Scratch used doesn't exist in the table. The table's columns may have changed since the last full pull (run a full pull to refresh them), or the table's filter may name a column that doesn't exist.",
  duplicateUniqueValue: 'Another row already has this value in a column that must be unique.',
  requiredColumnNull: "A column that can't be empty was given no value.",
  requiredColumnWithoutDefault: 'A required column has no value and no default.',
  valueTooLong: 'A value is too long for its column.',
  numberOutOfRange: 'A number is out of range for its column.',
  valueDoesNotFitColumn:
    "A value doesn't fit its column (for example a choice that isn't one of the column's options).",
  incorrectDateTimeOrNumber: "A date, time or number isn't in a form MySQL accepts.",
  valueDoesNotMatchColumnType: "A value doesn't match its column's type.",
  rowStillReferenced:
    "This row is still referenced by rows in another table (foreign key), so it can't be deleted or changed.",
  referencedRowMissing: "A value refers to a row that doesn't exist in the linked table (foreign key).",
  generatedColumnWritten: "A column that MySQL calculates itself (a generated column) can't be written.",
  checkConstraintViolated: "A value breaks one of the table's CHECK constraints.",
  mariaDbConstraintViolated:
    "A value breaks one of the table's constraints (on MariaDB this includes a JSON column given text that isn't valid JSON).",
  invalidJson: "A value isn't valid JSON.",
} as const;

/** `<lead sentence> Server message: <redacted sqlMessage>`; just the lead when the server sent no text. */
export function buildMySqlDataErrorMessage(leadSentence: string, sqlMessage: string | undefined): string {
  const redactedServerMessage = sqlMessage === undefined ? '' : redactMySqlServerMessageForDisplay(sqlMessage);
  return redactedServerMessage
    ? `${leadSentence} ${MYSQL_SERVER_MESSAGE_LABEL} ${redactedServerMessage}`
    : leadSentence;
}

// Schema creation (the DDL module may throw richer MySqlClientErrors; these are the generic fallbacks).
export const MYSQL_TABLE_ALREADY_EXISTS_MESSAGE = 'A table with that name already exists in this database.';
export const MYSQL_DUPLICATE_COLUMN_NAME_MESSAGE = 'A column with that name already exists in this table.';
export const MYSQL_IDENTIFIER_TOO_LONG_MESSAGE =
  'A table or column name is too long for MySQL (64 characters at most).';
export const MYSQL_INDEX_KEY_TOO_LONG_MESSAGE = "An index is longer than MySQL's maximum key length.";
export const MYSQL_ROW_SIZE_TOO_LARGE_MESSAGE =
  'The table has more (or wider) columns than fit in one MySQL row. Use fewer or smaller columns.';
export const MYSQL_FOREIGN_KEY_REJECTED_MESSAGE =
  "MySQL couldn't create the foreign key: the referenced table or column is missing, isn't indexed, or has a different type or character set.";
export const MYSQL_DUPLICATE_FOREIGN_KEY_NAME_MESSAGE = 'A foreign key with that name already exists in this database.';

// Other server errors.
export const MYSQL_PACKET_TOO_LARGE_MESSAGE =
  "A value is larger than the MySQL server's max_allowed_packet setting. Raise max_allowed_packet on the server, or make the value smaller.";

export function buildMySqlInvalidSqlMessage(errno: number): string {
  return `MySQL rejected the query as invalid SQL (error ${errno}). If this table has a filter, check the filter's syntax.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------------------------

interface MySqlErrorPresentation {
  readonly category: MySqlErrorCategory;
  readonly userFriendlyMessage: string;
}

function describeMySqlErrorWithoutSafetyNet(error: unknown, context: MySqlErrorMappingContext): ConnectorErrorDetails {
  // (1) Errors the connector raised itself already carry a safe, final message.
  if (error instanceof MySqlClientError) {
    return {
      userFriendlyMessage: error.userFriendlyMessage,
      description: error.userFriendlyMessage,
      additionalContext: { category: 'connector', mySqlClientProblem: error.problem },
      ...(error.errorCode !== undefined ? { errorCode: error.errorCode } : {}),
    };
  }
  if (isUserFriendlyError(error) && typeof error.userFriendlyMessage === 'string') {
    // A user-friendly error that also carries server-only diagnostics keeps its own (safe) message, but the
    // diagnostics still reach the log.
    logServerOnlyInternalDetailsIfPresent(error);
    const knownConnectorErrorCode = readKnownConnectorErrorCode(readProperty(error, 'errorCode'));
    return {
      userFriendlyMessage: error.userFriendlyMessage,
      description: error.userFriendlyMessage,
      additionalContext: { category: 'connector' },
      ...(knownConnectorErrorCode !== undefined ? { errorCode: knownConnectorErrorCode } : {}),
    };
  }

  const hostAndPortForDisplay = formatMySqlHostAndPortForDisplay(context.host, context.port);

  // (2) The database host guard refused the host (loopback, private, metadata, ...). Its `internalDetails` name the
  // resolved IP and the block reason, so they go to the server log only; the user gets the same generic text for
  // every refused host, so the connector can't be used as an internal-network oracle.
  if (logServerOnlyInternalDetailsIfPresent(error)) {
    return buildErrorDetails({
      category: 'host_guard',
      userFriendlyMessage: buildMySqlHostNotReachableFromScratchMessage(hostAndPortForDisplay),
    });
  }

  // (3) knex couldn't get a pooled connection in time (a slow connect / TLS handshake / session setup).
  if (isKnexConnectionAcquireTimeout(error)) {
    return buildErrorDetails({
      category: 'network',
      userFriendlyMessage: buildMySqlConnectionTimedOutMessage(hostAndPortForDisplay),
      description: 'Timed out acquiring a MySQL connection',
    });
  }

  // (4) The MySQL server answered with an error packet.
  const serverError = readMySqlServerError(error);
  if (serverError !== undefined) {
    return describeMySqlServerError(serverError, context, hostAndPortForDisplay);
  }

  // (5) Network, TLS, protocol and authentication-plugin failures (Node / mysql2 codes, no errno > 0).
  const clientSideErrorCode = readClientSideErrorCode(error);
  if (clientSideErrorCode !== undefined) {
    return describeMySqlClientSideError(error, clientSideErrorCode, context, hostAndPortForDisplay);
  }

  // (6) Anything else: say nothing about the error's text.
  return buildErrorDetails({ category: 'unknown', userFriendlyMessage: MYSQL_UNEXPECTED_FAILURE_MESSAGE });
}

// ---------------------------------------------------------------------------------------------------------------
// (2) Host guard
// ---------------------------------------------------------------------------------------------------------------

/**
 * Logs (warn) a string `internalDetails` property — the convention the SSRF guards use for server-only diagnostics
 * (`SsrfError`, the future shared database host guard). Returns whether one was present.
 */
function logServerOnlyInternalDetailsIfPresent(error: unknown): boolean {
  const internalDetails = readProperty(error, 'internalDetails');
  if (typeof internalDetails !== 'string') return false;
  WSLogger.warn({
    source: 'MySqlErrorMapping',
    message: 'MySQL connector error carries server-only details (not shown to the user)',
    internalDetails,
  });
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// (3) knex pool timeout
// ---------------------------------------------------------------------------------------------------------------

/**
 * knex's `acquireConnection` rewrites tarn's pool timeout into `KnexTimeoutError('Knex: Timeout acquiring a
 * connection. The pool is probably full. ...')` (`knex/lib/client.js`). The class name is the primary signal. The
 * message prefix is a fallback for when the class name got lost (e.g. the error was re-created by a wrapper): that
 * text is a constant knex generates itself — no SQL, server text or address can be in it — which is why this is the
 * only place the mapper looks at `error.message`, and even here only compares a prefix (never echoes it).
 */
const KNEX_CONNECTION_ACQUIRE_TIMEOUT_MESSAGE_PREFIX = 'Knex: Timeout acquiring a connection';

function isKnexConnectionAcquireTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'KnexTimeoutError' || error.message.startsWith(KNEX_CONNECTION_ACQUIRE_TIMEOUT_MESSAGE_PREFIX);
}

// ---------------------------------------------------------------------------------------------------------------
// (4) MySQL server errors
// ---------------------------------------------------------------------------------------------------------------

interface MySqlServerErrorFields {
  readonly errno: number;
  /** mysql2's name for the errno (from MySQL's table — wrong for some MariaDB numbers, see below). */
  readonly errorCodeName?: string;
  readonly sqlState?: string;
  readonly sqlMessage?: string;
}

/**
 * mysql2 names for the server errnos this module handles, for the rare server error that arrives with a `code` but
 * no `errno` (mysql2's `protocolError` path, e.g. MySQL ≥ 8.0.24 sending ER_CLIENT_INTERACTION_TIMEOUT to an idle
 * connection).
 */
const MYSQL_SERVER_ERROR_NUMBER_BY_CODE_NAME: ReadonlyMap<string, number> = new Map([
  ['ER_ACCESS_DENIED_ERROR', 1045],
  ['ER_DBACCESS_DENIED_ERROR', 1044],
  ['ER_BAD_DB_ERROR', 1049],
  ['ER_HOST_NOT_PRIVILEGED', 1130],
  ['ER_HOST_IS_BLOCKED', 1129],
  ['ER_CON_COUNT_ERROR', 1040],
  ['ER_TOO_MANY_USER_CONNECTIONS', 1203],
  ['ER_USER_LIMIT_REACHED', 1226],
  ['ER_NOT_SUPPORTED_AUTH_MODE', 1251],
  ['ER_MUST_CHANGE_PASSWORD', 1820],
  ['ER_MUST_CHANGE_PASSWORD_LOGIN', 1862],
  ['ER_ACCOUNT_HAS_BEEN_LOCKED', 3118],
  ['ER_SECURE_TRANSPORT_REQUIRED', 3159],
  ['ER_HANDSHAKE_ERROR', 1043],
  ['ER_TABLEACCESS_DENIED_ERROR', 1142],
  ['ER_COLUMNACCESS_DENIED_ERROR', 1143],
  ['ER_SPECIFIC_ACCESS_DENIED_ERROR', 1227],
  ['ER_LOCK_WAIT_TIMEOUT', 1205],
  ['ER_LOCK_DEADLOCK', 1213],
  ['ER_OPTION_PREVENTS_STATEMENT', 1290],
  ['ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION', 1792],
  ['ER_READ_ONLY_MODE', 1836],
  ['ER_QUERY_TIMEOUT', 3024],
  ['ER_QUERY_INTERRUPTED', 1317],
  ['ER_NO_SUCH_TABLE', 1146],
  ['ER_BAD_FIELD_ERROR', 1054],
  ['ER_DUP_ENTRY', 1062],
  ['ER_BAD_NULL_ERROR', 1048],
  ['ER_NO_DEFAULT_FOR_FIELD', 1364],
  ['ER_DATA_TOO_LONG', 1406],
  ['ER_WARN_DATA_OUT_OF_RANGE', 1264],
  ['WARN_DATA_TRUNCATED', 1265],
  ['ER_TRUNCATED_WRONG_VALUE', 1292],
  ['ER_TRUNCATED_WRONG_VALUE_FOR_FIELD', 1366],
  ['ER_ROW_IS_REFERENCED_2', 1451],
  ['ER_NO_REFERENCED_ROW_2', 1452],
  ['ER_ROW_IS_REFERENCED', 1217],
  ['ER_NO_REFERENCED_ROW', 1216],
  ['ER_NON_DEFAULT_VALUE_FOR_GENERATED_COLUMN', 3105],
  ['ER_CHECK_CONSTRAINT_VIOLATED', 3819],
  ['ER_INVALID_JSON_TEXT', 3140],
  ['ER_TABLE_EXISTS_ERROR', 1050],
  ['ER_DUP_FIELDNAME', 1060],
  ['ER_TOO_LONG_IDENT', 1059],
  ['ER_TOO_LONG_KEY', 1071],
  ['ER_TOO_MANY_FIELDS', 1117],
  ['ER_TOO_BIG_ROWSIZE', 1118],
  ['ER_CANT_CREATE_TABLE', 1005],
  ['ER_CANNOT_ADD_FOREIGN', 1215],
  ['ER_FK_NO_INDEX_PARENT', 1822],
  ['ER_FK_CANNOT_OPEN_PARENT', 1824],
  ['ER_FK_INCOMPATIBLE_COLUMNS', 3780],
  ['ER_FK_DUP_NAME', 1826],
  ['ER_NET_PACKET_TOO_LARGE', 1153],
  ['ER_PARSE_ERROR', 1064],
  ['ER_SYNTAX_ERROR', 1149],
  ['ER_CLIENT_INTERACTION_TIMEOUT', 4031],
]);

/** MariaDB's own errno block. MySQL numbers jump from ~1887 to 3000, so nothing else emits these. */
const MARIADB_ONLY_SERVER_ERROR_NUMBER_RANGE = { first: 1900, last: 1999 } as const;
const FIRST_SERVER_ERROR_NUMBER_REUSED_DIFFERENTLY_BY_MARIADB = 4000;
const MARIADB_CONSTRAINT_FAILED_ERROR_NUMBER = 4025;
/** MariaDB's 4025 (ER_CONSTRAINT_FAILED) is SQLSTATE 23000; MySQL's 4025 (an InnoDB DDL error) is HY000. */
const INTEGRITY_CONSTRAINT_VIOLATION_SQL_STATE = '23000';

/**
 * Whether an errno must be read with MariaDB's error table. mysql2 names every errno from MySQL's table, which is
 * wrong for MariaDB's numbers ≥ 1900. MariaDB's 1900–1999 block is unambiguous (MySQL never uses it — e.g. 1906
 * generated-column write, 1969 max_statement_time, which mysql2 leaves without a code). From 4000 up the tables
 * collide, so the detected flavor decides; for 4025 with an unknown flavor, the SQLSTATE does.
 */
function isMariaDbSpecificServerErrorNumber(
  errno: number,
  sqlState: string | undefined,
  serverFlavor: MySqlServerFlavor | undefined,
): boolean {
  if (errno >= MARIADB_ONLY_SERVER_ERROR_NUMBER_RANGE.first && errno <= MARIADB_ONLY_SERVER_ERROR_NUMBER_RANGE.last) {
    return true;
  }
  if (errno < FIRST_SERVER_ERROR_NUMBER_REUSED_DIFFERENTLY_BY_MARIADB) return false;
  if (serverFlavor === 'mariadb') return true;
  return (
    serverFlavor === undefined &&
    errno === MARIADB_CONSTRAINT_FAILED_ERROR_NUMBER &&
    sqlState === INTEGRITY_CONSTRAINT_VIOLATION_SQL_STATE
  );
}

function describeMySqlServerError(
  serverError: MySqlServerErrorFields,
  context: MySqlErrorMappingContext,
  hostAndPortForDisplay: string,
): ConnectorErrorDetails {
  const isMariaDbSpecificErrno = isMariaDbSpecificServerErrorNumber(
    serverError.errno,
    serverError.sqlState,
    context.serverFlavor,
  );
  // A MySQL code name next to a MariaDB-only number would be misleading (4025 is not an InnoDB autoextend error).
  const displayedErrorCodeName = isMariaDbSpecificErrno ? undefined : serverError.errorCodeName;
  const presentation = isMariaDbSpecificErrno
    ? presentMariaDbSpecificServerError(serverError, context)
    : presentMySqlServerError(serverError, context, hostAndPortForDisplay);
  const errorPresentation = presentation ?? {
    category: 'server' as const,
    userFriendlyMessage: buildMySqlUnexpectedServerErrorMessage(serverError.errno, displayedErrorCodeName),
  };
  return buildErrorDetails({
    ...errorPresentation,
    description: `MySQL error ${serverError.errno}${displayedErrorCodeName ? ` (${displayedErrorCodeName})` : ''}`,
    errno: serverError.errno,
    errorCodeName: displayedErrorCodeName,
    sqlState: serverError.sqlState,
    serverFlavor: context.serverFlavor,
  });
}

function dataError(leadSentence: string, sqlMessage: string | undefined): MySqlErrorPresentation {
  return { category: 'data', userFriendlyMessage: buildMySqlDataErrorMessage(leadSentence, sqlMessage) };
}

/** MariaDB's own numbers (1900–1999, and ≥ 4000 on a MariaDB server). Undefined = generic fallback. */
function presentMariaDbSpecificServerError(
  serverError: MySqlServerErrorFields,
  context: MySqlErrorMappingContext,
): MySqlErrorPresentation | undefined {
  switch (serverError.errno) {
    case 1906: // ER_WARNING_NON_DEFAULT_VALUE_FOR_VIRTUAL_COLUMN (an error under STRICT_TRANS_TABLES)
      return dataError(MYSQL_DATA_ERROR_LEAD_SENTENCES.generatedColumnWritten, serverError.sqlMessage);
    case 1969: // ER_STATEMENT_TIMEOUT (max_statement_time); mysql2 gives it no code
      return {
        category: 'timeout',
        userFriendlyMessage: buildMySqlStatementTimeoutMessage(context.statementTimeoutMs),
      };
    case MARIADB_CONSTRAINT_FAILED_ERROR_NUMBER: // ER_CONSTRAINT_FAILED: CHECK, incl. the JSON alias's json_valid()
      return dataError(MYSQL_DATA_ERROR_LEAD_SENTENCES.mariaDbConstraintViolated, serverError.sqlMessage);
    default:
      return undefined;
  }
}

/**
 * MySQL's numbers (shared with MariaDB below 1900; 3000–3999 and ≥ 4000 are MySQL's own). Undefined = generic
 * fallback. Only the data errors echo the (redacted) server message; everything that can name the connecting
 * account (`'user'@'ip'`) or echo SQL (1064) uses fixed text.
 */
function presentMySqlServerError(
  serverError: MySqlServerErrorFields,
  context: MySqlErrorMappingContext,
  hostAndPortForDisplay: string,
): MySqlErrorPresentation | undefined {
  const { sqlMessage } = serverError;
  switch (serverError.errno) {
    // Authentication, account state and connection limits (connect phase).
    case 1045: // ER_ACCESS_DENIED_ERROR — sqlMessage names 'user'@'<Scratch's IP>'
      return { category: 'credentials', userFriendlyMessage: buildMySqlAccessDeniedMessage(context.sslMode) };
    case 1044: // ER_DBACCESS_DENIED_ERROR — also what a scoped user gets for a database that doesn't exist
      return {
        category: 'permission',
        userFriendlyMessage: buildMySqlDatabaseAccessDeniedMessage(context.databaseName),
      };
    case 1049: // ER_BAD_DB_ERROR
      return { category: 'credentials', userFriendlyMessage: buildMySqlUnknownDatabaseMessage(context.databaseName) };
    case 1130: // ER_HOST_NOT_PRIVILEGED — sqlMessage names Scratch's address
      return { category: 'network', userFriendlyMessage: buildMySqlHostNotPrivilegedMessage(hostAndPortForDisplay) };
    case 1129: // ER_HOST_IS_BLOCKED
      return { category: 'network', userFriendlyMessage: MYSQL_HOST_BLOCKED_MESSAGE };
    case 1040: // ER_CON_COUNT_ERROR
      return { category: 'server', userFriendlyMessage: MYSQL_TOO_MANY_CONNECTIONS_MESSAGE };
    case 1203: // ER_TOO_MANY_USER_CONNECTIONS
    case 1226: // ER_USER_LIMIT_REACHED
      return { category: 'server', userFriendlyMessage: MYSQL_USER_RESOURCE_LIMIT_REACHED_MESSAGE };
    case 1251: // ER_NOT_SUPPORTED_AUTH_MODE
      return { category: 'credentials', userFriendlyMessage: MYSQL_UNSUPPORTED_AUTHENTICATION_METHOD_MESSAGE };
    case 1820: // ER_MUST_CHANGE_PASSWORD
    case 1862: // ER_MUST_CHANGE_PASSWORD_LOGIN
      return { category: 'credentials', userFriendlyMessage: MYSQL_PASSWORD_EXPIRED_MESSAGE };
    case 3118: // ER_ACCOUNT_HAS_BEEN_LOCKED
    case 3955: // ER_USER_ACCESS_DENIED_FOR_USER_ACCOUNT_BLOCKED_BY_PASSWORD_LOCK (temporary lock, MySQL ≥ 8.0.19)
      return { category: 'credentials', userFriendlyMessage: MYSQL_ACCOUNT_LOCKED_MESSAGE };
    case 3159: // ER_SECURE_TRANSPORT_REQUIRED (require_secure_transport=ON and SSL Mode DISABLED)
      return { category: 'tls', userFriendlyMessage: MYSQL_ENCRYPTED_CONNECTION_REQUIRED_MESSAGE };
    case 1043: // ER_HANDSHAKE_ERROR
      return {
        category: 'network',
        userFriendlyMessage: buildMySqlUnexpectedProtocolResponseMessage(hostAndPortForDisplay),
      };
    case 4031: // ER_CLIENT_INTERACTION_TIMEOUT: the server closed an idle connection
      return {
        category: 'network',
        userFriendlyMessage: buildMySqlConnectionClosedUnexpectedlyMessage(hostAndPortForDisplay),
      };

    // Privileges. The verb comes from an allowlist match, never the raw text (which names 'user'@'ip').
    case 1142: // ER_TABLEACCESS_DENIED_ERROR
      return {
        category: 'permission',
        userFriendlyMessage: buildMySqlTablePrivilegeDeniedMessage(readDeniedPrivilegeName(sqlMessage)),
      };
    case 1143: // ER_COLUMNACCESS_DENIED_ERROR
      return {
        category: 'permission',
        userFriendlyMessage: buildMySqlColumnPrivilegeDeniedMessage(readDeniedPrivilegeName(sqlMessage)),
      };
    case 1227: // ER_SPECIFIC_ACCESS_DENIED_ERROR
      return { category: 'permission', userFriendlyMessage: MYSQL_SPECIFIC_PRIVILEGE_REQUIRED_MESSAGE };

    // Locks, read-only servers, timeouts.
    case 1205: // ER_LOCK_WAIT_TIMEOUT
      return { category: 'lock', userFriendlyMessage: MYSQL_LOCK_WAIT_TIMEOUT_MESSAGE };
    case 1213: // ER_LOCK_DEADLOCK
      return { category: 'lock', userFriendlyMessage: MYSQL_DEADLOCK_MESSAGE };
    case 1290: // ER_OPTION_PREVENTS_STATEMENT (--read-only / --super-read-only)
    case 1792: // ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION
    case 1836: // ER_READ_ONLY_MODE
      return { category: 'read_only', userFriendlyMessage: MYSQL_READ_ONLY_SERVER_MESSAGE };
    case 3024: // ER_QUERY_TIMEOUT (max_execution_time)
      return {
        category: 'timeout',
        userFriendlyMessage: buildMySqlStatementTimeoutMessage(context.statementTimeoutMs),
      };
    case 1317: // ER_QUERY_INTERRUPTED
      return { category: 'timeout', userFriendlyMessage: MYSQL_QUERY_INTERRUPTED_MESSAGE };

    // Tables and columns.
    case 1146: // ER_NO_SUCH_TABLE
      return { category: 'schema', userFriendlyMessage: MYSQL_TABLE_NOT_FOUND_MESSAGE };
    case 1054: // ER_BAD_FIELD_ERROR — the server text names the column
      return {
        category: 'schema',
        userFriendlyMessage: buildMySqlDataErrorMessage(MYSQL_DATA_ERROR_LEAD_SENTENCES.unknownColumn, sqlMessage),
      };

    // Data errors: the redacted server text says which column / value / key failed.
    case 1062: // ER_DUP_ENTRY
      return dataError(MYSQL_DATA_ERROR_LEAD_SENTENCES.duplicateUniqueValue, sqlMessage);
    case 1048: // ER_BAD_NULL_ERROR
      return dataError(MYSQL_DATA_ERROR_LEAD_SENTENCES.requiredColumnNull, sqlMessage);
    case 1364: // ER_NO_DEFAULT_FOR_FIELD
      return dataError(MYSQL_DATA_ERROR_LEAD_SENTENCES.requiredColumnWithoutDefault, sqlMessage);
    case 1406: // ER_DATA_TOO_LONG
      return dataError(MYSQL_DATA_ERROR_LEAD_SENTENCES.valueTooLong, sqlMessage);
    case 1264: // ER_WARN_DATA_OUT_OF_RANGE
      return dataError(MYSQL_DATA_ERROR_LEAD_SENTENCES.numberOutOfRange, sqlMessage);
    case 1265: // WARN_DATA_TRUNCATED (e.g. an ENUM value that isn't a member)
      return dataError(MYSQL_DATA_ERROR_LEAD_SENTENCES.valueDoesNotFitColumn, sqlMessage);
    case 1292: // ER_TRUNCATED_WRONG_VALUE (bad date / time / number text)
      return dataError(MYSQL_DATA_ERROR_LEAD_SENTENCES.incorrectDateTimeOrNumber, sqlMessage);
    case 1366: // ER_TRUNCATED_WRONG_VALUE_FOR_FIELD
      return dataError(MYSQL_DATA_ERROR_LEAD_SENTENCES.valueDoesNotMatchColumnType, sqlMessage);
    case 1451: // ER_ROW_IS_REFERENCED_2
      return dataError(MYSQL_DATA_ERROR_LEAD_SENTENCES.rowStillReferenced, sqlMessage);
    case 1452: // ER_NO_REFERENCED_ROW_2
      return dataError(MYSQL_DATA_ERROR_LEAD_SENTENCES.referencedRowMissing, sqlMessage);
    case 1217: // ER_ROW_IS_REFERENCED (pre-5.1 wording; not on the echo allowlist)
      return dataError(MYSQL_DATA_ERROR_LEAD_SENTENCES.rowStillReferenced, undefined);
    case 1216: // ER_NO_REFERENCED_ROW (pre-5.1 wording; not on the echo allowlist)
      return dataError(MYSQL_DATA_ERROR_LEAD_SENTENCES.referencedRowMissing, undefined);
    case 3105: // ER_NON_DEFAULT_VALUE_FOR_GENERATED_COLUMN
      return dataError(MYSQL_DATA_ERROR_LEAD_SENTENCES.generatedColumnWritten, sqlMessage);
    case 3819: // ER_CHECK_CONSTRAINT_VIOLATED
      return dataError(MYSQL_DATA_ERROR_LEAD_SENTENCES.checkConstraintViolated, sqlMessage);
    case 3140: // ER_INVALID_JSON_TEXT
      return dataError(MYSQL_DATA_ERROR_LEAD_SENTENCES.invalidJson, sqlMessage);
    case 1153: // ER_NET_PACKET_TOO_LARGE
      return { category: 'data', userFriendlyMessage: MYSQL_PACKET_TOO_LARGE_MESSAGE };

    // Schema creation.
    case 1050: // ER_TABLE_EXISTS_ERROR
      return { category: 'schema', userFriendlyMessage: MYSQL_TABLE_ALREADY_EXISTS_MESSAGE };
    case 1060: // ER_DUP_FIELDNAME
      return { category: 'schema', userFriendlyMessage: MYSQL_DUPLICATE_COLUMN_NAME_MESSAGE };
    case 1059: // ER_TOO_LONG_IDENT
      return { category: 'schema', userFriendlyMessage: MYSQL_IDENTIFIER_TOO_LONG_MESSAGE };
    case 1071: // ER_TOO_LONG_KEY
      return { category: 'schema', userFriendlyMessage: MYSQL_INDEX_KEY_TOO_LONG_MESSAGE };
    case 1117: // ER_TOO_MANY_FIELDS
    case 1118: // ER_TOO_BIG_ROWSIZE
      return { category: 'schema', userFriendlyMessage: MYSQL_ROW_SIZE_TOO_LARGE_MESSAGE };
    case 1005: // ER_CANT_CREATE_TABLE (MariaDB's FK failure)
    case 1215: // ER_CANNOT_ADD_FOREIGN
    case 1822: // ER_FK_NO_INDEX_PARENT
    case 1824: // ER_FK_CANNOT_OPEN_PARENT
    case 3780: // ER_FK_INCOMPATIBLE_COLUMNS
    case 6125: // ER_FK_NO_UNIQUE_INDEX_PARENT (MySQL ≥ 8.4)
      return { category: 'schema', userFriendlyMessage: MYSQL_FOREIGN_KEY_REJECTED_MESSAGE };
    case 1826: // ER_FK_DUP_NAME
      return { category: 'schema', userFriendlyMessage: MYSQL_DUPLICATE_FOREIGN_KEY_NAME_MESSAGE };

    // The server text of a syntax error quotes the SQL around the error position: never shown.
    case 1064: // ER_PARSE_ERROR
    case 1149: // ER_SYNTAX_ERROR
      return { category: 'server', userFriendlyMessage: buildMySqlInvalidSqlMessage(serverError.errno) };

    default:
      return undefined;
  }
}

/**
 * The privilege named at the start of a 1142 / 1143 message (`INSERT command denied to user 'u'@'h' for table ...`),
 * returned only when it is one of the privileges Scratch uses — the rest of the text is never read.
 */
const DENIED_PRIVILEGE_NAMES_SHOWN_TO_USERS: ReadonlySet<string> = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'ALTER',
  'DROP',
  'INDEX',
  'REFERENCES',
]);

function readDeniedPrivilegeName(sqlMessage: string | undefined): string | undefined {
  const deniedPrivilegeMatch = sqlMessage === undefined ? null : /^([A-Z]+) command denied\b/.exec(sqlMessage);
  const deniedPrivilegeName = deniedPrivilegeMatch?.[1];
  return deniedPrivilegeName !== undefined && DENIED_PRIVILEGE_NAMES_SHOWN_TO_USERS.has(deniedPrivilegeName)
    ? deniedPrivilegeName
    : undefined;
}

/**
 * A server error's fields. mysql2 server errors carry a positive `errno` (Node system errors carry a NEGATIVE one,
 * e.g. -61 for ECONNREFUSED, so the sign matters). A server error delivered with only a `code` is resolved through
 * {@link MYSQL_SERVER_ERROR_NUMBER_BY_CODE_NAME}.
 */
function readMySqlServerError(error: unknown): MySqlServerErrorFields | undefined {
  const rawErrorNumber = readProperty(error, 'errno');
  const errorCodeName = readSanitizedErrorCode(readProperty(error, 'code'));
  const errno =
    typeof rawErrorNumber === 'number' && Number.isSafeInteger(rawErrorNumber) && rawErrorNumber > 0
      ? rawErrorNumber
      : errorCodeName !== undefined
        ? MYSQL_SERVER_ERROR_NUMBER_BY_CODE_NAME.get(errorCodeName)
        : undefined;
  if (errno === undefined) return undefined;
  const sqlMessage = readProperty(error, 'sqlMessage');
  return {
    errno,
    errorCodeName,
    sqlState: readSanitizedSqlState(readProperty(error, 'sqlState')),
    sqlMessage: typeof sqlMessage === 'string' ? sqlMessage : undefined,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// (5) Network, TLS, protocol and authentication-plugin failures
// ---------------------------------------------------------------------------------------------------------------

/**
 * The code of a failure that never reached a MySQL error packet. `AggregateError` (Node's happy-eyeballs connect to a
 * name with several addresses, e.g. `localhost` → ::1 and 127.0.0.1) usually carries the code itself; otherwise the
 * first inner error's code is used. The inner errors' `address` fields (resolved IPs) are never read.
 */
function readClientSideErrorCode(error: unknown): string | undefined {
  const ownErrorCode = readSanitizedErrorCode(readProperty(error, 'code'));
  if (ownErrorCode !== undefined) return ownErrorCode;
  const innerErrors = readProperty(error, 'errors');
  if (!Array.isArray(innerErrors)) return undefined;
  for (const innerError of innerErrors) {
    const innerErrorCode = readSanitizedErrorCode(readProperty(innerError, 'code'));
    if (innerErrorCode !== undefined) return innerErrorCode;
  }
  return undefined;
}

function describeMySqlClientSideError(
  error: unknown,
  clientSideErrorCode: string,
  context: MySqlErrorMappingContext,
  hostAndPortForDisplay: string,
): ConnectorErrorDetails {
  const presentation = presentMySqlClientSideError(error, clientSideErrorCode, context, hostAndPortForDisplay) ?? {
    category: 'unknown' as const,
    userFriendlyMessage: buildMySqlUnexpectedFailureMessage(clientSideErrorCode),
  };
  return buildErrorDetails({
    ...presentation,
    description: `MySQL connection error (${clientSideErrorCode})`,
    errorCodeName: clientSideErrorCode,
    syscall: readSanitizedSyscall(readProperty(error, 'syscall')),
  });
}

function presentMySqlClientSideError(
  error: unknown,
  clientSideErrorCode: string,
  context: MySqlErrorMappingContext,
  hostAndPortForDisplay: string,
): MySqlErrorPresentation | undefined {
  const hostForDisplay = sanitizeUserTypedTextForDisplay(context.host, MAXIMUM_DISPLAYED_HOST_CHARACTERS);
  switch (clientSideErrorCode) {
    case 'ECONNREFUSED':
      return { category: 'network', userFriendlyMessage: buildMySqlConnectionRefusedMessage(hostAndPortForDisplay) };
    case 'ETIMEDOUT': // Node's connect timeout, or mysql2's connectTimeout (also covers "no MySQL greeting")
      return { category: 'network', userFriendlyMessage: buildMySqlConnectionTimedOutMessage(hostAndPortForDisplay) };
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return { category: 'network', userFriendlyMessage: buildMySqlHostUnreachableMessage(hostAndPortForDisplay) };
    case 'ENOTFOUND':
      return { category: 'network', userFriendlyMessage: buildMySqlHostNotFoundMessage(hostForDisplay) };
    case 'EAI_AGAIN':
      return { category: 'network', userFriendlyMessage: buildMySqlHostLookupTemporarilyFailedMessage(hostForDisplay) };
    case 'ECONNRESET':
    case 'EPIPE':
    case 'PROTOCOL_CONNECTION_LOST':
      return {
        category: 'network',
        userFriendlyMessage: buildMySqlConnectionClosedUnexpectedlyMessage(hostAndPortForDisplay),
      };
    case 'PROTOCOL_SEQUENCE_TIMEOUT': // mysql2's per-query inactivity timeout
      return {
        category: 'network',
        userFriendlyMessage: buildMySqlServerStoppedRespondingMessage(hostAndPortForDisplay),
      };
    case 'PROTOCOL_ERROR':
    case 'PROTOCOL_UNEXPECTED_PACKET':
    case 'HANDSHAKE_UNKNOWN_ERROR':
      return {
        category: 'network',
        userFriendlyMessage: buildMySqlUnexpectedProtocolResponseMessage(hostAndPortForDisplay),
      };
    case 'HANDSHAKE_SSL_ERROR':
      return {
        category: 'tls',
        userFriendlyMessage: describeTlsHandshakeFailure(error, context, hostAndPortForDisplay),
      };
    case 'HANDSHAKE_NO_SSL_SUPPORT':
      return { category: 'tls', userFriendlyMessage: buildMySqlServerWithoutTlsSupportMessage(hostAndPortForDisplay) };
    case 'AUTH_SWITCH_PLUGIN_ERROR': // e.g. MariaDB ed25519 / parsec: mysql2 has no plugin for them
      return { category: 'credentials', userFriendlyMessage: MYSQL_UNSUPPORTED_AUTHENTICATION_METHOD_MESSAGE };
    case 'MYSQL_CLEAR_PASSWORD_NOT_ENABLED': // IAM / Entra / LDAP / PAM tokens, which we never send in clear text
      return {
        category: 'credentials',
        userFriendlyMessage: MYSQL_CLEAR_TEXT_PASSWORD_AUTHENTICATION_UNSUPPORTED_MESSAGE,
      };
    default:
      return undefined;
  }
}

/**
 * mysql2 overwrites the TLS error's own code (`SELF_SIGNED_CERT_IN_CHAIN`, `ERR_TLS_CERT_ALTNAME_INVALID`, ...) with
 * `HANDSHAKE_SSL_ERROR`, so what's left to go on is the SSL mode and one structural signal: Node's hostname-check
 * error (`tls.checkServerIdentity`) carries the peer certificate as `cert` and a `reason` string. Neither those nor
 * the message are shown — they contain the certificate's names and addresses.
 */
function describeTlsHandshakeFailure(
  error: unknown,
  context: MySqlErrorMappingContext,
  hostAndPortForDisplay: string,
): string {
  switch (context.sslMode) {
    case 'VERIFY_IDENTITY':
      if (isNodeTlsHostnameMismatchError(error)) {
        return buildMySqlTlsCertificateHostnameMismatchMessage(
          sanitizeUserTypedTextForDisplay(context.host, MAXIMUM_DISPLAYED_HOST_CHARACTERS),
        );
      }
      return buildMySqlTlsCertificateVerificationFailedMessage(hostAndPortForDisplay, context.sslMode);
    case 'VERIFY_CA':
      return buildMySqlTlsCertificateVerificationFailedMessage(hostAndPortForDisplay, context.sslMode);
    case 'REQUIRED': // no certificate checks in this mode, so this is a protocol-level TLS failure
    case 'DISABLED': // mysql2 never starts TLS in this mode; kept total
      return buildMySqlTlsHandshakeFailedMessage(hostAndPortForDisplay, context.sslMode);
    default:
      return assertUnreachable(context.sslMode);
  }
}

function isNodeTlsHostnameMismatchError(error: unknown): boolean {
  const peerCertificate = readProperty(error, 'cert');
  return (
    typeof peerCertificate === 'object' && peerCertificate !== null && typeof readProperty(error, 'reason') === 'string'
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Output assembly and sanitizers
// ---------------------------------------------------------------------------------------------------------------

function buildErrorDetails(params: {
  category: MySqlErrorCategory;
  userFriendlyMessage: string;
  description?: string;
  errno?: number;
  errorCodeName?: string;
  sqlState?: string;
  syscall?: string;
  serverFlavor?: MySqlServerFlavor;
}): ConnectorErrorDetails {
  const additionalContext: Record<string, unknown> = { category: params.category };
  if (params.errno !== undefined) additionalContext.errno = params.errno;
  if (params.errorCodeName !== undefined) additionalContext.code = params.errorCodeName;
  if (params.sqlState !== undefined) additionalContext.sqlState = params.sqlState;
  if (params.syscall !== undefined) additionalContext.syscall = params.syscall;
  if (params.serverFlavor !== undefined) additionalContext.serverFlavor = params.serverFlavor;
  return {
    userFriendlyMessage: params.userFriendlyMessage,
    description: params.description ?? params.userFriendlyMessage,
    additionalContext,
  };
}

function readKnownConnectorErrorCode(value: unknown): ConnectorErrorCode | undefined {
  return Object.values(ConnectorErrorCode).find((knownConnectorErrorCode) => knownConnectorErrorCode === value);
}

/** Reads one property of an arbitrary thrown value (anything but an object → undefined). */
function readProperty(value: unknown, propertyName: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
  return (value as Record<string, unknown>)[propertyName];
}

/** Error codes are identifiers from fixed vocabularies (mysql2 / Node); anything else is dropped, never echoed. */
function readSanitizedErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : undefined;
}

function readSanitizedSqlState(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9A-Z]{5}$/.test(value) ? value : undefined;
}

function readSanitizedSyscall(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z_]{1,32}$/.test(value) ? value : undefined;
}

const MAXIMUM_DISPLAYED_HOST_CHARACTERS = 255;
/** MySQL database names are at most 64 characters. */
const MAXIMUM_DISPLAYED_DATABASE_NAME_CHARACTERS = 64;

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTER_RUN_PATTERN = /[\u0000-\u001f\u007f]+/g;

/**
 * Text the user typed (host, database), shown back to them. Already validated by the credential parser; this only
 * keeps a message single-line and bounded.
 */
function sanitizeUserTypedTextForDisplay(userTypedText: string, maximumCharacters: number): string {
  return truncateForDisplay(userTypedText.replace(CONTROL_CHARACTER_RUN_PATTERN, ' ').trim(), maximumCharacters);
}

function sanitizeOptionalUserTypedTextForDisplay(userTypedText: string | undefined): string | undefined {
  if (userTypedText === undefined) return undefined;
  const sanitizedText = sanitizeUserTypedTextForDisplay(userTypedText, MAXIMUM_DISPLAYED_DATABASE_NAME_CHARACTERS);
  return sanitizedText === '' ? undefined : sanitizedText;
}

/** Cut to at most `maximumCharacters` code points (never splitting a surrogate pair), ending in an ellipsis. */
function truncateForDisplay(text: string, maximumCharacters: number): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= maximumCharacters) return text;
  return `${codePoints.slice(0, maximumCharacters - 1).join('')}…`;
}

/** `'user'@'host'` as MySQL / MariaDB print the connecting account; the host half is Scratch's address. */
const MYSQL_ACCOUNT_USER_AT_HOST_PATTERN = /('(?:[^'\\]|\\.)*')@'[^']*'/g;

/** Dotted quads not embedded in a longer dotted number (`1.2.3.4.5`); a trailing sentence period is fine. */
const IPV4_ADDRESS_PATTERN = /(?<!\d)(?<!\d\.)(?:\d{1,3}\.){3}\d{1,3}(?!\.?\d)/g;

/**
 * A maximal run of hex groups and colons, optionally ending in a dotted quad (tried first, so `::ffff:10.0.0.1` is one
 * candidate) and a `%zone`. Each candidate is confirmed with `net.isIP` before redaction, so times (`12:34:56`) and
 * MAC addresses survive.
 */
const IPV6_ADDRESS_CANDIDATE_PATTERN =
  /(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{0,4}:){2,7}(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9A-Fa-f]{0,4})(?:%[0-9A-Za-z._-]+)?(?![0-9A-Fa-f:])/g;

function isIpv6AddressLiteral(candidate: string): boolean {
  const zoneSeparatorIndex = candidate.indexOf('%');
  const addressWithoutZone = zoneSeparatorIndex === -1 ? candidate : candidate.slice(0, zoneSeparatorIndex);
  return isIP(addressWithoutZone) === 6;
}

const MILLISECONDS_PER_SECOND = 1000;
const MILLISECONDS_PER_MINUTE = 60_000;

/** `300000` → `5 minutes`, `60000` → `1 minute`, `1500` → `1.5 seconds`; undefined for a non-positive duration. */
function describeDurationForDisplay(durationMs: number): string | undefined {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return undefined;
  if (durationMs % MILLISECONDS_PER_MINUTE === 0) {
    const durationMinutes = durationMs / MILLISECONDS_PER_MINUTE;
    return `${durationMinutes} minute${durationMinutes === 1 ? '' : 's'}`;
  }
  const durationSeconds = Math.round((durationMs / MILLISECONDS_PER_SECOND) * 10) / 10;
  return `${durationSeconds} second${durationSeconds === 1 ? '' : 's'}`;
}
