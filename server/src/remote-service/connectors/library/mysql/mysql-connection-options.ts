/**
 * The MySQL connection settings: what the user submits, what is stored (encrypted) for the connection, and the
 * validated {@link MySqlConnectionOptions} the knex client accepts. The only module that turns credential input
 * into connection options — nothing else may build them from a raw blob or a URL.
 *
 * Three entry points, one validation path:
 * - {@link parseMySqlCredentialsFromUserInput} — creating a connection (the AuthParser). A connection string OR the
 *   discrete fields; unknown keys and non-text values are rejected by name.
 * - {@link applyMySqlCredentialPatch} — editing a connection (the AuthParser once the service passes the stored
 *   credentials on PATCH). Pure; returns the COMPLETE settings to store (the service replaces, not merges).
 * - {@link parseStoredMySqlCredentials} — every connect (`createConnector`). Defense in depth: until the service
 *   runs the AuthParser on PATCH, a stored blob can hold anything (a raw PATCH `Object.assign`s the request into it,
 *   and a dev-tools import re-encrypts exported blobs verbatim). No I/O.
 *
 * What is stored is ONLY the discrete {@link MYSQL_CREDENTIAL_KEYS}, as text (the port as a decimal string); a
 * pasted connection string is decomposed and never stored, so the URL can't drift from the fields and never
 * reaches mysql2 (whose URL parser turns query parameters into driver options).
 */
import { type DecryptedCredentials } from '@spinner/shared-types';
import net from 'node:net';
import { normalizeMySqlCaCertificateBundlePem } from './mysql-ca-certificate-bundle';
import { parseMySqlConnectionString } from './mysql-connection-string';
import {
  MySqlCredentialProblem,
  MySqlCredentialsInvalidError,
  runMySqlCredentialParsingWithSafeErrors,
} from './mysql-credential-errors';
import {
  mapMySqlSslModeSpellingToSslMode,
  parseMySqlSslModeFieldValue,
  resolveEffectiveMySqlSslMode,
} from './mysql-ssl-mode';
import { DEFAULT_MYSQL_PORT, type MySqlConnectionOptions, type MySqlSslMode } from './mysql-types';

/** Every key the MySQL connector stores. The `satisfies` keeps them in step with `DecryptedCredentials`. */
export const MYSQL_CREDENTIAL_KEYS = [
  'databaseHost',
  'databasePort',
  'databaseName',
  'username',
  'password',
  'sslMode',
  'sslCaCertificate',
] as const satisfies readonly (keyof DecryptedCredentials)[];
export type MySqlCredentialKey = (typeof MYSQL_CREDENTIAL_KEYS)[number];

/** Every key a user may SUBMIT: the stored keys plus `connectionString`, which is input only. */
export const MYSQL_CREDENTIAL_INPUT_KEYS = [
  ...MYSQL_CREDENTIAL_KEYS,
  'connectionString',
] as const satisfies readonly (keyof DecryptedCredentials)[];
export type MySqlCredentialInputKey = (typeof MYSQL_CREDENTIAL_INPUT_KEYS)[number];

/** The labels the connection form shows; messages name fields by these, never by the submitted text. */
export const MYSQL_CREDENTIAL_FIELD_LABELS: Readonly<Record<MySqlCredentialInputKey, string>> = Object.freeze({
  databaseHost: 'Host',
  databasePort: 'Port',
  databaseName: 'Database',
  username: 'Username',
  password: 'Password',
  sslMode: 'SSL Mode',
  sslCaCertificate: 'CA Certificate',
  connectionString: 'Connection String',
});

/** The canonical stored form. Never contains `connectionString`. */
export type MySqlStoredCredentials = {
  databaseHost: string;
  /** Decimal text, e.g. "3306" (the AuthParser contract is `Record<string, string>`). */
  databasePort: string;
  databaseName?: string;
  username: string;
  password?: string;
  /** The EFFECTIVE mode (defaults and upgrades applied), so an edit inherits exactly what connects today. */
  sslMode: MySqlSslMode;
  sslCaCertificate?: string;
};

