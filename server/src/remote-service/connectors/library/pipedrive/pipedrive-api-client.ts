import { AxiosInstance, isAxiosError } from 'axios';
import { WSLogger } from 'src/logger';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { createApiClient } from '../../create-api-client';
import { PipedriveEntityType, PipedriveField } from './pipedrive-types';

const LOG_SOURCE = 'PipedriveApiClient';

/**
 * Base URL for the Pipedrive v2 REST API. The official `pipedrive` SDK hardcoded
 * this exact value (`BASE_PATH` in its generated `base.js`) for both API-key and
 * OAuth auth modes — a plain `Configuration({ accessToken })` never swapped in a
 * company-specific `api_domain` (only the `OAuth2Configuration` flow we never
 * used did that), so we preserve the single shared host to keep request behaviour
 * byte-identical.
 */
const PIPEDRIVE_V2_BASE_URL = 'https://api.pipedrive.com/api/v2';

/** REST collection path for each entity type's list / create / single-fetch endpoints. */
const ENTITY_COLLECTION_PATH: Record<PipedriveEntityType, string> = {
  deals: '/deals',
  persons: '/persons',
  organizations: '/organizations',
};

/** REST collection path for each entity type's Fields-metadata endpoint. */
const ENTITY_FIELDS_PATH: Record<PipedriveEntityType, string> = {
  deals: '/dealFields',
  persons: '/personFields',
  organizations: '/organizationFields',
};

/** Max page size the v2 list and field endpoints accept. */
const PIPEDRIVE_MAX_PAGE_SIZE = 500;

/**
 * Custom error class for Pipedrive API errors.
 */
export class PipedriveError extends Error {
  public readonly statusCode?: number;
  public readonly code?: string;
  public readonly responseData?: unknown;

  constructor(message: string, statusCode?: number, code?: string, responseData?: unknown) {
    super(message);
    this.name = 'PipedriveError';
    this.statusCode = statusCode;
    this.code = code;
    this.responseData = responseData;
  }
}

/**
 * Envelope every Pipedrive v2 REST endpoint wraps its payload in. `data` is the
 * record (single fetch / create / update) or the array of records (list); cursor
 * pagination advances via `additional_data.next_cursor`. axios hands us this
 * verbatim as `response.data` and we never reshape it — preserving on-disk byte
 * fidelity, exactly as the old SDK's response interceptor (a pure
 * `response.data` passthrough, no model deserialization or date coercion) did.
 */
interface PipedriveResponseEnvelope {
  data?: unknown;
  additional_data?: { next_cursor?: string };
}

/**
 * Retry options for Pipedrive API calls — detect 429 from axios errors.
 */
const PIPEDRIVE_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: (error) => isAxiosError(error) && error.response?.status === 429,
  getRetryAfterS: (error) => {
    if (!isAxiosError(error)) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const header = error.response?.headers?.['retry-after'];
    const seconds = header ? parseInt(String(header), 10) : NaN;
    return !isNaN(seconds) && seconds > 0 ? seconds : undefined;
  },
};

/**
 * Build a request body with optional custom_fields sub-object.
 * The v2 API requires custom fields in a `custom_fields` key.
 */
function buildRequestBody(
  systemFields: Record<string, unknown>,
  customFields: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.keys(customFields).length > 0) {
    return { ...systemFields, custom_fields: customFields };
  }
  return { ...systemFields };
}

/**
 * Low-level HTTP client for the Pipedrive v2 REST API.
 *
 * Talks to the API directly over axios (via {@link createApiClient}) rather than
 * the vendored `pipedrive` SDK, so every URL we hit is visible and the connector
 * can be exercised offline against a fake server. The v2 endpoints are
 * cursor-paginated (`additional_data.next_cursor`) and authenticate via either
 * the `x-api-token` header (API key) or `Authorization: Bearer` (OAuth).
 */
export class PipedriveApiClient {
  private readonly http: AxiosInstance;
  private readonly rateLimiter?: RateLimiter;

