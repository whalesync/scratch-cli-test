/**
 * Our own, allowlisted parser for a pasted MySQL connection string. It is used ONLY while creating or editing a
 * connection: the result is decomposed into the discrete settings (host, port, database, username, password, SSL
 * mode) and the URL itself is never stored and never reaches mysql2.
 *
 * Why not mysql2's URL support or WHATWG `URL`:
 * - mysql2 JSON-parses EVERY query parameter into a driver option (`socketPath`, `multipleStatements`, `flags`,
 *   `localAddress`, `infileStreamFactory`, ...), so a pasted URL could reconfigure the driver. Here only the SSL
 *   options below are understood, and every other parameter is rejected BY NAME — except a name that may be part
 *   of the password (see {@link parseMySqlConnectionStringQueryParameters}), which is rejected without its name.
 * - WHATWG `URL` mis-splits a password containing an unencoded `/`, `?` or `#` (common in generated passwords),
 *   which is the bug the Supabase parser papers over with a heuristic. We split the authority ourselves.
 *
 * Accepted: `mysql://`, `mysql2://` (Rails), `mariadb://`, `jdbc:mysql://`, `jdbc:mariadb://` and SQLAlchemy's
 * `mysql+<driver>://` / `mariadb+<driver>://`, with `user:password@host:port/database?ssl-options`.
 *
 * Error messages never contain the connection string, the password (or a fragment of it), the username or a
 * parameter value.
 */
import net from 'node:net';
import {
  MySqlCredentialProblem,
  MySqlCredentialsInvalidError,
  mySqlConnectionStringParameterNameLooksLikeAnOptionName,
} from './mysql-credential-errors';
import { mapMySqlSslModeSpellingToSslMode } from './mysql-ssl-mode';
import { type MySqlSslMode } from './mysql-types';

export const MYSQL_CONNECTION_STRING_MAX_LENGTH = 8192;
/** Bound on the `ssl={json}` option before it is parsed. */
const MYSQL_CONNECTION_STRING_SSL_JSON_OPTION_MAX_LENGTH = 512;

export interface ParsedMySqlConnectionString {
  /**
   * Hostname or IP literal; an IPv6 literal WITHOUT its brackets. Only syntax-checked here — the caller applies
   * the same host rules as the Host field.
   */
  readonly host: string;
  readonly port: number | undefined;
  /** Percent-decoded; undefined when the URL has no (or an empty) path. */
  readonly databaseName: string | undefined;
  /** From the userinfo (`user:password@`) or `?user=`; always non-empty. */
  readonly username: string;
  /** Undefined when the URL has none (or an empty one). */
  readonly password: string | undefined;
  /** The TLS mode the connection string's SSL options ask for; undefined when it has none. */
  readonly sslModeFromConnectionString: MySqlSslMode | undefined;
}

const PASTE_THE_FIELDS_INSTEAD = 'Fill in Host, Port, Database, Username and Password instead.';
const SUPPORTED_CONNECTION_STRING_SCHEMES_DESCRIPTION = 'mysql://, mariadb:// or jdbc:mysql://';
const UNPARSEABLE_CONNECTION_STRING_MESSAGE =
  "Scratch couldn't read this connection string. If your password has special characters (@ / ? # %), " +
  'percent-encode them (e.g. @ as %40), or use the Host, Username and Password fields instead.';
/** Added when a rejected query parameter may really be a piece of the password that an unencoded `&` split off. */
const PERCENT_ENCODE_PASSWORD_SPECIAL_CHARACTERS_HINT =
  'If your password contains special characters (& = # % ? / @), percent-encode them (e.g. & as %26).';
const REMOVE_UNSUPPORTED_OPTIONS_GUIDANCE =
  "Remove everything after '?' except SSL settings (ssl-mode, sslaccept, ssl, useSSL, requireSSL).";
/** The query also carries credentials here, so "remove everything except SSL settings" would drop them. */
const REMOVE_UNSUPPORTED_OPTIONS_AFTER_PASSWORD_GUIDANCE =
  "Otherwise keep only user, password and SSL settings (ssl-mode, sslaccept, ssl, useSSL, requireSSL) after '?'.";

const CONNECTION_STRING_SCHEME_PATTERN = /^([a-z][a-z0-9+.:-]*):\/\//i;
const ACCEPTED_MYSQL_CONNECTION_STRING_SCHEMES: ReadonlySet<string> = new Set([
  'mysql',
  'mysql2',
  'mariadb',
  'jdbc:mysql',
  'jdbc:mariadb',
]);
/** SQLAlchemy's `dialect+driver` form, e.g. `mysql+pymysql`, `mariadb+mariadbconnector`. */
const DRIVER_QUALIFIED_MYSQL_SCHEME_PATTERN = /^(mysql|mariadb)\+[a-z0-9_]+$/;
const POSTGRES_SCHEME_PATTERN = /^(jdbc:)?postgres(ql)?(\+[a-z0-9_]+)?$/;
const MYSQL_X_PROTOCOL_SCHEME_PATTERN = /^(jdbc:)?mysqlx(\+[a-z0-9_]+)?$/;
/** `mysql+srv://`: the host is a DNS SRV name, which mysql2 can't resolve (it would dial the SRV name itself). */
const DNS_SRV_SCHEME_PATTERN = /^(jdbc:)?(mysql|mariadb)\+srv$/;
/** Connector/J `jdbc:mysql:loadbalance://`, `jdbc:mysql:replication://`, MariaDB `jdbc:mariadb:sequential://`, ... */
const MULTI_HOST_JDBC_SCHEME_PATTERN = /^jdbc:(mysql|mariadb):[a-z]+$/;

