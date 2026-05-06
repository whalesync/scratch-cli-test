import { ConnectorSettingDefinition } from './dtos';

export type AuthMethod = 'oauth' | 'user_provided_params' | 'oauth_custom';

export interface ConnectorMetadata {
  displayName: string;
  table: string;
  tables: string;
  record: string;
  records: string;
  base: string | null;
  bases: string | null;
  logo: string;
  visible: boolean;
  pushOperationName: string;
  pullOperationName: string;
  supportedAuthMethods: AuthMethod[];
  defaultAuthMethod: AuthMethod;
  oauth?: {
    label: string;
    privateLabel?: string;
  };
  credentialFields?: Partial<Record<AuthMethod, ConnectorSettingDefinition[]>>;
  userProvidedParamsLabel?: string;
  setupGuide?: {
    label: string;
    url: string;
  };
}

const DEFAULTS: Omit<ConnectorMetadata, 'displayName' | 'logo'> = {
  table: 'table',
  tables: 'tables',
  record: 'record',
  records: 'records',
  base: null,
  bases: null,
  visible: true,
  pushOperationName: 'Publish',
  pullOperationName: 'Download',
  supportedAuthMethods: [],
  defaultAuthMethod: 'oauth',
};

export function connectorMetadata(
  overrides: Pick<ConnectorMetadata, 'displayName' | 'logo'> & Partial<Omit<ConnectorMetadata, 'displayName' | 'logo'>>,
): ConnectorMetadata {
  return { ...DEFAULTS, ...overrides };
}

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
