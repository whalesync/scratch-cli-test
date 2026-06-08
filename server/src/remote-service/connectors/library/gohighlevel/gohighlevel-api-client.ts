import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, RawAxiosRequestHeaders } from 'axios';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { JsonSafeObject } from 'src/utils/objects';
import { createApiClient } from '../../create-api-client';
import { GoHighLevelLocationListEntityConfig } from './gohighlevel-entities';
import {
  GoHighLevelContact,
  GoHighLevelContactByIdResponse,
  GoHighLevelContactsSearchResponse,
  GoHighLevelCustomFieldDefinition,
  GoHighLevelCustomFieldsListResponse,
  GoHighLevelObjectDefinition,
  GoHighLevelObjectRecord,
  GoHighLevelObjectRecordByIdResponse,
  GoHighLevelObjectRecordsSearchResponse,
  GoHighLevelObjectSchemaResponse,
  GoHighLevelObjectsListResponse,
  GoHighLevelOpportunitiesSearchResponse,
  GoHighLevelOpportunity,
  GoHighLevelOpportunityByIdResponse,
  GoHighLevelPipeline,
  GoHighLevelPipelinesResponse,
} from './gohighlevel-types';

/**
 * Base host for ALL HighLevel (GoHighLevel) v2 REST endpoints, the OAuth token
 * exchange, and the agency->location token exchange. Note the consent screen
 * lives on a different host (marketplace.gohighlevel.com) — not relevant here
 * because Step 1 authenticates with a Private Integration Token, not OAuth.
 *
 * The legacy v1 host (rest.gohighlevel.com) is EOL 31 Dec 2025 — do not use it.
 */
const GOHIGHLEVEL_API_BASE_URL = 'https://services.leadconnectorhq.com';

/**
 * Every HighLevel v2 request MUST send this exact API version header. Omitting
 * it fails obscurely (the API rejects the request with an unhelpful error), so
 * it is baked into the client and sent on every call.
 */
const GOHIGHLEVEL_API_VERSION_HEADER = '2021-07-28';

/**
 * Retry policy for the rate limiter: treat HTTP 429 as rate-limited and honor a
 * `Retry-After` header when present (else fall back to the limiter's backoff).
 * HighLevel's burst limit is 100 req / 10s per app per location.
 */
const GOHIGHLEVEL_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: (error) => axios.isAxiosError(error) && error.response?.status === 429,
  getRetryAfterS: (error) => {
    if (!axios.isAxiosError(error)) return undefined;
    const header: unknown = error.response?.headers?.['retry-after'];
    const rawValue = Array.isArray(header) ? (header[0] as unknown) : header;
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number') return undefined;
    const seconds = parseInt(String(rawValue), 10);
    return !Number.isNaN(seconds) && seconds > 0 ? seconds : undefined;
  },
};

/**
 * Error raised by the HighLevel API client. Mirrors the shape other connectors
 * use (BrevoError, etc.) so `extractConnectorErrorDetails` can surface a
 * status code and the raw response body.
 */
export class GoHighLevelError extends Error {
  public readonly statusCode?: number;
  public readonly responseData?: unknown;

  constructor(message: string, statusCode?: number, responseData?: unknown) {
    super(message);
    this.name = 'GoHighLevelError';
    this.statusCode = statusCode;
    this.responseData = responseData;
  }
}

/**
 * Low-level API client for the HighLevel (GoHighLevel) v2 API.
 *
 * Authenticates with a **Private Integration Token** (PIT) — an API-key-style
 * bearer token created in a HighLevel sub-account under
 * Settings -> Private Integrations. The token is scoped to a single Location
 * (sub-account), but most endpoints still require the `locationId` explicitly
 * as a query param or request-body field, so the client stores it.
 *
 * Auth + the mandatory `Version` header are injected on every request.
 *
 * Step 1 scope: just enough to validate credentials (`testConnection`). Schema
 * discovery, pulls, and writes arrive in later steps.
 *
 * API docs: https://marketplace.gohighlevel.com/docs/
 */
export class GoHighLevelApiClient {
  private readonly client: AxiosInstance;
  private readonly locationId: string;
  private readonly rateLimiter?: RateLimiter;