export interface ParsedMySqlCredentials {
  readonly storedCredentials: MySqlStoredCredentials;
  readonly connectionOptions: MySqlConnectionOptions;
}

/** The settings a connection string replaces as a whole; giving one of them next to a URL is ambiguous. */
const MYSQL_CONNECTION_TARGET_CREDENTIAL_KEYS = [
  'databaseHost',
  'databasePort',
  'databaseName',
  'username',
  'password',
] as const satisfies readonly MySqlCredentialKey[];

/** Caps applied before any other check (DNS names are ≤253; the rest are generous but bounded). */
const MYSQL_CREDENTIAL_INPUT_MAXIMUM_LENGTHS: Readonly<Partial<Record<MySqlCredentialInputKey, number>>> = {
  databaseHost: 253,
  databasePort: 16,
  username: 256,
  password: 4096,
  sslMode: 64,
};
/** MySQL identifiers are at most 64 characters. */
const MYSQL_DATABASE_NAME_MAX_LENGTH = 64;

const MYSQL_HOSTNAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const MYSQL_PORT_TEXT_PATTERN = /^\d{1,5}$/;

/** A validated settings key → its text. Absent = not given; `null` = sent empty ('' / whitespace-only / null). */
type SubmittedMySqlCredentialValues = Map<MySqlCredentialInputKey, string | null>;
/** The settings a single parse runs on: absent or text (never empty). */
type MySqlCredentialValuesToValidate = Partial<Record<MySqlCredentialInputKey, string>>;

// ---------------------------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------------------------

/**
 * CREATE: a connection string OR Host/Port/Database/Username/Password, plus optional SSL Mode and CA Certificate
 * (both allowed next to a connection string). `''` and whitespace-only count as not given (the web form sends ''
 * for untouched fields).
 */
export function parseMySqlCredentialsFromUserInput(
  userProvidedParams: Record<string, unknown>,
): ParsedMySqlCredentials {
  return runMySqlCredentialParsingWithSafeErrors(() => {
    const submittedValues = readSubmittedMySqlCredentialValues(userProvidedParams, {
      keysToRead: MYSQL_CREDENTIAL_INPUT_KEYS,
      rejectUnknownKeys: true,
      describeNonTextValue: describeNonTextSubmittedValue,
    });
    return validateMySqlCredentialValues(nonEmptySubmittedValues(submittedValues), { inheritedSslMode: undefined });
  });
}

/**
 * EDIT (PATCH) semantics, pure. `patch` holds only the keys the caller sent; `''` (or null) clears a key.
 * - A connection string in the patch re-specifies host, port, database, username and password AS A WHOLE: a URL
 *   without a database or password removes the stored one. SSL Mode and CA Certificate still come from the patch,
 *   else from the stored settings. A URL next to a non-empty discrete connection field is ambiguous (rejected);
 *   next to '' fields it is fine (the web edit form sends '' for fields touched and then cleared).
 * - Otherwise the patch's fields are merged over the stored MySQL keys. Clearing the port restores 3306; clearing
 *   SSL Mode restores the default (VERIFY_CA when a CA certificate remains); clearing the CA keeps the SSL mode
 *   (VERIFY_* then trusts the public roots + Amazon RDS); clearing Host or Username is an error.
 * - The stored SSL mode is inherited unless the patch sends SSL Mode: a connection-string SSL option overrides it,
 *   and a newly added CA upgrades an inherited REQUIRED / DISABLED to VERIFY_CA.
 * - Stored keys are PICKED (the blob may carry other connectors' keys or the account row); a stored
 *   `connectionString` is ignored, so the first real edit purges it.
 */
