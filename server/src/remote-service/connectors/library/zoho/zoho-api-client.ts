import axios, { AxiosInstance, isAxiosError } from 'axios';
import { createHash } from 'crypto';
import { WSLogger } from 'src/logger';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import {
  ConnectorAuthTokenOrProvider,
  ConnectorAuthTokenProvider,
  toConnectorAuthTokenProvider,
} from '../../connector-auth-token';
import { ZOHO_DATA_CENTER_HOSTS, ZohoConnectorCredentials, ZohoFieldMetadata, ZohoModuleMetadata } from './zoho-types';

const LOG_SOURCE = 'ZohoApiClient';

/** Zoho caps a single records fetch at 50 fields; we batch wider modules. */
export const ZOHO_MAX_FIELDS_PER_REQUEST = 50;
/** Zoho records list page size. */
export const ZOHO_RECORDS_PAGE_SIZE = 200;
/** Zoho create/update/delete batch cap. */
export const ZOHO_WRITE_BATCH_SIZE = 100;
/** `page_token` pagination tops out here; beyond this a module needs Bulk Read. */
export const ZOHO_PAGE_TOKEN_RECORD_CEILING = 100_000;

export class ZohoError extends Error {
  public readonly statusCode?: number;
  public readonly code?: string;
  public readonly responseData?: unknown;

  constructor(message: string, statusCode?: number, code?: string, responseData?: unknown) {
    super(message);
    this.name = 'ZohoError';
    this.statusCode = statusCode;
    this.code = code;
    this.responseData = responseData;
  }
}

/** Thrown when a module exceeds the page_token ceiling and Bulk Read isn't built yet. */
export class ZohoModuleTooLargeError extends ZohoError {
  constructor(moduleApiName: string) {
    super(
      `Module "${moduleApiName}" has more than ${ZOHO_PAGE_TOKEN_RECORD_CEILING.toLocaleString()} records, ` +
        `which exceeds Zoho's page_token limit. Bulk Read support is required to sync it.`,
      undefined,
      'MODULE_TOO_LARGE',
    );
    this.name = 'ZohoModuleTooLargeError';
  }
}

const ZOHO_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: (error) => isAxiosError(error) && error.response?.status === 429,
  getRetryAfterS: (error) => {
    if (!isAxiosError(error)) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const header = error.response?.headers?.['retry-after'];
    const seconds = header ? parseInt(String(header), 10) : NaN;
    return !isNaN(seconds) && seconds > 0 ? seconds : undefined;
  },
};

/** Shape of one page of records returned to the connector. */
export interface ZohoRecordsPage {
  records: Record<string, unknown>[];
  /** `next_page_token` to fetch the following page, or undefined when exhausted. */
  nextPageToken?: string;
  /** Whether Zoho reports more records beyond this page. */
  moreRecords: boolean;
  /** Server `Date` header (RFC 1123), used as the incremental high-water mark. */
  serverDate?: string;
}

interface ZohoTokenResponse {
  access_token?: string;
  api_domain?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
}

/**
 * Process-wide access-token cache shared across every {@link ZohoApiClient}.
 *
 * A fresh connector — and therefore a fresh ZohoApiClient — is built for **every**
 * operation: `ConnectorsService.getConnector` calls `createConnector` per
 * request/job and never reuses the instance. An instance-level token cache is
 * therefore useless — each pull/link/test would mint a brand-new access token
 * from the refresh token, and a bulk operation across many tables quickly trips
 * Zoho's token-generation rate limit (`too many requests continuously`). Caching
 * the minted token at module scope, keyed by the credential set, lets all
 * instances in the process reuse one token until just before it expires —
 * dropping token minting from per-operation to ~once per token lifetime. The
 * in-flight map dedupes a burst of concurrent first-time mints (e.g. linking 14
 * tables at once) down to a single token request.
 */
interface SharedZohoAccessToken {
  token: string;
  expiresAtMs: number;
  apiDomain: string;
}
const sharedAccessTokenByCredential = new Map<string, SharedZohoAccessToken>();
const inFlightTokenMintByCredential = new Map<string, Promise<SharedZohoAccessToken>>();

/** Stable cache key for a credential set (never stores the raw secret as the key). */
function zohoTokenCacheKey(credentials: ZohoConnectorCredentials): string {
  return createHash('sha256')
    .update(`${credentials.dataCenter}:${credentials.clientId}:${credentials.refreshToken}`)
    .digest('hex');
}

