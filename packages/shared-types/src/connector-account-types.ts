// Types related to connector accounts

// ============= Connector Extras =============

/**
 * Extras stored on Shopify ConnectorAccount records.
 * The shop domain is stored unencrypted in `extras` so it can be queried directly (e.g. GDPR shop/redact).
 */
export interface ShopifyConnectorExtras {
  shopDomain: string;
}

/**
 * Type guard for ShopifyConnectorExtras.
 * Validates that the extras JSON has a `shopDomain` string property.
 */
export function isShopifyConnectorExtras(extras: unknown): extras is ShopifyConnectorExtras {
  return (
    typeof extras === 'object' &&
    extras !== null &&
    'shopDomain' in extras &&
    typeof (extras as Record<string, unknown>).shopDomain === 'string'
  );
}

// ============= QuickBooks Connector Extras =============

/**
 * Extras stored on QuickBooks ConnectorAccount records.
 * The realmId (company ID) is stored unencrypted in `extras` so it can be used for API calls.
 */
export interface QuickBooksConnectorExtras {
  realmId: string;
  sandbox?: boolean;
}

/**
 * Type guard for QuickBooksConnectorExtras.
 * Validates that the extras JSON has a `realmId` string property.
 */
export function isQuickBooksConnectorExtras(extras: unknown): extras is QuickBooksConnectorExtras {
  return (
    typeof extras === 'object' &&
    extras !== null &&
    'realmId' in extras &&
    typeof (extras as Record<string, unknown>).realmId === 'string'
  );
}

// ============= Credentials =============

export interface SupabaseProjectCredentials {
  projectRef: string;
  projectName: string;
  connectionString: string;
  dbUsername: string;
  dbPassword: string;
}

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
