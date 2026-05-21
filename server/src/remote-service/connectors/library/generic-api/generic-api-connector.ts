/**
 * GENERIC_API connector — point Scratch at any REST or GraphQL API, supply
 * an apiKey + auth header style + endpoint list, and pull records into a
 * workbook. See companion docs:
 *   ~/.gstack/projects/whalesync-spinner/ijd-apiget-shaping-20260514-232026.md
 *   ~/.gstack/projects/whalesync-spinner/ijd-apiget-impl-plan-20260514-232026.md
 *   /Users/ijd/repos/internal/projects/2026-05-18-generic-connector/flow.md
 *
 * v1 is read-only — createRecords / updateRecords / deleteRecords throw.
 * v1 has no schema UI — inferred schema is persisted silently and read at
 * pull time. The custom connection modal + AI-assist buttons + probe flow
 * land in PR 3-5; this PR (PR 2) is the connector class + registration only.
 *
 * The connector is registered with `visible: false` in metadata so it does
 * NOT appear in the picker until the PostHog flag flip in PR 6.
 */

import { Type } from '@sinclair/typebox';
import {
  connectorMetadata,
  DataFolderOptions,
  GenericApiConnectorExtras,
  GenericApiCredentials,
  GenericApiFolderOptions,
  GenericApiGraphqlEndpoint,
  GenericApiRestEndpoint,
  isGenericApiConnectorExtras,
} from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { WSLogger } from 'src/logger';
import { RateLimiter } from 'src/rate-limiter/rate-limiter';
import { JsonSafeObject } from 'src/utils/objects';
import { Connector } from '../../connector';
import { connectorRegistry } from '../../connector-registry';
import { ConnectorInstantiationError, extractErrorMessageFromAxiosError } from '../../error';
import { Service } from '../../service-constants';
import {
  BaseJsonTableSpec,
  ConnectorErrorDetails,
  ConnectorFile,
  EntityId,
  idPath,
  PullRecordFilesOptions,
  PullRecordFilesResult,
  TablePreview,
} from '../../types';
import {
  ApigetSettings,
  apigetStream,
  FetchRequest,
  FetchResponse,
  Header,
  HttpStatusError,
  MaxPagesReachedError,
  NonJsonResponseError,
  PaginationLoopError,
  SsrfError,
  ssrfSafeFetch,
  Strategy,
} from './apiget';
import { applyOverridesToSettings } from './apply-overrides';

/**
 * Per-page resume state checkpointed to Redis by the pull job. The connector
 * yields one of these in the `connectorProgress` argument of each callback
 * call so the job can resume after a crash.
 */
export interface GenericApiProgress extends JsonSafeObject {
  cursor?: string;
  offset?: number;
  linkUrl?: string;
  pageIndex: number;
}

export class GenericApiConnector extends Connector<typeof Service.GENERIC_API, GenericApiProgress> {
  readonly service = Service.GENERIC_API;
  static readonly displayName = 'Generic API';
  static readonly metadata = connectorMetadata({
    displayName: 'Generic API',
    table: 'endpoint',
    tables: 'endpoints',
    record: 'record',
    records: 'records',
    logo: '/logo-color.svg',
    // The connector
    // can still be loaded server-side (so internal tests / scripts work) but
    // the standard "Add connection" UI does not show it.
    visible: false,
    supportedAuthMethods: ['user_provided_params'],
    defaultAuthMethod: 'user_provided_params',
    credentialFields: {
      // Only `apiKey` is registered here — the secret. The rest of the form
      // (apiType / authHeader / endpoints) is non-secret config the v1 custom
      // modal collects directly and writes to `extras`. See the
      // GenericApiConnectorExtras type in shared-types.
      user_provided_params: [{ key: 'apiKey', type: 'password', label: 'API Key', required: true }],
    },
  });

  private readonly extras: GenericApiConnectorExtras;
  private readonly apiKey: string;
  private readonly connectorAccountId: string;
  private readonly getFolderOptionsByTableId: (
    connectorAccountId: string,
    tableId: string[],
  ) => Promise<DataFolderOptions | null>;
  private readonly rateLimiter: RateLimiter | undefined;