/**
 * Low-level HTTP client for the Zoho CRM v8 REST API.
 *
 * Owns OAuth token lifecycle: it exchanges the long-lived refresh token for a
 * short-lived access token on demand and caches it until shortly before expiry.
 * The CRM API host comes from the token response's `api_domain` (authoritative
 * across data centers), falling back to the data center's default host.
 *
 * Constructed from plain credentials so it can be exercised standalone in dev
 * scripts and unit tests without the DI / connector-account machinery.
 */
export class ZohoApiClient {
  private readonly credentials: ZohoConnectorCredentials;
  private readonly accountsDomain: string;
  private apiDomain: string;
  private readonly rateLimiter?: RateLimiter;
  private readonly http: AxiosInstance;
  /**
   * Access-token provider for the OAuth-redirect auth path. When set, the
   * OAuthService owns the token lifecycle (refresh + persistence), so this
   * client skips its own refresh-token mint and asks the host for the current
   * token on every request — a job that outlives one token therefore keeps
   * working instead of 401-ing for the rest of its run (DEV-11270). The API host
   * comes from the data center's `defaultApiDomain` (set below).
   */
  private readonly hostManagedOAuthAccessTokenProvider?: ConnectorAuthTokenProvider;

  constructor(
    credentials: ZohoConnectorCredentials,
    opts?: { rateLimiter?: RateLimiter; oauthAccessToken?: ConnectorAuthTokenOrProvider },
  ) {
    this.credentials = credentials;
    const hosts = ZOHO_DATA_CENTER_HOSTS[credentials.dataCenter];
    this.accountsDomain = hosts.accountsDomain;
    this.apiDomain = hosts.defaultApiDomain;
    this.rateLimiter = opts?.rateLimiter;
    this.hostManagedOAuthAccessTokenProvider = opts?.oauthAccessToken
      ? toConnectorAuthTokenProvider(opts.oauthAccessToken)
      : undefined;
    this.http = axios.create({ timeout: 60_000 });
  }

  // --- Auth ---

  /**
   * Return a valid access token. In the OAuth-redirect path the token is minted
   * by the OAuthService (which handles refresh + persistence), so we ask it for
   * the current one. Otherwise (Self-Client params) return a token from the
   * process-wide cache, minting a new one from the refresh token only when the
   * cached one is missing or within 60s of expiry. Concurrent first-time callers
   * share a single in-flight mint so a burst of parallel jobs issues one token
   * request, not one per job.
   */
  private async getAccessToken(): Promise<string> {
    if (this.hostManagedOAuthAccessTokenProvider) return this.hostManagedOAuthAccessTokenProvider();
    const cacheKey = zohoTokenCacheKey(this.credentials);
    const cached = sharedAccessTokenByCredential.get(cacheKey);
    if (cached && Date.now() < cached.expiresAtMs) {
      this.apiDomain = cached.apiDomain;
      return cached.token;
    }

    let mint = inFlightTokenMintByCredential.get(cacheKey);
    if (!mint) {
      mint = this.mintAccessToken().finally(() => inFlightTokenMintByCredential.delete(cacheKey));
      inFlightTokenMintByCredential.set(cacheKey, mint);
    }
    const fresh = await mint;
    sharedAccessTokenByCredential.set(cacheKey, fresh);
    this.apiDomain = fresh.apiDomain;
    return fresh.token;
  }