  constructor(privateIntegrationToken: string, locationId: string, opts?: { rateLimiter?: RateLimiter }) {
    this.locationId = locationId;
    this.rateLimiter = opts?.rateLimiter;

    const headers: RawAxiosRequestHeaders = {
      Authorization: `Bearer ${privateIntegrationToken}`,
      Version: GOHIGHLEVEL_API_VERSION_HEADER,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    this.client = createApiClient({
      baseURL: GOHIGHLEVEL_API_BASE_URL,
      headers,
    });

    // Surface HighLevel's actual error body. Axios's default message is just
    // "Request failed with status code 4xx", which hides WHY HighLevel rejected
    // the request and gets stored verbatim in publish operation errors. Wrap
    // non-429 HTTP errors in a GoHighLevelError carrying the method, URL, and
    // response body. (429s are left as AxiosErrors so the rate-limiter retry
    // logic still recognizes them.)
    this.client.interceptors.response.use(undefined, (error: unknown) => {
      if (axios.isAxiosError(error) && error.response && error.response.status !== 429) {
        const method = (error.config?.method ?? 'request').toUpperCase();
        const url = error.config?.url ?? '';
        const bodyText = JSON.stringify(error.response.data);
        return Promise.reject(
          new GoHighLevelError(
            `HighLevel ${method} ${url} failed (${error.response.status}): ${bodyText}`,
            error.response.status,
            error.response.data,
          ),
        );
      }
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- re-reject the ORIGINAL error untouched so the 429 rate-limiter retry still recognizes the AxiosError
      return Promise.reject(error);
    });
  }

  // ---------------------------------------------------------------------------
  // HTTP wrappers — EVERY request goes through these so the rate limiter (and
  // 429 retry) applies uniformly. When a RateLimiter is provided it proactively
  // throttles to HighLevel's 100 req/10s burst; otherwise it just retries 429s.
  // ---------------------------------------------------------------------------

  private withRetry<T>(fn: () => Promise<T>): Promise<T> {
    return this.rateLimiter
      ? this.rateLimiter.withRetry(fn, GOHIGHLEVEL_RETRY_OPTS)
      : standaloneWithRetry(fn, GOHIGHLEVEL_RETRY_OPTS);
  }

  private get<T>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.withRetry(() => this.client.get<T>(url, config));
  }

