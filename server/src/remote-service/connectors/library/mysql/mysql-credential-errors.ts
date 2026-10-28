/**
 * The one error type every MySQL credential check throws: the connection-settings parser (create and edit), the
 * connection-string parser, the CA bundle normalizer and the connect-time re-validation of stored settings.
 *
 * Both `message` and `userFriendlyMessage` reach the client, so they are the same safe text:
 * - `ConnectorAuthErrorExceptionFilter` answers `{ message: userFriendlyMessage, error: message }`
 *   (`connector.exception-filter.ts`), and logs `message`;
 * - `connector-account.service.ts#testConnection` stores `error.message` verbatim as the account's
 *   `healthStatusMessage` when `createConnector` throws, and job `failedReason`s use `.message` too.
 *
 * So a message NEVER contains the connection string, a password, the host input that failed validation (it may
 * hold `user:password@`), CA certificate contents, a query-parameter value, or an IP address. Field labels come
 * from our own label map; a connection-string parameter NAME appears only when it passes
 * {@link mySqlConnectionStringParameterNameLooksLikeAnOptionName} AND can't be part of a password (the connection
 * string parser withholds every name that follows `password=`, where an unencoded `&` splits the password).
 */
import { WSLogger } from 'src/logger';
import { ConnectorAuthError } from '../../error';
import { Service } from '../../service-constants';

export enum MySqlCredentialProblem {
  // The shape of the submitted settings.
  UnknownSetting = 'UNKNOWN_SETTING',
  SettingNotText = 'SETTING_NOT_TEXT',
  SettingTooLong = 'SETTING_TOO_LONG',
  HostOrConnectionStringRequired = 'HOST_OR_CONNECTION_STRING_REQUIRED',
  UsernameRequired = 'USERNAME_REQUIRED',
  UsernameInvalid = 'USERNAME_INVALID',
  ConnectionStringCombinedWithDiscreteFields = 'CONNECTION_STRING_COMBINED_WITH_DISCRETE_FIELDS',
  /** An edit would send the saved password to a different host, port or username. */
  PasswordRequiredForConnectionTargetChange = 'PASSWORD_REQUIRED_FOR_CONNECTION_TARGET_CHANGE',

  // Host / port / database.
  HostContainsUrl = 'HOST_CONTAINS_URL',
  HostContainsPort = 'HOST_CONTAINS_PORT',
  HostContainsCredentials = 'HOST_CONTAINS_CREDENTIALS',
  HostContainsPath = 'HOST_CONTAINS_PATH',
  HostInvalid = 'HOST_INVALID',
  PortInvalid = 'PORT_INVALID',
  DatabaseNameInvalid = 'DATABASE_NAME_INVALID',

  // The connection string.
  ConnectionStringAdoNetNotSupported = 'CONNECTION_STRING_ADO_NET_NOT_SUPPORTED',
  ConnectionStringGoDsnNotSupported = 'CONNECTION_STRING_GO_DSN_NOT_SUPPORTED',
  ConnectionStringIsPostgres = 'CONNECTION_STRING_IS_POSTGRES',
  ConnectionStringXProtocol = 'CONNECTION_STRING_X_PROTOCOL',
  ConnectionStringSchemeUnsupported = 'CONNECTION_STRING_SCHEME_UNSUPPORTED',
  ConnectionStringUnparseable = 'CONNECTION_STRING_UNPARSEABLE',
  ConnectionStringMultipleHosts = 'CONNECTION_STRING_MULTIPLE_HOSTS',
  ConnectionStringFragment = 'CONNECTION_STRING_FRAGMENT',
  ConnectionStringParameterUnsupported = 'CONNECTION_STRING_PARAMETER_UNSUPPORTED',
  ConnectionStringCertificatePathParameter = 'CONNECTION_STRING_CERTIFICATE_PATH_PARAMETER',
  ConnectionStringParameterDuplicated = 'CONNECTION_STRING_PARAMETER_DUPLICATED',
  ConnectionStringCredentialsConflict = 'CONNECTION_STRING_CREDENTIALS_CONFLICT',

