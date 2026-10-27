/**
 * The allowlist every Postgres connection string passes before it reaches node-postgres: on save (the Postgres and
 * Supabase AuthParsers) and again on every connect (`KnexPGClient`), so strings stored before the allowlist existed
 * are covered too.
 *
 * node-postgres parses a connection string with `pg-connection-string`, which copies EVERY query parameter into the
 * client config. Several of them do things we never mean to support:
 * - `sslrootcert`, `sslcert` and `sslkey` make the server read the named local file with `fs.readFileSync`, before
 *   any connection opens and so before the database host guard can refuse anything. `?sslrootcert=/dev/zero` blocks
 *   the process until it runs out of memory; a missing path fails with an error that names it (a file-existence
 *   oracle).
 * - `host`, `hostaddr`, `port`, `user`, `password` and `database` override the URL's own parts, and a host that is
 *   a path (`/var/run/postgresql`, `%2Fvar%2Frun`, the `socket:` scheme) is a Unix socket on our server.
 * - `replication` switches the connection to the replication protocol.
 * - `binary` and `client_encoding` change how node-postgres decodes values, which would corrupt what we pull.
 *
 * So only these parameters reach node-postgres, each value checked: `sslmode`, `ssl=true`, `uselibpqcompat`,
 * `application_name`, and `options` carrying a Neon endpoint ID. The dangerous groups above are refused with a
 * message naming them. Every other parameter (Prisma's `pgbouncer` / `schema` / `connection_limit`, Neon's
 * `channel_binding`, libpq timeouts and keepalives, ...) is dropped: node-postgres ignores most of them anyway, and a
 * parameter a future node-postgres starts honoring can't change what we do until we add it here.
 *
 * Messages never contain the connection string, the password, the host or a parameter value, and name only
 * parameters from the fixed lists below (a query-parameter name can be a fragment of an unencoded password).
 */

/** A connection string longer than this is refused before it is parsed. */
export const POSTGRES_CONNECTION_STRING_MAX_LENGTH = 8192;

/** `sslmode` values node-postgres understands: libpq's (except `allow`, which it doesn't) plus its own `no-verify`. */
const SUPPORTED_SSL_MODES: readonly string[] = [
  'disable',
  'prefer',
  'require',
  'verify-ca',
  'verify-full',
  'no-verify',
];

/** Parameters that make node-postgres read a file on our server. Compared lower-cased. */
const LOCAL_FILE_PARAMETER_NAMES: readonly string[] = [
  'sslcert',
  'sslkey',
  'sslrootcert',
  'sslpassword',
  'sslcrl',
  'sslcrldir',
];
/** Parameters that override the URL's host, port, credentials or database. Compared lower-cased. */
const CONNECTION_TARGET_PARAMETER_NAMES: readonly string[] = [
  'host',
  'hostaddr',
  'port',
  'user',
  'password',
  'dbname',
  'database',
];
/** Parameters that change the wire protocol. Compared lower-cased. */
const PROTOCOL_PARAMETER_NAMES: readonly string[] = ['replication'];

/**
 * Neon's endpoint option (`options=endpoint%3D<endpoint id>`, or the older `project=`), which Neon's connection strings
 * carry for clients without SNI. Any other `options` value would send arbitrary startup settings to the server.
 */
const NEON_ENDPOINT_OPTION_PATTERN = /^(endpoint|project)=[A-Za-z0-9-]+$/;
/** What node-postgres takes as a TCP host: a DNS name, an IPv4 literal, or a bracketed IPv6 literal. */
const NETWORK_HOST_PATTERN = /^([A-Za-z0-9_.-]+|\[[0-9A-Fa-f:.]+\])$/;
const POSTGRES_URL_SCHEME_PATTERN = /^postgres(ql)?:\/\//i;

const EXAMPLE_CONNECTION_STRING = 'postgres://user:password@host:5432/database';
const PERCENT_ENCODE_PASSWORD_HINT =
  'If your password has special characters (@ / ? # %), percent-encode them (e.g. @ as %40).';

export type NodePostgresConnectionStringPreparation =
  | {
      readonly accepted: true;
      /** The connection string to hand node-postgres: the input with every dropped parameter removed. */
      readonly connectionStringForNodePostgres: string;
    }
  | {
      readonly accepted: false;
      /** Safe to show and to store: never contains the connection string, a password, the host or a value. */
      readonly userFacingReason: string;
    };