  constructor(token: string, opts?: { rateLimiter?: RateLimiter; authType?: 'apiKey' | 'oauth' }) {
    // The v2 SDK injected the API key as the `x-api-token` request header and an
    // OAuth token as `Authorization: Bearer` (verified in its generated auth
    // helpers, `setApiKeyToObject` / `setBearerAuthToObject`). Reproduce exactly
    // so the wire request is unchanged.
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts?.authType === 'oauth') {
      headers.Authorization = `Bearer ${token}`;
    } else {
      headers['x-api-token'] = token;
    }
    this.http = createApiClient({ baseURL: PIPEDRIVE_V2_BASE_URL, headers });
    this.rateLimiter = opts?.rateLimiter;
  }

  // --- Retry wrapper ---

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, PIPEDRIVE_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, PIPEDRIVE_RETRY_OPTS);
  }

  // --- Connection test ---

  async testConnection(): Promise<void> {
    try {
      await this.withRetry(async () => this.http.get(ENTITY_COLLECTION_PATH.deals, { params: { limit: 1 } }));
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 401) {
        throw new PipedriveError('Invalid API key or access token', 401, 'UNAUTHORIZED', error.response.data);
      }
      throw error;
    }
  }

  // --- Fields API ---

  /**
   * Fetch all fields for an entity type, paginating if needed.
   */
  async getFields(entityType: PipedriveEntityType): Promise<PipedriveField[]> {
    const fieldsPath = ENTITY_FIELDS_PATH[entityType];
    const allFields: PipedriveField[] = [];
    let cursor: string | undefined;

    do {
      const params: { limit: number; cursor?: string } = { limit: PIPEDRIVE_MAX_PAGE_SIZE };
      if (cursor) params.cursor = cursor;

      const response = await this.withRetry(async () =>
        this.http.get<PipedriveResponseEnvelope>(fieldsPath, { params }),
      );

      const data = response.data.data;
      if (Array.isArray(data)) {
        allFields.push(...(data as PipedriveField[]));
      }

      cursor = response.data.additional_data?.next_cursor ?? undefined;
    } while (cursor);

    return allFields;
  }

  // --- Entity listing (cursor-paginated async generator) ---

  /**
   * List all entities of a given type using cursor pagination.
   * Yields batches of entities.
   *
   * When `updatedSince` (RFC3339) is provided, the server-side `updated_since`
   * filter restricts the result to records whose `update_time` is at or after
   * that instant — the incremental-pull path. Omitted ⇒ full scan (unchanged).
   */
  async *listEntities(
    entityType: PipedriveEntityType,
    resumeCursor?: string,
    updatedSince?: string,
  ): AsyncGenerator<{ data: Record<string, unknown>[]; nextCursor?: string }, void> {
    const collectionPath = ENTITY_COLLECTION_PATH[entityType];
    let cursor: string | undefined = resumeCursor;

    do {
      const params: { limit: number; cursor?: string; updated_since?: string } = { limit: PIPEDRIVE_MAX_PAGE_SIZE };
      if (cursor) params.cursor = cursor;
      if (updatedSince) params.updated_since = updatedSince;

      const response = await this.withRetry(async () =>
        this.http.get<PipedriveResponseEnvelope>(collectionPath, { params }),
      );

      const data = response.data.data;
      cursor = response.data.additional_data?.next_cursor ?? undefined;

      if (Array.isArray(data) && data.length > 0) {
        yield { data: data as Record<string, unknown>[], nextCursor: cursor };
      }
    } while (cursor);
  }

  // --- Single entity fetch ---

  /**
   * Get a single entity by type and ID. Returns null on 404.
   */
  async getEntity(entityType: PipedriveEntityType, id: number): Promise<Record<string, unknown> | null> {
    const collectionPath = ENTITY_COLLECTION_PATH[entityType];
    try {
      const response = await this.withRetry(async () =>
        this.http.get<PipedriveResponseEnvelope>(`${collectionPath}/${id}`),
      );
      return (response.data.data as Record<string, unknown>) ?? null;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  // --- Create ---

  /**
   * Create an entity. Separates system fields from custom_fields.
   */
  async createEntity(
    entityType: PipedriveEntityType,
    data: Record<string, unknown>,
    customFieldKeys: Set<string>,
  ): Promise<Record<string, unknown>> {
    const collectionPath = ENTITY_COLLECTION_PATH[entityType];
    const { systemFields, customFields } = this.separateFields(data, customFieldKeys);
    const body = buildRequestBody(systemFields, customFields);

    const response = await this.withRetry(async () => this.http.post<PipedriveResponseEnvelope>(collectionPath, body));

    return (response.data.data as Record<string, unknown>) ?? {};
  }

  // --- Update ---

  /**
   * Update an entity. Separates system fields from custom_fields.
   */
  async updateEntity(
    entityType: PipedriveEntityType,
    id: number,
    data: Record<string, unknown>,
    customFieldKeys: Set<string>,
  ): Promise<Record<string, unknown>> {
    const collectionPath = ENTITY_COLLECTION_PATH[entityType];
    const { systemFields, customFields } = this.separateFields(data, customFieldKeys);
    const body = buildRequestBody(systemFields, customFields);

    const response = await this.withRetry(async () =>
      this.http.patch<PipedriveResponseEnvelope>(`${collectionPath}/${id}`, body),
    );

    return (response.data.data as Record<string, unknown>) ?? {};
  }

  // --- Delete ---

  /**
   * Delete an entity by type and ID. Throws on non-404 errors.
   */
  async deleteEntity(entityType: PipedriveEntityType, id: number): Promise<void> {
    const collectionPath = ENTITY_COLLECTION_PATH[entityType];
    try {
      await this.withRetry(async () => this.http.delete(`${collectionPath}/${id}`));
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        WSLogger.warn({
          source: LOG_SOURCE,
          message: `Entity ${entityType}/${id} not found (404) during delete, ignoring`,
        });
        return;
      }
      throw error;
    }
  }

  // --- Field separation ---

  /**
   * Separate data into system fields and custom fields.
   * Custom fields are identified by their hash keys from the Fields API.
   */
  separateFields(
    data: Record<string, unknown>,
    customFieldKeys: Set<string>,
  ): { systemFields: Record<string, unknown>; customFields: Record<string, unknown> } {
    const systemFields: Record<string, unknown> = {};
    const customFields: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      if (key === 'id' || key === 'add_time' || key === 'update_time' || key === 'custom_fields') {
        // Skip read-only fields and the custom_fields wrapper itself
        continue;
      }
      if (customFieldKeys.has(key)) {
        customFields[key] = value;
      } else {
        systemFields[key] = value;
      }
    }

    return { systemFields, customFields };
  }
}
