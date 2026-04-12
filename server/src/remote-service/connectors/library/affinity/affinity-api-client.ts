import { AxiosInstance, isAxiosError } from 'axios';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { createApiClient } from '../../create-api-client';
import {
  AffinityCompany,
  AffinityFieldMetadata,
  AffinityList,
  AffinityListEntry,
  AffinityOpportunity,
  AffinityPagedResponse,
  AffinityPerson,
  AffinityQuota,
  FIELD_TYPES,
  TENANT_FIELD_TYPES,
} from './affinity-types';

const BASE_URL = 'https://api.affinity.co';
const PAGE_LIMIT = 100; // Affinity v2 max

/**
 * Custom error class for Affinity API errors. Carries the HTTP status and the
 * raw response body for diagnostics.
 */
export class AffinityError extends Error {
  public readonly statusCode?: number;
  public readonly responseData?: unknown;

  constructor(message: string, statusCode?: number, responseData?: unknown) {
    super(message);
    this.name = 'AffinityError';
    this.statusCode = statusCode;
    this.responseData = responseData;
  }
}

/**
 * Retry options for Affinity API calls — detect 429 from axios errors and
 * honour the `Retry-After` header.
 */
const AFFINITY_RETRY_OPTS: WithRetryOpts = {
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
 * Low-level HTTP client for the Affinity v2 API.
 *
 * - Bearer-token authentication (the v2 API does not accept HTTP Basic).
 * - Cursor pagination via `pagination.nextUrl` — we extract the `cursor` query
 *   parameter and re-issue the same request with it.
 * - Array query parameters (`fieldTypes`) are serialized as repeated keys —
 *   `?fieldTypes=enriched&fieldTypes=global` — which is what Affinity expects.
 */
export class AffinityApiClient {
  private readonly http: AxiosInstance;
  private readonly rateLimiter?: RateLimiter;

  constructor(apiKey: string, opts?: { rateLimiter?: RateLimiter }) {
    // Use the shared helper so API_URL_OVERRIDES applies — this is what lets
    // local dev and smoke tests rewrite https://api.affinity.co to a fake.
    this.http = createApiClient({
      baseURL: BASE_URL,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      timeout: 60_000,
      // Affinity expects repeated query params (e.g. ?fieldTypes=a&fieldTypes=b),
      // not the bracketed default that axios uses for arrays.
      paramsSerializer: { indexes: null },
    });
    this.rateLimiter = opts?.rateLimiter;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, AFFINITY_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, AFFINITY_RETRY_OPTS);
  }

  /**
   * Validate credentials by hitting `/v2/lists` with a 1-item page. Translates
   * 401/403 into a friendly `AffinityError`.
   */
  async testConnection(): Promise<void> {
    try {
      await this.withRetry(async () => this.http.get('/v2/lists', { params: { limit: 1 } }));
    } catch (error) {
      if (isAxiosError(error) && (error.response?.status === 401 || error.response?.status === 403)) {
        throw new AffinityError(
          'Invalid Affinity API key, or the key lacks the required v2 permissions',
          error.response.status,
          error.response.data,
        );
      }
      throw error;
    }
  }

  /**
   * Generic cursor-paginated GET. Yields one batch per page along with the
   * cursor for the *next* page (so callers can checkpoint and resume).
   */
  private async *paginate<T>(
    path: string,
    params: Record<string, unknown> = {},
    resumeCursor?: string,
  ): AsyncGenerator<{ data: T[]; nextCursor?: string }, void> {
    let cursor: string | undefined = resumeCursor;
    do {
      const requestParams: Record<string, unknown> = { ...params, limit: PAGE_LIMIT };
      if (cursor) requestParams.cursor = cursor;

      const response = await this.withRetry(async () =>
        this.http.get<AffinityPagedResponse<T>>(path, { params: requestParams }),
      );
      const body = response.data;
      const data = body?.data ?? [];
      cursor = extractCursor(body?.pagination?.nextUrl) ?? undefined;

      yield { data, nextCursor: cursor };
    } while (cursor);
  }

  /** Fetch every list the API key can see. Used by `listTables`. */
  async listAllLists(): Promise<AffinityList[]> {
    const all: AffinityList[] = [];
    for await (const { data } of this.paginate<AffinityList>('/v2/lists')) {
      all.push(...data);
    }
    return all;
  }

  /** Fetch every field metadata entry for a list. Used by `fetchJsonTableSpec`. */
  async listListFields(listId: number): Promise<AffinityFieldMetadata[]> {
    const all: AffinityFieldMetadata[] = [];
    for await (const { data } of this.paginate<AffinityFieldMetadata>(`/v2/lists/${listId}/fields`)) {
      all.push(...data);
    }
    return all;
  }

  /**
   * Stream list entries with all four field-type categories embedded inline.
   * Pass `resumeCursor` to resume a stalled pull from a checkpoint.
   */
  listListEntries(
    listId: number,
    resumeCursor?: string,
  ): AsyncGenerator<{ data: AffinityListEntry[]; nextCursor?: string }, void> {
    return this.paginate<AffinityListEntry>(
      `/v2/lists/${listId}/list-entries`,
      { fieldTypes: FIELD_TYPES },
      resumeCursor,
    );
  }

  /**
   * Fetch the current rate-limit quota — both the per-minute API-key bucket and
   * the monthly org bucket, including `used`/`remaining`/`reset` for each.
   *
   * This hits the v1-era `GET /rate-limit` endpoint (no `/v2` prefix). It accepts
   * the same Bearer token as v2 endpoints — Affinity has unified auth despite
   * what their public docs still claim. The same data is also attached to every
   * v2 response as `x-ratelimit-*` headers, so prefer reading those if you're
   * already making a call; this endpoint is for explicit "check my quota" flows.
   *
   * Surfaced through `AffinityConnector.getApiQuota()` for the "View API Quota"
   * dialog in the client; also used directly for diagnostics and integration tests.
   */
  async getQuota(): Promise<AffinityQuota> {
    const response = await this.withRetry(async () => this.http.get<AffinityQuota>('/rate-limit'));
    return response.data;
  }

  /** Fetch a single list's metadata by id. Returns `null` on 404. */
  async getList(listId: number): Promise<AffinityList | null> {
    try {
      const response = await this.withRetry(async () => this.http.get<AffinityList>(`/v2/lists/${listId}`));
      return response.data;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /** Fetch a single list entry by id. Returns `null` on 404. */
  async getListEntry(listId: number, listEntryId: number): Promise<AffinityListEntry | null> {
    try {
      const response = await this.withRetry(async () =>
        this.http.get<AffinityListEntry>(`/v2/lists/${listId}/list-entries/${listEntryId}`, {
          params: { fieldTypes: FIELD_TYPES },
        }),
      );
      return response.data;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Tenant-wide endpoints — return every record in the workspace, regardless of
  // list membership. Persons and companies embed `fields` data when `fieldTypes`
  // is passed (same shape as list-entries). Opportunities are intentionally thin
  // (`id` / `name` / `listId` only) — Affinity v2 has no /v2/opportunities/fields
  // metadata endpoint, and the per-record endpoint returns no field data either.
  // ---------------------------------------------------------------------------

  /**
   * Stream every person in the workspace with the three tenant-valid field-type
   * categories embedded inline. Pass `resumeCursor` to resume from a checkpoint.
   *
   * Note: passes `TENANT_FIELD_TYPES` (no `'list'`) — Affinity rejects
   * `fieldTypes=list` here with HTTP 400 because tenant-wide records have no
   * list context. Use `listListEntries` if you need list-specific fields.
   */
  listAllPersons(resumeCursor?: string): AsyncGenerator<{ data: AffinityPerson[]; nextCursor?: string }, void> {
    return this.paginate<AffinityPerson>('/v2/persons', { fieldTypes: TENANT_FIELD_TYPES }, resumeCursor);
  }

  /**
   * Stream every company in the workspace with the three tenant-valid field-type
   * categories embedded inline. Pass `resumeCursor` to resume from a checkpoint.
   *
   * Same `TENANT_FIELD_TYPES` caveat as `listAllPersons` — `fieldTypes=list` is
   * rejected by `/v2/companies` with HTTP 400.
   */
  listAllCompanies(resumeCursor?: string): AsyncGenerator<{ data: AffinityCompany[]; nextCursor?: string }, void> {
    return this.paginate<AffinityCompany>('/v2/companies', { fieldTypes: TENANT_FIELD_TYPES }, resumeCursor);
  }

  /**
   * Stream every opportunity in the workspace. Note: no `fieldTypes` parameter
   * — the v2 opportunities endpoint returns only `id` / `name` / `listId` and
   * has no equivalent of the lists fields-metadata endpoint.
   */
  listAllOpportunities(
    resumeCursor?: string,
  ): AsyncGenerator<{ data: AffinityOpportunity[]; nextCursor?: string }, void> {
    return this.paginate<AffinityOpportunity>('/v2/opportunities', {}, resumeCursor);
  }

  /**
   * Fetch metadata for non-list-specific person fields used by the tenant-wide
   * persons table. Note the path is `/v2/persons/fields` — Affinity's docs claim
   * `/v2/persons/metadata/fields` but that 404s in practice; the docs are wrong.
   */
  async listPersonFields(): Promise<AffinityFieldMetadata[]> {
    const all: AffinityFieldMetadata[] = [];
    for await (const { data } of this.paginate<AffinityFieldMetadata>('/v2/persons/fields')) {
      all.push(...data);
    }
    return all;
  }

  /**
   * Fetch metadata for non-list-specific company fields used by the tenant-wide
   * companies table. Same `/v2/companies/fields` vs. `/v2/companies/metadata/fields`
   * caveat as `listPersonFields`.
   */
  async listCompanyFields(): Promise<AffinityFieldMetadata[]> {
    const all: AffinityFieldMetadata[] = [];
    for await (const { data } of this.paginate<AffinityFieldMetadata>('/v2/companies/fields')) {
      all.push(...data);
    }
    return all;
  }

  /** Fetch a single person by id. Returns `null` on 404. */
  async getPerson(personId: number): Promise<AffinityPerson | null> {
    try {
      const response = await this.withRetry(async () =>
        this.http.get<AffinityPerson>(`/v2/persons/${personId}`, {
          params: { fieldTypes: TENANT_FIELD_TYPES },
        }),
      );
      return response.data;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /** Fetch a single company by id. Returns `null` on 404. */
  async getCompany(companyId: number): Promise<AffinityCompany | null> {
    try {
      const response = await this.withRetry(async () =>
        this.http.get<AffinityCompany>(`/v2/companies/${companyId}`, {
          params: { fieldTypes: TENANT_FIELD_TYPES },
        }),
      );
      return response.data;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /** Fetch a single opportunity by id. Returns `null` on 404. */
  async getOpportunity(opportunityId: number): Promise<AffinityOpportunity | null> {
    try {
      const response = await this.withRetry(async () =>
        this.http.get<AffinityOpportunity>(`/v2/opportunities/${opportunityId}`),
      );
      return response.data;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }
}

/** Extract the `cursor` query param from a paginated `nextUrl`. */
function extractCursor(nextUrl?: string | null): string | undefined {
  if (!nextUrl) return undefined;
  try {
    const url = new URL(nextUrl);
    return url.searchParams.get('cursor') ?? undefined;
  } catch {
    return undefined;
  }
}
