/**
 * Postgres / Supabase connection security integration test (DEV-12390), against the localdev Postgres.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * What this validates that the unit tests don't
 * ═══════════════════════════════════════════════════════════════════════════
 * The unit specs check `SsrfSafeSocket` against a bare TCP server and `KnexPGClient`'s config with knex mocked. This
 * spec goes through the real connectors, knex and node-postgres, and proves:
 *
 *   1. With `RUNNING_IN_CLOUD=true` (every deployed environment) a database on a loopback address is refused, whether
 *      the host is the literal IP or a name that resolves to it, for Postgres and for Supabase's connection-string
 *      mode. The refusal reaches the connector as the guard's own `SsrfError` (knex / node-postgres don't wrap it), and
 *      the user sees the generic unreachable-host message, with no address in it.
 *   2. Without `RUNNING_IN_CLOUD` the configured test database connects, so the guard is all that changed.
 *   3. A connection string that would make node-postgres read a file (`?sslrootcert=/dev/zero`, which would block the
 *      process until it ran out of memory) fails at once, without the file being read.
 *
 * Run via: cd server && yarn test:integration -- postgres-database-host-guard
 */
import fs from 'fs';
import {
  KnexPGClientError,
  POSTGRES_HOST_NOT_REACHABLE_MESSAGE,
} from 'src/remote-service/connectors/library/pg-common';
import { PostgresConnector } from 'src/remote-service/connectors/library/postgres/postgres-connector';
import { SupabaseConnector } from 'src/remote-service/connectors/library/supabase/supabase-connector';
import { SsrfError } from 'src/remote-service/connectors/utils/ssrf-address-guard';
import { buildConnectorConnectionStringForLocalPostgresTestDatabase } from './postgres-integration-helpers';

// With sslmode=disable: the local and CI servers have no TLS, and the guard refuses before TLS starts anyway.
const localDatabaseUrl = new URL(buildConnectorConnectionStringForLocalPostgresTestDatabase());

function localDatabaseConnectionStringWithHost(host: string): string {
  const connectionStringUrl = new URL(localDatabaseUrl.toString());
  connectionStringUrl.hostname = host;
  return connectionStringUrl.toString();
}

async function errorFrom(operation: () => Promise<unknown>): Promise<unknown> {
  return operation().then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('Postgres and Supabase connections — database host guard and connection-string allowlist', () => {
  const runningInCloudBeforeEachTest = process.env.RUNNING_IN_CLOUD;

  afterEach(() => {
    if (runningInCloudBeforeEachTest === undefined) {
      delete process.env.RUNNING_IN_CLOUD;
    } else {
      process.env.RUNNING_IN_CLOUD = runningInCloudBeforeEachTest;
    }
  });

  // The configured database as given: localhost locally, the `postgres` service alias (a Docker-network address) in
  // CI, where nothing listens on the job container's own loopback.
  it('connects to the configured test database when not running in the cloud', async () => {
    delete process.env.RUNNING_IN_CLOUD;
    const connector = new PostgresConnector({ connectionString: localDatabaseUrl.toString() });

    await expect(connector.testConnection()).resolves.toBeUndefined();
  });

  it.each([
    ['the configured test database host', localDatabaseUrl.hostname],
    ['127.0.0.1', '127.0.0.1'],
    ['localhost', 'localhost'],
  ])('refuses %s in deployed environments, with the generic message and no address', async (_description, host) => {
    process.env.RUNNING_IN_CLOUD = 'true';
    const connector = new PostgresConnector({ connectionString: localDatabaseConnectionStringWithHost(host) });

    const error = await errorFrom(() => connector.testConnection());

    expect(error).toBeInstanceOf(SsrfError);
    const errorDetails = connector.extractConnectorErrorDetails(error);
    expect(errorDetails.userFriendlyMessage).toBe(POSTGRES_HOST_NOT_REACHABLE_MESSAGE);
    for (const addressOrPort of [host, '127.0.0.1', '::1', 'localhost', `:${localDatabaseUrl.port || '5432'}`]) {
      expect(JSON.stringify(errorDetails)).not.toContain(addressOrPort);
    }
  });

  it("refuses a Supabase connection string's loopback host in deployed environments", async () => {
    process.env.RUNNING_IN_CLOUD = 'true';
    // A pooler-style user (`<role>.<project ref>`), which the Supabase connector reads the project ref from.
    const supabaseConnectionStringUrl = new URL(localDatabaseConnectionStringWithHost('127.0.0.1'));
    supabaseConnectionStringUrl.username = 'postgres.abcdefghijklmnopqrst';
    const connector = new SupabaseConnector({ connectionString: supabaseConnectionStringUrl.toString() });

    const error = await errorFrom(() => connector.testConnection());

    expect(error).toBeInstanceOf(SsrfError);
    expect(connector.extractConnectorErrorDetails(error).userFriendlyMessage).toBe(POSTGRES_HOST_NOT_REACHABLE_MESSAGE);
  });

  it('refuses a connection string that would make node-postgres read a file, without reading it', async () => {
    delete process.env.RUNNING_IN_CLOUD;
    const readFileSyncSpy = jest.spyOn(fs, 'readFileSync');
    try {
      const connectionStringUrl = new URL(localDatabaseConnectionStringWithHost('127.0.0.1'));
      connectionStringUrl.searchParams.set('sslrootcert', '/dev/zero');
      const connector = new PostgresConnector({ connectionString: connectionStringUrl.toString() });

      const error = await errorFrom(() => connector.testConnection());

      expect(error).toBeInstanceOf(KnexPGClientError);
      expect((error as KnexPGClientError).code).toBe('CONNECTION_STRING_REJECTED');
      expect(connector.extractConnectorErrorDetails(error).userFriendlyMessage).toContain('Remove sslrootcert');
      expect(readFileSyncSpy).not.toHaveBeenCalledWith('/dev/zero');
    } finally {
      readFileSyncSpy.mockRestore();
    }
  });

  it('refuses a ?host= override that would move the connection to a Unix socket', async () => {
    delete process.env.RUNNING_IN_CLOUD;
    const connectionStringUrl = new URL(localDatabaseConnectionStringWithHost('db.example.com'));
    connectionStringUrl.searchParams.set('host', '/var/run/postgresql');
    const connector = new PostgresConnector({ connectionString: connectionStringUrl.toString() });

    const error = await errorFrom(() => connector.testConnection());

    expect(error).toBeInstanceOf(KnexPGClientError);
    expect(connector.extractConnectorErrorDetails(error).userFriendlyMessage).toContain('Remove host');
  });
});