  /** Exchange the refresh token for a fresh access token (no caching here). */
  private async mintAccessToken(): Promise<SharedZohoAccessToken> {
    const now = Date.now();
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      refresh_token: this.credentials.refreshToken,
    });

    const response = await this.http.post<ZohoTokenResponse>(
      `${this.accountsDomain}/oauth/v2/token`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    const body = response.data;
    if (!body.access_token) {
      throw new ZohoError(
        `Failed to refresh Zoho access token: ${body.error ?? 'no access_token in response'}`,
        response.status,
        body.error,
        body,
      );
    }

    // Zoho access tokens last ~3600s; refresh 60s early to avoid races.
    const expiresInMs = (body.expires_in ?? 3600) * 1000;
    return {
      token: body.access_token,
      expiresAtMs: now + expiresInMs - 60_000,
      apiDomain: body.api_domain ?? this.apiDomain,
    };
  }

  // --- Request helper ---

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, ZOHO_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, ZOHO_RETRY_OPTS);
  }

  /**
   * Issue an authenticated request against the CRM API. Returns the full axios
   * response so callers can read headers (e.g. the server `Date`).
   */
  private async request<T>(config: {
    method: 'get' | 'post' | 'put' | 'delete';
    path: string;
    params?: Record<string, string | number | undefined>;
    data?: unknown;
    headers?: Record<string, string>;
  }): Promise<{ status: number; data: T; headers: Record<string, unknown> }> {
    return this.withRetry(async () => {
      const accessToken = await this.getAccessToken();
      const response = await this.http.request<T>({
        method: config.method,
        url: `${this.apiDomain}/crm/v8${config.path}`,
        params: config.params,
        data: config.data,
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          ...(config.headers ?? {}),
        },
      });
      return { status: response.status, data: response.data, headers: response.headers as Record<string, unknown> };
    });
  }

  // --- Connection test ---

  async testConnection(): Promise<void> {
    // Lightweight, always-available call: the current user.
    await this.request({ method: 'get', path: '/users', params: { type: 'CurrentUser' } });
  }

  // --- Metadata ---

  /** List every module (table) the org exposes. */
  async listModules(): Promise<ZohoModuleMetadata[]> {
    const { data } = await this.request<{ modules?: ZohoModuleMetadata[] }>({
      method: 'get',
      path: '/settings/modules',
    });
    return data.modules ?? [];
  }

  /** Fetch field metadata for a module (drives schema generation). */
  async getFields(moduleApiName: string): Promise<ZohoFieldMetadata[]> {
    const { data } = await this.request<{ fields?: ZohoFieldMetadata[] }>({
      method: 'get',
      path: '/settings/fields',
      params: { module: moduleApiName },
    });
    return data.fields ?? [];
  }

  // --- Records (read) ---

  /**
   * Fetch one page of records for a module, selecting `fieldApiNames`. Handles
   * Zoho's 50-field-per-request cap by splitting the field list across requests
   * for the same page and merging by record id. Pass `ifModifiedSince` (RFC
   * 1123 / ISO 8601) for an incremental pull.
   */
  async listRecordsPage(
    moduleApiName: string,
    fieldApiNames: string[],
    opts: { pageToken?: string; perPage?: number; ifModifiedSince?: string },
  ): Promise<ZohoRecordsPage> {
    const fieldChunks = chunk(fieldApiNames, ZOHO_MAX_FIELDS_PER_REQUEST);
    const chunksToFetch = fieldChunks.length > 0 ? fieldChunks : [['id']];

    const mergedById = new Map<string, Record<string, unknown>>();
    const order: string[] = [];
    let nextPageToken: string | undefined;
    let moreRecords = false;
    let serverDate: string | undefined;
    let emptyPage = false;

    for (let chunkIndex = 0; chunkIndex < chunksToFetch.length; chunkIndex++) {
      const fields = chunksToFetch[chunkIndex];
      const params: Record<string, string | number | undefined> = {
        fields: fields.join(','),
        per_page: opts.perPage ?? ZOHO_RECORDS_PAGE_SIZE,
        page_token: opts.pageToken,
      };
      const headers = opts.ifModifiedSince ? { 'If-Modified-Since': opts.ifModifiedSince } : undefined;

      const response = await this.request<{
        data?: Record<string, unknown>[];
        info?: { more_records?: boolean; next_page_token?: string };
      }>({ method: 'get', path: `/${moduleApiName}`, params, headers });

      // 204 No Content = no records (full) or nothing modified (incremental).
      if (response.status === 204 || !response.data?.data) {
        emptyPage = true;
        break;
      }

      if (chunkIndex === 0) {
        const dateHeader = response.headers['date'];
        serverDate = typeof dateHeader === 'string' ? dateHeader : undefined;
        nextPageToken = response.data.info?.next_page_token;
        moreRecords = response.data.info?.more_records ?? false;
      }

      for (const record of response.data.data) {
        const rawId = record['id'];
        const id = typeof rawId === 'string' ? rawId : typeof rawId === 'number' ? String(rawId) : '';
        if (!id) continue;
        const existing = mergedById.get(id);
        if (existing) {
          Object.assign(existing, record);
        } else {
          mergedById.set(id, { ...record });
          order.push(id);
        }
      }
    }

    if (emptyPage) {
      return { records: [], moreRecords: false, nextPageToken: undefined, serverDate };
    }

    return {
      records: order.map((id) => {
        const record = mergedById.get(id);
        if (!record) throw new ZohoError(`Lost record ${id} while merging field chunks`);
        return record;
      }),
      nextPageToken,
      moreRecords,
      serverDate,
    };
  }

  /** Fetch a single record by id, selecting `fieldApiNames`. Null on 204/404. */
  async getRecord(moduleApiName: string, id: string, fieldApiNames: string[]): Promise<Record<string, unknown> | null> {
    const fieldChunks = chunk(fieldApiNames, ZOHO_MAX_FIELDS_PER_REQUEST);
    const chunksToFetch = fieldChunks.length > 0 ? fieldChunks : [['id']];
    let merged: Record<string, unknown> | null = null;

    try {
      for (const fields of chunksToFetch) {
        const response = await this.request<{ data?: Record<string, unknown>[] }>({
          method: 'get',
          path: `/${moduleApiName}/${id}`,
          params: { fields: fields.join(',') },
        });
        const first: Record<string, unknown> | undefined = response.data?.data?.[0];
        if (response.status === 204 || first === undefined) {
          return merged;
        }
        merged = { ...(merged ?? {}), ...first };
      }
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
    return merged;
  }

  /**
   * List the ids of records deleted since `ifModifiedSince` (for tombstoning on
   * incremental pulls). Uses page/per_page pagination on the deleted endpoint.
   */
  async listDeletedRecordIds(moduleApiName: string, ifModifiedSince?: string): Promise<string[]> {
    const ids: string[] = [];
    let page = 1;
    while (true) {
      const response = await this.request<{
        data?: { id?: string }[];
        info?: { more_records?: boolean };
      }>({
        method: 'get',
        path: `/${moduleApiName}/deleted`,
        params: { type: 'all', page, per_page: ZOHO_RECORDS_PAGE_SIZE },
        headers: ifModifiedSince ? { 'If-Modified-Since': ifModifiedSince } : undefined,
      });
      if (response.status === 204 || !response.data?.data) break;
      for (const entry of response.data.data) {
        if (entry.id) ids.push(String(entry.id));
      }
      if (!response.data.info?.more_records) break;
      page += 1;
    }
    return ids;
  }

  /** List org users (read-only reference table). */
  async listUsers(): Promise<Record<string, unknown>[]> {
    const users: Record<string, unknown>[] = [];
    let page = 1;
    while (true) {
      const response = await this.request<{
        users?: Record<string, unknown>[];
        info?: { more_records?: boolean };
      }>({ method: 'get', path: '/users', params: { type: 'AllUsers', page, per_page: ZOHO_RECORDS_PAGE_SIZE } });
      if (response.status === 204 || !response.data?.users) break;
      users.push(...response.data.users);
      if (!response.data.info?.more_records) break;
      page += 1;
    }
    return users;
  }

  // --- Records (write) ---

  /**
   * Create up to {@link ZOHO_WRITE_BATCH_SIZE} records. Returns each input
   * record merged with the id Zoho assigned (and any details it returned).
   */
  async createRecords(moduleApiName: string, records: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    const { data } = await this.request<{ data?: { code?: string; status?: string; details?: { id?: string } }[] }>({
      method: 'post',
      path: `/${moduleApiName}`,
      data: { data: records },
    });
    return this.mergeWriteResults(records, data.data);
  }

  /** Update up to {@link ZOHO_WRITE_BATCH_SIZE} records (each must carry `id`). */
  async updateRecords(moduleApiName: string, records: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    const { data } = await this.request<{ data?: { code?: string; status?: string; details?: { id?: string } }[] }>({
      method: 'put',
      path: `/${moduleApiName}`,
      data: { data: records },
    });
    return this.mergeWriteResults(records, data.data);
  }

  /** Delete up to {@link ZOHO_WRITE_BATCH_SIZE} records by id. Ignores not-found. */
  async deleteRecords(moduleApiName: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.request({
      method: 'delete',
      path: `/${moduleApiName}`,
      params: { ids: ids.join(','), wf_trigger: 'false' },
    });
  }

  /**
   * Surface per-record write failures instead of silently dropping them, and
   * fold Zoho's assigned id back onto the matching input record.
   */
  private mergeWriteResults(
    inputs: Record<string, unknown>[],
    results: { code?: string; status?: string; details?: { id?: string } }[] | undefined,
  ): Record<string, unknown>[] {
    if (!results) {
      // A successful batch always returns a parallel `data[]` of per-record
      // results; its absence means a request-level failure we must surface.
      throw new ZohoError('Zoho write returned no per-record results', undefined, 'NO_WRITE_RESULTS');
    }
    return inputs.map((input, index) => {
      const result = results[index];
      if (result && result.status === 'error') {
        throw new ZohoError(
          `Zoho rejected record ${index}: ${result.code ?? 'unknown error'}`,
          undefined,
          result.code,
          result,
        );
      }
      const assignedId = result?.details?.id;
      return assignedId ? { ...input, id: assignedId } : input;
    });
  }
}

/** Split an array into chunks of at most `size`. */
function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/** Log helper kept for parity with other clients (unused branches stay quiet). */
export function logZohoWarn(message: string, error: unknown): void {
  WSLogger.warn({ source: LOG_SOURCE, message, error: error instanceof Error ? error.message : String(error) });
}
