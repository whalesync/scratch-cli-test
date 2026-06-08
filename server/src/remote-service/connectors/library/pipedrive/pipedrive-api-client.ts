import { AxiosInstance, isAxiosError } from 'axios';
import { WSLogger } from 'src/logger';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { createApiClient } from '../../create-api-client';
import {
  ENTITY_CONFIG,
  PipedriveApiVersion,
  PipedriveCustomFieldPlacement,
  PipedriveEntityType,
  PipedriveField,
} from './pipedrive-types';

const LOG_SOURCE = 'PipedriveApiClient';

/**
 * Host root for the Pipedrive REST API. We talk to two API versions off this one
 * host — modern objects (deals, persons, organizations, products, activities) on
 * `/api/v2` and legacy-only objects (leads, notes) on `/v1` — so the base URL is
 * the bare host and each request carries its own version-prefixed path
 * ({@link API_VERSION_PREFIX}). The official `pipedrive` SDK we replaced hardcoded
 * the `/api/v2` host for the objects it served; appending `/api/v2/...` here
 * yields the byte-identical URL for those, while `/v1/...` reaches the objects the
 * v2 API never exposed.
 */
const PIPEDRIVE_API_BASE_URL = 'https://api.pipedrive.com';

/** Path prefix per API version. */
const API_VERSION_PREFIX: Record<PipedriveApiVersion, string> = {
  v1: '/v1',
  v2: '/api/v2',
};

/** Full REST collection path for an entity (e.g. `/api/v2/deals`, `/v1/leads`). */
function collectionPathFor(entityType: PipedriveEntityType): string {
  const config = ENTITY_CONFIG[entityType];
  return `${API_VERSION_PREFIX[config.apiVersion]}/${config.collectionPath}`;
}

/**
 * Full Fields-metadata path for an entity, or `null` when it has no Fields
 * endpoint (notes). All `*Fields` endpoints live on the v2 API even for v1
 * entities — leads share deals' custom fields and so point at `/api/v2/dealFields`.
 */
function fieldsPathFor(entityType: PipedriveEntityType): string | null {
  const config = ENTITY_CONFIG[entityType];
  return config.fieldsCollectionPath ? `${API_VERSION_PREFIX.v2}/${config.fieldsCollectionPath}` : null;
}

/** Max page size the list and field endpoints accept. */
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
 * Envelope every Pipedrive REST endpoint wraps its payload in. `data` is the
 * record (single fetch / create / update) or the array of records (list).
 *
 * Pagination differs by API version, and `additional_data` carries whichever
 * applies: v2 advances via the opaque `next_cursor`; v1 advances via the
 * `pagination` object (`next_start` + `more_items_in_collection`). axios hands us
 * this verbatim as `response.data` and we never reshape the record `data` —
 * preserving on-disk byte fidelity, exactly as the old SDK's response interceptor
 * (a pure `response.data` passthrough, no model deserialization) did.
 */
interface PipedriveResponseEnvelope {
  data?: unknown;
  additional_data?: {
    /** v2 cursor pagination: marker for the next page, `null`/absent at the end. */
    next_cursor?: string | null;
    /** v1 offset pagination. */
    pagination?: {
      start?: number;
      limit?: number;
      more_items_in_collection?: boolean;
      next_start?: number;
    };
  };
}

/** A page of records plus whichever pagination marker the entity uses. */
export interface PipedriveListPage {
  data: Record<string, unknown>[];
  /** v2 cursor entities: the cursor for the next page (undefined at the end). */
  nextCursor?: string;
  /** v1 offset entities: the `start` index for the next page (undefined at the end). */
  nextStart?: number;
}

