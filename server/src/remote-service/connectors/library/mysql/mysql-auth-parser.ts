import { type DecryptedCredentials } from '@spinner/shared-types';
import { AuthParser } from '../../connector';
import { Service } from '../../service-constants';
import {
  applyMySqlCredentialPatch,
  MYSQL_CREDENTIAL_KEYS,
  parseMySqlCredentialsFromUserInput,
  type MySqlStoredCredentials,
} from './mysql-connection-options';
import { runMySqlCredentialParsingWithSafeErrors } from './mysql-credential-errors';

/**
 * Validates and normalizes MySQL connection settings before they are encrypted and stored. No network I/O: the
 * service runs `testConnection` after creating the account.
 *
 * Returns ONLY the discrete settings (`MYSQL_CREDENTIAL_KEYS`, all text, optional ones omitted when absent). A
 * pasted connection string is decomposed into them and never stored. Every failure is a
 * `MySqlCredentialsInvalidError` (a `ConnectorAuthError` → 400) whose message is safe to show and store.
 */
export class MySqlAuthParser extends AuthParser {
  readonly service = Service.MYSQL;

  /**
   * Create when `existingCredentials` is undefined; edit (PATCH semantics, see `applyMySqlCredentialPatch`) when
   * the service passes the stored credentials.
   *
   * Signature compatibility with `AuthParser.parseUserProvidedParams` (`connector.ts`), whose parameter today is
   * `{ userProvidedParams: Record<string, string | undefined> }`: this parameter type only ADDS an optional
   * `existingCredentials`, so it is a supertype of the abstract one — every call the service makes today
   * (`{ userProvidedParams }`, create only) is valid here, and the override type-checks under both method
   * bivariance and strict contravariance. The follow-up that runs the parser on PATCH only has to widen the
   * abstract type with the same optional `existingCredentials` key and pass the stored blob; nothing changes here.
   *
   * At runtime the values aren't guaranteed to be strings (the CLI create DTO only checks `@IsObject()`; the PATCH
   * schema is `z.record(z.string(), z.unknown())`), so the settings are parsed as `unknown` and non-text values are
   * rejected by field name.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async parseUserProvidedParams(params: {
    userProvidedParams: Record<string, string | undefined>;
    existingCredentials?: DecryptedCredentials;
  }): Promise<{ credentials: Record<string, string>; extras: Record<string, string> }> {
    const { storedCredentials } = runMySqlCredentialParsingWithSafeErrors(() =>
      params.existingCredentials === undefined
        ? parseMySqlCredentialsFromUserInput(params.userProvidedParams)
        : applyMySqlCredentialPatch(params.userProvidedParams, params.existingCredentials),
    );
    return { credentials: toCredentialTextRecord(storedCredentials), extras: {} };
  }
}

/** Exactly the stored MySQL keys that have a value — never `connectionString`, never an `undefined` entry. */
function toCredentialTextRecord(storedCredentials: MySqlStoredCredentials): Record<string, string> {
  const credentialTextRecord: Record<string, string> = {};
  for (const credentialKey of MYSQL_CREDENTIAL_KEYS) {
    const storedValue = storedCredentials[credentialKey];
    if (storedValue !== undefined) {
      credentialTextRecord[credentialKey] = storedValue;
    }
  }
  return credentialTextRecord;
}