/**
 * Check `connectionString` against the allowlist and return the string node-postgres should get, or the reason it is
 * refused. `sslNoVerify` adds `sslmode=no-verify` when the string sets no `sslmode` (the Supabase connector's
 * default).
 */
export function prepareConnectionStringForNodePostgres(
  connectionString: string,
  options?: { sslNoVerify?: boolean },
): NodePostgresConnectionStringPreparation {
  const refuse = (userFacingReason: string): NodePostgresConnectionStringPreparation => ({
    accepted: false,
    userFacingReason,
  });

  const trimmedConnectionString = connectionString.trim();
  if (trimmedConnectionString.length === 0) {
    return refuse(`Enter a connection string, e.g. ${EXAMPLE_CONNECTION_STRING}.`);
  }
  if (trimmedConnectionString.length > POSTGRES_CONNECTION_STRING_MAX_LENGTH) {
    return refuse(`The connection string is longer than ${POSTGRES_CONNECTION_STRING_MAX_LENGTH} characters.`);
  }
  // Also rules out the strings node-postgres reads as a Unix socket: one starting with "/", and the socket: scheme.
  if (!POSTGRES_URL_SCHEME_PATTERN.test(trimmedConnectionString)) {
    return refuse(
      `The connection string must start with postgres:// or postgresql://, e.g. ${EXAMPLE_CONNECTION_STRING}.`,
    );
  }

  const parsedConnectionStringUrl = parseConnectionStringTheWayNodePostgresDoes(trimmedConnectionString);
  if (parsedConnectionStringUrl === undefined) {
    return refuse(`This connection string couldn't be read. ${PERCENT_ENCODE_PASSWORD_HINT}`);
  }

  let hostAsNodePostgresWillUseIt: string;
  try {
    hostAsNodePostgresWillUseIt = decodeURIComponent(parsedConnectionStringUrl.hostname);
  } catch {
    return refuse(`This connection string couldn't be read. ${PERCENT_ENCODE_PASSWORD_HINT}`);
  }
  if (hostAsNodePostgresWillUseIt.length === 0) {
    return refuse(`The connection string has no host. Use one like ${EXAMPLE_CONNECTION_STRING}.`);
  }
  if (!NETWORK_HOST_PATTERN.test(hostAsNodePostgresWillUseIt)) {
    return refuse(
      `The connection string's host must be a host name or an IP address (Unix socket paths aren't supported). ${PERCENT_ENCODE_PASSWORD_HINT}`,
    );
  }

  // node-postgres writes the user and database into the startup message as NUL-terminated strings, so a control
  // character (`%00`) in either could smuggle in another startup setting (`replication`, `options`).
  let userAsNodePostgresWillUseIt: string;
  let databaseAsNodePostgresWillUseIt: string;
  try {
    userAsNodePostgresWillUseIt = decodeURIComponent(parsedConnectionStringUrl.username);
    databaseAsNodePostgresWillUseIt = decodeURI(parsedConnectionStringUrl.pathname.slice(1));
  } catch {
    return refuse(`This connection string couldn't be read. ${PERCENT_ENCODE_PASSWORD_HINT}`);
  }
  if (
    containsControlCharacter(userAsNodePostgresWillUseIt) ||
    containsControlCharacter(databaseAsNodePostgresWillUseIt)
  ) {
    return refuse("The connection string's user or database name contains a control character.");
  }

  const refusedLocalFileParameterNames = new Set<string>();
  const refusedConnectionTargetParameterNames = new Set<string>();
  const refusedProtocolParameterNames = new Set<string>();
  const queryParametersForNodePostgres = new URLSearchParams();
  for (const [parameterName, parameterValue] of parsedConnectionStringUrl.searchParams) {
    const lowerCasedParameterName = parameterName.toLowerCase();
    if (LOCAL_FILE_PARAMETER_NAMES.includes(lowerCasedParameterName)) {
      refusedLocalFileParameterNames.add(lowerCasedParameterName);
      continue;
    }
    if (CONNECTION_TARGET_PARAMETER_NAMES.includes(lowerCasedParameterName)) {
      refusedConnectionTargetParameterNames.add(lowerCasedParameterName);
      continue;
    }
    if (PROTOCOL_PARAMETER_NAMES.includes(lowerCasedParameterName)) {
      refusedProtocolParameterNames.add(lowerCasedParameterName);
      continue;
    }
    // node-postgres matches parameter names exactly, so only exact spellings are kept; anything else is dropped.
    switch (parameterName) {
      case 'sslmode':
        if (!SUPPORTED_SSL_MODES.includes(parameterValue)) {
          return refuse(`sslmode must be one of ${SUPPORTED_SSL_MODES.join(', ')}.`);
        }
        queryParametersForNodePostgres.append(parameterName, parameterValue);
        break;
      case 'ssl':
        // Only ssl=true turns TLS on; any other value was always dropped, leaving TLS to sslmode.
        if (parameterValue === 'true') queryParametersForNodePostgres.append(parameterName, parameterValue);
        break;
      case 'uselibpqcompat':
        if (parameterValue !== 'true' && parameterValue !== 'false') {
          return refuse('uselibpqcompat must be true or false.');
        }
        queryParametersForNodePostgres.append(parameterName, parameterValue);
        break;
      case 'application_name':
        // node-postgres writes it into the startup message as a NUL-terminated string, so a control character could
        // smuggle in another startup setting.
        if (containsControlCharacter(parameterValue)) {
          return refuse('application_name contains a control character.');
        }
        queryParametersForNodePostgres.append(parameterName, parameterValue);
        break;
      case 'options':
        if (!NEON_ENDPOINT_OPTION_PATTERN.test(parameterValue)) {
          return refuse(
            'The options parameter is only supported for a Neon endpoint ID (options=endpoint%3D<endpoint id>). Remove it from the connection string.',
          );
        }
        queryParametersForNodePostgres.append(parameterName, parameterValue);
        break;
      default:
        break;
    }
  }

  const refusalReasons: string[] = [];
  if (refusedLocalFileParameterNames.size > 0) {
    refusalReasons.push(
      `Remove ${describeParameterNames(refusedLocalFileParameterNames)} from the connection string: certificate and key files can't be read from a path. Use sslmode=verify-full to check the server's certificate against the public certificate authorities, or sslmode=no-verify to encrypt without checking it.`,
    );
  }
  if (refusedConnectionTargetParameterNames.size > 0) {
    refusalReasons.push(
      `Remove ${describeParameterNames(refusedConnectionTargetParameterNames)} from after the "?" in the connection string, and put the user, password, host, port and database in the URL itself: ${EXAMPLE_CONNECTION_STRING}.`,
    );
  }
  if (refusedProtocolParameterNames.size > 0) {
    refusalReasons.push(
      `Remove ${describeParameterNames(refusedProtocolParameterNames)} from the connection string: replication connections aren't supported.`,
    );
  }
  if (refusalReasons.length > 0) {
    return refuse(refusalReasons.join(' '));
  }

  if (options?.sslNoVerify && !queryParametersForNodePostgres.has('sslmode')) {
    queryParametersForNodePostgres.set('sslmode', 'no-verify');
  }
  parsedConnectionStringUrl.search = queryParametersForNodePostgres.toString();
  return { accepted: true, connectionStringForNodePostgres: parsedConnectionStringUrl.toString() };
}