/** Resume marker for a paginated list — cursor (v2) or start index (v1). */
export interface PipedriveListResume {
  cursor?: string;
  start?: number;
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
 * Build a request body, placing custom fields where the entity's API expects them:
 * - `nested` (v2): under a `custom_fields` sub-object.
 * - `flat` (v1, e.g. leads): as top-level hash keys alongside system fields.
 * - `none` (notes): no custom fields exist; `customFields` is always empty.
 */
function buildRequestBody(
  systemFields: Record<string, unknown>,
  customFields: Record<string, unknown>,
  placement: PipedriveCustomFieldPlacement,
): Record<string, unknown> {
  if (Object.keys(customFields).length === 0) {
    return { ...systemFields };
  }
  if (placement === 'nested') {
    return { ...systemFields, custom_fields: customFields };
  }
  return { ...systemFields, ...customFields };
}

/**
 * Low-level HTTP client for the Pipedrive REST API (v1 + v2).
 *
 * Talks to the API directly over axios (via {@link createApiClient}) rather than
 * the vendored `pipedrive` SDK, so every URL we hit is visible. v2 endpoints are
 * cursor-paginated (`additional_data.next_cursor`); v1 endpoints are
 * offset-paginated (`additional_data.pagination`). Both authenticate via either
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
    this.http = createApiClient({ baseURL: PIPEDRIVE_API_BASE_URL, headers });
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
      await this.withRetry(async () => this.http.get(collectionPathFor('deals'), { params: { limit: 1 } }));
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 401) {
        throw new PipedriveError('Invalid API key or access token', 401, 'UNAUTHORIZED', error.response.data);
      }
      throw error;
    }
  }

  // --- Fields API ---

  /**
   * Fetch all fields for an entity type, paginating if needed. Returns `[]` for
   * entities with no Fields endpoint (notes). Fields endpoints are always v2 and
   * cursor-paginated, regardless of the entity's own API version.
   */
  async getFields(entityType: PipedriveEntityType): Promise<PipedriveField[]> {
    const fieldsPath = fieldsPathFor(entityType);
    if (!fieldsPath) return [];

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

  // --- Entity listing (paginated async generator) ---

  /**
   * List all entities of a given type, yielding batches. Dispatches to cursor
   * (v2) or offset (v1) pagination based on the entity config.
   *
   * When `updatedSince` (RFC3339) is provided, the server-side `updated_since`
   * filter restricts the result to records whose `update_time` is at or after
   * that instant — the incremental-pull path. Both v1 and v2 list endpoints
   * accept it. Omitted ⇒ full scan.
   */
  async *listEntities(
    entityType: PipedriveEntityType,
    resume?: PipedriveListResume,
    updatedSince?: string,
  ): AsyncGenerator<PipedriveListPage, void> {
    const collectionPath = collectionPathFor(entityType);
    if (ENTITY_CONFIG[entityType].paginationStyle === 'cursor') {
      yield* this.listByCursor(collectionPath, resume?.cursor, updatedSince);
    } else {
      yield* this.listByOffset(collectionPath, resume?.start, updatedSince);
    }
  }

  /** Cursor pagination (v2): advance via `additional_data.next_cursor`. */
  private async *listByCursor(
    collectionPath: string,
    resumeCursor: string | undefined,
    updatedSince: string | undefined,
  ): AsyncGenerator<PipedriveListPage, void> {
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

  /** Offset pagination (v1): advance via `additional_data.pagination.next_start`. */
  private async *listByOffset(
    collectionPath: string,
    resumeStart: number | undefined,
    updatedSince: string | undefined,
  ): AsyncGenerator<PipedriveListPage, void> {
    let start = resumeStart ?? 0;
    let moreItems = true;

    while (moreItems) {
      const params: { limit: number; start: number; updated_since?: string } = {
        limit: PIPEDRIVE_MAX_PAGE_SIZE,
        start,
      };
      if (updatedSince) params.updated_since = updatedSince;

      const response = await this.withRetry(async () =>
        this.http.get<PipedriveResponseEnvelope>(collectionPath, { params }),
      );

      const data = response.data.data;
      const pagination = response.data.additional_data?.pagination;
      const nextStart = pagination?.next_start;
      moreItems = pagination?.more_items_in_collection === true && typeof nextStart === 'number';

      if (Array.isArray(data) && data.length > 0) {
        yield { data: data as Record<string, unknown>[], nextStart: moreItems ? nextStart : undefined };
      }

      if (moreItems && typeof nextStart === 'number') {
        start = nextStart;
      } else {
        moreItems = false;
      }
    }
  }

  // --- Single entity fetch ---

  /**
   * Get a single entity by type and ID. Returns null on 404. The id is an integer
   * for most entities and a UUID string for leads — pass whichever the caller has
   * (it is interpolated into the path verbatim).
   */
  async getEntity(entityType: PipedriveEntityType, id: string | number): Promise<Record<string, unknown> | null> {
    const collectionPath = collectionPathFor(entityType);
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
   * Create an entity. Separates system fields from custom fields and places the
   * latter per the entity's custom-field placement (nested for v2, flat for v1).
   */
  async createEntity(
    entityType: PipedriveEntityType,
    data: Record<string, unknown>,
    customFieldKeys: Set<string>,
  ): Promise<Record<string, unknown>> {
    const collectionPath = collectionPathFor(entityType);
    const { systemFields, customFields } = this.separateFields(data, customFieldKeys);
    const body = buildRequestBody(systemFields, customFields, ENTITY_CONFIG[entityType].customFieldPlacement);

    const response = await this.withRetry(async () => this.http.post<PipedriveResponseEnvelope>(collectionPath, body));

    return (response.data.data as Record<string, unknown>) ?? {};
  }

  // --- Update ---

  /**
   * Update an entity. Uses the entity's update verb (PATCH for v2 entities and
   * leads, PUT for notes) and places custom fields per the entity's placement.
   */
  async updateEntity(
    entityType: PipedriveEntityType,
    id: string | number,
    data: Record<string, unknown>,
    customFieldKeys: Set<string>,
  ): Promise<Record<string, unknown>> {
    const config = ENTITY_CONFIG[entityType];
    const url = `${collectionPathFor(entityType)}/${id}`;
    const { systemFields, customFields } = this.separateFields(data, customFieldKeys);
    const body = buildRequestBody(systemFields, customFields, config.customFieldPlacement);

    const response = await this.withRetry(async () =>
      config.updateVerb === 'PUT'
        ? this.http.put<PipedriveResponseEnvelope>(url, body)
        : this.http.patch<PipedriveResponseEnvelope>(url, body),
    );

    return (response.data.data as Record<string, unknown>) ?? {};
  }

  // --- Delete ---

  /**
   * Delete an entity by type and ID. Throws on non-404 errors.
   */
  async deleteEntity(entityType: PipedriveEntityType, id: string | number): Promise<void> {
    const collectionPath = collectionPathFor(entityType);
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
