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
  /**
   * User-facing notes explaining this connector's incremental-pull behavior,
   * surfaced in the web client near the incremental pull controls. Use it to
   * explain why a connector may not support incremental pull, the limitations
   * of incremental pull for this connector, and any special actions the user
   * must take to enable it (e.g. adding a "Last Modified" field to the table).
   *
   * `null` or empty string means "no notes to show". Always provide a value
   * (never `undefined`) so every connector's metadata is explicit about this.
   */
  incrementalPullInstructions: string | null;
  /**
   * Whether this connector type implements the create-schema seam
   * (`Connector.supportsSchemaCreation()` returns true). Static, per-connector
   * answer used by the web client to gate the "Create tables and fields" dev
   * tool — the menu item is disabled for connectors that can't create schemas.
   * The runtime `supportsSchemaCreation()` on the connector instance remains
   * authoritative for what the API actually does; this flag is only a UI hint
   * (kept in sync by hand per connector, exactly like `incrementalPull`).
   */
  supportsSchemaCreation: boolean;
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
  incrementalPullInstructions: null,
  supportsSchemaCreation: false,
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
  /** Optional pagination/enrich overrides — apiget auto-detects if absent. */
  overrides?: GenericApiEndpointOverrides;
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
  overrides?: GenericApiEndpointOverrides;
}

/**
 * Per-endpoint manual overrides for apiget's auto-detected behavior. All
 * optional — defaults come from apiget's detection.
 *
 * Split into two groups:
 *   - `request` — query-param names (and the page-size value) we send in the
 *     NEXT request to advance pagination
 *   - `response` — JSON paths into the response body where apiget should find
 *     the cursor / records array / record-ID
 * Top-level fields (paginationType, maxPages, enrichUrl) are general settings
 * that don't fit either bucket.
 */
export interface GenericApiEndpointOverrides {
  /** Force a specific pagination type instead of relying on auto-detect. */
  paginationType?: 'cursor' | 'offset' | 'graphql' | 'link-header' | 'page' | 'none';
  /** Override apiget's default maxPages backstop (default 1000). */
  maxPages?: number;
  /** Per-record enrichment: fetch full record from a detail endpoint (URL template with `{id}` placeholder). */
  enrichUrl?: string;
  /**
   * What we SEND in the next request to advance pagination. These describe
   * the *shape* of the request (param names, server constraints) — not the
   * value of any one fetch. The page-size VALUE is a caller-side decision
   * (driver `--page-size`, future memory-aware pull-job logic, etc.) and
   * flows through a separate runtime parameter.
   */
  request?: {
    /** Override the cursor query-parameter name (e.g. 'page_token'). */
    cursorParam?: string;
    /** Override the offset query-parameter name (e.g. 'skip'). */
    offsetParam?: string;
    /** Override the page-number query-parameter name (e.g. 'page_number'). Used only when paginationType === 'page'. Defaults to 'page'. */
    pageParam?: string;
    /** Override the limit query-parameter name (e.g. 'per_page'). */
    limitParam?: string;
    /** The server's hard maximum records-per-page for this endpoint (from API docs). Used as the default page size and as a safety clamp on runtime requests. */
    maxPageSize?: number;
  };
  /** Where in the response body apiget should look. Lodash-style dot paths. */
  response?: {
    /** Override the cursor JSON path (e.g. 'response_metadata.next_cursor'). */
    cursorPath?: string;
    /** Override the records array JSON path (e.g. 'members', 'result.items'). */
    dataPath?: string;
    /** Override the dot path used to extract each record's remote ID (default: 'id'). */
    idPath?: string;
  };
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
      type: 'cursor' | 'offset' | 'graphql' | 'link-header' | 'page' | 'none';
      cursorPath?: string;
      dataPath?: string;
      cursorParam?: string;
      offsetParam?: string;
      pageParam?: string;
      limitParam?: string;
      limit?: number;
    } | null;
    idPath: string;
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
