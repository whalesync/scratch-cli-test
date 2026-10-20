/**
 * Which TLS mode a MySQL connection uses, from the SSL Mode field, a connection string's SSL option and the mode
 * already stored for the connection. The mysql2 `ssl` object for the chosen mode is built separately
 * (`mysql-driver-ssl-options.ts`).
 *
 * The rules only ever TIGHTEN what the user asked for:
 * - MySQL's `PREFERRED` and libpq's `prefer` / `allow` mean "TLS if the server offers it, else plaintext". mysql2
 *   can't fall back, and a silent downgrade to plaintext is exactly what a user choosing them doesn't expect, so
 *   they become REQUIRED (a server without TLS then fails loudly and the user can pick DISABLED knowingly).
 * - A connection string that asks for TLS can be made stricter by the SSL Mode field but never weaker: a
 *   DigitalOcean URL carries `?ssl-mode=REQUIRED`, and the user adds the downloaded CA plus VERIFY_CA.
 * - A CA certificate is only used by the VERIFY_* modes. A mode the user chose explicitly is never silently
 *   changed (REQUIRED / DISABLED + CA is rejected); a mode that was only defaulted, inherited or implied by the
 *   URL's REQUIRED is upgraded to VERIFY_CA, since supplying a CA only makes sense for verification.
 */
import { assertUnreachable } from 'src/utils/asserts';
import { MySqlCredentialProblem, MySqlCredentialsInvalidError } from './mysql-credential-errors';
import { DEFAULT_MYSQL_SSL_MODE, type MySqlSslMode } from './mysql-types';

/** Higher = more protection. Used to decide whether the SSL Mode field weakens a connection string's SSL option. */
export const MYSQL_SSL_MODE_STRENGTH: Readonly<Record<MySqlSslMode, number>> = Object.freeze({
  DISABLED: 0,
  REQUIRED: 1,
  VERIFY_CA: 2,
  VERIFY_IDENTITY: 3,
});

/**
 * Every accepted spelling (upper-cased, `-` → `_`) of an SSL mode: MySQL's `--ssl-mode` names, and libpq's
 * `sslmode` names because people paste Postgres habits (`verify-full`, `require`).
 */
const MYSQL_SSL_MODE_BY_NORMALIZED_SPELLING: ReadonlyMap<string, MySqlSslMode> = new Map<string, MySqlSslMode>([
  ['DISABLED', 'DISABLED'],
  ['DISABLE', 'DISABLED'],
  ['PREFERRED', 'REQUIRED'],
  ['PREFER', 'REQUIRED'],
  ['ALLOW', 'REQUIRED'],
  ['REQUIRED', 'REQUIRED'],
  ['REQUIRE', 'REQUIRED'],
  ['VERIFY_CA', 'VERIFY_CA'],
  ['VERIFY_IDENTITY', 'VERIFY_IDENTITY'],
  ['VERIFY_FULL', 'VERIFY_IDENTITY'],
]);

export const MYSQL_SSL_MODE_INVALID_MESSAGE =
  'SSL Mode must be one of DISABLED, REQUIRED, VERIFY_CA or VERIFY_IDENTITY.';

/** The SSL mode a spelling stands for (case-insensitive, `-` or `_`), or undefined when it isn't one. */
export function mapMySqlSslModeSpellingToSslMode(rawSslMode: string): MySqlSslMode | undefined {
  const normalizedSslModeSpelling = rawSslMode.trim().toUpperCase().replace(/-/g, '_');
  return MYSQL_SSL_MODE_BY_NORMALIZED_SPELLING.get(normalizedSslModeSpelling);
}

/** The SSL Mode field's value (`verify-full`, `required`, `VERIFY_CA`, ...) as a canonical mode. */
export function parseMySqlSslModeFieldValue(rawSslMode: string): MySqlSslMode {
  const sslMode = mapMySqlSslModeSpellingToSslMode(rawSslMode);
  if (sslMode === undefined) {
    // The value itself isn't echoed: it is free text the user typed.
    throw new MySqlCredentialsInvalidError(MySqlCredentialProblem.SslModeInvalid, MYSQL_SSL_MODE_INVALID_MESSAGE);
  }
  return sslMode;
}