  constructor(opts: {
    extras: GenericApiConnectorExtras;
    apiKey: string;
    connectorAccountId: string;
    getFolderOptionsByTableId: (connectorAccountId: string, tableId: string[]) => Promise<DataFolderOptions | null>;
    rateLimiter?: RateLimiter;
  }) {
    super();
    this.extras = opts.extras;
    this.apiKey = opts.apiKey;
    this.connectorAccountId = opts.connectorAccountId;
    this.getFolderOptionsByTableId = opts.getFolderOptionsByTableId;
    this.rateLimiter = opts.rateLimiter;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Read-only stubs for the publish side
  // ───────────────────────────────────────────────────────────────────────

  async createRecords(): Promise<ConnectorFile[]> {
    return Promise.reject(new Error('Generic API connector is read-only (createRecords not supported)'));
  }

  async updateRecords(): Promise<void> {
    return Promise.reject(new Error('Generic API connector is read-only (updateRecords not supported)'));
  }

  async deleteRecords(): Promise<void> {
    return Promise.reject(new Error('Generic API connector is read-only (deleteRecords not supported)'));
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getBatchSize(operation: 'create' | 'update' | 'delete'): number {
    return 1; // must be > 0; unused since write methods throw
  }

  // ───────────────────────────────────────────────────────────────────────
  // Required abstract members
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Hit the first endpoint with auth and expect 2xx. Called by the framework
   * at connection-save (one-time, see PR 3 for the pre-create flow) and
   * periodically by health checks (see "Known v1 limitations" in the impl
   * plan — `testConnection` polluting upstream is a v2 fix).
   */
  async testConnection(): Promise<void> {
    if (this.extras.endpoints.length === 0) {
      throw new Error('No endpoints configured — add at least one endpoint to the connection.');
    }
    const first = this.extras.endpoints[0];
    const settings = this.composeSettings(first, undefined, { maxPages: 1 });
    // Drain one page to confirm 2xx + JSON. Any error propagates as-is and
    // gets mapped by extractConnectorErrorDetails when surfaced to the user.
    const iter = apigetStream(settings, this.rateLimiter ? { fetch: this.makeRateLimitedFetch() } : {});
    const first_ = await iter.next();
    if (first_.done) {
      throw new Error('Endpoint returned no response.');
    }
  }

  /**
   * Return one TablePreview per user-configured endpoint. Reads from
   * `extras.endpoints` — no decrypt needed (apiKey is not used here).
   * All entries are flagged as create/update/delete-disabled so the
   * workbook UI shows read-only affordances upfront rather than erroring
   * at write time.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async listTables(): Promise<TablePreview[]> {
    return this.extras.endpoints.map((endpoint) => {
      const tableId = endpointToTableId(endpoint, this.extras.apiType);
      return {
        id: { wsId: endpoint.id, remoteId: tableId },
        displayName: endpoint.name ?? slugFromUrl(endpoint.url),
        disabledCreates: true,
        disabledUpdates: true,
        disabledDeletes: true,
        disabledReason: 'Generic API connector is read-only in v1.',
      } satisfies TablePreview;
    });
  }

  /**
   * Build a `BaseJsonTableSpec` from the probe results persisted on
   * `DataFolder.options.genericApi.probe`. For GENERIC_API this is a pure DB
   * read — there is no remote schema endpoint to call (see "Why GENERIC_API
   * can't follow the native-connector pattern" in the impl plan).
   */
  async fetchJsonTableSpec(id: EntityId, pendingFolderOptions?: DataFolderOptions): Promise<BaseJsonTableSpec> {
    // Prefer pendingFolderOptions when supplied — DataFolderService.createFolder
    // calls us BEFORE inserting the DataFolder row, so the DB lookup would miss
    // the probe data the user just produced via probeEndpoint.
    let genericApi = extractGenericApiFolderOptions(pendingFolderOptions);
    if (!genericApi) {
      const dbOptions = await this.getFolderOptionsByTableId(this.connectorAccountId, id.remoteId);
      genericApi = extractGenericApiFolderOptions(dbOptions);
    }
    if (!genericApi) {
      throw new Error(
        `Endpoint "${id.wsId}" has not been probed yet. Re-pick this endpoint from the table picker to run the probe.`,
      );
    }
    // Find the user's endpoint metadata so the spec's slug/name reflect the
    // endpoint (e.g. "Projects") instead of id.wsId, which is just "GET" /
    // "POST" for REST under the current tableId scheme.
    const endpoint = this.extras.endpoints.find((e) => e.id === genericApi.endpointId);
    const displayName = endpoint?.name?.trim() || (endpoint ? slugFromUrl(endpoint.url) : id.wsId);
    return buildBaseJsonTableSpec(id, genericApi, displayName);
  }

  /**
   * Walk pages via apiget; emit a ConnectorFile per record. Hard-fail on
   * duplicate remote IDs within a single pull (safety-critical: per the impl
   * plan, last-write-wins is a data-loss footgun).
   */
  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: GenericApiProgress }) => Promise<void>,
    progress: GenericApiProgress,
    options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    const genericApi = extractGenericApiFolderOptions(options);
    if (!genericApi) {
      throw new Error('Missing genericApi folder options. Re-probe this endpoint before pulling.');
    }
    const endpoint = this.extras.endpoints.find((e) => e.id === genericApi.endpointId);
    if (!endpoint) {
      throw new Error(
        `Endpoint "${genericApi.endpointId}" is no longer present on the connection — it may have been deleted.`,
      );
    }

