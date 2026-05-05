import { AxiosInstance, isAxiosError } from 'axios';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { createApiClient } from '../../create-api-client';
import { AttioAttribute, AttioEnvelope, AttioList, AttioListEntry, AttioObject, AttioRecord } from './attio-types';

const BASE_URL = 'https://api.attio.com';
const PAGE_LIMIT = 500; // Attio's POST `/records/query` and `/entries/query` cap

/**
 * Custom error class for Attio API errors. Carries the HTTP status and the
 * raw response body for diagnostics.
 */
export class AttioError extends Error {
  public readonly statusCode?: number;
  public readonly responseData?: unknown;

  constructor(message: string, statusCode?: number, responseData?: unknown) {
    super(message);
    this.name = 'AttioError';
    this.statusCode = statusCode;
    this.responseData = responseData;
  }
}

/**
 * Retry options for Attio API calls — Attio responds with 429 on rate-limit
 * and includes a `Retry-After` header (seconds).
 */
const ATTIO_RETRY_OPTS: WithRetryOpts = {
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
 * Low-level HTTP client for the Attio v2 API.
 *
 * - Bearer-token authentication. Works with both API keys (workspace tokens
 *   from Settings → Developers) and OAuth access tokens — the header shape is
 *   identical, so OAuth can be added on top later without touching this class.
 * - List records / entries via `POST .../query` with `{ limit, offset }`. Attio
 *   uses offset-based pagination for those endpoints (cursor pagination is
 *   reserved for the activity feed, which we don't expose).
 * - Object/attribute/list metadata endpoints are simple GETs.
 */
export class AttioApiClient {
  private readonly http: AxiosInstance;
  private readonly rateLimiter?: RateLimiter;

  constructor(accessToken: string, opts?: { rateLimiter?: RateLimiter }) {
    this.http = createApiClient({
      baseURL: BASE_URL,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      timeout: 60_000,
    });
    this.rateLimiter = opts?.rateLimiter;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, ATTIO_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, ATTIO_RETRY_OPTS);
  }

  /**
   * Validate credentials by hitting `GET /v2/self`. Translates 401/403 into a
   * friendly `AttioError`.
   */
  async testConnection(): Promise<void> {
    try {
      await this.withRetry(async () => this.http.get('/v2/self'));
    } catch (error) {
      if (isAxiosError(error) && (error.response?.status === 401 || error.response?.status === 403)) {
        throw new AttioError(
          'Invalid Attio access token, or the token lacks the required scopes',
          error.response.status,
          error.response.data,
        );
      }
      throw error;
    }
  }

  /** List every object (standard + custom) in the workspace. */
  async listObjects(): Promise<AttioObject[]> {
    const response = await this.withRetry(async () => this.http.get<AttioEnvelope<AttioObject[]>>('/v2/objects'));
    return response.data.data;
  }

  /** List every attribute on an object. */
  async listObjectAttributes(objectSlug: string): Promise<AttioAttribute[]> {
    const response = await this.withRetry(async () =>
      this.http.get<AttioEnvelope<AttioAttribute[]>>(`/v2/objects/${objectSlug}/attributes`),
    );
    return response.data.data;
  }

  /** List every list visible to the access token. */
  async listLists(): Promise<AttioList[]> {
    const response = await this.withRetry(async () => this.http.get<AttioEnvelope<AttioList[]>>('/v2/lists'));
    return response.data.data;
  }

  /** List every list-scoped attribute on a list. */
  async listListAttributes(listSlug: string): Promise<AttioAttribute[]> {
    const response = await this.withRetry(async () =>
      this.http.get<AttioEnvelope<AttioAttribute[]>>(`/v2/lists/${listSlug}/attributes`),
    );
    return response.data.data;
  }

  /**
   * Stream every record on an object via `POST /v2/objects/{slug}/records/query`.
   * Yields one batch per page along with the next offset for resumption.
   */
  async *queryRecords(
    objectSlug: string,
    resumeOffset?: number,
  ): AsyncGenerator<{ data: AttioRecord[]; nextOffset?: number }, void> {
    let offset = resumeOffset ?? 0;
    while (true) {
      const response = await this.withRetry(async () =>
        this.http.post<AttioEnvelope<AttioRecord[]>>(`/v2/objects/${objectSlug}/records/query`, {
          limit: PAGE_LIMIT,
          offset,
        }),
      );
      const data = response.data.data ?? [];
      const nextOffset = offset + data.length;
      const hasMore = data.length === PAGE_LIMIT;
      yield { data, nextOffset: hasMore ? nextOffset : undefined };
      if (!hasMore) return;
      offset = nextOffset;
    }
  }

  /**
   * Stream every entry on a list via `POST /v2/lists/{slug}/entries/query`.
   *
   * Entries are stored as pointers to their parent record (`parent_record_id`),
   * not as embedded copies — the parent objects (companies/people/deals) are
   * first-class tables in the same workbook, so duplicating their data inside
   * every list entry would just churn diffs whenever a parent record is edited.
   */
  async *queryListEntries(
    listSlug: string,
    resumeOffset?: number,
  ): AsyncGenerator<{ data: AttioListEntry[]; nextOffset?: number }, void> {
    let offset = resumeOffset ?? 0;
    while (true) {
      const response = await this.withRetry(async () =>
        this.http.post<AttioEnvelope<AttioListEntry[]>>(`/v2/lists/${listSlug}/entries/query`, {
          limit: PAGE_LIMIT,
          offset,
        }),
      );
      const data = response.data.data ?? [];
      const nextOffset = offset + data.length;
      const hasMore = data.length === PAGE_LIMIT;
      yield { data, nextOffset: hasMore ? nextOffset : undefined };
      if (!hasMore) return;
      offset = nextOffset;
    }
  }

  /** Fetch a single record by id. Returns `null` on 404. */
  async getRecord(objectSlug: string, recordId: string): Promise<AttioRecord | null> {
    try {
      const response = await this.withRetry(async () =>
        this.http.get<AttioEnvelope<AttioRecord>>(`/v2/objects/${objectSlug}/records/${recordId}`),
      );
      return response.data.data;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) return null;
      throw error;
    }
  }

  /** Fetch a single list entry by id. Returns `null` on 404. */
  async getListEntry(listSlug: string, entryId: string): Promise<AttioListEntry | null> {
    try {
      const response = await this.withRetry(async () =>
        this.http.get<AttioEnvelope<AttioListEntry>>(`/v2/lists/${listSlug}/entries/${entryId}`),
      );
      return response.data.data;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) return null;
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Create a record via `POST /v2/objects/{slug}/records`. The body shape is
   * `{ data: { values: <write-shape values> } }` — see `attio-write-shape.ts`
   * for how we convert from the on-disk read shape.
   */
  async createRecord(objectSlug: string, values: Record<string, unknown[]>): Promise<AttioRecord> {
    const response = await this.withRetry(async () =>
      this.http.post<AttioEnvelope<AttioRecord>>(`/v2/objects/${objectSlug}/records`, {
        data: { values },
      }),
    );
    return response.data.data;
  }

  /**
   * Update a record via `PATCH /v2/objects/{slug}/records/{id}`. Attio accepts
   * partial payloads — only the keys present in `values` are touched, all
   * others left alone. Pairs naturally with `changedFields`.
   */
  async updateRecord(objectSlug: string, recordId: string, values: Record<string, unknown[]>): Promise<AttioRecord> {
    const response = await this.withRetry(async () =>
      this.http.patch<AttioEnvelope<AttioRecord>>(`/v2/objects/${objectSlug}/records/${recordId}`, {
        data: { values },
      }),
    );
    return response.data.data;
  }

  /** Delete a record. Returns `true` if deleted, `false` if it was already gone (404). */
  async deleteRecord(objectSlug: string, recordId: string): Promise<boolean> {
    try {
      await this.withRetry(async () => this.http.delete(`/v2/objects/${objectSlug}/records/${recordId}`));
      return true;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) return false;
      throw error;
    }
  }

  /**
   * Add a record to a list as a new entry. Body shape is
   * `{ data: { parent_record_id, parent_object, entry_values: <write-shape> } }`.
   */
  async createListEntry(
    listSlug: string,
    parentObject: string,
    parentRecordId: string,
    entryValues: Record<string, unknown[]>,
  ): Promise<AttioListEntry> {
    const response = await this.withRetry(async () =>
      this.http.post<AttioEnvelope<AttioListEntry>>(`/v2/lists/${listSlug}/entries`, {
        data: {
          parent_record_id: parentRecordId,
          parent_object: parentObject,
          entry_values: entryValues,
        },
      }),
    );
    return response.data.data;
  }

  /** Update list-scoped attributes on a list entry. Same partial semantics as `updateRecord`. */
  async updateListEntry(
    listSlug: string,
    entryId: string,
    entryValues: Record<string, unknown[]>,
  ): Promise<AttioListEntry> {
    const response = await this.withRetry(async () =>
      this.http.patch<AttioEnvelope<AttioListEntry>>(`/v2/lists/${listSlug}/entries/${entryId}`, {
        data: { entry_values: entryValues },
      }),
    );
    return response.data.data;
  }

  /** Delete a list entry. Returns `true` if deleted, `false` if it was already gone (404). */
  async deleteListEntry(listSlug: string, entryId: string): Promise<boolean> {
    try {
      await this.withRetry(async () => this.http.delete(`/v2/lists/${listSlug}/entries/${entryId}`));
      return true;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) return false;
      throw error;
    }
  }
}
