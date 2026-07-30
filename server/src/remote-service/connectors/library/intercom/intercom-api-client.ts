import axios, { AxiosInstance, RawAxiosRequestHeaders } from 'axios';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { createApiClient } from '../../create-api-client';
import { IntercomUpdatedSinceQuery } from './intercom-incremental';
import {
  IntercomArticle,
  IntercomCollection,
  IntercomConversation,
  IntercomConversationListItem,
  IntercomCreateArticleRequest,
  IntercomCreateCollectionRequest,
  IntercomCursorPaginatedResponse,
  IntercomPaginatedResponse,
  IntercomUpdateArticleRequest,
  IntercomUpdateCollectionRequest,
} from './intercom-types';

const INTERCOM_API_BASE_URL = 'https://api.intercom.io';
const INTERCOM_API_VERSION = '2.11';

/**
 * Ceiling on the wait we will derive from `X-RateLimit-Reset`, in seconds.
 *
 * Intercom's buckets reset every 10 seconds, so a legitimate wait is short. The
 * cap guards against a skewed clock or a header in unexpected units turning into
 * a very long sleep; past it, the retry falls back to the exponential ladder.
 */
const INTERCOM_MAX_TRUSTED_RATE_LIMIT_RESET_S = 60;

/**
 * Intercom error codes that mean "you are being throttled, wait and retry".
 *
 * `rate_limit_exceeded` is the documented rate-limit code. `retry_after` is a
 * separate documented code meaning "the client should wait before retrying" —
 * which endpoints emit it is undocumented, so it is matched here rather than
 * discovered the hard way.
 *
 * https://developers.intercom.com/docs/references/rest-api/errors/error-codes
 */
const INTERCOM_THROTTLE_ERROR_CODES = new Set(['rate_limit_exceeded', 'retry_after']);

/**
 * True when Intercom is throttling us — an HTTP 429, or one of
 * {@link INTERCOM_THROTTLE_ERROR_CODES} in the `error.list` body.
 *
 * Intercom wraps every error as `{ type: 'error.list', errors: [{ code, ... }] }`,
 * and unlike Stripe/Brevo/Memberstack its rate-limit codes ARE documented, so
 * checking the body adds real coverage rather than fragility. The status check
 * still comes first so a 429 is caught even if the body is missing or malformed.
 */
export function isIntercomRateLimitError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  if (error.response?.status === 429) return true;
  const body = error.response?.data as { errors?: { code?: string }[] } | undefined;
  return (body?.errors ?? []).some((e) => e.code !== undefined && INTERCOM_THROTTLE_ERROR_CODES.has(e.code));
}

/**
 * Retry policy for every Intercom API call.
 *
 * Intercom does not document a `Retry-After`, but it does return
 * `X-RateLimit-Reset` on every response. Note the unit trap: unlike Brevo's
 * relative `x-sib-ratelimit-reset`, Intercom's is an **absolute Unix timestamp
 * in seconds**, so the wait is `reset - now` — reading it as a duration would
 * sleep for decades. `Retry-After` is still read first if present, since Intercom
 * documents neither its presence nor its absence.
 *
 * https://developers.intercom.com/docs/references/rest-api/errors/rate-limiting
 */
export const INTERCOM_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: isIntercomRateLimitError,
  getRetryAfterS: (error) => {
    if (!axios.isAxiosError(error)) return undefined;
    const headers = error.response?.headers;

    const retryAfterHeader = headers?.['retry-after'] as string | number | undefined;
    const retryAfterSeconds = parseInt(String(retryAfterHeader ?? ''), 10);
    if (!isNaN(retryAfterSeconds) && retryAfterSeconds > 0) {
      return Math.min(retryAfterSeconds, INTERCOM_MAX_TRUSTED_RATE_LIMIT_RESET_S);
    }

    const resetHeader = headers?.['x-ratelimit-reset'] as string | number | undefined;
    const resetAtUnixSeconds = parseInt(String(resetHeader ?? ''), 10);
    if (isNaN(resetAtUnixSeconds)) return undefined;
    const secondsUntilReset = Math.ceil(resetAtUnixSeconds - Date.now() / 1000);
    if (secondsUntilReset <= 0) return undefined;
    return Math.min(secondsUntilReset, INTERCOM_MAX_TRUSTED_RATE_LIMIT_RESET_S);
  },
};

/**
 * A page of conversations plus the opaque cursor returned by Intercom for the
 * next page (or undefined if this was the last page). Callers persist
 * `nextCursor` for crash-resume — Intercom rejects record ids passed as
 * `starting_after`.
 */
export interface IntercomConversationPage {
  items: (IntercomConversation | IntercomConversationListItem)[];
  nextCursor: string | undefined;
}

/**
 * Custom error class for Intercom API errors.
 */
export class IntercomError extends Error {
  public readonly statusCode?: number;
  public readonly responseData?: unknown;

