import { type DecryptedCredentials } from '@spinner/shared-types';
import { AuthParser } from '../../connector';
import { ConnectorAuthError } from '../../error';
import { Service } from '../../service-constants';
import { prepareConnectionStringForNodePostgres } from '../pg-common';

/**
 * Checks a Postgres connection string against the node-postgres allowlist (`node-postgres-connection-string.ts`)
 * before it is encrypted and stored, so a refused string fails when the connection is saved, not on its first sync.
 * No network I/O: the service runs `testConnection` after creating the account. `KnexPGClient` checks the stored string
 * again on every connect.
 *
 * Stores only `connectionString`, trimmed, as the user typed it: the parameters the allowlist drops are dropped again
 * on every connect.
 */
export class PostgresAuthParser extends AuthParser {
  readonly service = Service.POSTGRES;
  /** An edit that sends a new connection string is checked like a create; an edit without one keeps the stored one. */
  override readonly parsesCredentialEditsAgainstStoredCredentials = true;

  // eslint-disable-next-line @typescript-eslint/require-await
  async parseUserProvidedParams(params: {
    userProvidedParams: Record<string, string | undefined>;
    existingCredentials?: DecryptedCredentials;
  }): Promise<{ credentials: Record<string, string>; extras: Record<string, string> }> {
    // The values aren't guaranteed to be strings at runtime: the CLI create DTO only checks `@IsObject()`, and the
    // PATCH schema is `z.record(z.string(), z.unknown())`.
    const connectionStringFromUser: unknown = params.userProvidedParams.connectionString;
    const isEditKeepingTheStoredConnectionString =
      params.existingCredentials !== undefined && connectionStringFromUser === undefined;
    const connectionStringToStore = isEditKeepingTheStoredConnectionString
      ? params.existingCredentials?.connectionString
      : connectionStringFromUser;

    if (typeof connectionStringToStore !== 'string' || connectionStringToStore.trim().length === 0) {
      throw new ConnectorAuthError(
        'Connection string is required for PostgreSQL',
        'Enter a connection string, e.g. postgres://user:password@host:5432/database.',
        this.service,
      );
    }
    const connectionStringPreparation = prepareConnectionStringForNodePostgres(connectionStringToStore);
    if (!connectionStringPreparation.accepted) {
      throw new ConnectorAuthError(
        connectionStringPreparation.userFacingReason,
        connectionStringPreparation.userFacingReason,
        this.service,
      );
    }
    return { credentials: { connectionString: connectionStringToStore.trim() }, extras: {} };
  }
}
