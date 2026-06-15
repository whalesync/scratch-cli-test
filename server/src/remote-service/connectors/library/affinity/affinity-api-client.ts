import { AxiosInstance, isAxiosError } from 'axios';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { createApiClient } from '../../create-api-client';
import {
  AffinityCompany,
  AffinityEntityFile,
  AffinityFieldMetadata,
  AffinityFieldValueUpdate,
  AffinityList,
  AffinityListEntry,
  AffinityNote,
  AffinityNoteCreateRequest,
  AffinityNoteUpdateRequest,
  AffinityOpportunity,
  AffinityPagedResponse,
  AffinityPerson,
  AffinityQuota,
  AffinityUser,
  AffinityV1ListEntry,
  AffinityV1Opportunity,
  AffinityV1OpportunityCreate,
  AffinityV1OpportunityWrite,
  AffinityV1Organization,
  AffinityV1OrganizationWrite,
  AffinityV1PagedResponse,
  AffinityV1Person,
  AffinityV1PersonWrite,
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

  // ---------------------------------------------------------------------------
  // Notes
  // ---------------------------------------------------------------------------

  /**
   * Stream every note in the workspace with company, person, and opportunity
   * previews included inline. Pass `resumeCursor` to resume from a checkpoint.
   */
  listAllNotes(resumeCursor?: string): AsyncGenerator<{ data: AffinityNote[]; nextCursor?: string }, void> {
    return this.paginate<AffinityNote>(
      '/v2/notes',
      { includes: ['companiesPreview', 'personsPreview', 'opportunitiesPreview', 'repliesCount'] },
      resumeCursor,
    );
  }

  /** Fetch a single note by id with all includes. Returns `null` on 404. */
  async getNote(noteId: number): Promise<AffinityNote | null> {
    try {
      const response = await this.withRetry(async () =>
        this.http.get<AffinityNote>(`/v2/notes/${noteId}`, {
          params: { includes: ['companiesPreview', 'personsPreview', 'opportunitiesPreview', 'repliesCount'] },
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
  // Users (workspace teammates) — v2, read-only reference entity.
  // ---------------------------------------------------------------------------

  /** Stream every workspace user. Pass `resumeCursor` to resume from a checkpoint. */
  listAllUsers(resumeCursor?: string): AsyncGenerator<{ data: AffinityUser[]; nextCursor?: string }, void> {
    return this.paginate<AffinityUser>('/v2/users', {}, resumeCursor);
  }

  /** Fetch a single user by id. Returns `null` on 404. */
  async getUser(userId: number): Promise<AffinityUser | null> {
    try {
      const response = await this.withRetry(async () => this.http.get<AffinityUser>(`/v2/users/${userId}`));
      return response.data;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Entity Files (v1 API)
  //
  // The v1 API uses token-based pagination (`page_token` / `next_page_token`)
  // instead of v2's cursor-based pagination. The Bearer token auth works the
  // same — Affinity has unified auth despite what their docs still claim.
  // ---------------------------------------------------------------------------

  /**
   * Stream every entity file in the workspace via the v1 `GET /entity-files`
   * endpoint. Pass `resumePageToken` to resume from a checkpoint.
   */
  async *listAllEntityFiles(
    resumePageToken?: string,
  ): AsyncGenerator<{ data: AffinityEntityFile[]; nextCursor?: string }, void> {
    const V1_PAGE_SIZE = 500; // v1 max
    let pageToken: string | undefined = resumePageToken;
    do {
      const params: Record<string, unknown> = { page_size: V1_PAGE_SIZE };
      if (pageToken) params.page_token = pageToken;

      const response = await this.withRetry(async () =>
        this.http.get<AffinityV1PagedResponse<AffinityEntityFile>>('/entity-files', { params }),
      );
      const body = response.data;
      const data = body?.entity_files ?? [];
      pageToken = body?.next_page_token ?? undefined;

      yield { data, nextCursor: pageToken };
    } while (pageToken);
  }

  /** Fetch a single entity file by id (v1). Returns `null` on 404. */
  async getEntityFile(entityFileId: number): Promise<AffinityEntityFile | null> {
    try {
      const response = await this.withRetry(async () =>
        this.http.get<AffinityEntityFile>(`/entity-files/${entityFileId}`),
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
  // Writes (DEV-10298) — v2 field-value batch updates + Notes CRUD.
  //
  // Field values are written through per-record `update-fields` batch
  // operations (≤100 field updates per request). There is NO v2 endpoint for
  // whole-record create/delete or for record basics (firstName, name, domain)
  // — those are v1-API-only and intentionally not implemented yet.
  // ---------------------------------------------------------------------------

  /** Max field updates the batch `update-fields` operation accepts per request. */
  private static readonly FIELD_UPDATE_BATCH_LIMIT = 100;

  /**
   * Issue one or more `update-fields` batch operations against a fields path,
   * chunking at the API's 100-updates-per-request limit.
   */
  private async patchFieldValues(fieldsPath: string, updates: AffinityFieldValueUpdate[]): Promise<void> {
    for (let start = 0; start < updates.length; start += AffinityApiClient.FIELD_UPDATE_BATCH_LIMIT) {
      const chunk = updates.slice(start, start + AffinityApiClient.FIELD_UPDATE_BATCH_LIMIT);
      await this.withRetry(async () => this.http.patch(fieldsPath, { operation: 'update-fields', updates: chunk }));
    }
  }

  /** Update field values on a tenant-wide person. */
  async updatePersonFieldValues(personId: number, updates: AffinityFieldValueUpdate[]): Promise<void> {
    await this.patchFieldValues(`/v2/persons/${personId}/fields`, updates);
  }

  /** Update field values on a tenant-wide company. */
  async updateCompanyFieldValues(companyId: number, updates: AffinityFieldValueUpdate[]): Promise<void> {
    await this.patchFieldValues(`/v2/companies/${companyId}/fields`, updates);
  }

  /** Update field values on a list entry. */
  async updateListEntryFieldValues(
    listId: number,
    listEntryId: number,
    updates: AffinityFieldValueUpdate[],
  ): Promise<void> {
    await this.patchFieldValues(`/v2/lists/${listId}/list-entries/${listEntryId}/fields`, updates);
  }

  /**
   * Create a note attached directly to entities (`POST /v2/notes`).
   * The service requires `content` and at least one person/company/opportunity
   * association — an unattached note is rejected with a 400 we surface as-is.
   */
  async createNote(request: AffinityNoteCreateRequest): Promise<AffinityNote> {
    const response = await this.withRetry(async () => this.http.post<AffinityNote>('/v2/notes', request));
    return response.data;
  }

  /**
   * Update a note's content and/or entity associations (`POST /v2/notes/{id}`,
   * sparse body — omitted properties are left unchanged). Affinity rejects
   * content updates on notes containing @mentions; that error is surfaced.
   */
  async updateNote(noteId: number, request: AffinityNoteUpdateRequest): Promise<AffinityNote> {
    const response = await this.withRetry(async () => this.http.post<AffinityNote>(`/v2/notes/${noteId}`, request));
    return response.data;
  }

  /** Delete a note (`DELETE /v2/notes/{id}`). An already-deleted note (404) is a no-op. */
  async deleteNote(noteId: number): Promise<void> {
    await this.deleteWith404Noop(`/v2/notes/${noteId}`);
  }

  // ---------------------------------------------------------------------------
  // v1 record lifecycle (DEV-10298 phase 2) — whole-record create/update/delete
  // and list membership. The v2 API has no endpoint for these; v1 does, and the
  // same Bearer token authorizes it (verified 2026-06-12). These paths carry NO
  // `/v2` prefix. Record *field values* still go through the v2 field-update
  // methods above, even on a freshly v1-created record — so this layer never
  // touches the v1 field-values endpoint or its multi-value one-row-per-element
  // model.
  // ---------------------------------------------------------------------------

  /** Create a person (`POST /persons`, v1). Returns the v1 record carrying the new id. */
  async createPerson(body: AffinityV1PersonWrite): Promise<AffinityV1Person> {
    const response = await this.withRetry(async () => this.http.post<AffinityV1Person>('/persons', body));
    return response.data;
  }

  /** Update a person's basics (`PUT /persons/{id}`, v1) — first/last name, emails. */
  async updatePerson(personId: number, body: AffinityV1PersonWrite): Promise<AffinityV1Person> {
    const response = await this.withRetry(async () => this.http.put<AffinityV1Person>(`/persons/${personId}`, body));
    return response.data;
  }

  /** Delete a person (`DELETE /persons/{id}`, v1). 404 is a no-op. */
  async deletePerson(personId: number): Promise<void> {
    await this.deleteWith404Noop(`/persons/${personId}`);
  }

  /** Create a company (`POST /organizations`, v1 — the Companies table maps to v1 organizations). */
  async createCompany(body: AffinityV1OrganizationWrite): Promise<AffinityV1Organization> {
    const response = await this.withRetry(async () => this.http.post<AffinityV1Organization>('/organizations', body));
    return response.data;
  }

  /** Update a company's basics (`PUT /organizations/{id}`, v1) — name, domain. */
  async updateCompany(companyId: number, body: AffinityV1OrganizationWrite): Promise<AffinityV1Organization> {
    const response = await this.withRetry(async () =>
      this.http.put<AffinityV1Organization>(`/organizations/${companyId}`, body),
    );
    return response.data;
  }

  /** Delete a company (`DELETE /organizations/{id}`, v1). 404 is a no-op. */
  async deleteCompany(companyId: number): Promise<void> {
    await this.deleteWith404Noop(`/organizations/${companyId}`);
  }

  /** Create an opportunity (`POST /opportunities`, v1) — requires an opportunity-type `list_id`. */
  async createOpportunity(body: AffinityV1OpportunityCreate): Promise<AffinityV1Opportunity> {
    const response = await this.withRetry(async () => this.http.post<AffinityV1Opportunity>('/opportunities', body));
    return response.data;
  }

  /** Update an opportunity (`PUT /opportunities/{id}`, v1) — name. */
  async updateOpportunity(opportunityId: number, body: AffinityV1OpportunityWrite): Promise<AffinityV1Opportunity> {
    const response = await this.withRetry(async () =>
      this.http.put<AffinityV1Opportunity>(`/opportunities/${opportunityId}`, body),
    );
    return response.data;
  }

  /** Delete an opportunity (`DELETE /opportunities/{id}`, v1). 404 is a no-op. */
  async deleteOpportunity(opportunityId: number): Promise<void> {
    await this.deleteWith404Noop(`/opportunities/${opportunityId}`);
  }

  /** Add a record to a list (`POST /lists/{listId}/list-entries`, v1) — list membership. */
  async createListEntry(listId: number, entityId: number): Promise<AffinityV1ListEntry> {
    const response = await this.withRetry(async () =>
      this.http.post<AffinityV1ListEntry>(`/lists/${listId}/list-entries`, { entity_id: entityId }),
    );
    return response.data;
  }

  /** Remove a record from a list (`DELETE /lists/{listId}/list-entries/{entryId}`, v1). 404 is a no-op. */
  async deleteListEntry(listId: number, listEntryId: number): Promise<void> {
    await this.deleteWith404Noop(`/lists/${listId}/list-entries/${listEntryId}`);
  }

  /** Issue a DELETE, treating an already-deleted target (404) as a successful no-op. */
  private async deleteWith404Noop(path: string): Promise<void> {
    try {
      await this.withRetry(async () => this.http.delete(path));
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) {
        return;
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