export function applyMySqlCredentialPatch(
  patch: Record<string, unknown>,
  existingCredentials: Partial<DecryptedCredentials> | undefined,
): ParsedMySqlCredentials {
  return runMySqlCredentialParsingWithSafeErrors(() => {
    const submittedPatchValues = readSubmittedMySqlCredentialValues(patch, {
      keysToRead: MYSQL_CREDENTIAL_INPUT_KEYS,
      rejectUnknownKeys: true,
      describeNonTextValue: describeNonTextSubmittedValue,
    });
    const patchSetsConnectionString = typeof submittedPatchValues.get('connectionString') === 'string';

    // Only the stored keys the result actually uses are read (and must be text).
    const storedKeysToInherit = MYSQL_CREDENTIAL_KEYS.filter((credentialKey) => {
      if (submittedPatchValues.has(credentialKey)) return false;
      const isReplacedByConnectionString = (MYSQL_CONNECTION_TARGET_CREDENTIAL_KEYS as readonly string[]).includes(
        credentialKey,
      );
      return !(patchSetsConnectionString && isReplacedByConnectionString);
    });
    const storedValues = readSubmittedMySqlCredentialValues(existingCredentials ?? {}, {
      keysToRead: storedKeysToInherit,
      rejectUnknownKeys: false,
      describeNonTextValue: describeNonTextStoredValue,
    });

    const { sslMode: storedSslModeText, ...storedValuesExceptSslMode } = nonEmptySubmittedValues(storedValues);
    const mergedValues: MySqlCredentialValuesToValidate = {
      ...storedValuesExceptSslMode,
      ...nonEmptySubmittedValues(submittedPatchValues),
    };
    // An unreadable stored SSL mode is dropped (it never took effect: connecting rejects it).
    const inheritedSslMode =
      storedSslModeText === undefined ? undefined : mapMySqlSslModeSpellingToSslMode(storedSslModeText);
    return validateMySqlCredentialValues(mergedValues, { inheritedSslMode });
  });
}

/**
 * CONNECT: re-validate the stored settings. `decryptedCredentials` is the whole account row spread with the
 * decrypted blob (`connector-account.service.ts#getDecryptedAccount`), so the MySQL keys are picked explicitly and
 * everything else is ignored. A stored connection string is refused, never parsed: it can only come from a raw
 * PATCH or an old blob, and preferring it would silently ignore a later password-only edit of the fields.
 */
export function parseStoredMySqlCredentials(
  decryptedCredentials: DecryptedCredentials | null | undefined,
): MySqlConnectionOptions {
  return runMySqlCredentialParsingWithSafeErrors(() => {
    if (decryptedCredentials === null || decryptedCredentials === undefined) {
      throw new MySqlCredentialsInvalidError(
        MySqlCredentialProblem.StoredCredentialsMissing,
        'This MySQL connection has no saved settings. Edit the connection and enter them again.',
      );
    }
    const storedConnectionString = readOwnPropertyValue(decryptedCredentials, 'connectionString');
    if (typeof storedConnectionString === 'string' && storedConnectionString.trim() !== '') {
      throw new MySqlCredentialsInvalidError(
        MySqlCredentialProblem.StoredConnectionStringNotSupported,
        "This MySQL connection's saved settings include a connection string, which Scratch only accepts while " +
          'creating a connection. Delete this connection and create it again.',
      );
    }
    if (
      storedConnectionString !== undefined &&
      storedConnectionString !== null &&
      typeof storedConnectionString !== 'string'
    ) {
      throw describeNonTextStoredValue('connectionString');
    }

    const storedValues = readSubmittedMySqlCredentialValues(decryptedCredentials, {
      keysToRead: MYSQL_CREDENTIAL_KEYS,
      rejectUnknownKeys: false,
      describeNonTextValue: describeNonTextStoredValue,
    });
    const { sslMode: storedSslModeText, ...storedValuesExceptSslMode } = nonEmptySubmittedValues(storedValues);
    const missingRequiredStoredKey = (['databaseHost', 'username'] as const).find(
      (requiredKey) => storedValuesExceptSslMode[requiredKey] === undefined,
    );
    if (missingRequiredStoredKey !== undefined) {
      const missingFieldLabel = MYSQL_CREDENTIAL_FIELD_LABELS[missingRequiredStoredKey];
      throw new MySqlCredentialsInvalidError(
        MySqlCredentialProblem.StoredCredentialsMissing,
        `This MySQL connection has no saved ${missingFieldLabel}. Edit the connection and enter ${missingFieldLabel} again.`,
      );
    }
    let inheritedSslMode: MySqlSslMode | undefined;
    if (storedSslModeText !== undefined) {
      inheritedSslMode = mapMySqlSslModeSpellingToSslMode(storedSslModeText);
      if (inheritedSslMode === undefined) {
        throw new MySqlCredentialsInvalidError(
          MySqlCredentialProblem.SslModeInvalid,
          "This MySQL connection's saved SSL Mode isn't valid. Edit the connection and choose DISABLED, REQUIRED, VERIFY_CA or VERIFY_IDENTITY.",
        );
      }
    }
    return validateMySqlCredentialValues(storedValuesExceptSslMode, { inheritedSslMode }).connectionOptions;
  });
}

