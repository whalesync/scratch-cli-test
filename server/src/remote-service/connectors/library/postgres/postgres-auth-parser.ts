import { type DecryptedCredentials } from '@spinner/shared-types';
import { AuthParser } from '../../connector';
import { ConnectorAuthError } from '../../error';
import { Service } from '../../service-constants';
import {
  POSTGRES_TLS_CERTIFICATE_FIELD_LABELS,
  prepareConnectionStringForNodePostgres,
  preparePostgresTlsSettings,
  type PostgresTlsCertificates,
} from '../pg-common';

/** Every key a Postgres connection stores. Anything else submitted is ignored. */
const POSTGRES_CREDENTIAL_KEYS = [
  'connectionString',
  'sslCaCertificate',
  'sslClientCertificate',
  'sslClientKey',
] as const;
type PostgresCredentialKey = (typeof POSTGRES_CREDENTIAL_KEYS)[number];

const POSTGRES_CREDENTIAL_FIELD_LABELS: Readonly<Record<PostgresCredentialKey, string>> = Object.freeze({
  connectionString: 'Connection String',
  ...POSTGRES_TLS_CERTIFICATE_FIELD_LABELS,
});

/**
 * Checks a Postgres connection's settings before they are encrypted and stored, so a refused setting fails when the
 * connection is saved, not on its first sync: the connection string against the node-postgres allowlist
 * (`node-postgres-connection-string.ts`), and the certificates against each other and the string's `sslmode`
 * (`node-postgres-tls.ts`). No network I/O: the service runs `testConnection` after creating the account.
 * `KnexPGClient` checks the stored settings again on every connect.
 *
 * Stores the connection string trimmed, as the user typed it (the parameters the allowlist drops are dropped again
 * on every connect), and the certificates in canonical PEM. Every failure is a `ConnectorAuthError` whose message is
 * safe to show and store: it never contains the connection string, a password or certificate text.
 */
export class PostgresAuthParser extends AuthParser {
  readonly service = Service.POSTGRES;
  /**
   * An edit is merged over the stored settings, then checked as a whole: a field the edit doesn't send keeps its
   * stored value, and `''` (or null) clears it. So a certificate can be replaced or removed without re-entering the
   * connection string.
   */
  override readonly parsesCredentialEditsAgainstStoredCredentials = true;

  // eslint-disable-next-line @typescript-eslint/require-await
  async parseUserProvidedParams(params: {
    userProvidedParams: Record<string, string | undefined>;
    existingCredentials?: DecryptedCredentials;
  }): Promise<{ credentials: Record<string, string>; extras: Record<string, string> }> {
    const settingsToStore = this.mergeSubmittedSettings(params.userProvidedParams, params.existingCredentials);

    const connectionString = settingsToStore.connectionString;
    if (connectionString === undefined) {
      throw this.refuse('Enter a connection string, e.g. postgres://user:password@host:5432/database.');
    }
    const connectionStringPreparation = prepareConnectionStringForNodePostgres(connectionString, {
      connectionFormHasCertificateFields: true,
    });
    if (!connectionStringPreparation.accepted) {
      throw this.refuse(connectionStringPreparation.userFacingReason);
    }
    const tlsCertificates: PostgresTlsCertificates = {
      sslCaCertificate: settingsToStore.sslCaCertificate,
      sslClientCertificate: settingsToStore.sslClientCertificate,
      sslClientKey: settingsToStore.sslClientKey,
    };
    const tlsSettingsPreparation = preparePostgresTlsSettings({
      tlsMode: connectionStringPreparation.tlsMode,
      serverHost: connectionStringPreparation.host,
      certificates: tlsCertificates,
    });
    if (!tlsSettingsPreparation.accepted) {
      throw this.refuse(tlsSettingsPreparation.userFacingReason);
    }

    const credentials: Record<string, string> = { connectionString };
    for (const [certificateKey, canonicalPem] of Object.entries(tlsSettingsPreparation.canonicalCertificates)) {
      if (typeof canonicalPem === 'string') credentials[certificateKey] = canonicalPem;
    }
    return { credentials, extras: {} };
  }

  /**
   * The settings to check and store, trimmed, blank ones left out. On a create, a blank field counts as not given
   * (the web form sends '' for untouched fields). On an edit, the submitted fields are merged over the stored ones.
   *
   * At runtime the values aren't guaranteed to be strings (the CLI create DTO only checks `@IsObject()`, and the
   * PATCH schema is `z.record(z.string(), z.unknown())`), so each is read as `unknown`.
   */
  private mergeSubmittedSettings(
    userProvidedParams: Record<string, unknown>,
    existingCredentials: DecryptedCredentials | undefined,
  ): Partial<Record<PostgresCredentialKey, string>> {
    const settingsToStore: Partial<Record<PostgresCredentialKey, string>> = {};
    for (const credentialKey of POSTGRES_CREDENTIAL_KEYS) {
      const submittedValue: unknown = userProvidedParams[credentialKey];
      const isEditKeepingTheStoredValue = existingCredentials !== undefined && submittedValue === undefined;
      const value: unknown = isEditKeepingTheStoredValue ? existingCredentials[credentialKey] : submittedValue;
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string') {
        throw this.refuse(`${POSTGRES_CREDENTIAL_FIELD_LABELS[credentialKey]} must be text.`);
      }
      const trimmedValue = value.trim();
      if (trimmedValue.length > 0) settingsToStore[credentialKey] = trimmedValue;
    }
    return settingsToStore;
  }

  private refuse(userFacingReason: string): ConnectorAuthError {
    return new ConnectorAuthError(userFacingReason, userFacingReason, this.service);
  }
}