    const settings = this.composeSettings(endpoint, genericApi, {
      progress,
      // No maxPages override → uses apigetStream's 1000-page default backstop.
    });

    // Cross-page duplicate-ID detection. Per impl plan §2 ("Record file
    // layout") and safety-critical test #3: if idPath resolves to
    // the same value for two different records, the pull hard-fails BEFORE
    // any files are written to disk. Last-write-wins is unacceptable.
    const seenIds = new Set<string>();
    // Per-endpoint idPath override wins over the probed default.
    const idPathStr = endpoint.overrides?.response?.idPath ?? genericApi.probe.idPath;

    const iter = apigetStream(settings, this.rateLimiter ? { fetch: this.makeRateLimitedFetch() } : {});
    for await (const page of iter) {
      const files: ConnectorFile[] = [];
      for (const record of page.records) {
        const file = recordToConnectorFile(record);
        const id = extractRemoteIdString(file, idPathStr);
        if (id === null) {
          const keys = file && typeof file === 'object' ? Object.keys(file).slice(0, 12).join(', ') : '<not an object>';
          throw new Error(
            `Record missing or null remote ID at path "${idPathStr}". ` +
              `Record keys seen: [${keys}]. ` +
              `Re-probe this endpoint or override response.idPath in the endpoint's overrides.`,
          );
        }
        if (seenIds.has(id)) {
          throw new Error(
            `Duplicate remote IDs detected — "${id}" appeared twice at path ` +
              `"${idPathStr}". Your response.idPath is probably wrong, ` +
              `or the API does not assign stable IDs at the path you specified.`,
          );
        }
        seenIds.add(id);
        files.push(file);
      }
      await callback({
        files,
        connectorProgress: {
          cursor: page.cursor,
          offset: page.offset,
          linkUrl: page.linkUrl,
          pageIndex: page.pageIndex,
        },
      });
    }
    return {};
  }

  /**
   * Per-record fetch (used by enrichment + recovery). Uses the per-endpoint
   * `advanced.enrichUrl` template if set; otherwise apiget infers the detail
   * URL from the list URL + extracted ID. 404s are silently skipped per the
   * abstract contract.
   *
   * For v1 this is a thin wrapper — most generic APIs don't have per-record
   * endpoints we discover automatically, so absent an `enrichUrl` override
   * this method may produce no results. That's acceptable: the framework
   * uses `pullRecordFilesByIds` for recovery, not for primary pulls.
   */
  // v1: not implemented. Recovery of individual records is rare for read-only
  // generic-API tables, and the enrichment URL pattern UX lands in PR 4 (the
  // AI-prompt asset + endpoint advanced disclosure). The framework treats an
  // empty result as "no records found" — same as the documented 404-skip behavior.
  /* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    return;
  }
  /* eslint-enable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */

  getSuggestedRecordFileNames(records: ConnectorFile[]): (string | undefined)[] {
    // Default to undefined → framework uses the remote ID as the filename.
    return records.map(() => undefined);
  }

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof SsrfError) {
      // Log verbose detail (resolved IP, exact block reason, hostname) server-side.
      // The user-facing message stays generic so the connector cannot be used
      // as an internal-DNS / internal-IP oracle.
      WSLogger.warn({
        source: 'generic-api',
        message: 'SSRF guard rejected an endpoint URL',
        connectorAccountId: this.connectorAccountId,
        internalDetails: error.internalDetails,
      });
      return { userFriendlyMessage: error.message };
    }
    if (error instanceof PaginationLoopError) {
      return {
        userFriendlyMessage:
          'Pagination loop detected — the same cursor was returned twice in a row, which would cause an infinite pull. Your cursor path may be wrong; open advanced settings to adjust.',
      };
    }
    if (error instanceof MaxPagesReachedError) {
      return {
        userFriendlyMessage: `Hit the ${error.maxPages}-page cap for this endpoint. If your endpoint legitimately has more pages, raise maxPages in advanced settings.`,
      };
    }
    if (error instanceof NonJsonResponseError) {
      return {
        userFriendlyMessage: `Expected JSON; got ${error.contentType ?? '(no content-type)'}. Generic API supports JSON endpoints only.`,
      };
    }
    if (error instanceof HttpStatusError) {
      const trimmedBody = error.body.length > 300 ? error.body.slice(0, 300) + '…' : error.body;
      if (error.status === 401) {
        return {
          userFriendlyMessage: `Authentication failed (HTTP 401). Re-check your API key and auth header style. Response: ${trimmedBody}`,
        };
      }
      if (error.status === 403) {
        return {
          userFriendlyMessage: `Authorized but forbidden (HTTP 403). The key may lack the right scope. Response: ${trimmedBody}`,
        };
      }
      if (error.status === 404) {
        return {
          userFriendlyMessage: `Endpoint not found (HTTP 404). Re-check the URL. Response: ${trimmedBody}`,
        };
      }
      if (error.status === 429) {
        return {
          userFriendlyMessage: `Rate-limited by upstream (HTTP 429) — retry attempt also returned 429. Response: ${trimmedBody}`,
        };
      }
      return {
        userFriendlyMessage: `Upstream API returned HTTP ${error.status}. Response: ${trimmedBody}`,
      };
    }
    if (isAxiosError(error)) {
      const status = error.response?.status;
      if (status === 401) {
        return {
          userFriendlyMessage: 'Authentication failed. Re-check your API key and auth header style.',
        };
      }
      if (status === 403) {
        return {
          userFriendlyMessage: 'Authorized but forbidden. The key may lack the right scope for this endpoint.',
        };
      }
      if (status === 404) {
        return { userFriendlyMessage: 'Endpoint not found. Re-check the URL in your connection settings.' };
      }
      if (status === 429) {
        return {
          userFriendlyMessage:
            'Rate limited. Scratch will retry; if this persists, lower the poll frequency or raise the rate limit override.',
        };
      }
      if (typeof status === 'number' && status >= 500) {
        return { userFriendlyMessage: 'Upstream API error. Scratch will retry on the next scheduled pull.' };
      }
      return { userFriendlyMessage: extractErrorMessageFromAxiosError('Generic API', error) };
    }
    return this.fallbackErrorDetails(error);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Build the apiget request settings for a given endpoint + optional
   * persisted probe + per-call opts (progress, maxPages override).
   *
   * Single shared entry point used by every call site:
   *   - testConnection                 → maxPages: 1
   *   - pullRecordFiles (this method)  → uses default maxPages (1000 backstop)
   *   - probe flow (PR 5)              → maxPages: 2
   *
   * Per impl plan: `composeSettings is the single shared apiget-request-builder
   * used by all three call sites` (prevents drift between probe and pull).
   */
  private composeSettings(
    endpoint: GenericApiRestEndpoint | GenericApiGraphqlEndpoint,
    persisted: GenericApiFolderOptions | undefined,
    opts: { progress?: GenericApiProgress; maxPages?: number },
  ): ApigetSettings {
    const headers = buildAuthHeaders(this.extras, this.apiKey);

    const isRestEndpoint = (e: GenericApiRestEndpoint | GenericApiGraphqlEndpoint): e is GenericApiRestEndpoint =>
      this.extras.apiType === 'rest';

    const method: 'GET' | 'POST' = isRestEndpoint(endpoint) ? endpoint.method : 'POST';
    const body: unknown = isRestEndpoint(endpoint) ? endpoint.body : { query: endpoint.query };

    const pagination: Strategy | undefined = persisted?.probe.detectedPagination
      ? toStrategyOrUndefined(persisted.probe.detectedPagination)
      : undefined;

    const baseSettings: ApigetSettings = {
      url: endpoint.url,
      method,
      headers,
      body,
      pagination,
      maxPages: opts.maxPages,
    };
    // Per-endpoint overrides win over auto-detection AND over the persisted
    // probe — the user explicitly set them, so honor them.
    return applyOverridesToSettings(baseSettings, endpoint.overrides);
  }

  /**
   * Wraps the SSRF-safe transport in `this.rateLimiter.withRetry(...)` so
   * apiget's HTTP calls participate in the connection's rate limit. Audienceful
   * and other connectors do the same via their own api-client wrappers; for
   * GENERIC_API we wire it at the fetch layer because apiget doesn't know
   * about Scratch's RateLimiter.
   *
   * The SSRF guard (HTTPS-only, private-IP rejection, redirect re-validation,
   * 10MB body cap) lives in `ssrfSafeFetch` so this code path and apiget's
   * default transport share the same chokepoint.
   */
  private makeRateLimitedFetch(): (request: FetchRequest) => Promise<FetchResponse> {
    const limiter = this.rateLimiter;
    if (!limiter) return ssrfSafeFetch;
    return (request: FetchRequest) =>
      limiter.withRetry(() => ssrfSafeFetch(request), {
        isRateLimited: (e) => isAxiosError(e) && e.response?.status === 429,
      });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — exported only as needed for tests; rest are file-local.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compose the HTTP headers for an apiget request from the connection's
 * authHeader style + the decrypted apiKey. Exported for testing.
 */
export function buildAuthHeaders(extras: GenericApiConnectorExtras, apiKey: string): Header[] {
  const { style, headerName } = extras.authHeader;
  switch (style) {
    case 'bearer':
      return [{ name: 'Authorization', value: `Bearer ${apiKey}` }];
    case 'token':
      return [{ name: 'Authorization', value: `Token ${apiKey}` }];
    case 'raw':
      return [{ name: 'Authorization', value: apiKey }];
    case 'custom-header':
      return [{ name: headerName ?? 'X-API-Key', value: apiKey }];
  }
}

/** Stable per-endpoint tableId. REST: [method, url]. GraphQL: [url, queryHash-ish]. */
export function endpointToTableId(
  endpoint: GenericApiRestEndpoint | GenericApiGraphqlEndpoint,
  apiType: 'rest' | 'graphql',
): string[] {
  if (apiType === 'rest') {
    const rest = endpoint as GenericApiRestEndpoint;
    return [rest.method, rest.url];
  }
  const gql = endpoint as GenericApiGraphqlEndpoint;
  return [gql.url, gql.id]; // include id since query strings can be long/non-unique
}

/** Derive a sensible default name from a URL when the user didn't supply one. */
function slugFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const lastSegment = u.pathname.split('/').filter(Boolean).pop();
    return lastSegment ?? u.hostname;
  } catch {
    return url;
  }
}

