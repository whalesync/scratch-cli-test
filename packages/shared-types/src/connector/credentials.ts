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