  private post<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.withRetry(() => this.client.post<T>(url, body, config));
  }

  private put<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.withRetry(() => this.client.put<T>(url, body, config));
  }

  private delete<T>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.withRetry(() => this.client.delete<T>(url, config));
  }

  /**
   * Guard a create response: the publish flow links the on-disk file to its new
   * remote id via the returned record's id. If a 2xx create returns no record /
   * no id, fail loudly — returning an id-less record would silently leave the
   * file unlinked and re-create a duplicate on the next publish.
   */
  private requireCreatedRecord<T extends { id?: unknown }>(
    record: T | undefined,
    response: AxiosResponse<unknown>,
    label: string,
  ): T {
    if (!record || typeof record.id !== 'string' || record.id.length === 0) {
      throw new GoHighLevelError(
        `HighLevel ${label} create succeeded but returned no record id`,
        response.status,
        response.data,
      );
    }
    return record;
  }

  /**
   * Validate the Private Integration Token and Location ID with one lightweight,
   * read-only call: fetch a single contact page for the configured location.
   *
   * A 401 means the token is invalid or lacks the `contacts.readonly` scope; a
   * 4xx referencing the location means the Location ID is wrong. We surface both
   * as a `GoHighLevelError` so the connect dialog shows a clear message rather
   * than an opaque failure deep in the stack.
   *
   * @throws GoHighLevelError if credentials are rejected.
   */
  async validateCredentials(): Promise<void> {
    try {
      await this.get('/contacts/', {
        params: { locationId: this.locationId, limit: 1 },
      });
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 401 || status === 403) {
          throw new GoHighLevelError(
            'HighLevel rejected the Private Integration Token. Check the token value and that it grants the contacts.readonly scope.',
            status,
            error.response?.data,
          );
        }
        if (status === 404 || status === 422) {
          throw new GoHighLevelError(
            'HighLevel could not find that Location. Check the Location ID matches the sub-account the token was created in.',
            status,
            error.response?.data,
          );
        }
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Contacts
  // ---------------------------------------------------------------------------

  /**
   * Fetch ALL custom-field definitions for the location. The endpoint returns
   * definitions for both the `contact` and `opportunity` models.
   */
  private async fetchAllCustomFieldDefinitions(): Promise<GoHighLevelCustomFieldDefinition[]> {
    const response = await this.get<GoHighLevelCustomFieldsListResponse>(`/locations/${this.locationId}/customFields`);
    return response.data.customFields ?? [];
  }

  /**
   * Contact custom-field definitions. An unset `model` is treated as a contact
   * field (older locations may not set it).
   */
  async getContactCustomFieldDefinitions(): Promise<GoHighLevelCustomFieldDefinition[]> {
    const allDefinitions = await this.fetchAllCustomFieldDefinitions();
    return allDefinitions.filter((definition) => definition.model !== 'opportunity');
  }

  /** Opportunity custom-field definitions. */
  async getOpportunityCustomFieldDefinitions(): Promise<GoHighLevelCustomFieldDefinition[]> {
    const allDefinitions = await this.fetchAllCustomFieldDefinitions();
    return allDefinitions.filter((definition) => definition.model === 'opportunity');
  }

  /**
   * Stream all contacts for the location via `POST /contacts/search`, yielding
   * one page at a time.
   *
   * Pagination uses the `searchAfter` cursor (the Elasticsearch sort key carried
   * on each contact), NOT page offsets — page offsets are capped at ~10k records
   * and would silently truncate a large backfill. We read the cursor from the
   * last contact of each page and pass it back on the next request.
   *
   * @param pageLimit Records per page (HighLevel max is 100).
   * @param resumeSearchAfter Cursor to resume from after a stalled run.
   */
  async *searchContacts(
    pageLimit: number,
    resumeSearchAfter?: (string | number)[],
  ): AsyncGenerator<{ contacts: GoHighLevelContact[]; searchAfter?: (string | number)[] }, void> {
    let searchAfter = resumeSearchAfter;

    while (true) {
      const requestBody: Record<string, unknown> = { locationId: this.locationId, pageLimit };
      if (searchAfter && searchAfter.length > 0) {
        requestBody.searchAfter = searchAfter;
      }

      const response = await this.post<GoHighLevelContactsSearchResponse>('/contacts/search', requestBody);
      const contacts = response.data.contacts ?? [];
      if (contacts.length === 0) {
        return;
      }

      // CURSOR: advance via the last contact's `searchAfter` sort key (an array
      // of primitive ES sort values, e.g. [timestamp, id]).
      const lastContact = contacts[contacts.length - 1];
      searchAfter = Array.isArray(lastContact.searchAfter)
        ? (lastContact.searchAfter as (string | number)[])
        : undefined;

      yield { contacts, searchAfter };

      // End of results (short page) or no cursor to advance with.
      if (contacts.length < pageLimit || !searchAfter || searchAfter.length === 0) {
        return;
      }
    }
  }

  /**
   * Fetch a single contact by ID. Returns null on 404 (already deleted).
   */
  async getContact(contactId: string): Promise<GoHighLevelContact | null> {
    try {
      const response = await this.get<GoHighLevelContactByIdResponse>(`/contacts/${contactId}`);
      return response.data.contact ?? null;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Contact-scoped sub-entities, fetched on demand (one request per contact) when
   * the user opts in via the Contacts advanced settings. Each returns the raw
   * array as the API gives it, to embed verbatim on the contact record.
   */
  async getContactNotes(contactId: string): Promise<unknown[]> {
    const response = await this.get<{ notes?: unknown[] }>(`/contacts/${encodeURIComponent(contactId)}/notes`);
    return response.data.notes ?? [];
  }

  async getContactTasks(contactId: string): Promise<unknown[]> {
    const response = await this.get<{ tasks?: unknown[] }>(`/contacts/${encodeURIComponent(contactId)}/tasks`);
    return response.data.tasks ?? [];
  }

  async getContactAppointments(contactId: string): Promise<unknown[]> {
    // Note: the appointments endpoint returns the array under `events`.
    const response = await this.get<{ events?: unknown[] }>(`/contacts/${encodeURIComponent(contactId)}/appointments`);
    return response.data.events ?? [];
  }

  /** Create a contact. CreateContactDto requires locationId, which we inject. Returns the created contact (with id). */
  async createContact(payload: Record<string, unknown>): Promise<GoHighLevelContact> {
    const response = await this.post<GoHighLevelContactByIdResponse>('/contacts/', {
      ...payload,
      locationId: this.locationId,
    });
    return this.requireCreatedRecord(response.data.contact, response, 'contact');
  }

  /** Update a contact (partial UpdateContactDto). Returns the updated contact, or null if not echoed. */
  async updateContact(contactId: string, payload: Record<string, unknown>): Promise<GoHighLevelContact | null> {
    const response = await this.put<GoHighLevelContactByIdResponse>(
      `/contacts/${encodeURIComponent(contactId)}`,
      payload,
    );
    return response.data.contact ?? null;
  }

  /** Delete a contact. Ignores 404 (already deleted). */
  async deleteContact(contactId: string): Promise<void> {
    try {
      await this.delete(`/contacts/${encodeURIComponent(contactId)}`);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) return;
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Opportunities
  // ---------------------------------------------------------------------------

  /**
   * Stream all opportunities for the location via `GET /opportunities/search`,
   * yielding one page at a time.
   *
   * Unlike Contacts (which use a `searchAfter` array), this endpoint paginates
   * with a `startAfter` (timestamp) + `startAfterId` (id) pair returned in the
   * response `meta`, passed back as query params. Note the query param is
   * `location_id` (snake_case) here — NOT `locationId`.
   *
   * @param limit Records per page (HighLevel max is 100).
   * @param resume Cursor to resume from after a stalled run.
   */
  async *searchOpportunities(
    limit: number,
    resume?: { startAfter?: number; startAfterId?: string },
  ): AsyncGenerator<{ opportunities: GoHighLevelOpportunity[]; startAfter?: number; startAfterId?: string }, void> {
    let startAfter = resume?.startAfter;
    let startAfterId = resume?.startAfterId;

    while (true) {
      const params: Record<string, unknown> = { location_id: this.locationId, limit };
      if (startAfter !== undefined) params.startAfter = startAfter;
      if (startAfterId !== undefined) params.startAfterId = startAfterId;

      const response = await this.get<GoHighLevelOpportunitiesSearchResponse>('/opportunities/search', {
        params,
      });
      const opportunities = response.data.opportunities ?? [];
      if (opportunities.length === 0) {
        return;
      }

      // CURSOR: advance via the response meta's startAfter/startAfterId pair.
      const meta = response.data.meta ?? {};
      startAfter = meta.startAfter;
      startAfterId = meta.startAfterId;

      yield { opportunities, startAfter, startAfterId };

      // End of results (short page) or no cursor to advance with.
      if (opportunities.length < limit || startAfterId === undefined) {
        return;
      }
    }
  }

  /** Fetch a single opportunity by ID. Returns null on 404. */
  async getOpportunity(opportunityId: string): Promise<GoHighLevelOpportunity | null> {
    try {
      const response = await this.get<GoHighLevelOpportunityByIdResponse>(`/opportunities/${opportunityId}`);
      return response.data.opportunity ?? null;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /** Create an opportunity. CreateDto requires pipelineId/name/status/contactId (caller-supplied) + locationId (injected). */
  async createOpportunity(payload: Record<string, unknown>): Promise<GoHighLevelOpportunity> {
    const response = await this.post<GoHighLevelOpportunityByIdResponse>('/opportunities/', {
      ...payload,
      locationId: this.locationId,
    });
    return this.requireCreatedRecord(response.data.opportunity, response, 'opportunity');
  }

  /** Update an opportunity (partial UpdateOpportunityDto; `status` is accepted here, no separate call needed). */
  async updateOpportunity(
    opportunityId: string,
    payload: Record<string, unknown>,
  ): Promise<GoHighLevelOpportunity | null> {
    const response = await this.put<GoHighLevelOpportunityByIdResponse>(
      `/opportunities/${encodeURIComponent(opportunityId)}`,
      payload,
    );
    return response.data.opportunity ?? null;
  }

  /** Delete an opportunity. Ignores 404. */
  async deleteOpportunity(opportunityId: string): Promise<void> {
    try {
      await this.delete(`/opportunities/${encodeURIComponent(opportunityId)}`);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) return;
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Pipelines
  // ---------------------------------------------------------------------------

  /**
   * Fetch all opportunity pipelines (with their stages) for the location. This
   * endpoint is not paginated and takes `locationId` (camelCase) as a query
   * param.
   */
  async getPipelines(): Promise<GoHighLevelPipeline[]> {
    const response = await this.get<GoHighLevelPipelinesResponse>('/opportunities/pipelines', {
      params: { locationId: this.locationId },
    });
    return response.data.pipelines ?? [];
  }

  // ---------------------------------------------------------------------------
  // Objects (custom + standard business objects)
  // ---------------------------------------------------------------------------

  /**
   * List every object DEFINITION for the location (both custom and standard).
   * Used by `listTables` to surface each custom object as its own table.
   */
  async getObjects(): Promise<GoHighLevelObjectDefinition[]> {
    const response = await this.get<GoHighLevelObjectsListResponse>('/objects/', {
      params: { locationId: this.locationId },
    });
    return response.data.objects ?? [];
  }

  /**
   * Fetch one object's definition + its field definitions
   * (`fetchProperties=true`), used to build the table schema.
   */
  async getObjectSchema(objectKey: string): Promise<GoHighLevelObjectSchemaResponse> {
    const response = await this.get<GoHighLevelObjectSchemaResponse>(`/objects/${encodeURIComponent(objectKey)}`, {
      params: { locationId: this.locationId, fetchProperties: true },
    });
    return response.data;
  }

  /**
   * Stream all records of an object via `POST /objects/{schemaKey}/records/search`.
   *
   * Paginates by `page` and terminates on the first empty page — robust to the
   * API capping page size below the requested `pageLimit` (a short page would
   * otherwise stop the scan early and silently truncate). `query` is sent empty
   * to match all records.
   *
   * @param objectKey The object's internal key (e.g. `custom_objects.pet`).
   * @param pageLimit Records per page requested.
   * @param resumePage Page to resume from after a stalled run (1-based).
   */
  async *searchObjectRecords(
    objectKey: string,
    pageLimit: number,
    resumePage = 1,
  ): AsyncGenerator<{ records: GoHighLevelObjectRecord[]; nextPage: number }, void> {
    let page = resumePage;

    while (true) {
      const requestBody = { locationId: this.locationId, page, pageLimit, query: '', searchAfter: [] };
      const response = await this.post<GoHighLevelObjectRecordsSearchResponse>(
        `/objects/${encodeURIComponent(objectKey)}/records/search`,
        requestBody,
      );
      const records = response.data.records ?? [];
      if (records.length === 0) {
        return;
      }

      page += 1;
      yield { records, nextPage: page };
    }
  }

  /** Fetch a single object record by ID. Returns null on 404. */
  async getObjectRecord(objectKey: string, recordId: string): Promise<GoHighLevelObjectRecord | null> {
    try {
      const response = await this.get<GoHighLevelObjectRecordByIdResponse>(
        `/objects/${encodeURIComponent(objectKey)}/records/${encodeURIComponent(recordId)}`,
      );
      return response.data.record ?? null;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /** Create an object record. Body is `{ locationId, properties, owner?, followers? }` (locationId injected). */
  async createObjectRecord(objectKey: string, payload: Record<string, unknown>): Promise<GoHighLevelObjectRecord> {
    const response = await this.post<GoHighLevelObjectRecordByIdResponse>(
      `/objects/${encodeURIComponent(objectKey)}/records`,
      { ...payload, locationId: this.locationId },
    );
    return this.requireCreatedRecord(response.data.record, response, 'object record');
  }

  /**
   * Update an object record. Unlike create (locationId in body), the update
   * endpoint requires `locationId` as a REQUIRED QUERY param — sending it in the
   * body is rejected. (Verified against the OpenAPI: PUT records/{id} declares
   * `locationId` `in: query, required: true`.)
   */
  async updateObjectRecord(
    objectKey: string,
    recordId: string,
    payload: Record<string, unknown>,
  ): Promise<GoHighLevelObjectRecord | null> {
    const response = await this.put<GoHighLevelObjectRecordByIdResponse>(
      `/objects/${encodeURIComponent(objectKey)}/records/${encodeURIComponent(recordId)}`,
      payload,
      { params: { locationId: this.locationId } },
    );
    return response.data.record ?? null;
  }

  /** Delete an object record. Ignores 404. */
  async deleteObjectRecord(objectKey: string, recordId: string): Promise<void> {
    try {
      await this.delete(`/objects/${encodeURIComponent(objectKey)}/records/${encodeURIComponent(recordId)}`);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) return;
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Generic location-scoped list entities (see gohighlevel-entities.ts)
  // ---------------------------------------------------------------------------

  /**
   * Stream all records of a generic location-scoped list entity, yielding one
   * page at a time with a `cursor` to checkpoint for resumable pulls.
   *
   * Dispatches on the entity's `pagination` style:
   * - `none`     — one call, one page.
   * - `skip`/`offset` — `limit` + running record-count cursor; stop on a short page.
   * - `conversations` — `limit` + `startAfterDate`/`id` cursor from the last record.
   */
  async *listLocationEntity(
    config: GoHighLevelLocationListEntityConfig,
    resume: JsonSafeObject,
  ): AsyncGenerator<{ records: Record<string, unknown>[]; cursor: JsonSafeObject }, void> {
    // Per-endpoint cap (HighLevel's `limit` max is inconsistent and the docs lie).
    // Sending more than the cap 422s and silently fails the whole folder pull.
    const PAGE_LIMIT = config.pageLimit ?? 100;

    const readArray = (data: Record<string, unknown>): Record<string, unknown>[] => {
      const value = data[config.responseArrayKey];
      return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
    };
    const fetchPage = async (params: Record<string, unknown>): Promise<Record<string, unknown>> =>
      (await this.get<Record<string, unknown>>(config.listPath, { params })).data;

    if (config.pagination === 'none') {
      const records = readArray(await fetchPage({ locationId: this.locationId }));
      if (records.length > 0) {
        yield { records, cursor: {} };
      }
      return;
    }

    if (config.pagination === 'skip' || config.pagination === 'offset') {
      const offsetParamName = config.pagination; // 'skip' | 'offset'
      let offset = typeof resume.offset === 'number' ? resume.offset : 0;
      while (true) {
        const records = readArray(
          await fetchPage({ locationId: this.locationId, limit: PAGE_LIMIT, [offsetParamName]: offset }),
        );
        if (records.length === 0) {
          return;
        }
        offset += records.length;
        yield { records, cursor: { offset } };
        if (records.length < PAGE_LIMIT) {
          return;
        }
      }
    }

    // Conversations: cursor by the last record's date + id.
    let startAfterDate =
      typeof resume.startAfterDate === 'string' || typeof resume.startAfterDate === 'number'
        ? resume.startAfterDate
        : undefined;
    let startAfterId = typeof resume.startAfterId === 'string' ? resume.startAfterId : undefined;
    while (true) {
      const params: Record<string, unknown> = { locationId: this.locationId, limit: PAGE_LIMIT };
      if (startAfterDate !== undefined) params.startAfterDate = startAfterDate;
      if (startAfterId !== undefined) params.id = startAfterId;

      const records = readArray(await fetchPage(params));
      if (records.length === 0) {
        return;
      }

      const lastRecord = records[records.length - 1];
      const nextDate = lastRecord.lastMessageDate ?? lastRecord.dateUpdated ?? lastRecord.dateAdded;
      startAfterDate = typeof nextDate === 'string' || typeof nextDate === 'number' ? nextDate : undefined;
      startAfterId = typeof lastRecord.id === 'string' ? lastRecord.id : undefined;

      const cursor: JsonSafeObject = {};
      if (startAfterDate !== undefined) cursor.startAfterDate = startAfterDate;
      if (startAfterId !== undefined) cursor.startAfterId = startAfterId;
      yield { records, cursor };

      if (records.length < PAGE_LIMIT || startAfterDate === undefined) {
        return;
      }
    }
  }
}