/** The canonical stored form of validated options: optional keys omitted when absent, the port as text. */
export function serializeMySqlConnectionOptionsForStorage(
  connectionOptions: MySqlConnectionOptions,
): MySqlStoredCredentials {
  return {
    databaseHost: connectionOptions.host,
    databasePort: String(connectionOptions.port),
    ...(connectionOptions.databaseName !== undefined ? { databaseName: connectionOptions.databaseName } : {}),
    username: connectionOptions.username,
    ...(connectionOptions.password !== '' ? { password: connectionOptions.password } : {}),
    sslMode: connectionOptions.sslMode,
    ...(connectionOptions.sslCaCertificatePem !== undefined
      ? { sslCaCertificate: connectionOptions.sslCaCertificatePem }
      : {}),
  };
}

/**
 * The Host field's rules; the value is never echoed (a pasted `user:password@host` must not bounce back). Returns
 * the host to connect to: an IPv6 literal without brackets. `localhost` and private addresses are NOT rejected
 * here — refusing them is the database host guard's job, at connect time, after DNS.
 */
export function normalizeMySqlDatabaseHost(trimmedHost: string): string {
  if (trimmedHost.length > (MYSQL_CREDENTIAL_INPUT_MAXIMUM_LENGTHS.databaseHost ?? 0)) {
    throw describeTooLongValue('databaseHost');
  }
  if (trimmedHost.includes('://')) {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.HostContainsUrl,
      'Enter only the hostname in Host, e.g. db.example.com. To paste a URL, use Connection String instead.',
    );
  }
  if (trimmedHost.includes('@')) {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.HostContainsCredentials,
      "Host should be only the hostname, without a username or password (drop everything up to '@'). Enter those in Username and Password.",
    );
  }
  if (/[/\\?#]/.test(trimmedHost)) {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.HostContainsPath,
      'Host should be only the hostname, without a path or options, e.g. db.example.com.',
    );
  }
  if (trimmedHost.startsWith('[')) {
    if (/^\[[^\]]*\]:\d*$/.test(trimmedHost)) {
      throw describeHostContainsPort();
    }
    const hostInsideBrackets = trimmedHost.endsWith(']') ? trimmedHost.slice(1, -1) : '';
    if (!isIpv6LiteralWithoutZone(hostInsideBrackets)) {
      throw describeInvalidHost();
    }
    return hostInsideBrackets;
  }
  if (trimmedHost.includes(':')) {
    if (isIpv6LiteralWithoutZone(trimmedHost)) {
      return trimmedHost;
    }
    if (/^[^:]+:\d+$/.test(trimmedHost)) {
      throw describeHostContainsPort();
    }
    throw describeInvalidHost();
  }
  if (!MYSQL_HOSTNAME_PATTERN.test(trimmedHost)) {
    throw describeInvalidHost();
  }
  return trimmedHost;
}