/** Pull the genericApi sub-object out of a DataFolderOptions blob, narrowing safely. */
function extractGenericApiFolderOptions(
  options: DataFolderOptions | null | undefined,
): GenericApiFolderOptions | undefined {
  if (!options || typeof options !== 'object') return undefined;
  const wrapper = (options as Record<string, unknown>)['genericApi'];
  if (!wrapper || typeof wrapper !== 'object') return undefined;
  // Trust the shape — written by our own probe flow. Defensive validation
  // happens at probe time; here we just narrow the type.
  return wrapper as GenericApiFolderOptions;
}

/** Re-hydrate the persisted detectedPagination shape into an apiget Strategy. */
function toStrategyOrUndefined(detected: GenericApiFolderOptions['probe']['detectedPagination']): Strategy | undefined {
  if (!detected || detected.type === 'none') return undefined;
  return {
    type: detected.type,
    cursorPath: detected.cursorPath,
    dataPath: detected.dataPath,
    cursorParam: detected.cursorParam,
    offsetParam: detected.offsetParam,
    limitParam: detected.limitParam,
    limit: detected.limit,
  };
}

/**
 * Build a BaseJsonTableSpec from the persisted probe. The connector stores
 * `inferredSchema` as a plain JSON Schema object; we wrap it with TypeBox so
 * the downstream framework gets the TSchema shape it expects. The wrap is
 * defensive — we don't try to round-trip TypeBox's symbol-keyed metadata,
 * just hand it a `Type.Object` that reproduces the property shape.
 */