export function isVerifyingMySqlSslMode(sslMode: MySqlSslMode): boolean {
  return sslMode === 'VERIFY_CA' || sslMode === 'VERIFY_IDENTITY';
}

export interface ResolveEffectiveMySqlSslModeParams {
  /** Chosen explicitly in THIS input's SSL Mode field. */
  readonly sslModeFromField: MySqlSslMode | undefined;
  /** Implied by an SSL option in this input's connection string (`ssl-mode`, `sslaccept`, `ssl`, `useSSL`, ...). */
  readonly sslModeFromConnectionString: MySqlSslMode | undefined;
  /** The mode already stored for the connection (edits and connect-time re-validation only). */
  readonly inheritedSslMode: MySqlSslMode | undefined;
  /** Whether the resulting settings carry a CA certificate. */
  readonly hasCaCertificate: boolean;
}

type MySqlSslModeSource = 'field' | 'connectionString' | 'inherited' | 'default';

/**
 * Precedence: field, then the connection string's SSL option, then the inherited (stored) mode, then REQUIRED.
 * Throws when the field is weaker than the connection string, or when a CA certificate accompanies an SSL mode
 * the user explicitly chose that doesn't verify certificates.
 */
export function resolveEffectiveMySqlSslMode(params: ResolveEffectiveMySqlSslModeParams): MySqlSslMode {
  const { sslModeFromField, sslModeFromConnectionString, inheritedSslMode, hasCaCertificate } = params;

  if (
    sslModeFromField !== undefined &&
    sslModeFromConnectionString !== undefined &&
    MYSQL_SSL_MODE_STRENGTH[sslModeFromField] < MYSQL_SSL_MODE_STRENGTH[sslModeFromConnectionString]
  ) {
    throw new MySqlCredentialsInvalidError(
      MySqlCredentialProblem.SslModeWeakerThanConnectionString,
      `SSL Mode ${sslModeFromField} is weaker than the connection string's SSL option (${sslModeFromConnectionString}). ` +
        `Choose ${sslModeFromConnectionString} or stricter, or remove the SSL option from the connection string.`,
    );
  }

  const [chosenSslMode, chosenSslModeSource]: [MySqlSslMode, MySqlSslModeSource] =
    sslModeFromField !== undefined
      ? [sslModeFromField, 'field']
      : sslModeFromConnectionString !== undefined
        ? [sslModeFromConnectionString, 'connectionString']
        : inheritedSslMode !== undefined
          ? [inheritedSslMode, 'inherited']
          : [DEFAULT_MYSQL_SSL_MODE, 'default'];

  if (!hasCaCertificate || isVerifyingMySqlSslMode(chosenSslMode)) {
    return chosenSslMode;
  }

  switch (chosenSslModeSource) {
    case 'field':
      throw new MySqlCredentialsInvalidError(
        MySqlCredentialProblem.CaCertificateRequiresVerifyingSslMode,
        'A CA certificate is only used with SSL Mode VERIFY_CA or VERIFY_IDENTITY. Choose one of those, or remove the CA certificate.',
      );
    case 'connectionString':
      if (chosenSslMode === 'DISABLED') {
        throw new MySqlCredentialsInvalidError(
          MySqlCredentialProblem.CaCertificateRequiresVerifyingSslMode,
          'The connection string turns SSL off, but a CA certificate was provided. Remove the SSL option from the connection string (or change it to ssl-mode=VERIFY_CA), or remove the CA certificate.',
        );
      }
      return 'VERIFY_CA';
    case 'inherited':
    case 'default':
      return 'VERIFY_CA';
    default:
      return assertUnreachable(chosenSslModeSource);
  }
}