// ---------------------------------------------------------------------------------------------------------------
// The single validation path
// ---------------------------------------------------------------------------------------------------------------

function validateMySqlCredentialValues(
  valuesToValidate: MySqlCredentialValuesToValidate,
  options: { inheritedSslMode: MySqlSslMode | undefined },
): ParsedMySqlCredentials {
  let host: string;
  let port: number;
  let databaseName: string | undefined;
  let username: string;
  let password: string | undefined;
  let sslModeFromConnectionString: MySqlSslMode | undefined;

  const connectionString = valuesToValidate.connectionString;
  if (connectionString !== undefined) {
    const connectionTargetKeysAlsoGiven = MYSQL_CONNECTION_TARGET_CREDENTIAL_KEYS.filter(
      (credentialKey) => valuesToValidate[credentialKey] !== undefined,
    );
    if (connectionTargetKeysAlsoGiven.length > 0) {
      const alsoGivenLabels = connectionTargetKeysAlsoGiven.map(
        (credentialKey) => MYSQL_CREDENTIAL_FIELD_LABELS[credentialKey],
      );
      throw new MySqlCredentialsInvalidError(
        MySqlCredentialProblem.ConnectionStringCombinedWithDiscreteFields,
        `Use either the connection string or Host/Port/Database/Username/Password, not both. Clear ${alsoGivenLabels.join(', ')} or the connection string.`,
      );
    }
    const parsedConnectionString = parseMySqlConnectionString(connectionString);
    host = normalizeMySqlDatabaseHost(parsedConnectionString.host);
    port = parsedConnectionString.port ?? DEFAULT_MYSQL_PORT;
    databaseName = parsedConnectionString.databaseName;
    username = parsedConnectionString.username;
    password = parsedConnectionString.password;
    sslModeFromConnectionString = parsedConnectionString.sslModeFromConnectionString;
  } else {
    if (valuesToValidate.databaseHost === undefined) {
      throw new MySqlCredentialsInvalidError(
        MySqlCredentialProblem.HostOrConnectionStringRequired,
        'Enter a Host and Username, or paste a Connection String.',
      );
    }
    if (valuesToValidate.username === undefined) {
      throw new MySqlCredentialsInvalidError(
        MySqlCredentialProblem.UsernameRequired,
        'Enter the Username Scratch should connect as.',
      );
    }
    host = normalizeMySqlDatabaseHost(valuesToValidate.databaseHost);
    port = parseMySqlPortFieldValue(valuesToValidate.databasePort);
    databaseName = valuesToValidate.databaseName;
    username = valuesToValidate.username;
    password = valuesToValidate.password;
  }

  // Values from a connection string go through the same caps as the fields.
  assertMySqlDatabaseNameIsValid(databaseName);
  assertMySqlUsernameIsValid(username);
  if (password !== undefined && password.length > (MYSQL_CREDENTIAL_INPUT_MAXIMUM_LENGTHS.password ?? 0)) {
    throw describeTooLongValue('password');
  }

  const sslCaCertificatePem =
    valuesToValidate.sslCaCertificate === undefined
      ? undefined
      : normalizeMySqlCaCertificateBundlePem(valuesToValidate.sslCaCertificate);
  const sslMode = resolveEffectiveMySqlSslMode({
    sslModeFromField:
      valuesToValidate.sslMode === undefined ? undefined : parseMySqlSslModeFieldValue(valuesToValidate.sslMode),
    sslModeFromConnectionString,
    inheritedSslMode: options.inheritedSslMode,
    hasCaCertificate: sslCaCertificatePem !== undefined,
  });
  // mysql2 sends no SNI name for an IP-literal host, and Node then checks the certificate against "localhost"
  // (verified against MySQL 8.4: "Host: localhost. is not cert's CN"). VERIFY_IDENTITY would so reject a
  // certificate issued for the IP and accept one issued for localhost — refuse it rather than pretend to check.
  if (sslMode === 'VERIFY_IDENTITY' && net.isIP(host) !== 0) {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.SslModeVerifyIdentityRequiresHostname,
      "SSL Mode VERIFY_IDENTITY checks the server's certificate against the hostname, so Host must be the hostname " +
        'on the certificate, not an IP address. Use that hostname, or choose VERIFY_CA.',
    );
  }

  const connectionOptions: MySqlConnectionOptions = Object.freeze({
    host,
    port,
    ...(databaseName !== undefined ? { databaseName } : {}),
    username,
    // mysql2 takes '' for an account without a password.
    password: password ?? '',
    sslMode,
    ...(sslCaCertificatePem !== undefined ? { sslCaCertificatePem } : {}),
  });
  return { storedCredentials: serializeMySqlConnectionOptionsForStorage(connectionOptions), connectionOptions };
}