function buildBaseJsonTableSpec(
  id: EntityId,
  folderOpts: GenericApiFolderOptions,
  displayName?: string,
): BaseJsonTableSpec {
  // We trust inferredSchema is the shape from generic-api-schema-inference.ts.
  // Wrap with TypeBox so the result is a TSchema.
  const schema = Type.Object({}, { description: 'Generic API record (v1 has no per-field schema UI)' });
  // Stash the raw inferred JSON Schema on the TSchema as a non-symbol prop so
  // downstream views can introspect it if they want (without round-tripping
  // through TypeBox's brand symbols). This is a tactical bridge for v1.
  (schema as unknown as Record<string, unknown>)._rawInferredSchema = folderOpts.probe.inferredSchema;

  const labelOrFallback = displayName && displayName !== '' ? displayName : id.wsId;
  return {
    id,
    slug: labelOrFallback,
    name: labelOrFallback,
    schema,
    idColumnRemoteId: idPath(folderOpts.probe.idPath),
    generatedAt: folderOpts.probe.lastProbedAt,
  };
}

/**
 * Coerce an apiget record (unknown) into a ConnectorFile (Record<string, unknown>).
 * apiget extracts records as `unknown[]`; we know they're plain objects when
 * the upstream API is well-behaved JSON.
 */