/** Go's go-sql-driver DSN: `user:password@tcp(host:3306)/database`. */
const GO_SQL_DRIVER_DSN_PATTERN = /(^|@)(tcp6?|unix|udp)\(/i;
/** ADO.NET / ODBC `Key=Value;` strings: `Server=db;Uid=me;Pwd=...;Database=app`. */
const KEY_VALUE_CONNECTION_STRING_PATTERN =
  /(^|;)\s*(server|data source|datasource|host|uid|user id|userid|pwd|password|database|initial catalog|port|sslmode|driver)\s*=/i;

const HOSTNAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const PORT_TEXT_PATTERN = /^\d{1,5}$/;

/** Query-parameter keys after normalization (lower-cased, `-` and `_` removed). */
const SSL_MODE_PARAMETER_KEY = 'sslmode'; // ssl-mode (MySQL), sslmode (libpq), sslMode (Connector/J 8), ssl_mode
const SSL_ACCEPT_PARAMETER_KEY = 'sslaccept'; // Prisma
const SSL_PARAMETER_KEY = 'ssl'; // mysql2 / Node drivers
const USE_SSL_PARAMETER_KEY = 'usessl'; // Connector/J 5.1
const REQUIRE_SSL_PARAMETER_KEY = 'requiressl'; // Connector/J 5.1
const VERIFY_SERVER_CERTIFICATE_PARAMETER_KEY = 'verifyservercertificate'; // Connector/J 5.1
const USER_PARAMETER_KEY = 'user'; // JDBC, Azure
const PASSWORD_PARAMETER_KEY = 'password'; // JDBC, Azure
/** Our spelling of Connector/J 5.1's boolean SSL options, used in messages when the typed name may be password text. */
const CONNECTOR_J_BOOLEAN_SSL_OPTION_SPELLINGS: Readonly<Record<string, string>> = {
  [USE_SSL_PARAMETER_KEY]: 'useSSL',
  [REQUIRE_SSL_PARAMETER_KEY]: 'requireSSL',
  [VERIFY_SERVER_CERTIFICATE_PARAMETER_KEY]: 'verifyServerCertificate',
};
/** Options that point at certificate FILES on the client machine; Scratch has no such files. */
const CERTIFICATE_PATH_PARAMETER_KEYS: ReadonlySet<string> = new Set([
  'sslca',
  'sslcapath',
  'sslrootcert',
  'sslcert',
  'sslkey',
  'sslcrl',
  'sslcrlpath',
  'serversslcert',
  'trustcertificatekeystoreurl',
  'clientcertificatekeystoreurl',
]);
/** The only keys an `ssl={...}` JSON option may set; every other key (`ca`, `key`, `__proto__`, ...) is rejected. */
const ALLOWED_SSL_JSON_OPTION_KEYS: ReadonlySet<string> = new Set(['rejectUnauthorized', 'verifyIdentity']);
/**
 * Rejected `ssl={...}` keys that a message may name: Node TLS / mysql2 option names people copy from driver docs.
 * The JSON is part of a query-parameter VALUE, so any other key is described without echoing it.
 */
const NAMEABLE_REJECTED_SSL_JSON_OPTION_KEYS: ReadonlySet<string> = new Set([
  'ca',
  'cert',
  'key',
  'pfx',
  'passphrase',
  'crl',
  'ciphers',
  'minVersion',
  'maxVersion',
  'secureProtocol',
  'servername',
  'checkServerIdentity',
  'sigalgs',
  'ecdhCurve',
  'honorCipherOrder',
  'secureOptions',
  'dhparam',
  'sessionIdContext',
  'ALPNProtocols',
]);

/** Parse a pasted MySQL connection string into discrete settings. Throws {@link MySqlCredentialsInvalidError}. */
export function parseMySqlConnectionString(connectionString: string): ParsedMySqlConnectionString {
  const trimmedConnectionString = connectionString.trim();
  if (trimmedConnectionString.length > MYSQL_CONNECTION_STRING_MAX_LENGTH) {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.SettingTooLong,
      `Connection String is too long (at most ${MYSQL_CONNECTION_STRING_MAX_LENGTH} characters).`,
    );
  }

  const schemeMatch = CONNECTION_STRING_SCHEME_PATTERN.exec(trimmedConnectionString);
  if (!schemeMatch) {
    throw describeConnectionStringWithoutScheme(trimmedConnectionString);
  }
  assertMySqlConnectionStringSchemeIsSupported(schemeMatch[1].toLowerCase());

  const connectionStringAfterScheme = trimmedConnectionString.slice(schemeMatch[0].length);
  const { rawUserinfo, hostPortPathAndQuery } = splitUserinfoFromConnectionStringAuthority(connectionStringAfterScheme);

  if (hostPortPathAndQuery.hasFragment) {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.ConnectionStringFragment,
      "The connection string contains a '#' after the host, which Scratch reads as the end of the address. " +
        "If '#' is part of your password, percent-encode it as %23.",
    );
  }

  const queryParameters = parseMySqlConnectionStringQueryParameters(hostPortPathAndQuery.rawQuery, {
    queryMayHoldUserinfoPasswordText: hostPortPathAndQuery.queryMayHoldUserinfoPasswordText,
  });
  const { username, password } = resolveMySqlConnectionStringCredentials(rawUserinfo, queryParameters);
  const rawDatabasePath = hostPortPathAndQuery.rawDatabasePath;
  const decodedDatabaseName =
    rawDatabasePath === undefined ? undefined : decodePercentEncodedRunsTolerantly(rawDatabasePath);

  return {
    host: hostPortPathAndQuery.host,
    port: hostPortPathAndQuery.port,
    databaseName: decodedDatabaseName === '' ? undefined : decodedDatabaseName,
    username,
    password,
    sslModeFromConnectionString: queryParameters.sslModeFromConnectionString,
  };
}

