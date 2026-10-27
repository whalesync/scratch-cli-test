/**
 * The local Postgres the Postgres integration specs run against: `DATABASE_URL` (CI's `postgres` service, or the
 * localdev database), which has no TLS.
 */
const DEFAULT_LOCAL_POSTGRES_TEST_DATABASE_URL =
  'postgresql://postgres:postgres@localhost:5432/scratchpad?schema=public';

/** The test database URL as configured, for setting up tables with `pg` directly. */
export function readLocalPostgresTestDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_LOCAL_POSTGRES_TEST_DATABASE_URL;
}

/**
 * The connection string to hand the Postgres connector for that database: with `sslmode=disable` unless the URL sets
 * its own sslmode, because the connector encrypts by default (DEV-12575) and the local and CI servers have no TLS.
 */
export function buildConnectorConnectionStringForLocalPostgresTestDatabase(): string {
  const connectionStringUrl = new URL(readLocalPostgresTestDatabaseUrl());
  if (!connectionStringUrl.searchParams.has('sslmode')) connectionStringUrl.searchParams.set('sslmode', 'disable');
  return connectionStringUrl.toString();
}