  constructor(message: string, statusCode?: number, responseData?: unknown) {
    super(message);
    this.name = 'IntercomError';
    this.statusCode = statusCode;
    this.responseData = responseData;
  }
}

/**
 * Low-level API client for the Intercom REST API.
 *
 * Uses Bearer token authentication and Intercom-Version header.
 * API docs: https://developers.intercom.com/docs/references/rest-api/api.intercom.io/
 */
export class IntercomApiClient {
  private readonly client: AxiosInstance;
  private readonly rateLimiter?: RateLimiter;

  constructor(accessToken: string, opts?: { rateLimiter?: RateLimiter }) {
    this.rateLimiter = opts?.rateLimiter;

    const headers: RawAxiosRequestHeaders = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Intercom-Version': INTERCOM_API_VERSION,
    };

    this.client = createApiClient({
      baseURL: INTERCOM_API_BASE_URL,
      headers,
    });
  }

  /**
   * Execute a request under the connector account's rate limiter, retrying if
   * Intercom throttles us (see {@link INTERCOM_RETRY_OPTS}).
   */
  private async requestWithRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, INTERCOM_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, INTERCOM_RETRY_OPTS);
  }

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  /**
   * Validate the access token by fetching the authenticated admin.
   * @throws IntercomError if the token is invalid.
   */
  async validateCredentials(): Promise<void> {
    try {
      await this.requestWithRateLimitRetry(() => this.client.get('/me'));
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        throw new IntercomError('Invalid access token', 401, error.response?.data);
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Articles
  // ---------------------------------------------------------------------------

  /**
   * List articles with page-based pagination.
   * Yields pages of article records.
   */
  async *listArticles(pageSize = 25, startPage = 1): AsyncGenerator<IntercomArticle[], void> {
    let page = startPage;
    let totalPages = Infinity;

    while (page <= totalPages) {
      const response = await this.requestWithRateLimitRetry(() =>
        this.client.get<IntercomPaginatedResponse<IntercomArticle>>('/articles', {
          params: { page, per_page: pageSize },
        }),
      );

      totalPages = response.data.pages.total_pages;
      const articles = response.data.data ?? [];

      if (articles.length > 0) {
        yield articles;
      }

      page++;
    }
  }

  /**
   * Get a single article by ID.
   * @returns The article, or null if not found.
   */
  async getArticle(id: string): Promise<IntercomArticle | null> {
    try {
      const response = await this.requestWithRateLimitRetry(() => this.client.get<IntercomArticle>(`/articles/${id}`));
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Create a new article.
   * @returns The created article.
   */
  async createArticle(data: IntercomCreateArticleRequest): Promise<IntercomArticle> {
    const response = await this.requestWithRateLimitRetry(() => this.client.post<IntercomArticle>('/articles', data));
    return response.data;
  }

  /**
   * Update an existing article by ID.
   */
  async updateArticle(id: string, data: IntercomUpdateArticleRequest): Promise<IntercomArticle> {
    const response = await this.requestWithRateLimitRetry(() =>
      this.client.put<IntercomArticle>(`/articles/${id}`, data),
    );
    return response.data;
  }

  /**
   * Delete an article by ID.
   * Does not throw on 404 (idempotent delete).
   */
  async deleteArticle(id: string): Promise<void> {
    try {
      await this.requestWithRateLimitRetry(() => this.client.delete(`/articles/${id}`));
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return;
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Collections
  // ---------------------------------------------------------------------------

  /**
   * List collections with page-based pagination.
   * Yields pages of collection records.
   */
  async *listCollections(pageSize = 20, startPage = 1): AsyncGenerator<IntercomCollection[], void> {
    let page = startPage;
    let totalPages = Infinity;

    while (page <= totalPages) {
      const response = await this.requestWithRateLimitRetry(() =>
        this.client.get<IntercomPaginatedResponse<IntercomCollection>>('/help_center/collections', {
          params: { page, per_page: pageSize },
        }),
      );

      totalPages = response.data.pages.total_pages;
      const collections = response.data.data ?? [];

      if (collections.length > 0) {
        yield collections;
      }

      page++;
    }
  }

  /**
   * Get a single collection by ID.
   * @returns The collection, or null if not found.
   */
  async getCollection(id: string): Promise<IntercomCollection | null> {
    try {
      const response = await this.requestWithRateLimitRetry(() =>
        this.client.get<IntercomCollection>(`/help_center/collections/${id}`),
      );
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Create a new collection.
   * @returns The created collection.
   */
  async createCollection(data: IntercomCreateCollectionRequest): Promise<IntercomCollection> {
    const response = await this.requestWithRateLimitRetry(() =>
      this.client.post<IntercomCollection>('/help_center/collections', data),
    );
    return response.data;
  }

  /**
   * Update an existing collection by ID.
   */
  async updateCollection(id: string, data: IntercomUpdateCollectionRequest): Promise<IntercomCollection> {
    const response = await this.requestWithRateLimitRetry(() =>
      this.client.put<IntercomCollection>(`/help_center/collections/${id}`, data),
    );
    return response.data;
  }

  /**
   * Delete a collection by ID.
   * Does not throw on 404 (idempotent delete).
   */
  async deleteCollection(id: string): Promise<void> {
    try {
      await this.requestWithRateLimitRetry(() => this.client.delete(`/help_center/collections/${id}`));
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return;
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Conversations (read-only)
  // ---------------------------------------------------------------------------

  /**
   * Shared cursor-pagination + hydration loop for conversations, used by both
   * the full list (`GET /conversations`) and the incremental search
   * (`POST /conversations/search`). `fetchPage` performs one request given the
   * current cursor and returns the parsed response body.
   *
   * Yields each page alongside `nextCursor`, the opaque cursor returned by
   * Intercom in `pages.next.starting_after`. Callers persist `nextCursor` (not
   * a record id) for crash-resume — Intercom rejects ids passed as
   * `starting_after` with "Invalid starting_after param".
   *
   * When `hydrate` is true, each conversation is individually fetched via
   * getConversation to include `conversation_parts` (one API call per
   * conversation — slow for large workspaces). When false, conversations are
   * yielded as-is from the list/search endpoint (no `conversation_parts`).
   */
  private async *paginateConversations(
    fetchPage: (
      startingAfter: string | undefined,
    ) => Promise<IntercomCursorPaginatedResponse<IntercomConversationListItem>>,
    hydrate: boolean,
    resumeAfter?: string,
  ): AsyncGenerator<IntercomConversationPage, void> {
    let startingAfter: string | undefined = resumeAfter;
    let hasMore = true;

    while (hasMore) {
      const data = await fetchPage(startingAfter);
      const items = data.conversations ?? [];
      const nextCursor = data.pages.next?.starting_after;

      if (items.length > 0) {
        if (hydrate) {
          // Hydrate each conversation to get conversation_parts
          const fullConversations: IntercomConversation[] = [];
          for (const item of items) {
            const full = await this.getConversation(item.id);
            if (full) {
              fullConversations.push(full);
            }
          }
          if (fullConversations.length > 0) {
            yield { items: fullConversations, nextCursor };
          }
        } else {
          yield { items, nextCursor };
        }
      }

      if (nextCursor) {
        startingAfter = nextCursor;
      } else {
        hasMore = false;
      }
    }
  }

  /**
   * List conversations with cursor-based pagination.
   *
   * When `hydrate` is true (default), each conversation is individually fetched via
   * getConversation to include `conversation_parts`. This is slow for large workspaces
   * (one API call per conversation).
   *
   * When `hydrate` is false, conversations are returned as-is from the list endpoint
   * (no `conversation_parts`). Much faster for large workspaces.
   */
  listConversations(
    pageSize = 20,
    hydrate = true,
    resumeAfter?: string,
  ): AsyncGenerator<IntercomConversationPage, void> {
    return this.paginateConversations(
      async (startingAfter) => {
        const params: Record<string, unknown> = { per_page: pageSize };
        if (startingAfter) {
          params.starting_after = startingAfter;
        }
        const response = await this.requestWithRateLimitRetry(() =>
          this.client.get<IntercomCursorPaginatedResponse<IntercomConversationListItem>>('/conversations', { params }),
        );
        return response.data;
      },
      hydrate,
      resumeAfter,
    );
  }

  /**
   * Incremental conversations pull: search for conversations whose
   * `updated_at` matches `query` (built by `buildIntercomUpdatedSinceQuery`),
   * sorted ascending so a record updated mid-pagination is pushed to the tail
   * (a possible duplicate, never a miss — Intercom's cursor pagination is
   * stateless). Same hydration/pagination behavior as `listConversations`.
   */
  searchConversationsUpdatedSince(
    query: IntercomUpdatedSinceQuery,
    pageSize = 20,
    hydrate = true,
    resumeAfter?: string,
  ): AsyncGenerator<IntercomConversationPage, void> {
    return this.paginateConversations(
      async (startingAfter) => {
        const pagination: Record<string, unknown> = { per_page: pageSize };
        if (startingAfter) {
          pagination.starting_after = startingAfter;
        }
        const body = {
          query,
          sort: { field: 'updated_at', order: 'ascending' },
          pagination,
        };
        const response = await this.requestWithRateLimitRetry(() =>
          this.client.post<IntercomCursorPaginatedResponse<IntercomConversationListItem>>(
            '/conversations/search',
            body,
          ),
        );
        return response.data;
      },
      hydrate,
      resumeAfter,
    );
  }

  /**
   * Get a single conversation by ID, including conversation_parts.
   * @returns The full conversation, or null if not found.
   */
  async getConversation(id: string): Promise<IntercomConversation | null> {
    try {
      const response = await this.requestWithRateLimitRetry(() =>
        this.client.get<IntercomConversation>(`/conversations/${id}`),
      );
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }
}
