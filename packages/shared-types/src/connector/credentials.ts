export interface DecryptedCredentials {
  apiKey?: string;
  // WordPress specific
  username?: string;
  password?: string;
  endpoint?: string;
  // Moco specific
  domain?: string;
  // PostgreSQL specific
  connectionString?: string;
  // Supabase multi-project (OAuth)
  supabaseProjects?: SupabaseProjectCredentials[];

  oauthAccessToken?: string;
  oauthRefreshToken?: string;
  oauthExpiresAt?: string; // ISO string
  oauthWorkspaceId?: string;
  // Optional custom OAuth app credentials (plaintext in memory only, encrypted at rest)
  customOAuthClientId?: string;
  customOAuthClientSecret?: string;
}

export interface SupabaseProjectCredentials {
  projectRef: string;
  projectName: string;
  connectionString: string;
  dbUsername: string;
  dbPassword: string;
}
