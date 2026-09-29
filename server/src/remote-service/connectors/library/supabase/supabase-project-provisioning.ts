/**
 * Provisioning of the per-project database role an OAuth Supabase connection
 * uses for its data plane.
 *
 * Supabase's OAuth token authorizes the *Management* API, not Postgres — reading
 * or writing rows needs a real database login. So Scratch creates one dedicated
 * role per project ({@link SUPABASE_SERVICE_ROLE_NAME_PREFIX}) through the
 * Management API's SQL endpoint, which runs as the project's `postgres`
 * superuser.
 *
 * This runs **lazily**, the first time a project is actually used — a table
 * added, a schema created, rows read or written (DEV-11875). It used to run for
 * every project in the organization the moment the user finished the OAuth flow,
 * which meant connecting a single project left a Scratch role sitting in every
 * other project (production databases included) that the user never pointed us
 * at. Browsing — listing projects, schemas and tables — deliberately does NOT
 * come through here; it goes over the Management API instead
 * ({@link SupabaseManagementApiCatalogReader}).
 */
import { SupabaseProjectCredentials } from '@spinner/shared-types';
import { randomUUID } from 'crypto';
import { KnexPGClient } from '../pg-common';
import { SupabaseApiClient } from './supabase-api-client';
import { buildConnectionString, buildCreateUserSQL } from './supabase-setup-utils';

/**
 * Prefix of the role Scratch creates in a customer's Supabase project. It names
 * **Whalesync**, not Scratch: this role shows up in the customer's own database
 * — in `pg_roles`, in their audit logs, in the Supabase dashboard — and
 * Whalesync is the company name they recognize on the connection they
 * authorized.
 *
 * Roles provisioned before this rename keep their old `scratch_svc_…` name and
 * keep working, because a project's credentials store the username and
 * connection string that reach it. So the prefix is **not** a reliable way to
 * find every role we own: read `credentials.supabaseProjects[].dbUsername`
 * instead.
 */
const SUPABASE_SERVICE_ROLE_NAME_PREFIX = 'whalesync_svc_';

/**
 * Create a service role in one Supabase project and return the credentials that
 * reach it, verified with a live connection before they are handed back.
 *
 * The caller persists the result; see
 * `SupabaseConnector.ensureProjectRoleProvisioned` for how a race between two
 * concurrent provisioners resolves.
 */
export async function provisionServiceRoleForSupabaseProject(
  apiClient: SupabaseApiClient,
  projectRef: string,
  projectName: string,
): Promise<SupabaseProjectCredentials> {
  // Username and password are generated here (UUID-based), never user input.
  const dbUsername = `${SUPABASE_SERVICE_ROLE_NAME_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const dbPassword = randomUUID() + randomUUID().replace(/-/g, '');

  await apiClient.executeQuery(projectRef, buildCreateUserSQL(dbUsername, dbPassword));

  const poolerConfigs = await apiClient.getPoolerConfig(projectRef);
  const poolerConnectionString = poolerConfigs?.[0]?.connection_string;
  if (!poolerConnectionString) {
    throw new Error(`Supabase project ${projectName} (${projectRef}) has no connection pooler configuration.`);
  }

  const connectionString = buildConnectionString(poolerConnectionString, dbUsername, dbPassword, projectRef);

  // Verify the new role can actually log in before anything is persisted or a
  // caller starts a job against it.
  const pgClient = new KnexPGClient(connectionString, { sslNoVerify: true });
  try {
    await pgClient.testQuery();
  } finally {
    await pgClient.dispose().catch(() => {});
  }

  return { projectRef, projectName, connectionString, dbUsername, dbPassword };
}

/**
 * Best-effort removal of a role this process created but lost the race to
 * persist — the loser of a concurrent provision would otherwise leave an
 * orphaned login role behind, which is exactly the litter DEV-11875 is about.
 * Failure is swallowed: the winning role is already stored and usable, and a
 * stray unreferenced role must never fail a user's operation.
 */
export async function dropOrphanedServiceRole(
  apiClient: SupabaseApiClient,
  projectRef: string,
  dbUsername: string,
): Promise<void> {
  // A role can't be dropped while grants still reference it: `DROP OWNED BY`
  // clears the per-schema/table grants and default privileges, and the explicit
  // REVOKE clears the database-level CREATE (a shared object, which `DROP OWNED
  // BY` does not cover).
  const dropRoleSQL = `
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${dbUsername}') THEN
    EXECUTE format('REVOKE ALL ON DATABASE %I FROM "${dbUsername}"', current_database());
    EXECUTE 'DROP OWNED BY "${dbUsername}"';
    EXECUTE 'DROP ROLE "${dbUsername}"';
  END IF;
END
$$;`;
  await apiClient.executeQuery(projectRef, dropRoleSQL).catch(() => {});
}
