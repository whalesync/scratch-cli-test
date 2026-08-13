import axios, { AxiosInstance, RawAxiosRequestHeaders } from 'axios';
import { WSLogger } from 'src/logger';
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
 * Hard ceiling on `per_page` for Intercom's page-number-paginated list
 * endpoints (`/articles`, `/help_center/collections`). Anything larger is
 * rejected with `parameter_invalid: "Per Page is too big"` (probed live).
 *
 * Listing at the maximum matters for correctness, not just speed: these
 * endpoints sort by `updated_at` DESC with 1-second granularity and break ties
 * inconsistently across page requests, so every page boundary is a place where
 * a tie-group can be split differently between two requests — duplicating one
 * record and silently skipping its neighbor (DEV-11283). Fewer pages = fewer
 * boundaries, and any dataset that fits in one page has no boundaries at all.
 */
export const INTERCOM_MAX_PAGE_SIZE = 250;

/**
 * How many complete page walks {@link IntercomApiClient.listArticles} /
 * `listCollections` will attempt before accepting an unverified (short) walk
 * and logging a warning. See `listWithFaithfulPageWalk` for why re-walking
 * with a shifted page size recovers records the previous walk skipped.
 */
const MAX_PAGE_WALKS_PER_FAITHFUL_LISTING = 4;

/**
 * Page-size ratios for the primary walk and each verification re-walk.
 *
 * The spread must be LARGE, not adjacent: page boundary k sits at record index
 * k × per_page, so stepping per_page down by 1 only moves boundary k by k
 * records — early boundaries barely move, and a tie-group straddling one keeps
 * straddling it walk after walk. Measured live against a bulk-touched
 * 60-article tie block (DEV-11283): adjacent sizes (10, 9, 8, 7) stalled at
 * 212/213 after 4 walks, while this ratio family — (10, 7, 5, 4) and
 * (25, 17, 11, 7) — recovered 213/213 within 3–4 walks. (A 0.68-power ladder
 * rounding to (10, 7, 5, 3) also left 1/213 unrecovered, so the exact rungs
 * matter; these ratios reproduce the empirically complete ladders.)
 */
const PAGE_SIZE_LADDER_RATIOS = [1, 0.7, 0.5, 0.36];

/**
 * Cap on the random per-listing offset subtracted from every verification
 * rung of the ladder (primary walk stays at the requested size). Jitter is
 * skipped for small base page sizes, where subtracting up to 7 would collapse
 * the rung spacing that makes the ladder work (and where unit tests need
 * deterministic rungs).
 */
const VERIFICATION_WALK_MAX_JITTER = 8;
const MIN_BASE_PAGE_SIZE_FOR_JITTER = 50;

/**
 * The staggered page-size ladder for one faithful listing: the requested size
 * first, then widely spaced smaller sizes for each verification re-walk,
 * clamped to ≥1. For the production {@link INTERCOM_MAX_PAGE_SIZE} this is
 * [250, 175, 125, 90] minus the jitter on the verification rungs.
 *
 * `verificationWalkJitter` exists because even a well-spread ladder can leave
 * a record unrecovered on an extreme tie block, and the ladder is otherwise
 * deterministic — the SAME record would then be missing on every subsequent
 * pull (a permanent hole, the exact DEV-11283 failure mode). Randomizing the
 * verification rungs per listing makes consecutive pulls walk different
 * boundary layouts, so a persistent miss heals on the next pull instead.
 */
export function buildStaggeredPageSizeLadder(basePageSize: number, verificationWalkJitter: number): number[] {
  return PAGE_SIZE_LADDER_RATIOS.map((ratio, walkIndex) =>
    walkIndex === 0 ? basePageSize : Math.max(1, Math.round(basePageSize * ratio) - verificationWalkJitter),
  );
}

/**
 * One batch of records from a faithful page walk over a page-number-paginated
 * Intercom list endpoint.
 *
 * `resumeFromPage` is the crash-resume checkpoint: the next page of the
 * *primary* walk to fetch. Callers persist it after processing the batch and
 * pass it back as `startPage` to resume. Batches yielded by a verification
 * re-walk keep reporting the primary walk's past-the-end page, so a resume
 * after a mid-verification crash re-enters at "primary walk complete" and the
 * verification logic re-runs from scratch.
 */
