import axios, { AxiosInstance, RawAxiosRequestHeaders } from 'axios';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { toConnectorAuthTokenProvider } from '../../connector-auth-token';
import { createApiClient } from '../../create-api-client';
import { StripeCredentials, StripeEntityType, StripeListResponse } from './stripe-types';

/**
 * Custom error class for Stripe API errors.
 */
export class StripeError extends Error {
  public readonly statusCode?: number;
  public readonly code?: string;
  public readonly type?: string;
  public readonly responseData?: unknown;

  constructor(message: string, statusCode?: number, code?: string, type?: string, responseData?: unknown) {
    super(message);
    this.name = 'StripeError';
    this.statusCode = statusCode;
    this.code = code;
    this.type = type;
    this.responseData = responseData;
  }
}

/**
 * The Stripe API version this connector is pinned to, sent as `Stripe-Version` on every request.
 *
 * Without an explicit pin Stripe serves whatever version the *connected account* happens to default
 * to, so the payload shape — and therefore every field declared in `stripe-json-schema.ts` — would
 * differ from account to account and change under us whenever an account upgrades. Pinning makes the
 * connector's contract deterministic: the schema is verified against exactly this version.
 *
 * Bump this and `stripe-json-schema.ts` / `stripe-types.ts` together, re-verifying each declared
 * field against the API reference for the new version. Major releases remove fields — the Basil
 * release (2025-03-31) alone moved `subscription.current_period_start|end` onto `items.data[]` and
 * removed `invoice.subscription|charge|payment_intent|paid|tax` plus `charge.invoice` and
 * `payment_intent.invoice`.
 *
 * Deliberately independent of `STRIPE_API_VERSION` in `server/src/payment/stripe-payment.service.ts`,
 * which pins Whalesync's own billing integration to the version its `stripe` SDK ships types for.
 *
 * https://docs.stripe.com/api/versioning
 */
export const STRIPE_CONNECTOR_API_VERSION = '2026-07-29.dahlia';

/**
 * True when Stripe is throttling us.
 *
 * Detection is by HTTP status alone, deliberately. Stripe's error reference
 * enumerates only four `error.type` values and `rate_limit_error` is not among
 * them, and Stripe's own Node SDK dispatches on the status code rather than the
 * type — so branching on `error.type === 'rate_limit_error'` would fail closed
 * and the retry would silently never fire.
 *
 * Matching the status also picks up `lock_timeout`, a *different* failure that
 * Stripe returns as 429: another request or an internal Stripe process is
 * holding the object. Stripe explicitly recommends retrying it on backoff — and
 * notes their SDKs do retry it — so folding it in here is correct, not
 * incidental. The one thing backoff cannot fix is sustained contention on a
 * single object, which needs serialized writes rather than a longer sleep.
 *
 * https://docs.stripe.com/rate-limits · https://docs.stripe.com/error-codes
 */
export function isStripeRateLimitError(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 429;
}

/**
 * Retry policy for every Stripe API call.
 *
 * Stripe documents no `Retry-After` header — their guidance is client-computed
 * exponential backoff with jitter, which is what {@link WithRetryOpts} does by
 * default — so `getRetryAfterS` is omitted rather than guessing at a header that
 * may not exist.
 *
 * Retries are safe here because this connector's Stripe calls are all `GET`s,
 * which Stripe guarantees are idempotent. A future write path must send an
 * `Idempotency-Key` before it can rely on this retry.
 */
export const STRIPE_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: isStripeRateLimitError,
};

/**
 * Endpoint configuration for each entity type.
 */
const ENTITY_ENDPOINTS: Record<StripeEntityType, string> = {
  customers: '/v1/customers',
  products: '/v1/products',
  prices: '/v1/prices',
  subscriptions: '/v1/subscriptions',
  invoices: '/v1/invoices',
  payment_intents: '/v1/payment_intents',
  charges: '/v1/charges',
  refunds: '/v1/refunds',
  disputes: '/v1/disputes',
  credit_notes: '/v1/credit_notes',
  coupons: '/v1/coupons',
  promotion_codes: '/v1/promotion_codes',
  balance_transactions: '/v1/balance_transactions',
  subscription_schedules: '/v1/subscription_schedules',
  // Stripe only lists events from the last 30 days.
  events: '/v1/events',
};

/**
 * A list Stripe embeds in a record and cuts off at 10 entries (`has_more: true`), with the endpoint
 * that pages through the whole list for one record. The embedded list can't be paginated in place, so
 * the client fetches the rest from that endpoint and splices it back in (see
 * `hydrateTruncatedEmbeddedList`).
 */
