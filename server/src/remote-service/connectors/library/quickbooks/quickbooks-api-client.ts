import axios, { AxiosInstance } from 'axios';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { createApiClient } from '../../create-api-client';
import { QuickBooksCredentials, QuickBooksQueryResponse } from './quickbooks-types';

const QBO_PRODUCTION_BASE = 'https://quickbooks.api.intuit.com';
const QBO_SANDBOX_BASE = 'https://sandbox-quickbooks.api.intuit.com';
const QBO_MAX_RESULTS = 1000;

/**
 * QBO's Fault error code for a throttled request — the machine-readable half of
 * `message=ThrottleExceeded; errorCode=003001; statusCode=429`.
 */
const QBO_THROTTLE_EXCEEDED_ERROR_CODE = '003001';

/**
 * True when QBO is throttling us. Intuit signals this as HTTP 429 with Fault
 * error code `003001` ("ThrottleExceeded"), raised for *either* of its two
 * documented limits — 500 requests/minute per realmId, or 10 simultaneous
 * requests per realmId — so a 429 here does not necessarily mean the per-minute
 * quota is spent.
 *
 * The Fault code is checked as well as the status because Intuit has been known
 * to return the throttle Fault under other 4xx/5xx statuses; matching either
 * signal keeps the predicate honest without widening it to unrelated errors.
 */
export function isQuickBooksThrottleError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  if (error.response?.status === 429) return true;
  const fault = (error.response?.data as { Fault?: { Error?: { code?: string }[] } } | undefined)?.Fault;
  return (fault?.Error ?? []).some((faultError) => faultError.code === QBO_THROTTLE_EXCEEDED_ERROR_CODE);
}

/**
 * Retry policy for every QBO call.
 *
 * Intuit does **not** send a `Retry-After` on a 429 — their guidance is plain
 * exponential backoff — so `getRetryAfterS` is omitted entirely and the ladder
 * plus `defaultCooldownS` do all the work. Both are sized against QBO's
 * per-*minute* window: a 15s bucket freeze on each 429 (so the sibling folders
 * of a parallel pull stop hammering the realm too), and enough attempts that the
 * ladder — 2s, 4s, 8s, 16s, 32s, 60s — spans a full window reset rather than
 * giving up inside the minute that is still throttled.
 */
export const QUICKBOOKS_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: isQuickBooksThrottleError,
  defaultCooldownS: 15,
  maxRetries: 6,
  initialRetryDelayMs: 2000,
};

/**
 * Custom error class for QuickBooks API errors.
 */
export class QuickBooksError extends Error {
  public readonly statusCode?: number;
  public readonly code?: string;
  public readonly responseData?: unknown;

  constructor(message: string, statusCode?: number, code?: string, responseData?: unknown) {
    super(message);
    this.name = 'QuickBooksError';
    this.statusCode = statusCode;
    this.code = code;
    this.responseData = responseData;
  }
}

/**
 * Low-level API client for the QuickBooks Online API.
 *
 * Uses the QBO v3 REST API with OAuth 2.0 Bearer token authentication.
 * API docs: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities
 */
export class QuickBooksApiClient {
  private readonly client: AxiosInstance;
  private readonly realmId: string;
  private readonly rateLimiter?: RateLimiter;

  constructor(credentials: QuickBooksCredentials, opts?: { rateLimiter?: RateLimiter; sandbox?: boolean }) {
    this.realmId = credentials.realmId;
    this.rateLimiter = opts?.rateLimiter;

    const baseURL = opts?.sandbox ? QBO_SANDBOX_BASE : QBO_PRODUCTION_BASE;

    this.client = createApiClient({
      baseURL: `${baseURL}/v3/company/${credentials.realmId}`,
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Execute a request under the connector account's rate limiter, retrying if
   * QBO throttles us (see {@link QUICKBOOKS_RETRY_OPTS}).
   *
   * Proactive quota alone is not enough here: the limiter only counts what *this
   * connection* spends, while Intuit throttles per realmId across everything
   * touching that company — another Scratch connection, a publish running
   * alongside the pull, or the customer's other integrations. So a 429 can (and
   * does) arrive while our own bucket looks half full, and the only correct
   * answer is to back off and retry.
   */
  private async requestWithRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, QUICKBOOKS_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, QUICKBOOKS_RETRY_OPTS);
  }