export interface IntercomPageBatch<T> {
  records: T[];
  resumeFromPage: number;
}

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
   * Walk a page-number-paginated list endpoint (`/articles`,
   * `/help_center/collections`) so that the union of yielded records is a
   * faithful snapshot of the list, verified against Intercom's `total_count`.
   *
   * Why a plain page walk is NOT faithful (DEV-11283): these endpoints sort by
   * `updated_at` DESC with 1-second timestamp granularity and break ties
   * inconsistently across page requests. When a tie-group straddles a page
   * boundary, the two requests can order the group differently — one member
   * appears on both pages while its neighbor appears on neither. The skip is
   * deterministic while the list order persists, so it never self-heals, and
   * downstream full-scan delete-detection turns the skipped record into a
   * wrongful destination delete.
   *
   * Defenses, in order:
   * 1. Records are deduplicated by id across the whole listing, so a
   *    boundary-duplicated record is yielded once (a same-pull duplicate
   *    previously produced a slug-collision twin file).
   * 2. After each complete walk, the unique-records-seen count is checked
   *    against the endpoint's own `total_count`. A shortfall triggers a
   *    re-walk at the next size in {@link buildStaggeredPageSizeLadder},
   *    which moves every page boundary far enough that the same tie-group
   *    lands strictly inside a page; only records not yet seen are yielded.
   *    Verification re-walks run ONLY on a detected shortfall — a clean walk
   *    costs exactly one walk.
   * 3. After {@link MAX_PAGE_WALKS_PER_FAITHFUL_LISTING} walks a persistent
   *    shortfall ABORTS the listing with an {@link IntercomError}: the pull
   *    fails visibly and the engine never runs full-scan delete-detection
   *    over an unverified walk, so a missed record cannot become a wrongful
   *    destination delete. (There is deliberately no engine-side guard —
   *    DEV-11289 was canceled: walk fidelity is the connector's job, so the
   *    connector refuses to hand the engine an incomplete snapshot.)
   *
   * A shortfall can also be legitimate churn (records created mid-walk appear
   * in the already-walked region). Failing is still safe there: a failed pull
   * never runs delete-detection (and a redelivered job resumes with
   * `isResuming`, which also skips it), so the cost is a visible retry, never
   * a destructive write. The next pull's verification rungs are jittered
   * differently, so a deterministic skip does not repeat.
   */
  private async *listWithFaithfulPageWalk<T extends { id: string }>(
    endpointPath: string,
    basePageSize: number,
    startPage: number,
  ): AsyncGenerator<IntercomPageBatch<T>, void> {
    const recordIdsSeenAcrossAllWalks = new Set<string>();
    let resumeFromPageInPrimaryWalk = startPage;
    let totalCountReportedByLatestResponse = 0;
    const verificationWalkJitter =
      basePageSize >= MIN_BASE_PAGE_SIZE_FOR_JITTER ? Math.floor(Math.random() * VERIFICATION_WALK_MAX_JITTER) : 0;
    const staggeredPageSizeLadder = buildStaggeredPageSizeLadder(basePageSize, verificationWalkJitter);

    for (let walkAttemptIndex = 0; walkAttemptIndex < staggeredPageSizeLadder.length; walkAttemptIndex++) {
      const pageSizeForThisWalk = staggeredPageSizeLadder[walkAttemptIndex];
      const isPrimaryWalk = walkAttemptIndex === 0;
      let page = isPrimaryWalk ? startPage : 1;
      let totalPages = Infinity;

      while (page <= totalPages) {
        const response = await this.requestWithRateLimitRetry(() =>
          this.client.get<IntercomPaginatedResponse<T>>(endpointPath, {
            params: { page, per_page: pageSizeForThisWalk },
          }),
        );

        totalPages = response.data.pages.total_pages;
        totalCountReportedByLatestResponse = response.data.total_count;
        page++;
        if (isPrimaryWalk) {
          resumeFromPageInPrimaryWalk = page;
        }

        const recordsNotYetSeenThisListing = (response.data.data ?? []).filter(
          (record) => !recordIdsSeenAcrossAllWalks.has(record.id),
        );
        for (const record of recordsNotYetSeenThisListing) {
          recordIdsSeenAcrossAllWalks.add(record.id);
        }

        if (recordsNotYetSeenThisListing.length > 0) {
          yield { records: recordsNotYetSeenThisListing, resumeFromPage: resumeFromPageInPrimaryWalk };
        }
      }

      // A resumed primary walk (startPage > 1) only saw the tail of the list,
      // so its seen-count is expected to fall short and the verification
      // re-walk doubles as resume-completion: it re-covers the pages the
      // crashed run already staged (idempotent) and everything it missed.
      if (recordIdsSeenAcrossAllWalks.size >= totalCountReportedByLatestResponse) {
        return;
      }
    }

    WSLogger.warn({
      source: 'IntercomApiClient',
      message:
        'Faithful page walk still short of total_count after all retries — failing the pull so no records are wrongly deleted (unstable /articles sort, DEV-11283)',
      endpointPath,
      uniqueRecordsSeen: recordIdsSeenAcrossAllWalks.size,
      totalCountReportedByLatestResponse,
      walkAttempts: MAX_PAGE_WALKS_PER_FAITHFUL_LISTING,
    });
    // Surfaced verbatim to the user via extractConnectorErrorDetails, so the
    // message explains the abort and that no data was harmed.
    throw new IntercomError(
      `Intercom returned an unstable record list for ${endpointPath}: after ${MAX_PAGE_WALKS_PER_FAITHFUL_LISTING} ` +
        `complete walks, only ${recordIdsSeenAcrossAllWalks.size} of the ${totalCountReportedByLatestResponse} records ` +
        `Intercom reports were seen. The pull was stopped before any records could be wrongly deleted; ` +
        `the next pull will retry with a different page layout.`,
    );
  }

  /**
   * List articles as a faithful, id-deduplicated snapshot (see
   * {@link listWithFaithfulPageWalk} for the pagination-instability defenses).
   * Yields batches of article records with a crash-resume checkpoint.
   */
  listArticles(
    pageSize = INTERCOM_MAX_PAGE_SIZE,
    startPage = 1,
  ): AsyncGenerator<IntercomPageBatch<IntercomArticle>, void> {
    return this.listWithFaithfulPageWalk<IntercomArticle>('/articles', pageSize, startPage);
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
   * List collections as a faithful, id-deduplicated snapshot (see
   * {@link listWithFaithfulPageWalk} for the pagination-instability defenses —
   * `/help_center/collections` has the same unstable `updated_at` DESC order
   * as `/articles`).
   * Yields batches of collection records with a crash-resume checkpoint.
   */
  listCollections(
    pageSize = INTERCOM_MAX_PAGE_SIZE,
    startPage = 1,
  ): AsyncGenerator<IntercomPageBatch<IntercomCollection>, void> {
    return this.listWithFaithfulPageWalk<IntercomCollection>('/help_center/collections', pageSize, startPage);
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