interface TruncatedEmbeddedListSource {
  /** The record field holding the embedded list. */
  listFieldName: string;
  /** The endpoint and fixed query parameters that list every entry for the record with this id. */
  fullListRequestForRecord: (recordId: string) => { path: string; params: Record<string, string> };
}

const TRUNCATED_EMBEDDED_LIST_SOURCES: Partial<Record<StripeEntityType, TruncatedEmbeddedListSource>> = {
  // The same endpoint that backs the nested list (`items.url`).
  subscriptions: {
    listFieldName: 'items',
    fullListRequestForRecord: (subscriptionId) => ({
      path: '/v1/subscription_items',
      params: { subscription: subscriptionId },
    }),
  },
  invoices: {
    listFieldName: 'lines',
    fullListRequestForRecord: (invoiceId) => ({
      path: `/v1/invoices/${encodeURIComponent(invoiceId)}/lines`,
      params: {},
    }),
  },
  credit_notes: {
    listFieldName: 'lines',
    fullListRequestForRecord: (creditNoteId) => ({
      path: `/v1/credit_notes/${encodeURIComponent(creditNoteId)}/lines`,
      params: {},
    }),
  },
};

/**
 * Low-level API client for the Stripe API.
 *
 * Uses axios for HTTP requests with Bearer token authentication.
 * Stripe uses cursor-based pagination with `starting_after` parameter.
 *
 * API docs: https://stripe.com/docs/api
 */
export class StripeApiClient {
  private readonly client: AxiosInstance;
  private readonly rateLimiter?: RateLimiter;

  constructor(credentials: StripeCredentials, opts?: { rateLimiter?: RateLimiter }) {
    this.rateLimiter = opts?.rateLimiter;

    const headers: RawAxiosRequestHeaders = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'Stripe-Version': STRIPE_CONNECTOR_API_VERSION,
    };