/**
 * Decode `%XX` runs; anything that isn't a valid escape stays literal: `50%off` keeps its `%`, `+` stays `+`
 * (a URL path/userinfo `+` is not a space), and a run that isn't valid UTF-8 is kept as typed.
 */
export function decodePercentEncodedRunsTolerantly(rawText: string): string {
  return rawText.replace(/(?:%[0-9A-Fa-f]{2})+/g, (percentEncodedRun) => {
    try {
      return decodeURIComponent(percentEncodedRun);
    } catch {
      return percentEncodedRun;
    }
  });
}

function describeConnectionStringWithoutScheme(trimmedConnectionString: string): MySqlCredentialsInvalidError {
  if (GO_SQL_DRIVER_DSN_PATTERN.test(trimmedConnectionString)) {
    return new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.ConnectionStringGoDsnNotSupported,
      `Go-style connection strings (user:password@tcp(host:3306)/database) aren't supported. ${PASTE_THE_FIELDS_INSTEAD}`,
    );
  }
  if (KEY_VALUE_CONNECTION_STRING_PATTERN.test(trimmedConnectionString)) {
    return new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.ConnectionStringAdoNetNotSupported,
      `Key=value connection strings (Server=...;Uid=...;) aren't supported. ${PASTE_THE_FIELDS_INSTEAD}`,
    );
  }
  return new MySqlCredentialsInvalidError(
    MySqlCredentialProblem.ConnectionStringSchemeUnsupported,
    `The connection string must start with ${SUPPORTED_CONNECTION_STRING_SCHEMES_DESCRIPTION}.`,
  );
}

function assertMySqlConnectionStringSchemeIsSupported(lowerCaseScheme: string): void {
  if (POSTGRES_SCHEME_PATTERN.test(lowerCaseScheme)) {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.ConnectionStringIsPostgres,
      'This is a PostgreSQL connection string. Use the PostgreSQL connector for PostgreSQL databases.',
    );
  }
  if (MYSQL_X_PROTOCOL_SCHEME_PATTERN.test(lowerCaseScheme)) {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.ConnectionStringXProtocol,
      "mysqlx:// connection strings use MySQL's X Protocol, which Scratch doesn't support. " +
        'Use a mysql:// connection string with the classic protocol port (usually 3306).',
    );
  }
  if (DNS_SRV_SCHEME_PATTERN.test(lowerCaseScheme)) {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.ConnectionStringSchemeUnsupported,
      "DNS SRV connection strings (mysql+srv://) aren't supported. Use mysql:// with the server's hostname and port.",
    );
  }
  if (
    ACCEPTED_MYSQL_CONNECTION_STRING_SCHEMES.has(lowerCaseScheme) ||
    DRIVER_QUALIFIED_MYSQL_SCHEME_PATTERN.test(lowerCaseScheme)
  ) {
    return;
  }
  if (MULTI_HOST_JDBC_SCHEME_PATTERN.test(lowerCaseScheme)) {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.ConnectionStringMultipleHosts,
      "Load-balancing, replication and failover JDBC URLs aren't supported. Use a single-host mysql:// connection string.",
    );
  }
  throw new MySqlCredentialsInvalidError(
    MySqlCredentialProblem.ConnectionStringSchemeUnsupported,
    `The connection string must start with ${SUPPORTED_CONNECTION_STRING_SCHEMES_DESCRIPTION}.`,
  );
}

interface ParsedHostPortPathAndQuery {
  readonly host: string;
  readonly port: number | undefined;
  readonly rawDatabasePath: string | undefined;
  readonly rawQuery: string | undefined;
  readonly hasFragment: boolean;
}

type HostPortPathAndQueryParseOutcome =
  | { readonly parsed: true; readonly hostPortPathAndQuery: ParsedHostPortPathAndQuery }
  | { readonly parsed: false; readonly failure: MySqlCredentialsInvalidError };

/**
 * Split `[userinfo@]host[:port][/database][?query][#fragment]`.
 *
 * The userinfo ends at the LAST `@` — a password may contain `@` (and `/ ? # :`) unencoded, while the host, port
 * and database can't, and with userinfo present the query has no reason to carry an `@` either. That `@` is only
 * taken as the userinfo end when:
 * - the username part (before the first `:`) contains no `/ ? #` — otherwise the `@` belongs to the path or the
 *   query (`mysql://host/db?user=a@b`);
 * - the text before it doesn't carry `?user=` / `&password=` — credentials supplied as query parameters
 *   (`jdbc:mysql://host:3306?user=me@example.com`), which would otherwise split into user `host`;
 * - what follows parses as a valid `host[:port][/database][?query]`.
 * Otherwise the string is parsed without userinfo (the username then comes from `?user=`).
 *
 * When that fallback follows a `user:password@` candidate whose host part failed (a typo'd port, say), a `?` in
 * the password has become the start of the query, so the query may hold password text:
 * `mysql://admin:2024?Secret&x@db:99999` reads query `Secret&x@db:99999`. That is reported as
 * `queryMayHoldUserinfoPasswordText`, and no query-parameter name is then echoed.
 */
