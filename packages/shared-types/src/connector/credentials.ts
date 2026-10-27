export interface DecryptedCredentials {
  apiKey?: string;
  // HighLevel (GoHighLevel) specific: the sub-account ("Location") the Private
  // Integration Token is scoped to. Required as a query/body param on most v2
  // endpoints, so it is captured alongside the token at connect time.
  locationId?: string;
  // WordPress specific
  username?: string;
  password?: string;
  endpoint?: string;
  // Moco specific
  domain?: string;
  // Copper specific (the account email the API key was generated under, sent as X-PW-UserEmail)
  email?: string;
  // PostgreSQL / Supabase: the stored connection string.
  // MySQL: accepted as INPUT only (create / edit); decomposed by the MySQL AuthParser and never stored.
  connectionString?: string;
  // MySQL / MariaDB discrete connection settings (also reuses `username` / `password` above). Always strings:
  // the AuthParser contract is Record<string, string>, so the port is stored as decimal text (e.g. "3306").
  databaseHost?: string; // hostname or IP literal (IPv6 without brackets); never a URL
  databasePort?: string;
  databaseName?: string; // optional; absent = every non-system database the user can see
  sslMode?: string; // 'DISABLED' | 'REQUIRED' | 'VERIFY_CA' | 'VERIFY_IDENTITY' (validated server-side)
  sslCaCertificate?: string; // PEM bundle, re-wrapped to 64-character lines
  // Supabase multi-project (OAuth)
  supabaseProjects?: SupabaseProjectCredentials[];

  // Zoho CRM specific (user-provided OAuth client + long-lived refresh token).
  // Zoho has no static API key — the connector mints short-lived access tokens
  // from these by calling the data-center's accounts token endpoint.
  zohoClientId?: string;
  zohoClientSecret?: string;
  zohoRefreshToken?: string;
  zohoDataCenter?: string; // one of: US | EU | IN | AU | JP | CA | CN | SA (defaults to US)

  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthExpiresAt?: string; // ISO string
  oauthWorkspaceId?: string;
  // Optional custom OAuth app credentials (plaintext in memory only, encrypted at rest)
  customOAuthClientId?: string;
  customOAuthClientSecret?: string;

  // Framer specific: the project URL (https://framer.com/projects/<Name>--<hash>)
  // the Server API key is scoped to. The `framer-api` SDK's connect() needs both
  // the project URL and the key, so both are captured at connect time.
  projectUrl?: string;

  // Sanity specific: the project the API token targets. Optional — robot tokens are
  // project-scoped, so the connector auto-discovers the project from the token via the
  // management API; this is only required when the token can see multiple projects.
  sanityProjectId?: string;

  // Gong specific (Basic auth pair from Gong Admin → API, plus the
  // instance-specific API base URL, e.g. https://us02-12345.api.gong.io —
  // Gong routes each company to a regional cell; the generic
  // https://api.gong.io also resolves but Gong recommends the per-instance host).
  gongAccessKey?: string;
  gongAccessKeySecret?: string;
  gongBaseUrl?: string;

  // Square specific: which environment the access token (stored in `apiKey`) belongs to —
  // 'production' or 'sandbox'. Detected from the token at connect time by the Square AuthParser,
  // since each environment rejects the other's tokens and uses its own API host.
  squareEnvironment?: string;
}

/**
 * A Supabase project this connection holds a provisioned database role in.
 * Since DEV-11875 a project only appears here once it has actually been used —
 * the full project list is read live from the Management API instead.
 */
export interface SupabaseProjectCredentials {
  projectRef: string;
  projectName: string;
  connectionString: string;
  dbUsername: string;
  dbPassword: string;
}