  /**
   * Test connection by querying CompanyInfo.
   */
  async testConnection(): Promise<void> {
    try {
      // Use `SELECT *` — QBO's query parser rejects selecting an individual
      // column on the CompanyInfo singleton (`SELECT CompanyName FROM CompanyInfo`
      // → 400 "Property CompanyName not found for Entity CompanyInfo", code 4001).
      await this.requestWithRateLimitRetry(() =>
        this.client.get<QuickBooksQueryResponse>('/query', {
          params: { query: 'SELECT * FROM CompanyInfo' },
        }),
      );
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 401 || status === 403) {
          throw new QuickBooksError('Invalid or expired QuickBooks credentials', status, 'UNAUTHORIZED');
        }
      }
      throw error;
    }
  }

  /**
   * Query entities using QBO's SQL-like query language.
   * Returns the array of entities and whether more results exist.
   *
   * QBO uses 1-based STARTPOSITION.
   */
  async query(
    entityType: string,
    startPosition: number,
    maxResults: number = QBO_MAX_RESULTS,
  ): Promise<{ entities: Record<string, unknown>[]; hasMore: boolean }> {
    const query = `SELECT * FROM ${entityType} STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`;

    const response = await this.requestWithRateLimitRetry(() =>
      this.client.get<QuickBooksQueryResponse>('/query', { params: { query } }),
    );

    const queryResponse = response.data.QueryResponse;
    const entities = (queryResponse[entityType] as Record<string, unknown>[] | undefined) ?? [];
    const hasMore = entities.length === maxResults;

    return { entities, hasMore };
  }

  /**
   * Get a single entity by type and ID.
   * Returns null if not found (404).
   */
  async getEntity(entityType: string, id: string): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.requestWithRateLimitRetry(() =>
        this.client.get<Record<string, Record<string, unknown>>>(`/${entityType.toLowerCase()}/${id}`),
      );
      return response.data[entityType] ?? null;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Create a new entity.
   *
   * QBO create and update both POST to the same collection endpoint
   * (`/v3/company/{realmId}/{entity}`); the presence of `Id` + `SyncToken` in the
   * body is what makes it an update. `body` here must therefore NOT carry an `Id`
   * or `SyncToken`. Returns the created object as QBO stored it (with the
   * server-assigned `Id` and initial `SyncToken`).
   */
  async createEntity(entityType: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.requestWithRateLimitRetry(() =>
      this.client.post<Record<string, Record<string, unknown>>>(`/${entityType.toLowerCase()}`, body),
    );
    return response.data[entityType] ?? {};
  }

  /**
   * Update an existing entity.
   *
   * `body` must include `Id`, the current `SyncToken`, and `sparse: true` — a
   * sparse update patches only the supplied fields and leaves everything else
   * intact. (A non-sparse update nulls every omitted field, which would be silent
   * data loss.) The caller (connector) is responsible for supplying a current
   * `SyncToken` and retrying on a stale-object error via {@link isStaleObjectError}.
   * Returns the updated object as QBO stored it (with the incremented `SyncToken`).
   */
  async updateEntity(entityType: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.requestWithRateLimitRetry(() =>
      this.client.post<Record<string, Record<string, unknown>>>(`/${entityType.toLowerCase()}`, body),
    );
    return response.data[entityType] ?? {};
  }

  /**
   * Permanently delete a transaction entity via `?operation=delete`.
   *
   * Only transaction entities (Invoice, Bill, Payment, …) support this; name-list
   * entities cannot be hard-deleted (the connector routes those to a deactivating
   * `Active: false` update instead). Requires the current `SyncToken`. Returns
   * `true` on success and `false` if the record was already gone (404), so the
   * caller can treat an already-deleted record as a no-op.
   */
  async deleteTransaction(entityType: string, id: string, syncToken: string): Promise<boolean> {
    try {
      await this.requestWithRateLimitRetry(() =>
        this.client.post(
          `/${entityType.toLowerCase()}`,
          { Id: id, SyncToken: syncToken },
          { params: { operation: 'delete' } },
        ),
      );
      return true;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Detect QBO's optimistic-concurrency "stale object" rejection.
   *
   * SyncToken increments on every change to a record — including edits made in
   * QBO's own UI — so a token captured at pull time can be stale by write time.
   * QBO rejects the write with HTTP 400 and Fault error code `5010`
   * ("Stale Object Error"). The connector catches this, re-fetches the current
   * SyncToken, and retries once.
   */
  static isStaleObjectError(error: unknown): boolean {
    if (!axios.isAxiosError(error) || error.response?.status !== 400) return false;
    const fault = (error.response?.data as { Fault?: { Error?: { code?: string; Message?: string }[] } } | undefined)
      ?.Fault;
    return (fault?.Error ?? []).some(
      (e) => e.code === '5010' || (e.Message ?? '').toLowerCase().includes('stale object'),
    );
  }
}