/**
 * Parse the way `pg-connection-string` does, so what we check is exactly what node-postgres will read: it first
 * re-encodes a string that has a space or a malformed percent escape, then parses it as a URL. Undefined when it
 * doesn't parse (node-postgres would then retry with an empty host, which we refuse anyway).
 */
function parseConnectionStringTheWayNodePostgresDoes(connectionString: string): URL | undefined {
  const connectionStringAsNodePostgresParsesIt = / |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(connectionString)
    ? encodeURI(connectionString).replace(/%25(\d\d)/g, '%$1')
    : connectionString;
  try {
    return new URL(connectionStringAsNodePostgresParsesIt, 'postgres://base');
  } catch {
    return undefined;
  }
}

function describeParameterNames(parameterNames: ReadonlySet<string>): string {
  const sortedParameterNames = [...parameterNames].sort();
  if (sortedParameterNames.length === 1) return sortedParameterNames[0];
  return `${sortedParameterNames.slice(0, -1).join(', ')} and ${sortedParameterNames[sortedParameterNames.length - 1]}`;
}

/** A C0 control character or DEL. */
function containsControlCharacter(text: string): boolean {
  for (let characterIndex = 0; characterIndex < text.length; characterIndex++) {
    const characterCode = text.charCodeAt(characterIndex);
    if (characterCode < 0x20 || characterCode === 0x7f) return true;
  }
  return false;
}
