import axios, { AxiosInstance, isAxiosError, RawAxiosRequestHeaders } from 'axios';
import { WSLogger } from 'src/logger';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { createApiClient } from '../../create-api-client';
import { CopperCredentials, CopperCustomFieldDefinition, CopperEntityType } from './copper-types';

const LOG_SOURCE = 'CopperApiClient';

const COPPER_BASE_URL = 'https://api.copper.com/developer_api/v1';

/** Copper search caps `page_size` at 200 (the read page size — unrelated to bulk write size). */
export const COPPER_SEARCH_PAGE_SIZE = 200;

/**
 * Copper search returns at most the first 100,000 matching records. A full scan
 * of a larger table would silently truncate, so we log a warning at the boundary
 * rather than stopping silently. Partitioning the scan is a future improvement.
 */
export const COPPER_SEARCH_RECORD_CEILING = 100_000;

/** Detect Copper's `429 Too Many Requests` and honour any `Retry-After` header. */
const COPPER_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: (error) => isAxiosError(error) && error.response?.status === 429,
  getRetryAfterS: (error) => {
    if (!isAxiosError(error)) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const header = error.response?.headers?.['retry-after'];
    const seconds = header ? parseInt(String(header), 10) : NaN;
    return !isNaN(seconds) && seconds > 0 ? seconds : undefined;
  },
};

/** Custom error class for Copper API errors. */
export class CopperError extends Error {
  public readonly statusCode?: number;
  public readonly responseData?: unknown;

  constructor(message: string, statusCode?: number, responseData?: unknown) {
    super(message);
    this.name = 'CopperError';
    this.statusCode = statusCode;
    this.responseData = responseData;
  }
}

/**
 * Low-level API client for the Copper CRM REST API.
 *
 * Auth requires three headers together: the API token (`X-PW-AccessToken`), a
 * fixed `X-PW-Application: developer_api`, and the account email
 * (`X-PW-UserEmail`). Listing is done via `POST /{entity}/search` with
 * offset pagination (`page_number` / `page_size`).
 */
export class CopperApiClient {
  private readonly client: AxiosInstance;
  private readonly rateLimiter?: RateLimiter;

  constructor(credentials: CopperCredentials, opts?: { rateLimiter?: RateLimiter }) {
    this.rateLimiter = opts?.rateLimiter;

    const headers: RawAxiosRequestHeaders = {
      'X-PW-AccessToken': credentials.apiKey,
      'X-PW-Application': 'developer_api',
      'X-PW-UserEmail': credentials.email,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    this.client = createApiClient({ baseURL: COPPER_BASE_URL, headers });
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, COPPER_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, COPPER_RETRY_OPTS);
  }

  // --- Connection test ---

  /** Validate credentials with the lightest authenticated call. Throws on 401. */
  async testConnection(): Promise<void> {
    try {
      await this.withRetry(() => this.client.get('/account'));
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 401) {
        throw new CopperError('Invalid API token or email', 401, error.response?.data);
      }
      throw error;
    }
  }

  // --- Metadata ---

  /** Fetch all user-defined custom field definitions (drives the dynamic schema). */
  async listCustomFieldDefinitions(): Promise<CopperCustomFieldDefinition[]> {
    const response = await this.withRetry(() =>
      this.client.get<CopperCustomFieldDefinition[]>('/custom_field_definitions'),
    );
    return Array.isArray(response.data) ? response.data : [];
  }

  // --- Listing (offset-paginated async generator) ---

  /**
   * List all records of a type via `POST /{entity}/search`. Yields one page at a
   * time along with the next page number to checkpoint for resume. Sorted by
   * `date_modified asc` so records created mid-pull land on a later page (and are
   * picked up) rather than shifting earlier pages.
   */
  async *listEntities(
    entityType: CopperEntityType,
    pageSize = COPPER_SEARCH_PAGE_SIZE,
    startPage = 1,
  ): AsyncGenerator<{ records: Record<string, unknown>[]; nextPage: number }, void> {
    let pageNumber = startPage;
    let hasMore = true;

    while (hasMore) {
      const records = await this.searchPage(entityType, pageNumber, pageSize);
      if (records.length > 0) {
        yield { records, nextPage: pageNumber + 1 };
      }
      hasMore = records.length === pageSize;
      if (hasMore && pageNumber * pageSize >= COPPER_SEARCH_RECORD_CEILING) {
        WSLogger.warn({
          source: LOG_SOURCE,
          message: `Reached Copper's ${COPPER_SEARCH_RECORD_CEILING}-record search ceiling for ${entityType}; remaining records are not returned by /search and were skipped this pull`,
        });
        hasMore = false;
      }
      pageNumber++;
    }
  }

  /** Fetch a single page of search results. */
  async searchPage(
    entityType: CopperEntityType,
    pageNumber: number,
    pageSize: number,
  ): Promise<Record<string, unknown>[]> {
    const response = await this.withRetry(() =>
      this.client.post<Record<string, unknown>[]>(`/${entityType}/search`, {
        page_number: pageNumber,
        page_size: pageSize,
        sort_by: 'date_modified',
        sort_direction: 'asc',
      }),
    );
    return Array.isArray(response.data) ? response.data : [];
  }

  // --- Single record fetch ---

  /** Get one record by id. Returns null on 404 (already deleted). */
  async getEntity(entityType: CopperEntityType, id: number): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.withRetry(() => this.client.get<Record<string, unknown>>(`/${entityType}/${id}`));
      return response.data ?? null;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  // --- Create / Update / Delete ---

  /** Create a record. Returns Copper's response (includes the assigned `id`). */
  async createEntity(entityType: CopperEntityType, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.withRetry(() => this.client.post<Record<string, unknown>>(`/${entityType}`, body));
    return response.data ?? {};
  }

  /** Update a record. Copper applies only the fields present in the body. */
  async updateEntity(
    entityType: CopperEntityType,
    id: number,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await this.withRetry(() => this.client.put<Record<string, unknown>>(`/${entityType}/${id}`, body));
    return response.data ?? {};
  }

  /** Delete a record. Ignores 404 (already deleted). */
  async deleteEntity(entityType: CopperEntityType, id: number): Promise<void> {
    try {
      await this.withRetry(() => this.client.delete(`/${entityType}/${id}`));
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        WSLogger.warn({
          source: LOG_SOURCE,
          message: `Record ${entityType}/${id} not found (404) during delete, ignoring`,
        });
        return;
      }
      throw error;
    }
  }
}

/** True when the error is an Axios error from Copper (used by error extraction). */
export function isCopperAxiosError(error: unknown): boolean {
  return axios.isAxiosError(error);
}