    const secretKeyOrOAuthAccessTokenProvider = toConnectorAuthTokenProvider(credentials.secretKeyOrOAuthAccessToken);
    this.client = createApiClient(
      {
        baseURL: 'https://api.stripe.com',
        headers,
      },
      { authorizationHeaderValueProvider: async () => `Bearer ${await secretKeyOrOAuthAccessTokenProvider()}` },
    );
  }

  /**
   * Execute a request under the connector account's rate limiter, retrying if
   * Stripe throttles us (see {@link STRIPE_RETRY_OPTS}).
   */
  private async requestWithRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, STRIPE_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, STRIPE_RETRY_OPTS);
  }

  /**
   * Validate the secret key or OAuth access token by listing one customer.
   * @throws StripeError if Stripe refuses it.
   */
  async validateCredentials(): Promise<void> {
    try {
      await this.requestWithRateLimitRetry(() => this.client.get('/v1/customers', { params: { limit: 1 } }));
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        const data = error.response?.data as { error?: { message?: string } } | undefined;
        throw new StripeError(
          data?.error?.message ?? 'Invalid API key',
          401,
          'authentication_error',
          'authentication_error',
          error.response?.data,
        );
      }
      throw error;
    }
  }

  /**
   * List entities with cursor-based pagination.
   * Returns an async generator that yields pages of entities.
   */
  async *listEntities(
    entityType: StripeEntityType,
    limit = 100,
    resumeAfter?: string,
  ): AsyncGenerator<Record<string, unknown>[], void> {
    const endpoint = ENTITY_ENDPOINTS[entityType];
    let startingAfter: string | undefined = resumeAfter;
    let hasMore = true;

    while (hasMore) {
      const params: Record<string, string | number> = { limit };
      if (startingAfter) {
        params.starting_after = startingAfter;
      }

      // Expand nested objects for certain entity types to get full data
      const expandParams = this.getExpandParams(entityType);

      // Override Stripe list defaults that would otherwise silently omit records
      // (e.g. subscriptions exclude canceled ones unless status=all is passed).
      const fullPullFilterParams = this.getListFilterParamsToIncludeAllRecords(entityType);

      const response = await this.requestWithRateLimitRetry(() =>
        this.client.get<StripeListResponse<Record<string, unknown>>>(endpoint, {
          params: { ...params, ...expandParams, ...fullPullFilterParams },
        }),
      );

      const list = response.data;

      if (list.data && list.data.length > 0) {
        for (const record of list.data) {
          await this.hydrateTruncatedEmbeddedList(entityType, record);
        }
        yield list.data;
        const lastItem = list.data[list.data.length - 1];
        startingAfter = lastItem.id as string;
      }

      hasMore = list.has_more;
    }
  }

  /**
   * Get a single entity by ID.
   * Returns null if not found (404).
   */
  async getEntity(entityType: StripeEntityType, id: string): Promise<Record<string, unknown> | null> {
    const endpoint = ENTITY_ENDPOINTS[entityType];
    try {
      const expandParams = this.getExpandParams(entityType);
      const response = await this.requestWithRateLimitRetry(() =>
        this.client.get<Record<string, unknown>>(`${endpoint}/${id}`, {
          params: expandParams,
        }),
      );
      const entity = response.data;
      await this.hydrateTruncatedEmbeddedList(entityType, entity);
      return entity;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get expand parameters for entity types that have nested objects.
   * Stripe returns IDs for related objects by default; expanding hydrates them.
   */
  private getExpandParams(entityType: StripeEntityType): Record<string, string> {
    switch (entityType) {
      case 'subscriptions':
        return { 'expand[]': 'data.items' };
      default:
        return {};
    }
  }

  /**
   * Get additional list-query parameters needed to pull *every* record for an
   * entity type, overriding Stripe defaults that would silently omit some.
   *
   * Stripe's `GET /v1/subscriptions` returns only non-canceled subscriptions
   * unless `status=all` is supplied, which would drop canceled/ended
   * subscriptions from a full pull. Every other entity type lists all records by
   * default — products, prices, and promotion codes return both active and
   * inactive, invoices and credit notes return every status including drafts and
   * voids, subscription schedules return every status unless filtered, and
   * charges, payment intents, refunds, disputes, coupons, and balance
   * transactions have no status filter — so they need no extra parameters.
   * Events are the exception no parameter can fix: Stripe only lists the last
   * 30 days of them.
   *
   * See: https://docs.stripe.com/api/subscriptions/list (status parameter)
   */
  private getListFilterParamsToIncludeAllRecords(entityType: StripeEntityType): Record<string, string> {
    switch (entityType) {
      case 'subscriptions':
        return { status: 'all' };
      default:
        return {};
    }
  }

  /**
   * Repair a record whose embedded list was truncated: a subscription's `items`, or an invoice's or
   * credit note's `lines` (see `TRUNCATED_EMBEDDED_LIST_SOURCES`).
   *
   * Stripe embeds at most 10 entries and sets `has_more = true` when the record has more. An embedded
   * list cannot be paginated in place, so we fetch the complete set from the endpoint that lists it
   * for this record and splice it back in. The result is what Stripe would have returned had it not
   * truncated the list, preserving record fidelity.
   *
   * No-op for entity types with no such list, and for records whose list already fits in one page.
   */
  private async hydrateTruncatedEmbeddedList(
    entityType: StripeEntityType,
    record: Record<string, unknown>,
  ): Promise<void> {
    const listSource = TRUNCATED_EMBEDDED_LIST_SOURCES[entityType];
    if (!listSource) {
      return;
    }

    const embeddedList = record[listSource.listFieldName] as StripeListResponse<Record<string, unknown>> | undefined;
    if (!embeddedList || embeddedList.has_more !== true) {
      return;
    }

    const recordId = record.id;
    if (typeof recordId !== 'string') {
      return;
    }

    embeddedList.data = await this.fetchAllEmbeddedListEntries(listSource.fullListRequestForRecord(recordId));
    embeddedList.has_more = false;
  }

  /**
   * Fetch every entry of a record's embedded list, following Stripe's cursor-based pagination at the
   * maximum page size. Each entry comes back in the same shape as the embedded ones (a subscription
   * item embeds its full `price`, an invoice line its `pricing` and `period`).
   */
  private async fetchAllEmbeddedListEntries(fullListRequest: {
    path: string;
    params: Record<string, string>;
  }): Promise<Record<string, unknown>[]> {
    const allEntries: Record<string, unknown>[] = [];
    let startingAfter: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const params: Record<string, string | number> = {
        ...fullListRequest.params,
        limit: 100,
      };
      if (startingAfter) {
        params.starting_after = startingAfter;
      }

      const response = await this.requestWithRateLimitRetry(() =>
        this.client.get<StripeListResponse<Record<string, unknown>>>(fullListRequest.path, {
          params,
        }),
      );
      const list = response.data;

      if (list.data && list.data.length > 0) {
        allEntries.push(...list.data);
        const lastEntry = list.data[list.data.length - 1];
        startingAfter = lastEntry.id as string;
      }

      hasMore = list.has_more;
    }

    return allEntries;
  }
}