function splitUserinfoFromConnectionStringAuthority(connectionStringAfterScheme: string): {
  rawUserinfo: string | undefined;
  hostPortPathAndQuery: ParsedHostPortPathAndQuery & { readonly queryMayHoldUserinfoPasswordText: boolean };
} {
  let userinfoCandidateFailure: MySqlCredentialsInvalidError | undefined;
  const lastAtSignIndex = connectionStringAfterScheme.lastIndexOf('@');
  if (lastAtSignIndex >= 0) {
    const userinfoCandidate = connectionStringAfterScheme.slice(0, lastAtSignIndex);
    const usernamePartOfUserinfoCandidate = userinfoCandidate.split(':', 1)[0];
    const userinfoCandidateCarriesQueryCredentials = /[?&](user|password)=/i.test(userinfoCandidate);
    if (!/[/?#]/.test(usernamePartOfUserinfoCandidate) && !userinfoCandidateCarriesQueryCredentials) {
      const outcome = parseHostPortPathAndQuery(connectionStringAfterScheme.slice(lastAtSignIndex + 1));
      if (outcome.parsed) {
        return {
          rawUserinfo: userinfoCandidate,
          hostPortPathAndQuery: { ...outcome.hostPortPathAndQuery, queryMayHoldUserinfoPasswordText: false },
        };
      }
      userinfoCandidateFailure = outcome.failure;
    }
  }

  const outcomeWithoutUserinfo = parseHostPortPathAndQuery(connectionStringAfterScheme);
  if (outcomeWithoutUserinfo.parsed) {
    return {
      rawUserinfo: undefined,
      hostPortPathAndQuery: {
        ...outcomeWithoutUserinfo.hostPortPathAndQuery,
        queryMayHoldUserinfoPasswordText: userinfoCandidateFailure !== undefined,
      },
    };
  }
  if (userinfoCandidateFailure) {
    throw userinfoCandidateFailure;
  }
  if (lastAtSignIndex >= 0) {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.ConnectionStringUnparseable,
      UNPARSEABLE_CONNECTION_STRING_MESSAGE,
    );
  }
  throw outcomeWithoutUserinfo.failure;
}

function failHostPortPathAndQueryParse(
  problem: MySqlCredentialProblem,
  userFriendlyMessage: string,
): HostPortPathAndQueryParseOutcome {
  return { parsed: false, failure: new MySqlCredentialsInvalidError(problem, userFriendlyMessage) };
}

