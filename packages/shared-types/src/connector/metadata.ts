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
  /**
   * Whether this connector type implements the incremental-pull contract
   * (`Connector.supportsIncrementalPull` can resolve to true for some folder).
   * Static, per-connector answer used by the web client to gate incremental
   * pull menu actions and the incremental schedule row. The runtime
   * `supportsIncrementalPull(options, tableSpec)` still
   * decides whether a given folder's run actually goes incremental.
   */
  incrementalPull: boolean;
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
  incrementalPull: false,
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

// ============= Generic API Connector Extras =============
//
// The GENERIC_API connector lets a user point Scratch at any REST or GraphQL
// API. The user (or their AI via the AI-assist buttons) supplies the auth
// header style and the list of endpoints up front. Per-endpoint probe results
// (detected pagination Strategy, inferred schema) live in
// DataFolder.options.genericApi after the user picks an endpoint as a table.

/** How the apiKey is wrapped into an HTTP header. */
export type GenericApiAuthHeaderStyle = 'bearer' | 'token' | 'raw' | 'custom-header';

/**
 * A REST endpoint the user has configured for this connection. Each entry
 * shows up as a table the user can pick from the standard table-picker
 * (the connector's listTables returns one TablePreview per entry).
 */
export interface GenericApiRestEndpoint {
  /** Stable UUID generated when the endpoint is added. NOT the array index — survives rename/reorder of other endpoints. */
  id: string;
  /** User-supplied display name; falls back to a slug derived from the URL path. */
  name?: string;
  method: 'GET' | 'POST';
  /** Full URL — e.g. https://api.example.com/v1/projects */
  url: string;
  /** For POST endpoints. Static — not mutated between pages (cursor-in-body pagination is NOT supported in v1). */
  body?: unknown;
  /** Optional pagination/enrich/expand overrides — apiget auto-detects if absent. */
  advanced?: GenericApiAdvancedOverrides;
}

/** A GraphQL "endpoint" — one entity to sync, expressed as a single query string. */
export interface GenericApiGraphqlEndpoint {
  /** Stable UUID. */
  id: string;
  name?: string;
  /** GraphQL endpoint URL — typically one per connection, but per-endpoint to allow exceptions. */
  url: string;
  /** The full GraphQL query string for this entity (apiget injects the cursor into variables on subsequent pages). */
  query: string;
  advanced?: GenericApiAdvancedOverrides;
}

/**
 * Per-endpoint manual overrides for apiget's auto-detected behavior. All
 * optional — defaults come from apiget's detection. Surfaced in the advanced
 * disclosure of the endpoint editor.
 */
export interface GenericApiAdvancedOverrides {
  /** Force a specific pagination type instead of relying on auto-detect. */
  paginationType?: 'cursor' | 'offset' | 'graphql' | 'link-header' | 'none';
  /** Override the cursor JSON path (e.g. 'pagination.next_cursor'). */
  cursorPath?: string;
  /** Override the records array JSON path (e.g. 'data', 'result.items'). */
  dataPath?: string;
  /** Override the cursor query-parameter name (e.g. 'page_token'). */
  cursorParam?: string;
  /** Override the offset / limit query-parameter names. */
  offsetParam?: string;
  limitParam?: string;
  /** Override the records-per-page hint. */
  pageSize?: number;
  /** Per-record enrichment: fetch full record from a detail endpoint. */
  enrichUrl?: string;
  /** Override the lodash-style dot path used to extract each record's remote ID. */
  extractionIdPath?: string;
  /** Override apiget's default maxPages backstop (default 1000). */
  maxPages?: number;
}

/**
 * Extras stored on GENERIC_API ConnectorAccount records — non-secret config
 * authored by the user. The apiKey itself lives separately in
 * encryptedCredentials. Storing endpoints + auth style here (not encrypted)
 * means listTables doesn't need to decrypt and endpoint lists are queryable
 * for staff diagnostics. Same precedent Shopify and QuickBooks set.
 */
export interface GenericApiConnectorExtras {
  apiType: 'rest' | 'graphql';
  authHeader: {
    style: GenericApiAuthHeaderStyle;
    /** Required when style === 'custom-header'; ignored otherwise (defaults to 'Authorization'). */
    headerName?: string;
  };
  endpoints: Array<GenericApiRestEndpoint | GenericApiGraphqlEndpoint>;
}

/**
 * Credentials stored encrypted for GENERIC_API. Only the apiKey is sensitive;
 * everything else (auth header style, endpoint URLs) is in `extras`.
 */
export interface GenericApiCredentials {
  apiKey: string;
}

/**
 * Per-folder (per-table) state for a GENERIC_API DataFolder. Populated by the
 * probe when the user picks an endpoint as a table; read by the connector's
 * fetchJsonTableSpec and pullRecordFiles.
 *
 * The probe runs at most twice (page 1 + page 2 verification) and walks the
 * records returned to infer the schema. `inferredSchema` is a plain JSON
 * Schema object — NOT a TypeBox TSchema instance — because the symbol-keyed
 * metadata TypeBox attaches doesn't round-trip through a Prisma `Json` column.
 * The connector reconstructs a TSchema from this at read time.
 */
export interface GenericApiFolderOptions {
  /** References extras.endpoints[i].id — the endpoint this folder is bound to. */
  endpointId: string;
  probe: {
    detectedPagination: {
      type: 'cursor' | 'offset' | 'graphql' | 'link-header' | 'none';
      cursorPath?: string;
      dataPath?: string;
      cursorParam?: string;
      offsetParam?: string;
      limitParam?: string;
      limit?: number;
    } | null;
    extractionIdPath: string;
    /** Plain JSON Schema object (see note above). */
    inferredSchema: object;
    /** ISO 8601. */
    lastProbedAt: string;
  };
}

/** Type guard for GenericApiConnectorExtras (used by the connector at instantiation). */
export function isGenericApiConnectorExtras(extras: unknown): extras is GenericApiConnectorExtras {
  if (typeof extras !== 'object' || extras === null) return false;
  const obj = extras as Record<string, unknown>;
  if (obj.apiType !== 'rest' && obj.apiType !== 'graphql') return false;
  if (typeof obj.authHeader !== 'object' || obj.authHeader === null) return false;
  const auth = obj.authHeader as Record<string, unknown>;
  if (auth.style !== 'bearer' && auth.style !== 'token' && auth.style !== 'raw' && auth.style !== 'custom-header') {
    return false;
  }
  if (!Array.isArray(obj.endpoints)) return false;
  return true;
}