function parseMySqlPortFieldValue(portText: string | undefined): number {
  if (portText === undefined) return DEFAULT_MYSQL_PORT;
  const port = MYSQL_PORT_TEXT_PATTERN.test(portText) ? Number(portText) : Number.NaN;
  if (!(port >= 1 && port <= 65535)) {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.PortInvalid,
      `Port must be a whole number from 1 to 65535 (MySQL's default is ${DEFAULT_MYSQL_PORT}).`,
    );
  }
  return port;
}

function assertMySqlDatabaseNameIsValid(databaseName: string | undefined): void {
  if (databaseName === undefined) return;
  if (databaseName.length > MYSQL_DATABASE_NAME_MAX_LENGTH || databaseName.includes('\u0000')) {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.DatabaseNameInvalid,
      `Database must be a MySQL database name: at most ${MYSQL_DATABASE_NAME_MAX_LENGTH} characters, with no NUL characters. Leave it blank to see every database the user can access.`,
    );
  }
}

function assertMySqlUsernameIsValid(username: string): void {
  if (username.length > (MYSQL_CREDENTIAL_INPUT_MAXIMUM_LENGTHS.username ?? 0)) {
    throw describeTooLongValue('username');
  }
  // mysql2 sends the user name NUL-terminated in the handshake, so a NUL would silently truncate it.
  if (username.includes('\u0000')) {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.UsernameInvalid,
      "Username can't contain a NUL character.",
    );
  }
}

function isIpv6LiteralWithoutZone(host: string): boolean {
  // A zone (`fe80::1%eth0`) names an interface on the CLIENT machine; it means nothing to Scratch's servers.
  return !host.includes('%') && net.isIPv6(host);
}

function describeHostContainsPort(): MySqlCredentialsInvalidError {
  return new MySqlCredentialsInvalidError(
    MySqlCredentialProblem.HostContainsPort,
    'Put the port in the Port field, not in Host.',
  );
}