  // TLS.
  SslModeInvalid = 'SSL_MODE_INVALID',
  SslAliasValueInvalid = 'SSL_ALIAS_VALUE_INVALID',
  SslAliasesConflict = 'SSL_ALIASES_CONFLICT',
  SslModeWeakerThanConnectionString = 'SSL_MODE_WEAKER_THAN_CONNECTION_STRING',
  /** mysql2 can't check a certificate's identity against an IP-literal host (it checks "localhost" instead). */
  SslModeVerifyIdentityRequiresHostname = 'SSL_MODE_VERIFY_IDENTITY_REQUIRES_HOSTNAME',
  CaCertificateRequiresVerifyingSslMode = 'CA_CERTIFICATE_REQUIRES_VERIFYING_SSL_MODE',
  CaCertificateNotFound = 'CA_CERTIFICATE_NOT_FOUND',
  CaCertificateIsPrivateKey = 'CA_CERTIFICATE_IS_PRIVATE_KEY',
  CaCertificateFormatUnsupported = 'CA_CERTIFICATE_FORMAT_UNSUPPORTED',
  CaCertificateMalformed = 'CA_CERTIFICATE_MALFORMED',
  CaCertificateTooLarge = 'CA_CERTIFICATE_TOO_LARGE',

  // Connect-time re-validation of the stored (encrypted) settings.
  StoredCredentialsMissing = 'STORED_CREDENTIALS_MISSING',
  StoredConnectionStringNotSupported = 'STORED_CONNECTION_STRING_NOT_SUPPORTED',
  StoredSettingNotText = 'STORED_SETTING_NOT_TEXT',

  /** A bug in the parser, not in the input. The original error is logged by class name only. */
  Unexpected = 'UNEXPECTED',
}

/**
 * `@Catch(ConnectorAuthError)` matches subclasses via `instanceof`, so this becomes a 400 whose body carries the
 * message; `isUserFriendlyError` matches it too, so the service's parser wrapper rethrows it unchanged.
 */
export class MySqlCredentialsInvalidError extends ConnectorAuthError {
  constructor(
    public readonly problem: MySqlCredentialProblem,
    userFriendlyMessage: string,
  ) {
    // message === userFriendlyMessage on purpose (see the file comment). No `cause`: an underlying error's message
    // (URL / JSON / decodeURIComponent failures) can quote the input, and causes get serialized by some loggers.
    super(userFriendlyMessage, userFriendlyMessage, Service.MYSQL);
    this.name = 'MySqlCredentialsInvalidError';
  }
}

export const MYSQL_UNEXPECTED_CREDENTIAL_PARSING_FAILURE_MESSAGE =
  "Scratch couldn't read these MySQL settings. Check them and try again.";

/**
 * Run a credential parse so that ANY failure leaves as a safe {@link MySqlCredentialsInvalidError}.
 *
 * Needed because the service wraps a parser error that isn't user-friendly as
 * `Unexpected error in parseUserProvidedParams: ${_.toString(error)}` and sends that text to the client
 * (`connector-account.service.ts#parseUserProvidedParams`) — e.g. a `SyntaxError` from `JSON.parse` quotes the
 * input, which may be a password. The unexpected error is logged by class name only, never its message.
 */
export function runMySqlCredentialParsingWithSafeErrors<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof MySqlCredentialsInvalidError) {
      throw error;
    }
    WSLogger.error({
      source: 'MySqlCredentialParsing',
      message: 'Unexpected failure while parsing MySQL connection settings (input and error message withheld)',
      unexpectedErrorClassName: error instanceof Error ? error.name : typeof error,
    });
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.Unexpected,
      MYSQL_UNEXPECTED_CREDENTIAL_PARSING_FAILURE_MESSAGE,
    );
  }
}

/** Parameter names are safe to show only when they look like an option name (not a pasted secret). */
const OPTION_NAME_SHAPED_CONNECTION_STRING_PARAMETER_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,40}$/;

/**
 * True for `serverTimezone`, `ssl-mode`; false for anything that doesn't look like an option name. Necessary but
 * NOT sufficient to show a name: a password fragment split off by an unencoded `&` (`...&password=abc&Secret1`)
 * looks like an option name too, so the caller also withholds names that may be password text.
 */
export function mySqlConnectionStringParameterNameLooksLikeAnOptionName(parameterName: string): boolean {
  return OPTION_NAME_SHAPED_CONNECTION_STRING_PARAMETER_NAME_PATTERN.test(parameterName);
}
