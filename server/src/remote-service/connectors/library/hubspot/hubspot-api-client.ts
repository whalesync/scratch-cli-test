import { AxiosInstance, isAxiosError } from 'axios';
import { WSLogger } from 'src/logger';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { createApiClient } from '../../create-api-client';
import { buildHubspotModifiedSinceSearch } from './hubspot-incremental';
import {
  HubspotBatchReadResponse,
  HubspotCustomObjectSchemasResponse,
  HubspotListResponse,
  HubspotPropertiesResponse,
  HubspotProperty,
  HubspotRecord,
  HubspotSearchResponse,
} from './hubspot-types';

const LOG_SOURCE = 'HubspotApiClient';
const BASE_URL = 'https://api.hubapi.com';
const PAGE_SIZE = 100;
const BATCH_READ_SIZE = 100;

/**
 * Custom error class for HubSpot API errors.
 */
export class HubspotError extends Error {
  public readonly statusCode?: number;
  public readonly category?: string;
  public readonly responseData?: unknown;

  constructor(message: string, statusCode?: number, category?: string, responseData?: unknown) {
    super(message);
    this.name = 'HubspotError';
    this.statusCode = statusCode;
    this.category = category;
    this.responseData = responseData;
  }
}

/**
 * Retry options for HubSpot API calls — detect 429 from axios errors.
 */