function describeInvalidHost(): MySqlCredentialsInvalidError {
  return new MySqlCredentialsInvalidError(
    MySqlCredentialProblem.HostInvalid,
    'Host must be a hostname or an IP address, e.g. db.example.com.',
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Reading raw input
// ---------------------------------------------------------------------------------------------------------------

/**
 * Read the given keys from an untrusted object (request body, stored blob, account row spread): own properties
 * only, `undefined` = not given, `null` / '' / whitespace-only = sent empty, anything that isn't text is rejected
 * naming the field's label. Every value except the password is trimmed (a password may legitimately start or end
 * with a space). Length caps run before any other check.
 */
function readSubmittedMySqlCredentialValues(
  untrustedSource: object,
  options: {
    keysToRead: readonly MySqlCredentialInputKey[];
    rejectUnknownKeys: boolean;
    describeNonTextValue: (credentialKey: MySqlCredentialInputKey) => MySqlCredentialsInvalidError;
  },
): SubmittedMySqlCredentialValues {
  if (options.rejectUnknownKeys) {
    const unknownKeys = Object.keys(untrustedSource).filter(
      (submittedKey) => !(MYSQL_CREDENTIAL_INPUT_KEYS as readonly string[]).includes(submittedKey),
    );
    if (unknownKeys.length > 0) {
      throw describeUnknownSetting(unknownKeys[0]);
    }
  }

  const submittedValues: SubmittedMySqlCredentialValues = new Map();
  for (const credentialKey of options.keysToRead) {
    const rawValue = readOwnPropertyValue(untrustedSource, credentialKey);
    if (rawValue === undefined) continue;
    if (rawValue === null) {
      submittedValues.set(credentialKey, null);
      continue;
    }
    if (typeof rawValue !== 'string') {
      throw options.describeNonTextValue(credentialKey);
    }
    const valueToValidate = credentialKey === 'password' ? rawValue : rawValue.trim();
    const maximumLength = MYSQL_CREDENTIAL_INPUT_MAXIMUM_LENGTHS[credentialKey];
    if (maximumLength !== undefined && valueToValidate.length > maximumLength) {
      throw describeTooLongValue(credentialKey);
    }
    submittedValues.set(credentialKey, valueToValidate === '' ? null : valueToValidate);
  }
  return submittedValues;
}

function nonEmptySubmittedValues(submittedValues: SubmittedMySqlCredentialValues): MySqlCredentialValuesToValidate {
  const nonEmptyValues: MySqlCredentialValuesToValidate = {};
  for (const [credentialKey, submittedValue] of submittedValues) {
    if (submittedValue !== null) nonEmptyValues[credentialKey] = submittedValue;
  }
  return nonEmptyValues;
}

/** Own properties only: never `__proto__` / `constructor` / anything inherited from Object.prototype. */
function readOwnPropertyValue(untrustedSource: object, propertyName: string): unknown {
  return Object.prototype.hasOwnProperty.call(untrustedSource, propertyName)
    ? Reflect.get(untrustedSource, propertyName)
    : undefined;
}

/** Setting names are shown only when they look like a setting name (never a pasted value). */
function describeUnknownSetting(unknownKey: string): MySqlCredentialsInvalidError {
  const displayableUnknownKey = /^[A-Za-z0-9_.-]{1,40}$/.test(unknownKey) ? `'${unknownKey}'` : 'with that name';
  return new MySqlCredentialsInvalidError(
    MySqlCredentialProblem.UnknownSetting,
    `Unknown MySQL setting ${displayableUnknownKey}. Valid settings: ${MYSQL_CREDENTIAL_INPUT_KEYS.join(', ')}.`,
  );
}

function describeNonTextSubmittedValue(credentialKey: MySqlCredentialInputKey): MySqlCredentialsInvalidError {
  const fieldLabel = MYSQL_CREDENTIAL_FIELD_LABELS[credentialKey];
  const portExample = credentialKey === 'databasePort' ? ', e.g. "3306"' : '';
  return new MySqlCredentialsInvalidError(
    MySqlCredentialProblem.SettingNotText,
    `${fieldLabel} must be text${portExample}.`,
  );
}

function describeNonTextStoredValue(credentialKey: MySqlCredentialInputKey): MySqlCredentialsInvalidError {
  const fieldLabel = MYSQL_CREDENTIAL_FIELD_LABELS[credentialKey];
  return new MySqlCredentialsInvalidError(
    MySqlCredentialProblem.StoredSettingNotText,
    `This MySQL connection's saved ${fieldLabel} isn't valid. Edit the connection and enter ${fieldLabel} again.`,
  );
}

function describeTooLongValue(credentialKey: MySqlCredentialInputKey): MySqlCredentialsInvalidError {
  const fieldLabel = MYSQL_CREDENTIAL_FIELD_LABELS[credentialKey];
  const maximumLength = MYSQL_CREDENTIAL_INPUT_MAXIMUM_LENGTHS[credentialKey];
  return new MySqlCredentialsInvalidError(
    MySqlCredentialProblem.SettingTooLong,
    maximumLength === undefined
      ? `${fieldLabel} is too long.`
      : `${fieldLabel} is too long (at most ${maximumLength} characters).`,
  );
}