function parseHostPortPathAndQuery(text: string): HostPortPathAndQueryParseOutcome {
  const authorityEndIndex = text.search(/[/?#]/);
  const authority = authorityEndIndex < 0 ? text : text.slice(0, authorityEndIndex);
  let textAfterAuthority = authorityEndIndex < 0 ? '' : text.slice(authorityEndIndex);

  if (authority === '') {
    return failHostPortPathAndQueryParse(
      MySqlCredentialProblem.ConnectionStringUnparseable,
      "The connection string has no host after '://'.",
    );
  }
  if (authority.includes('@')) {
    return failHostPortPathAndQueryParse(
      MySqlCredentialProblem.ConnectionStringUnparseable,
      UNPARSEABLE_CONNECTION_STRING_MESSAGE,
    );
  }
  if (/^(tcp6?|unix|udp)\(/i.test(authority)) {
    return failHostPortPathAndQueryParse(
      MySqlCredentialProblem.ConnectionStringGoDsnNotSupported,
      `Go-style connection strings (user:password@tcp(host:3306)/database) aren't supported. ${PASTE_THE_FIELDS_INSTEAD}`,
    );
  }
  if (authority.includes(',')) {
    return failHostPortPathAndQueryParse(
      MySqlCredentialProblem.ConnectionStringMultipleHosts,
      "Connection strings with several hosts (failover or load balancing) aren't supported. Use a single host.",
    );
  }
  if (/[()=]/.test(authority)) {
    return failHostPortPathAndQueryParse(
      MySqlCredentialProblem.ConnectionStringUnparseable,
      "The connection string's host must be a plain hostname or IP address (JDBC address=(...) syntax isn't supported).",
    );
  }

  let host: string;
  let portText: string | undefined;
  if (authority.startsWith('[')) {
    const closingBracketIndex = authority.indexOf(']');
    const textAfterClosingBracket = closingBracketIndex < 0 ? '' : authority.slice(closingBracketIndex + 1);
    const bracketedHost = closingBracketIndex < 0 ? '' : authority.slice(1, closingBracketIndex);
    if (
      closingBracketIndex < 0 ||
      (textAfterClosingBracket !== '' && !textAfterClosingBracket.startsWith(':')) ||
      bracketedHost.includes('%') ||
      !net.isIPv6(bracketedHost)
    ) {
      return failHostPortPathAndQueryParse(
        MySqlCredentialProblem.HostInvalid,
        "The connection string's host isn't a valid bracketed IPv6 address, e.g. [2001:db8::1].",
      );
    }
    host = bracketedHost;
    portText = textAfterClosingBracket === '' ? undefined : textAfterClosingBracket.slice(1);
  } else {
    const colonSeparatedAuthorityParts = authority.split(':');
    if (colonSeparatedAuthorityParts.length > 2) {
      return failHostPortPathAndQueryParse(
        MySqlCredentialProblem.ConnectionStringUnparseable,
        'IPv6 addresses in a connection string must be in [brackets], e.g. mysql://user@[2001:db8::1]:3306/database.',
      );
    }
    [host, portText] = colonSeparatedAuthorityParts;
    if (!HOSTNAME_PATTERN.test(host)) {
      return failHostPortPathAndQueryParse(
        MySqlCredentialProblem.HostInvalid,
        "The connection string's host isn't a valid hostname or IP address.",
      );
    }
  }

  let port: number | undefined;
  if (portText !== undefined && portText !== '') {
    const portNumber = PORT_TEXT_PATTERN.test(portText) ? Number(portText) : Number.NaN;
    if (!(portNumber >= 1 && portNumber <= 65535)) {
      return failHostPortPathAndQueryParse(
        MySqlCredentialProblem.PortInvalid,
        "The connection string's port must be a whole number from 1 to 65535.",
      );
    }
    port = portNumber;
  }

  let rawDatabasePath: string | undefined;
  if (textAfterAuthority.startsWith('/')) {
    const databasePathEndIndex = textAfterAuthority.search(/[?#]/);
    rawDatabasePath =
      databasePathEndIndex < 0 ? textAfterAuthority.slice(1) : textAfterAuthority.slice(1, databasePathEndIndex);
    textAfterAuthority = databasePathEndIndex < 0 ? '' : textAfterAuthority.slice(databasePathEndIndex);
    if (rawDatabasePath.includes('/')) {
      return failHostPortPathAndQueryParse(
        MySqlCredentialProblem.ConnectionStringUnparseable,
        "The connection string has more than one '/' segment after the host. Only /database may follow the host " +
          '(percent-encode any / in the password as %2F).',
      );
    }
  }

  let rawQuery: string | undefined;
  if (textAfterAuthority.startsWith('?')) {
    const fragmentStartIndex = textAfterAuthority.indexOf('#');
    rawQuery = fragmentStartIndex < 0 ? textAfterAuthority.slice(1) : textAfterAuthority.slice(1, fragmentStartIndex);
    textAfterAuthority = fragmentStartIndex < 0 ? '' : textAfterAuthority.slice(fragmentStartIndex);
  }

  return {
    parsed: true,
    hostPortPathAndQuery: {
      host,
      port,
      rawDatabasePath,
      rawQuery,
      hasFragment: textAfterAuthority.startsWith('#'),
    },
  };
}

interface ParsedMySqlConnectionStringQueryParameters {
  readonly usernameFromQuery: string | undefined;
  readonly passwordFromQuery: string | undefined;
  readonly sslModeFromConnectionString: MySqlSslMode | undefined;
}

interface MySqlSslModeHintFromConnectionString {
  /** The option(s) the hint came from, quoted for a message (Connector/J's three booleans combine into one hint). */
  readonly quotedParameterNamesForMessages: readonly string[];
  readonly sslMode: MySqlSslMode;
}

interface ConnectorJBooleanSslOption {
  readonly quotedParameterNameForMessages: string;
  readonly normalizedKey: string;
  readonly enabled: boolean;
}

interface UnsupportedConnectionStringParameter {
  /** Undefined when the name is withheld from messages (not option-shaped, or possibly password text). */
  readonly parameterNameShownInMessages: string | undefined;
  readonly parameterNameMayBePasswordText: boolean;
}

/**
 * Read the query's SSL options and `user=` / `password=` (JDBC, Azure), rejecting everything else.
 *
 * Which names a message may echo: the query is split on `&`, so a password with an unencoded `&`
 * (`?user=admin&password=Tr0ub4dor&Hunter2Secret`) turns its tail into what looks like a parameter NAME. Every
 * parameter after `password=` — and every parameter when {@link splitUserinfoFromConnectionStringAuthority} says
 * the query may hold userinfo password text — may therefore be password text: an unsupported or duplicated one is
 * rejected WITHOUT its name (plus a percent-encoding hint), and a recognized option is named in our own spelling,
 * never as typed. Parameters before `password=` are still named as typed, so ordinary mistakes stay easy to fix.
 */
function parseMySqlConnectionStringQueryParameters(
  rawQuery: string | undefined,
  { queryMayHoldUserinfoPasswordText }: { queryMayHoldUserinfoPasswordText: boolean },
): ParsedMySqlConnectionStringQueryParameters {
  let usernameFromQuery: string | undefined;
  let passwordFromQuery: string | undefined;
  let laterParameterNamesMayBePasswordText = queryMayHoldUserinfoPasswordText;
  const sslModeHints: MySqlSslModeHintFromConnectionString[] = [];
  const connectorJBooleanSslOptions: ConnectorJBooleanSslOption[] = [];
  const quotedCertificatePathParameterNamesForMessages: string[] = [];
  const unsupportedParameters: UnsupportedConnectionStringParameter[] = [];
  const seenNormalizedParameterKeys = new Set<string>();

  for (const rawParameter of (rawQuery ?? '').split('&')) {
    if (rawParameter === '') continue;
    const equalsSignIndex = rawParameter.indexOf('=');
    const parameterName = decodePercentEncodedRunsTolerantly(
      equalsSignIndex < 0 ? rawParameter : rawParameter.slice(0, equalsSignIndex),
    );
    const parameterValue = decodePercentEncodedRunsTolerantly(
      equalsSignIndex < 0 ? '' : rawParameter.slice(equalsSignIndex + 1),
    );
    const parameterNameMayBePasswordText = laterParameterNamesMayBePasswordText;
    const parameterNameIsShownAsTyped =
      !parameterNameMayBePasswordText && mySqlConnectionStringParameterNameLooksLikeAnOptionName(parameterName);
    /** A recognized option as typed (`sslMode`, `SSL_MODE`) when that is safe; otherwise our own spelling of it. */
    const quoteRecognizedParameterNameForMessages = (ourSpellingOfTheOption: string): string =>
      `'${parameterNameIsShownAsTyped ? parameterName : ourSpellingOfTheOption}'`;

    // `ssl-mode`, `sslMode`, `ssl_mode` and `SSLMODE` are the same option to the drivers people copy URLs from.
    const normalizedParameterKey = parameterName.toLowerCase().replace(/[-_]/g, '');
    if (seenNormalizedParameterKeys.has(normalizedParameterKey)) {
      throw describeDuplicatedConnectionStringParameter(
        parameterNameIsShownAsTyped ? parameterName : undefined,
        parameterNameMayBePasswordText,
      );
    }
    seenNormalizedParameterKeys.add(normalizedParameterKey);

    switch (normalizedParameterKey) {
      case USER_PARAMETER_KEY:
        usernameFromQuery = parameterValue;
        break;
      case PASSWORD_PARAMETER_KEY:
        passwordFromQuery = parameterValue;
        // An unencoded `&` in the password splits it here, so what follows may be the rest of the password.
        laterParameterNamesMayBePasswordText = true;
        break;
      case SSL_MODE_PARAMETER_KEY: {
        const quotedParameterName = quoteRecognizedParameterNameForMessages('ssl-mode');
        sslModeHints.push({
          quotedParameterNamesForMessages: [quotedParameterName],
          sslMode: mapMySqlSslModeSpellingToSslMode(parameterValue) ?? throwInvalidSslOptionValue(quotedParameterName),
        });
        break;
      }
      case SSL_ACCEPT_PARAMETER_KEY: {
        const quotedParameterName = quoteRecognizedParameterNameForMessages('sslaccept');
        sslModeHints.push({
          quotedParameterNamesForMessages: [quotedParameterName],
          sslMode: mapPrismaSslAcceptValue(quotedParameterName, parameterValue),
        });
        break;
      }
      case SSL_PARAMETER_KEY: {
        const quotedParameterName = quoteRecognizedParameterNameForMessages('ssl');
        sslModeHints.push({
          quotedParameterNamesForMessages: [quotedParameterName],
          sslMode: mapMySqlSslOptionValue(quotedParameterName, parameterValue),
        });
        break;
      }
      case USE_SSL_PARAMETER_KEY:
      case REQUIRE_SSL_PARAMETER_KEY:
      case VERIFY_SERVER_CERTIFICATE_PARAMETER_KEY: {
        const quotedParameterName = quoteRecognizedParameterNameForMessages(
          CONNECTOR_J_BOOLEAN_SSL_OPTION_SPELLINGS[normalizedParameterKey],
        );
        connectorJBooleanSslOptions.push({
          quotedParameterNameForMessages: quotedParameterName,
          normalizedKey: normalizedParameterKey,
          enabled: parseConnectorJBooleanOptionValue(quotedParameterName, parameterValue),
        });
        break;
      }
      default:
        if (CERTIFICATE_PATH_PARAMETER_KEYS.has(normalizedParameterKey)) {
          // The normalized key is a member of our own set, so it is safe to show when the typed name isn't.
          quotedCertificatePathParameterNamesForMessages.push(
            quoteRecognizedParameterNameForMessages(normalizedParameterKey),
          );
        } else {
          unsupportedParameters.push({
            parameterNameShownInMessages: parameterNameIsShownAsTyped ? parameterName : undefined,
            parameterNameMayBePasswordText,
          });
        }
    }
  }

  if (quotedCertificatePathParameterNamesForMessages.length > 0) {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.ConnectionStringCertificatePathParameter,
      `Certificate file options in the connection string (${joinQuotedParameterNamesForMessage(quotedCertificatePathParameterNamesForMessages)}) ` +
        "aren't supported: Scratch can't read files from your computer. Paste the CA certificate into CA Certificate instead.",
    );
  }
  if (unsupportedParameters.length > 0) {
    throw describeUnsupportedConnectionStringParameters(unsupportedParameters);
  }

  const connectorJSslModeHint = combineConnectorJBooleanSslOptions(connectorJBooleanSslOptions);
  if (connectorJSslModeHint) sslModeHints.push(connectorJSslModeHint);
  const distinctHintedSslModes = new Set(sslModeHints.map((sslModeHint) => sslModeHint.sslMode));
  if (distinctHintedSslModes.size > 1) {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.SslAliasesConflict,
      `The connection string's SSL options (${joinQuotedParameterNamesForMessage(sslModeHints.flatMap((sslModeHint) => sslModeHint.quotedParameterNamesForMessages))}) ` +
        'ask for different SSL modes. Keep one of them, or remove them and set SSL Mode instead.',
    );
  }

  return {
    usernameFromQuery,
    passwordFromQuery,
    sslModeFromConnectionString: sslModeHints[0]?.sslMode,
  };
}

function describeDuplicatedConnectionStringParameter(
  parameterNameShownInMessages: string | undefined,
  parameterNameMayBePasswordText: boolean,
): MySqlCredentialsInvalidError {
  const duplicatedOptionSentence =
    parameterNameShownInMessages === undefined
      ? 'An option in the connection string appears more than once. Keep one.'
      : `The connection-string option '${parameterNameShownInMessages}' appears more than once. Keep one.`;
  return new MySqlCredentialsInvalidError(
    MySqlCredentialProblem.ConnectionStringParameterDuplicated,
    parameterNameMayBePasswordText
      ? `${duplicatedOptionSentence} ${PERCENT_ENCODE_PASSWORD_SPECIAL_CHARACTERS_HINT}`
      : duplicatedOptionSentence,
  );
}

/** Names at most three unsupported parameters (the rest summarized); withheld names are only counted. */
function describeUnsupportedConnectionStringParameters(
  unsupportedParameters: readonly UnsupportedConnectionStringParameter[],
): MySqlCredentialsInvalidError {
  const maximumNamedParameters = 3;
  const quotedShownParameterNames = unsupportedParameters
    .flatMap(({ parameterNameShownInMessages }) =>
      parameterNameShownInMessages === undefined ? [] : [`'${parameterNameShownInMessages}'`],
    )
    .slice(0, maximumNamedParameters);
  const unnamedParameterCount = unsupportedParameters.length - quotedShownParameterNames.length;
  const isSingleParameter = unsupportedParameters.length === 1;

  let unsupportedOptionsSentence: string;
  if (quotedShownParameterNames.length === 0) {
    unsupportedOptionsSentence = isSingleParameter
      ? 'The connection string has an unsupported option.'
      : `The connection string has ${unsupportedParameters.length} unsupported options.`;
  } else {
    const namedAndSummarizedParameters =
      unnamedParameterCount > 0
        ? `${quotedShownParameterNames.join(', ')} and ${unnamedParameterCount} more`
        : quotedShownParameterNames.join(', ');
    unsupportedOptionsSentence =
      `The connection-string option${isSingleParameter ? '' : 's'} ${namedAndSummarizedParameters} ` +
      `${isSingleParameter ? "isn't" : "aren't"} supported.`;
  }
  const someUnsupportedParameterMayBePasswordText = unsupportedParameters.some(
    ({ parameterNameMayBePasswordText }) => parameterNameMayBePasswordText,
  );
  return new MySqlCredentialsInvalidError(
    MySqlCredentialProblem.ConnectionStringParameterUnsupported,
    someUnsupportedParameterMayBePasswordText
      ? `${unsupportedOptionsSentence} ${PERCENT_ENCODE_PASSWORD_SPECIAL_CHARACTERS_HINT} ${REMOVE_UNSUPPORTED_OPTIONS_AFTER_PASSWORD_GUIDANCE}`
      : `${unsupportedOptionsSentence} ${REMOVE_UNSUPPORTED_OPTIONS_GUIDANCE}`,
  );
}

/** At most three already-quoted names of recognized options, the rest summarized. */
function joinQuotedParameterNamesForMessage(quotedParameterNames: readonly string[]): string {
  const maximumNamedParameters = 3;
  const namedParameters = quotedParameterNames.slice(0, maximumNamedParameters);
  const remainingParameterCount = quotedParameterNames.length - maximumNamedParameters;
  return remainingParameterCount > 0
    ? `${namedParameters.join(', ')} and ${remainingParameterCount} more`
    : namedParameters.join(', ');
}

function throwInvalidSslOptionValue(quotedParameterName: string, guidance?: string): never {
  throw new MySqlCredentialsInvalidError(
    MySqlCredentialProblem.SslAliasValueInvalid,
    `The connection string's ${quotedParameterName} option has a value Scratch doesn't recognize. ` +
      (guidance ?? 'Use DISABLED, REQUIRED, VERIFY_CA or VERIFY_IDENTITY, or remove it and set SSL Mode instead.'),
  );
}

/** Prisma's `sslaccept`: `strict` verifies the certificate and hostname; `accept_invalid_certs` only encrypts. */
function mapPrismaSslAcceptValue(quotedParameterName: string, parameterValue: string): MySqlSslMode {
  switch (parameterValue.trim().toLowerCase()) {
    case 'strict':
      return 'VERIFY_IDENTITY';
    case 'accept_invalid_certs':
      return 'REQUIRED';
    default:
      return throwInvalidSslOptionValue(quotedParameterName, 'Use strict or accept_invalid_certs.');
  }
}

/**
 * mysql2 / Node-driver `ssl`: a boolean-ish flag, the `Amazon RDS` profile name, or a small JSON object. From
 * the JSON only `rejectUnauthorized` / `verifyIdentity` (booleans) are understood; CA material must go in the CA
 * Certificate field, and any other key — `ca`, `key`, `__proto__` — is rejected (named only when it is a TLS
 * option name from {@link NAMEABLE_REJECTED_SSL_JSON_OPTION_KEYS}, since the JSON is a parameter value).
 */
function mapMySqlSslOptionValue(quotedParameterName: string, parameterValue: string): MySqlSslMode {
  const sslOptionGuidance = 'Use ssl=true, or remove it and set SSL Mode instead.';
  const trimmedSslOptionValue = parameterValue.trim();
  const lowerCaseSslOptionValue = trimmedSslOptionValue.toLowerCase();
  if (['true', '1', 'required'].includes(lowerCaseSslOptionValue)) return 'REQUIRED';
  if (['false', '0'].includes(lowerCaseSslOptionValue)) return 'DISABLED';
  // mysql2's built-in profile: verify against the Amazon RDS CA bundle (which the default trust set includes).
  if (lowerCaseSslOptionValue.replace(/\+/g, ' ') === 'amazon rds') return 'VERIFY_CA';
  if (!trimmedSslOptionValue.startsWith('{')) return throwInvalidSslOptionValue(quotedParameterName, sslOptionGuidance);

  if (trimmedSslOptionValue.length > MYSQL_CONNECTION_STRING_SSL_JSON_OPTION_MAX_LENGTH) {
    return throwInvalidSslOptionValue(quotedParameterName, sslOptionGuidance);
  }
  let parsedSslOptionObject: unknown;
  try {
    parsedSslOptionObject = JSON.parse(trimmedSslOptionValue);
  } catch {
    return throwInvalidSslOptionValue(quotedParameterName, sslOptionGuidance);
  }
  if (
    typeof parsedSslOptionObject !== 'object' ||
    parsedSslOptionObject === null ||
    Array.isArray(parsedSslOptionObject)
  ) {
    return throwInvalidSslOptionValue(quotedParameterName, sslOptionGuidance);
  }
  // JSON.parse defines `__proto__` as an OWN data property (it never sets the prototype), so Object.keys sees it.
  for (const sslOptionKey of Object.keys(parsedSslOptionObject)) {
    if (!ALLOWED_SSL_JSON_OPTION_KEYS.has(sslOptionKey)) {
      const rejectedKeySentence = NAMEABLE_REJECTED_SSL_JSON_OPTION_KEYS.has(sslOptionKey)
        ? `The connection string's ssl option '${sslOptionKey}' isn't supported.`
        : "The connection string's ssl option sets a key Scratch doesn't support.";
      throw new MySqlCredentialsInvalidError(
        MySqlCredentialProblem.SslAliasValueInvalid,
        `${rejectedKeySentence} Only rejectUnauthorized and verifyIdentity may be set there; paste a CA certificate into CA Certificate instead.`,
      );
    }
  }
  const rejectUnauthorizedOption: unknown = Reflect.get(parsedSslOptionObject, 'rejectUnauthorized');
  const verifyIdentityOption: unknown = Reflect.get(parsedSslOptionObject, 'verifyIdentity');
  if (
    (rejectUnauthorizedOption !== undefined && typeof rejectUnauthorizedOption !== 'boolean') ||
    (verifyIdentityOption !== undefined && typeof verifyIdentityOption !== 'boolean')
  ) {
    return throwInvalidSslOptionValue(
      quotedParameterName,
      'rejectUnauthorized and verifyIdentity must be true or false.',
    );
  }
  // mysql2 defaults rejectUnauthorized to true.
  const certificateChainIsVerified = rejectUnauthorizedOption !== false;
  if (!certificateChainIsVerified && verifyIdentityOption === true) {
    return throwInvalidSslOptionValue(
      quotedParameterName,
      "verifyIdentity needs rejectUnauthorized; Scratch can't check the hostname of an unverified certificate.",
    );
  }
  if (!certificateChainIsVerified) return 'REQUIRED';
  return verifyIdentityOption === true ? 'VERIFY_IDENTITY' : 'VERIFY_CA';
}

function parseConnectorJBooleanOptionValue(quotedParameterName: string, parameterValue: string): boolean {
  switch (parameterValue.trim().toLowerCase()) {
    case 'true':
    case 'yes':
      return true;
    case 'false':
    case 'no':
      return false;
    default:
      return throwInvalidSslOptionValue(quotedParameterName, 'Use true or false.');
  }
}

/**
 * Connector/J 5.1's `useSSL` / `requireSSL` / `verifyServerCertificate` combine into ONE hint: `useSSL=false` turns
 * TLS off (and contradicts `requireSSL=true` or `verifyServerCertificate=true`); `verifyServerCertificate=true`
 * checks the chain (not the hostname); `useSSL=true` or `requireSSL=true` alone encrypt without checking.
 */
function combineConnectorJBooleanSslOptions(
  connectorJBooleanSslOptions: readonly ConnectorJBooleanSslOption[],
): MySqlSslModeHintFromConnectionString | undefined {
  if (connectorJBooleanSslOptions.length === 0) return undefined;
  const optionValue = (normalizedKey: string): boolean | undefined =>
    connectorJBooleanSslOptions.find((option) => option.normalizedKey === normalizedKey)?.enabled;
  const useSsl = optionValue(USE_SSL_PARAMETER_KEY);
  const requireSsl = optionValue(REQUIRE_SSL_PARAMETER_KEY);
  const verifyServerCertificate = optionValue(VERIFY_SERVER_CERTIFICATE_PARAMETER_KEY);
  const quotedParameterNamesForMessages = connectorJBooleanSslOptions.map(
    (option) => option.quotedParameterNameForMessages,
  );

  if (useSsl === false) {
    if (requireSsl === true || verifyServerCertificate === true) {
      throw new MySqlCredentialsInvalidError(
        MySqlCredentialProblem.SslAliasesConflict,
        'The connection string sets useSSL=false together with requireSSL=true or verifyServerCertificate=true. Keep one, or remove them and set SSL Mode instead.',
      );
    }
    return { quotedParameterNamesForMessages, sslMode: 'DISABLED' };
  }
  if (verifyServerCertificate === true) return { quotedParameterNamesForMessages, sslMode: 'VERIFY_CA' };
  if (useSsl === true || requireSsl === true) return { quotedParameterNamesForMessages, sslMode: 'REQUIRED' };
  return undefined;
}

function resolveMySqlConnectionStringCredentials(
  rawUserinfo: string | undefined,
  queryParameters: ParsedMySqlConnectionStringQueryParameters,
): { username: string; password: string | undefined } {
  // Userinfo splits at the FIRST ':' so passwords may contain ':'.
  const userinfoColonIndex = rawUserinfo === undefined ? -1 : rawUserinfo.indexOf(':');
  const usernameFromUserinfo =
    rawUserinfo === undefined
      ? ''
      : decodePercentEncodedRunsTolerantly(
          userinfoColonIndex < 0 ? rawUserinfo : rawUserinfo.slice(0, userinfoColonIndex),
        );
  const passwordFromUserinfo =
    rawUserinfo === undefined || userinfoColonIndex < 0
      ? ''
      : decodePercentEncodedRunsTolerantly(rawUserinfo.slice(userinfoColonIndex + 1));
  const usernameFromQuery = queryParameters.usernameFromQuery ?? '';
  const passwordFromQuery = queryParameters.passwordFromQuery ?? '';

  if (usernameFromUserinfo !== '' && usernameFromQuery !== '' && usernameFromUserinfo !== usernameFromQuery) {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.ConnectionStringCredentialsConflict,
      'The connection string gives two different usernames (before the host and as ?user=). Keep one.',
    );
  }
  if (passwordFromUserinfo !== '' && passwordFromQuery !== '' && passwordFromUserinfo !== passwordFromQuery) {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.ConnectionStringCredentialsConflict,
      'The connection string gives two different passwords (before the host and as ?password=). Keep one.',
    );
  }

  const username = usernameFromUserinfo !== '' ? usernameFromUserinfo : usernameFromQuery;
  if (username === '') {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.UsernameRequired,
      'The connection string has no username. Add user:password@ before the host, or fill in the fields instead.',
    );
  }
  const password = passwordFromUserinfo !== '' ? passwordFromUserinfo : passwordFromQuery;
  return { username, password: password === '' ? undefined : password };
}