const HUBSPOT_RETRY_OPTS: WithRetryOpts = {
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
 * Low-level HTTP client for the HubSpot CRM v3/v4 REST APIs.
 * Uses axios with bearer token auth, rate limiting, and retry on 429.
 */
export class HubspotApiClient {
  private readonly http: AxiosInstance;
  private readonly rateLimiter?: RateLimiter;

  constructor(accessToken: string, opts?: { rateLimiter?: RateLimiter }) {
    this.http = createApiClient({
      baseURL: BASE_URL,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    this.rateLimiter = opts?.rateLimiter;
  }

  // --- Retry wrapper ---

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, HUBSPOT_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, HUBSPOT_RETRY_OPTS);
  }

  // --- Connection test ---

  async testConnection(): Promise<void> {
    try {
      await this.withRetry(async () => this.http.get('/crm/v3/objects/contacts', { params: { limit: 1 } }));
    } catch (error) {
      if (isAxiosError(error) && (error.response?.status === 401 || error.response?.status === 403)) {
        throw new HubspotError(
          'Invalid private app access token',
          error.response.status,
          'UNAUTHORIZED',
          error.response.data,
        );
      }
      throw error;
    }
  }

  // --- API Quota ---

  /**
   * Make a lightweight API call and extract rate-limit headers from the response.
   *
   * HubSpot returns these headers on every response:
   *   - `x-hubspot-ratelimit-daily` / `x-hubspot-ratelimit-daily-remaining`
   *   - `x-hubspot-ratelimit-secondly` / `x-hubspot-ratelimit-secondly-remaining`
   */
  async getApiQuota(): Promise<{
    daily: { limit: number; remaining: number };
    secondly: { limit: number; remaining: number };
  }> {
    const response = await this.withRetry(async () =>
      this.http.get('/crm/v3/objects/contacts', { params: { limit: 1 } }),
    );
    const headers = response.headers as Record<string, string>;
    return {
      daily: {
        limit: parseInt(headers['x-hubspot-ratelimit-daily'] ?? '0', 10),
        remaining: parseInt(headers['x-hubspot-ratelimit-daily-remaining'] ?? '0', 10),
      },
      secondly: {
        limit: parseInt(headers['x-hubspot-ratelimit-secondly'] ?? '0', 10),
        remaining: parseInt(headers['x-hubspot-ratelimit-secondly-remaining'] ?? '0', 10),
      },
    };
  }

  // --- Properties API ---

  /**
   * Fetch all properties for an object type, filtering out hidden ones.
   */
  async getProperties(objectType: string): Promise<HubspotProperty[]> {
    const response = await this.withRetry(async () =>
      this.http.get<HubspotPropertiesResponse>(`/crm/v3/properties/${objectType}`),
    );
    return response.data.results.filter((p) => !p.hidden);
  }

  // --- Custom Objects API ---

  /**
   * Fetch all custom object schemas.
   */
  async getCustomObjectSchemas(): Promise<HubspotCustomObjectSchemasResponse['results']> {
    const response = await this.withRetry(async () =>
      this.http.get<HubspotCustomObjectSchemasResponse>('/crm/v3/schemas'),
    );
    return response.data.results;
  }

  // --- Record listing (cursor-paginated async generator) ---

  /**
   * List all records of an object type using cursor pagination.
   * Yields batches of records with associations included.
   *
   * @param objectType - The CRM object type to list.
   * @param propertyNames - All property names to request (HubSpot only returns default properties otherwise).
   * @param associations - Object types to include in the associations response.
   * @param startAfter - Optional cursor to resume from.
   */
  async *listRecords(
    objectType: string,
    propertyNames: string[],
    associations: string[],
    startAfter?: string,
  ): AsyncGenerator<{ records: HubspotRecord[]; nextCursor: string | undefined }> {
    let after: string | undefined = startAfter;

    do {
      const params: Record<string, string | number> = { limit: PAGE_SIZE };
      if (propertyNames.length > 0) {
        params.properties = propertyNames.join(',');
      }
      if (associations.length > 0) {
        params.associations = associations.join(',');
      }
      if (after) {
        params.after = after;
      }

      const response = await this.withRetry(async () =>
        this.http.get<HubspotListResponse>(`/crm/v3/objects/${objectType}`, { params }),
      );

      const results = response.data.results.filter((r) => !r.archived);
      after = response.data.paging?.next?.after;

      if (results.length > 0) {
        yield { records: results, nextCursor: after };
      }
    } while (after);
  }

  // --- Incremental record search (cursor-paginated async generator) ---

  /**
   * List records modified on or after `since` using the CRM Search API.
   * Yields batches sorted ascending by the modified-date property, paginated via
   * the search `after` cursor.
   *
   * Unlike {@link listRecords}, the Search API returns `properties` but **not**
   * `associations` — incremental pulls therefore don't refresh association data
   * (reconciled by the periodic full pull). A single Search result set is also
   * capped at 10,000 records by HubSpot; the watermark advances by what returned
   * and the next run continues from there.
   *
   * @param objectType - The CRM object type to search.
   * @param propertyNames - All property names to request (HubSpot only returns default properties otherwise).
   * @param modifiedAtField - The modified-date property to filter and sort on (e.g. `hs_lastmodifieddate`).
   * @param since - Watermark; the builder subtracts the clock-skew margin and renders epoch-ms.
   * @param startAfter - Optional cursor to resume from.
   */
  async *searchRecordsModifiedSince(
    objectType: string,
    propertyNames: string[],
    modifiedAtField: string,
    since: Date,
    startAfter?: string,
  ): AsyncGenerator<{ records: HubspotRecord[]; nextCursor: string | undefined }> {
    let after: string | undefined = startAfter;

    do {
      const body = buildHubspotModifiedSinceSearch(modifiedAtField, since, propertyNames, after);

      const response = await this.withRetry(async () =>
        this.http.post<HubspotSearchResponse>(`/crm/v3/objects/${objectType}/search`, body),
      );

      const results = response.data.results.filter((r) => !r.archived);
      after = response.data.paging?.next?.after;

      if (results.length > 0) {
        yield { records: results, nextCursor: after };
      }
    } while (after);
  }

  // --- Single record fetch ---

  /**
   * Get a single record by ID. Returns null on 404.
   */
  async getRecord(
    objectType: string,
    recordId: string,
    propertyNames: string[],
    associations: string[],
  ): Promise<HubspotRecord | null> {
    try {
      const params: Record<string, string> = {};
      if (propertyNames.length > 0) {
        params.properties = propertyNames.join(',');
      }
      if (associations.length > 0) {
        params.associations = associations.join(',');
      }

      const response = await this.withRetry(async () =>
        this.http.get<HubspotRecord>(`/crm/v3/objects/${objectType}/${recordId}`, { params }),
      );

      if (response.data.archived) return null;
      return response.data;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  // --- Batch read ---

  /**
   * Batch read records by IDs. Max 100 per call.
   * Note: HubSpot batch read does NOT support the associations parameter.
   */
  async batchReadRecords(objectType: string, ids: string[], propertyNames: string[]): Promise<HubspotRecord[]> {
    const allRecords: HubspotRecord[] = [];

    for (let i = 0; i < ids.length; i += BATCH_READ_SIZE) {
      const chunk = ids.slice(i, i + BATCH_READ_SIZE);
      const response = await this.withRetry(async () =>
        this.http.post<HubspotBatchReadResponse>(`/crm/v3/objects/${objectType}/batch/read`, {
          inputs: chunk.map((id) => ({ id })),
          properties: propertyNames,
        }),
      );

      allRecords.push(...response.data.results.filter((r) => !r.archived));
    }

    return allRecords;
  }

  // --- CRUD operations ---

  /**
   * Create a record. Returns the newly created record.
   */
  async createRecord(objectType: string, properties: Record<string, unknown>): Promise<HubspotRecord> {
    const response = await this.withRetry(async () =>
      this.http.post<HubspotRecord>(`/crm/v3/objects/${objectType}`, { properties }),
    );
    return response.data;
  }

  /**
   * Update a record. Returns the updated record.
   */
  async updateRecord(
    objectType: string,
    recordId: string,
    properties: Record<string, unknown>,
  ): Promise<HubspotRecord> {
    const response = await this.withRetry(async () =>
      this.http.patch<HubspotRecord>(`/crm/v3/objects/${objectType}/${recordId}`, { properties }),
    );
    return response.data;
  }

  /**
   * Delete a record. Ignores 404 errors.
   */
  async deleteRecord(objectType: string, recordId: string): Promise<void> {
    try {
      await this.withRetry(async () => this.http.delete(`/crm/v3/objects/${objectType}/${recordId}`));
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        WSLogger.warn({
          source: LOG_SOURCE,
          message: `Record ${objectType}/${recordId} not found (404) during delete, ignoring`,
        });
        return;
      }
      throw error;
    }
  }

  // --- Associations (v4 API) ---

  /**
   * Create a default association between two records.
   */
  async createAssociation(fromObjectType: string, fromId: string, toObjectType: string, toId: string): Promise<void> {
    await this.withRetry(async () =>
      this.http.put(`/crm/v4/objects/${fromObjectType}/${fromId}/associations/default/${toObjectType}/${toId}`),
    );
  }

  /**
   * Delete an association between two records.
   */
  async deleteAssociation(fromObjectType: string, fromId: string, toObjectType: string, toId: string): Promise<void> {
    try {
      await this.withRetry(async () =>
        this.http.delete(`/crm/v4/objects/${fromObjectType}/${fromId}/associations/${toObjectType}/${toId}`),
      );
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        WSLogger.warn({
          source: LOG_SOURCE,
          message: `Association ${fromObjectType}/${fromId} -> ${toObjectType}/${toId} not found (404) during delete, ignoring`,
        });
        return;
      }
      throw error;
    }
  }
}