function recordToConnectorFile(record: unknown): ConnectorFile {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('Record is not a JSON object — cannot map to ConnectorFile.');
  }
  // After the guards above `record` is a non-array object; the cast adds the
  // string index signature that ConnectorFile requires.
  return record as Record<string, unknown>;
}

/**
 * Walk a record by a lodash-style dot path and return the value at the leaf
 * as a string (suitable for de-dup tracking + filename derivation). Returns
 * null if the path resolves to null/undefined OR to a non-primitive value
 * (per the composite-ID guard in enrich.inferDetailURL).
 */
function extractRemoteIdString(record: ConnectorFile, dotPath: string): string | null {
  const parts = dotPath.split('.');
  let current: unknown = record;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[part];
  }
  if (current === null || current === undefined) return null;
  if (typeof current === 'object') return null; // composite-ID guard
  if (typeof current === 'string') return current;
  if (typeof current === 'number') return current.toString(10);
  if (typeof current === 'boolean') return current ? 'true' : 'false';
  if (typeof current === 'bigint') return current.toString(10);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

connectorRegistry.register({
  service: Service.GENERIC_API,
  metadata: GenericApiConnector.metadata,
  advancedSettings: [],
  supportedAuthMethods: ['user_provided_params'],
  // Conservative default: 1 RPS per connection (see impl plan §7 Rate-limit).
  rateLimiterSpec: { points: 1, duration: 1 },
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for GENERIC_API', Service.GENERIC_API);
    }
    if (!ctx.decryptedCredentials || typeof ctx.decryptedCredentials.apiKey !== 'string') {
      throw new ConnectorInstantiationError('API key is required for GENERIC_API', Service.GENERIC_API);
    }
    if (!isGenericApiConnectorExtras(ctx.connectorAccount.extras)) {
      throw new ConnectorInstantiationError(
        'GENERIC_API connector_account.extras is missing or malformed (expected { apiType, authHeader, endpoints }).',
        Service.GENERIC_API,
      );
    }
    const rateLimiter = ctx.createRateLimiter(ctx.connectorAccount.id);
    return Promise.resolve(
      new GenericApiConnector({
        extras: ctx.connectorAccount.extras,
        apiKey: ctx.decryptedCredentials.apiKey,
        connectorAccountId: ctx.connectorAccount.id,
        getFolderOptionsByTableId: ctx.getFolderOptionsByTableId,
        rateLimiter,
      }),
    );
  },
});

// Helper export for the schema-inference module's barrel use
export type { GenericApiCredentials };
