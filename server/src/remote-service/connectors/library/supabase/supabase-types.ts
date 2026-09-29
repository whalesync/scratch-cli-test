/**
 * Supabase Management API type definitions.
 * Ported from Whalesync's supabase-types.ts.
 */
import { SupabaseProjectCredentials } from '@spinner/shared-types';

export interface SupabaseProject {
  id: string;
  organization_id: string;
  name: string;
  region: string;
  created_at: string;
  status: string;
}

export interface SupabasePoolerConfig {
  database_type: string;
  default_pool_size: number;
  pool_mode: string;
  connection_string: string;
}

/** One Supabase project as the connector refers to it, provisioned or not. */
export interface SupabaseProjectConfig {
  projectRef: string;
  projectName: string;
}

/**
 * What an OAuth Supabase connection hands its connector.
 *
 * `provisionedProjects` holds only the projects a Scratch database role has
 * already been created in — which, since DEV-11875, means only the projects
 * someone has actually used. The full project list is read live from the
 * Management API instead of being frozen into the connection at connect time, so
 * a project created after connecting shows up without reconnecting.
 */
export interface SupabaseOAuthCredentials {
  /** Resolves a currently-valid Management API access token, refreshing as needed. */
  resolveAccessToken: () => Promise<string>;
  provisionedProjects: SupabaseProjectCredentials[];
  /**
   * Persist a newly provisioned project role onto the connection, serialized
   * against concurrent credential writes, and resolve to the authoritative list
   * as stored. A caller that lost a race gets back the winner's entry for its
   * project rather than its own — see `SupabaseConnector.ensureProjectRoleProvisioned`.
   */
  persistProvisionedProject: (provisioned: SupabaseProjectCredentials) => Promise<SupabaseProjectCredentials[]>;
}

export interface SupabaseCredentials {
  /** Manual single-project mode */
  connectionString?: string;
  /** OAuth multi-project mode */
  oauth?: SupabaseOAuthCredentials;
}
