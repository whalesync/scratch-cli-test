import axios, { AxiosError, AxiosInstance, RawAxiosRequestHeaders } from 'axios';
import { WSLogger } from 'src/logger';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { sleep } from 'src/util';
import { createApiClient } from '../../create-api-client';
import { IntercomUpdatedSinceQuery } from './intercom-incremental';
import {
  IntercomArticle,
  IntercomCollection,
  IntercomCompany,
  IntercomCompanyScrollPage,
  IntercomContact,
  IntercomConversation,
  IntercomConversationListItem,
  IntercomCreateArticleRequest,
  IntercomCreateCollectionRequest,
  IntercomCursorPaginatedResponse,
  IntercomDataAttribute,
  IntercomDataAttributeListResponse,
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
 * HTTP 5xx codes we treat as transient, retryable Intercom gateway/availability
 * failures: 502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout.
 *
 * A full conversations pull is one long sequential walk (one list call per page
 * plus one GET per conversation when hydrating), so without a retry a single
 * gateway blip fails the whole folder hours in and the next run starts over.
 *
 * We deliberately EXCLUDE 500 Internal Server Error. 502/503/504 mean the request
 * did not reach, or was not completed by, a healthy backend, so retrying is safe
 * even for the article/collection creates (POST). A 500 is ambiguous — the backend
 * may have persisted the write before erroring — so retrying a create risks a
 * DUPLICATE record. Same policy as Attio's `ATTIO_RETRYABLE_SERVER_ERROR_STATUSES`.
 */
const INTERCOM_RETRYABLE_SERVER_ERROR_STATUSES = new Set([502, 503, 504]);

/**
 * True when an error is a transient Intercom server-side failure worth retrying
 * (see {@link INTERCOM_RETRYABLE_SERVER_ERROR_STATUSES}). The retry predicate sees
 * the RAW AxiosError — callers wrap into `IntercomError` only OUTSIDE the retry —
 * so this checks `error.response.status` directly.
 */
export function isTransientIntercomServerError(error: unknown): boolean {
  return axios.isAxiosError(error) && INTERCOM_RETRYABLE_SERVER_ERROR_STATUSES.has(error.response?.status ?? 0);
}

/**
 * True when a READ (list, search, get) failed in a way worth retrying beyond throttling: a transient 5xx
 * ({@link isTransientIntercomServerError}), a `500`, or a network error that never got a response (connection reset,
 * timeout, DNS). {@link INTERCOM_RETRY_OPTS} leaves a `500` alone only because a retried create could duplicate a
 * record; a read changes nothing on Intercom, so retrying it carries no such risk. A cancelled request is not retried.
 */
export function isRetryableIntercomReadFailure(error: unknown): boolean {
  if (!axios.isAxiosError(error) || axios.isCancel(error)) return false;
  if (error.response === undefined) return true;
  return error.response.status === 500 || isTransientIntercomServerError(error);
}

/**
 * True when Intercom's failure to return ONE listed conversation in full (`GET /conversations/{id}`) is about that
 * conversation rather than the connection, so the walk keeps the conversation as listed and goes on (see
 * `paginateConversations`):
 *  - `403 Forbidden` (not throttle-coded): the same token just listed the conversation and hydrates the others (seen
 *    in prod: one 403 eight hours into a ~156k-conversation pull). Intercom documents that an app token only reaches
 *    the conversations its authorizing teammate's "Conversation access" allows, the likely cause.
 *    https://www.intercom.com/help/en/articles/4707721-limit-teammates-access-to-conversations
 *  - a 5xx that outlasted {@link INTERCOM_READ_RETRY_OPTS}: Intercom keeps failing on this one conversation while the
 *    walk around it succeeds. (In an outage the next page's list call fails too, and that still fails the walk.)
 * Anything else — a 401, throttling that outlasted the retries, a network error that outlasted them — is about the
 * connection, and still fails the walk.
 */
function isIntercomFailureToReturnOneConversationInFull(error: unknown): boolean {
  if (!axios.isAxiosError(error) || error.response === undefined || isIntercomRateLimitError(error)) return false;
  return error.response.status === 403 || error.response.status >= 500;
}

/** Intercom's own explanation from an `error.list` error body (`errors[0].message`, else its `code`), if any. */
function readIntercomErrorMessage(error: unknown): string | null {
  if (!axios.isAxiosError(error)) return null;
  const body = error.response?.data as { errors?: { code?: string; message?: string }[] } | undefined;
  const firstIntercomError = body?.errors?.[0];
  return firstIntercomError?.message ?? firstIntercomError?.code ?? null;
}

/**
 * Retry policy for every Intercom API call. Retries two DISTINCT failures:
 *  - Throttling ({@link isIntercomRateLimitError}): a 429 or a documented
 *    throttle code in the error body.
 *  - Transient gateway/availability errors ({@link isTransientIntercomServerError}):
 *    502/503/504 only — a 500 or any other 4xx still surfaces immediately.
 *
 * Intercom does not document a `Retry-After`, but it does return
 * `X-RateLimit-Reset` on every response. Note the unit trap: unlike Brevo's
 * relative `x-sib-ratelimit-reset`, Intercom's is an **absolute Unix timestamp
 * in seconds**, so the wait is `reset - now` — reading it as a duration would
 * sleep for decades. `Retry-After` is still read first if present, since Intercom
 * documents neither its presence nor its absence. The reset header describes the
 * rate-limit bucket, not gateway health, so it is only honored for throttling; a
 * transient 5xx without a `Retry-After` falls back to the exponential backoff.
 *
 * https://developers.intercom.com/docs/references/rest-api/errors/rate-limiting
 */
export const INTERCOM_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: (error) => isIntercomRateLimitError(error) || isTransientIntercomServerError(error),
  getRetryAfterS: (error) => {
    if (!axios.isAxiosError(error)) return undefined;
    const headers = error.response?.headers;

    const retryAfterHeader = headers?.['retry-after'] as string | number | undefined;
    const retryAfterSeconds = parseInt(String(retryAfterHeader ?? ''), 10);
    if (!isNaN(retryAfterSeconds) && retryAfterSeconds > 0) {
      return Math.min(retryAfterSeconds, INTERCOM_MAX_TRUSTED_RATE_LIMIT_RESET_S);
    }

    if (!isIntercomRateLimitError(error)) return undefined;

    const resetHeader = headers?.['x-ratelimit-reset'] as string | number | undefined;
    const resetAtUnixSeconds = parseInt(String(resetHeader ?? ''), 10);
    if (isNaN(resetAtUnixSeconds)) return undefined;
    const secondsUntilReset = Math.ceil(resetAtUnixSeconds - Date.now() / 1000);
    if (secondsUntilReset <= 0) return undefined;
    return Math.min(secondsUntilReset, INTERCOM_MAX_TRUSTED_RATE_LIMIT_RESET_S);
  },
};

/**
 * Retry policy for every Intercom READ: {@link INTERCOM_RETRY_OPTS} plus a `500` and network errors
 * ({@link isRetryableIntercomReadFailure}). A conversations pull is one long sequential walk — up to a day of one GET
 * per conversation — so a single transient failure must not throw the whole walk away, and a read can safely be
 * repeated. Writes keep {@link INTERCOM_RETRY_OPTS}.
 */
export const INTERCOM_READ_RETRY_OPTS: WithRetryOpts = {
  ...INTERCOM_RETRY_OPTS,
  isRateLimited: (error) => isIntercomRateLimitError(error) || isRetryableIntercomReadFailure(error),
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
 * Documented ceiling on `per_page` for the cursor-paginated conversation
 * endpoints (`GET /conversations` and `POST /conversations/search`).
 * Used when conversations are listed without per-conversation hydration, where
 * the list call IS the whole cost of a page — 150 per page is 7.5× fewer calls
 * than Intercom's default of 20.
 */
export const INTERCOM_MAX_CONVERSATIONS_PAGE_SIZE = 150;

/**
 * Conversations `per_page` when each listed conversation is then hydrated with
 * its own `GET /conversations/{id}`. The list call is a rounding error next to
 * those GETs, so a bigger page buys no speed — and the pull job checkpoints its
 * cursor once per page, so a small page keeps crash-resume re-work small (at most
 * 20 re-fetched conversations rather than 150).
 */
export const INTERCOM_CONVERSATIONS_PAGE_SIZE_WHEN_FETCHING_EACH_CONVERSATION = 20;

/**
 * Ceiling on `per_page` for `GET /contacts` and `POST /contacts/search`. Larger values are not
 * rejected — Intercom silently caps them at 150 (probed live) — so asking for more buys nothing.
 */
export const INTERCOM_MAX_CONTACTS_PAGE_SIZE = 150;

/**
 * The `POST /contacts/search` body that lists EVERY contact in creation order — not an
 * updated-since filter (the Contacts table has no incremental pull). `created_at > 0` matches every
 * contact, so Intercom's pre-2.17 rule that timestamp filters match by calendar day is irrelevant;
 * the ascending `created_at` sort is what makes the walk stable (see
 * {@link IntercomApiClient.listAllContactsInCreationOrder}).
 */
export function buildAllContactsInCreationOrderSearchBody(
  pageSize: number,
  startingAfter: string | undefined,
): Record<string, unknown> {
  return {
    query: { field: 'created_at', operator: '>', value: 0 },
    sort: { field: 'created_at', order: 'ascending' },
    pagination: { per_page: pageSize, ...(startingAfter ? { starting_after: startingAfter } : {}) },
  };
}

/**
 * Timing and limits for {@link IntercomApiClient.listAllCompaniesViaScroll}. Every field is optional;
 * the defaults are the production values (tests pass zero waits).
 */
export interface IntercomCompaniesScrollWalkOptions {
  /** Pause between attempts to start a scroll while another scroll holds the workspace's only slot. */
  waitBetweenScrollStartAttemptsMs?: number;
  /** Attempts to start a scroll before giving up on a slot another integration holds. */
  maxScrollStartAttempts?: number;
  /** Times a walk may start over after its scroll expires or fails mid-walk. */
  maxWalkRestarts?: number;
}

/**
 * Production scroll-walk limits. Intercom allows ONE open company scroll per WORKSPACE (any app,
 * any token): a finished scroll frees the slot at once, an abandoned one holds it for ~60 s after
 * its last use (probed live). 7 attempts 15 s apart wait out ~90 s — past one abandoned scroll —
 * before giving up.
 */
const DEFAULT_COMPANIES_SCROLL_WALK_OPTIONS: Required<IntercomCompaniesScrollWalkOptions> = {
  waitBetweenScrollStartAttemptsMs: 15_000,
  maxScrollStartAttempts: 7,
  maxWalkRestarts: 3,
};

/** Intercom's error codes from an `error.list` body, or [] when the error isn't an Intercom HTTP error. */
function intercomErrorCodesOf(error: unknown): string[] {
  if (!axios.isAxiosError(error)) return [];
  const body = error.response?.data as { errors?: { code?: string }[] } | undefined;
  return (body?.errors ?? []).flatMap((e) => (e.code ? [e.code] : []));
}

/** `400 scroll_exists` — another scroll already holds the workspace's only company-scroll slot. */
function isCompaniesScrollSlotTaken(error: unknown): error is AxiosError {
  return (
    axios.isAxiosError(error) && error.response?.status === 400 && intercomErrorCodesOf(error).includes('scroll_exists')
  );
}

/**
 * The open scroll is gone and the walk must start over: `404 scroll parameter not found` once a
 * scroll has been idle ~60 s (probed live), or the `500` Intercom's docs describe for a timed-out
 * scroll. A scroll cannot be resumed part-way.
 */
function isCompaniesScrollLost(error: unknown): boolean {
  return axios.isAxiosError(error) && (error.response?.status === 404 || error.response?.status === 500);
}

/**
 * The permission an Intercom app needs to list contacts, companies and their attribute definitions.
 * "Read one user and one company" is not enough for a listing.
 * https://developers.intercom.com/docs/build-an-integration/learn-more/authentication/oauth-scopes
 */
const INTERCOM_READ_AND_LIST_USERS_AND_COMPANIES_PERMISSION = 'Read and list users and companies';

/**
 * The error to throw for a failed contacts/attributes read. A 401/403 there almost always means the
 * token's Intercom app lacks {@link INTERCOM_READ_AND_LIST_USERS_AND_COMPANIES_PERMISSION}: the
 * connection test only calls `GET /me`, which any valid token passes, so without this the first
 * contacts pull fails with a bare "unauthorized" that doesn't say what to fix. Intercom's own message
 * is kept in the text so an invalid token still reads as one. Anything else is returned untouched.
 */
function intercomReadPermissionErrorOrOriginal(error: unknown, whatWasBeingRead: string): unknown {
  if (!axios.isAxiosError(error)) return error;
  const status = error.response?.status;
  if (status !== 401 && status !== 403) return error;
  const body = error.response?.data as { errors?: { message?: string }[] } | undefined;
  const intercomMessage = body?.errors?.find((e) => e.message)?.message;
  return new IntercomError(
    `Intercom refused to list ${whatWasBeingRead}${intercomMessage ? ` (${intercomMessage})` : ''}. ` +
      `Give the Intercom app behind this access token the "${INTERCOM_READ_AND_LIST_USERS_AND_COMPANIES_PERMISSION}" ` +
      `permission in the Intercom Developer Hub, then reconnect.`,
    status,
    error.response?.data,
  );
}

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
  /**
   * Conversations in `items` that Intercom listed but could not return in full
   * (a 403, or a 5xx that outlasted the retries), so each is in `items` as the
   * list endpoint returned it — without `conversation_parts` — instead of
   * hydrated. Always empty when not hydrating.
   */
  conversationsIntercomCouldNotReturnInFull: IntercomConversationFullFetchFailure[];
}

/**
 * A listed conversation whose `GET /conversations/{id}` Intercom answered with an error about that conversation
 * (see `isIntercomFailureToReturnOneConversationInFull`).
 */
export interface IntercomConversationFullFetchFailure {
  conversationId: string;
  /** The HTTP status Intercom answered with: `403`, or a 5xx that outlasted the retries. */
  httpStatus: number;
  /** Intercom's own explanation from the error's `error.list` body, when it sent one. */
  intercomErrorMessage: string | null;
}

/**
 * A page of contacts plus Intercom's opaque cursor for the next page (undefined on the last page).
 * Callers persist `nextCursor` for crash-resume, exactly like {@link IntercomConversationPage}.
 */
export interface IntercomContactPage {
  items: IntercomContact[];
  nextCursor: string | undefined;
}

/**
 * A page of companies from the scroll walk. There is no resume cursor: a scroll can't be resumed
 * part-way, so a crashed walk starts over.
 */
export interface IntercomCompanyPage {
  items: IntercomCompany[];
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
   * Execute a WRITE under the connector account's rate limiter, retrying if
   * Intercom throttles us or a gateway blips (see {@link INTERCOM_RETRY_OPTS}).
   */
  private async requestWithRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, INTERCOM_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, INTERCOM_RETRY_OPTS);
  }

  /**
   * Execute a READ under the connector account's rate limiter, also retrying a
   * `500` and network errors (see {@link INTERCOM_READ_RETRY_OPTS}).
   */
  private async requestReadWithRetryOnTransientFailures<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, INTERCOM_READ_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, INTERCOM_READ_RETRY_OPTS);
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
      await this.requestReadWithRetryOnTransientFailures(() => this.client.get('/me'));
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
        const response = await this.requestReadWithRetryOnTransientFailures(() =>
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
      const response = await this.requestReadWithRetryOnTransientFailures(() =>
        this.client.get<IntercomArticle>(`/articles/${id}`),
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
      const response = await this.requestReadWithRetryOnTransientFailures(() =>
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
   *
   * A hydration that fails for that one conversation (a 403, or a 5xx that
   * outlasted the retries — see {@link isIntercomFailureToReturnOneConversationInFull})
   * keeps the conversation as the list endpoint returned it and names it in the
   * page's `conversationsIntercomCouldNotReturnInFull`, rather than failing the
   * walk: one conversation must not fail a pull that runs for hours. A 404 still
   * drops the conversation — it was deleted between the list and the hydration.
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
          const conversationsInPage: (IntercomConversation | IntercomConversationListItem)[] = [];
          const conversationsIntercomCouldNotReturnInFull: IntercomConversationFullFetchFailure[] = [];
          for (const listedConversation of items) {
            let fullConversationOrNullIfDeleted: IntercomConversation | null;
            try {
              fullConversationOrNullIfDeleted = await this.getConversation(listedConversation.id);
            } catch (error) {
              if (!isIntercomFailureToReturnOneConversationInFull(error)) {
                throw error;
              }
              // Keep the listed copy (stored as Intercom returned it, just without conversation_parts) rather
              // than dropping it: a dropped conversation would read as deleted, and a full pull would then
              // remove it downstream even though it still exists in Intercom.
              conversationsInPage.push(listedConversation);
              conversationsIntercomCouldNotReturnInFull.push({
                conversationId: listedConversation.id,
                httpStatus: axios.isAxiosError(error) ? (error.response?.status ?? 0) : 0,
                intercomErrorMessage: readIntercomErrorMessage(error),
              });
              continue;
            }
            if (fullConversationOrNullIfDeleted) {
              conversationsInPage.push(fullConversationOrNullIfDeleted);
            }
          }
          if (conversationsInPage.length > 0) {
            yield { items: conversationsInPage, nextCursor, conversationsIntercomCouldNotReturnInFull };
          }
        } else {
          yield { items, nextCursor, conversationsIntercomCouldNotReturnInFull: [] };
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
        const response = await this.requestReadWithRetryOnTransientFailures(() =>
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
        const response = await this.requestReadWithRetryOnTransientFailures(() =>
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
      const response = await this.requestReadWithRetryOnTransientFailures(() =>
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

  // ---------------------------------------------------------------------------
  // Contacts (read-only)
  // ---------------------------------------------------------------------------

  /**
   * Every contact in the workspace, walked in creation order, deduplicated by id, and checked
   * against Intercom's own count before the walk is allowed to finish.
   *
   * Why `POST /contacts/search` and not `GET /contacts`: the list endpoint is ordered by
   * `last_seen_at` DESC (probed live: zero ordering inversions across 19k contacts), a key that
   * changes every time a contact is active. A not-yet-reached contact that becomes active mid-walk
   * jumps to the front of the list — behind Intercom's stateless cursor — and is never returned; a
   * full pull would then delete it from Scratch and any Live Export destination until the next run.
   * `created_at` never changes, so an existing contact cannot move, and a contact created mid-walk
   * lands at the tail where the walk still reaches it. Live, both walks returned the identical id
   * set at the same cost (DEV-12350). Search's few-minute indexing lag only delays NEW contacts,
   * which aren't in Scratch yet, so it cannot cause a delete.
   *
   * Completeness: a fresh walk (no `resumeAfter`) must see at least the smaller of the `total_count`
   * reported on its first and last pages. Contacts created mid-walk raise both the seen count and
   * the later total, and contacts deleted before the walk reaches them lower both, so the smaller
   * total needs no tolerance. A shortfall throws an {@link IntercomError}; the pull job runs
   * delete-detection only after the walk returns, so a short walk can never become a wrongful
   * delete. A resumed walk sees only the tail and can't be checked — and the job skips
   * delete-detection on resumed runs anyway.
   *
   * The seen-id set holds one id string per contact for the length of the walk (tens of MB for a
   * million contacts) — the price of the dedupe the completeness check depends on.
   */
  async *listAllContactsInCreationOrder(
    pageSize = INTERCOM_MAX_CONTACTS_PAGE_SIZE,
    resumeAfter?: string,
  ): AsyncGenerator<IntercomContactPage, void> {
    const contactIdsSeenThisWalk = new Set<string>();
    let totalCountReportedOnFirstPage: number | undefined;
    let totalCountReportedOnLatestPage = 0;
    let startingAfter = resumeAfter;

    do {
      const searchBody = buildAllContactsInCreationOrderSearchBody(pageSize, startingAfter);
      let page: IntercomPaginatedResponse<IntercomContact>;
      try {
        const response = await this.requestWithRateLimitRetry(() =>
          this.client.post<IntercomPaginatedResponse<IntercomContact>>('/contacts/search', searchBody),
        );
        page = response.data;
      } catch (error) {
        throw intercomReadPermissionErrorOrOriginal(error, 'contacts');
      }

      totalCountReportedOnFirstPage ??= page.total_count ?? 0;
      totalCountReportedOnLatestPage = page.total_count ?? 0;

      const contactsNotYetSeenThisWalk = (page.data ?? []).filter((contact) => !contactIdsSeenThisWalk.has(contact.id));
      for (const contact of contactsNotYetSeenThisWalk) {
        contactIdsSeenThisWalk.add(contact.id);
      }

      const nextCursor = page.pages?.next?.starting_after;
      if (contactsNotYetSeenThisWalk.length > 0) {
        yield { items: contactsNotYetSeenThisWalk, nextCursor };
      }
      startingAfter = nextCursor;
    } while (startingAfter);

    if (resumeAfter !== undefined) return;

    const minimumContactsTheWalkMustHaveSeen = Math.min(
      totalCountReportedOnFirstPage ?? 0,
      totalCountReportedOnLatestPage,
    );
    if (contactIdsSeenThisWalk.size >= minimumContactsTheWalkMustHaveSeen) return;

    WSLogger.warn({
      source: 'IntercomApiClient',
      message: 'Contacts walk saw fewer contacts than Intercom reports — failing the pull so none are wrongly deleted',
      uniqueContactsSeen: contactIdsSeenThisWalk.size,
      totalCountReportedOnFirstPage,
      totalCountReportedOnLatestPage,
    });
    // Surfaced verbatim to the user via extractConnectorErrorDetails.
    throw new IntercomError(
      `Intercom returned ${contactIdsSeenThisWalk.size} of the ${minimumContactsTheWalkMustHaveSeen} contacts it ` +
        `reports. The pull was stopped before any contacts could be wrongly deleted; the next pull will retry.`,
    );
  }

  /**
   * Get a single contact by ID — the same keys the search walk returns (probed live).
   * @returns The contact, or null if not found (deleted, or merged into another contact).
   */
  async getContact(id: string): Promise<IntercomContact | null> {
    try {
      const response = await this.requestWithRateLimitRetry(() => this.client.get<IntercomContact>(`/contacts/${id}`));
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw intercomReadPermissionErrorOrOriginal(error, 'contacts');
    }
  }

  // ---------------------------------------------------------------------------
  // Companies (read-only)
  // ---------------------------------------------------------------------------

  /**
   * Every company Intercom will list, walked with `GET /companies/scroll`, deduplicated by id.
   *
   * What "every" means: Intercom lists only companies with at least one contact (user or lead). The
   * scroll, `POST /companies/list` and `GET /companies` all return exactly that set, and no 2.11
   * endpoint enumerates the rest (probed live). The scroll is used because the paged list is
   * documented to stop at 10,000 companies.
   *
   * Scroll mechanics (probed live, where they differ from the docs):
   *  - 100 companies per page; the walk ends on the FIRST EMPTY page, whose `scroll_param` is never
   *    followed (it returns 404).
   *  - ONE open scroll per WORKSPACE — any app, any token: starting one while another is open
   *    returns `400 scroll_exists`. A finished scroll frees the slot at once; an abandoned one holds
   *    it ~60 s. So a taken slot is waited out (see {@link DEFAULT_COMPANIES_SCROLL_WALK_OPTIONS}),
   *    and the walk always runs to its empty page so it never leaves its own scroll holding the slot.
   *  - A scroll idle ~60 s expires (`404 scroll parameter not found`; the docs say `500`). A scroll
   *    can't be resumed, so the walk starts over — at most `maxWalkRestarts` times — re-yielding only
   *    companies not already yielded, and throws rather than ever returning part of a walk.
   *
   * Completeness: the scroll has no `total_count`. `POST /companies/list`'s `total_count` matches it
   * once Intercom's index settles, but lags, runs ahead and even moves backwards while the index
   * churns (probed live), so it can't gate deletes. It is read after the walk only to log a warning
   * when the scroll saw fewer companies. The scroll itself is a server-side snapshot, so concurrent
   * changes can't make it silently skip a company; its failure modes are explicit errors.
   */
  async *listAllCompaniesViaScroll(
    options: IntercomCompaniesScrollWalkOptions = {},
  ): AsyncGenerator<IntercomCompanyPage, void> {
    const walkOptions = { ...DEFAULT_COMPANIES_SCROLL_WALK_OPTIONS, ...options };
    const companyIdsYieldedThisWalk = new Set<string>();
    let walkRestartsUsed = 0;

    for (;;) {
      try {
        let page = await this.startCompaniesScroll(walkOptions);
        while (page.data.length > 0) {
          const companiesNotYetYielded = page.data.filter((company) => !companyIdsYieldedThisWalk.has(company.id));
          for (const company of companiesNotYetYielded) {
            companyIdsYieldedThisWalk.add(company.id);
          }
          if (companiesNotYetYielded.length > 0) {
            yield { items: companiesNotYetYielded };
          }
          const scrollParam = page.scroll_param;
          if (!scrollParam) {
            throw new IntercomError(
              'Intercom returned a page of companies without a scroll_param, so the rest of the list cannot be read. ' +
                'The pull was stopped before any companies could be wrongly deleted; the next pull will retry.',
            );
          }
          page = await this.fetchCompaniesScrollPage(scrollParam);
        }
        break;
      } catch (error) {
        if (isCompaniesScrollLost(error) && walkRestartsUsed < walkOptions.maxWalkRestarts) {
          walkRestartsUsed++;
          WSLogger.warn({
            source: 'IntercomApiClient',
            message: 'Companies scroll expired or failed mid-walk — starting the walk over',
            status: axios.isAxiosError(error) ? error.response?.status : undefined,
            walkRestartsUsed,
            companiesYieldedSoFar: companyIdsYieldedThisWalk.size,
          });
          continue;
        }
        if (isCompaniesScrollLost(error)) {
          throw new IntercomError(
            `Intercom's company scroll expired or failed ${walkRestartsUsed + 1} times in one pull. ` +
              'The pull was stopped before any companies could be wrongly deleted; the next pull will retry.',
            axios.isAxiosError(error) ? error.response?.status : undefined,
          );
        }
        throw intercomReadPermissionErrorOrOriginal(error, 'companies');
      }
    }

    await this.warnIfCompaniesListReportsMoreThanTheScrollSaw(companyIdsYieldedThisWalk.size);
  }

  /**
   * Start a company scroll, waiting out a slot another scroll holds (`400 scroll_exists`). Gives up
   * with an explanatory error once `maxScrollStartAttempts` is spent.
   */
  private async startCompaniesScroll(
    walkOptions: Required<IntercomCompaniesScrollWalkOptions>,
  ): Promise<IntercomCompanyScrollPage> {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await this.requestWithRateLimitRetry(() =>
          this.client.get<IntercomCompanyScrollPage>('/companies/scroll'),
        );
        return response.data;
      } catch (error) {
        if (!isCompaniesScrollSlotTaken(error)) throw error;
        if (attempt >= walkOptions.maxScrollStartAttempts) {
          throw new IntercomError(
            'Another integration is reading companies from this Intercom workspace — Intercom allows only one ' +
              'company scroll per workspace at a time. The pull was stopped before any companies could be wrongly ' +
              'deleted; try again in a few minutes.',
            409,
            error.response?.data,
          );
        }
        await sleep(walkOptions.waitBetweenScrollStartAttemptsMs);
      }
    }
  }

  private async fetchCompaniesScrollPage(scrollParam: string): Promise<IntercomCompanyScrollPage> {
    const response = await this.requestWithRateLimitRetry(() =>
      this.client.get<IntercomCompanyScrollPage>('/companies/scroll', { params: { scroll_param: scrollParam } }),
    );
    return response.data;
  }

  /**
   * Observability only (see {@link listAllCompaniesViaScroll}): warn when `POST /companies/list`
   * reports more companies than the scroll returned. Never fails the pull — the list total is too
   * noisy while Intercom's index churns — and logs only the HTTP status if the read itself fails.
   */
  private async warnIfCompaniesListReportsMoreThanTheScrollSaw(uniqueCompaniesSeen: number): Promise<void> {
    try {
      const response = await this.requestWithRateLimitRetry(() =>
        this.client.post<IntercomPaginatedResponse<IntercomCompany>>('/companies/list', { per_page: 1 }),
      );
      const companiesListTotal = response.data.total_count;
      if (typeof companiesListTotal === 'number' && uniqueCompaniesSeen < companiesListTotal) {
        WSLogger.warn({
          source: 'IntercomApiClient',
          message:
            'Companies scroll returned fewer companies than POST /companies/list reports (expected briefly while Intercom re-indexes)',
          uniqueCompaniesSeen,
          companiesListTotal,
        });
      }
    } catch (error) {
      WSLogger.warn({
        source: 'IntercomApiClient',
        message: 'Could not read the companies list total to cross-check the scroll',
        status: axios.isAxiosError(error) ? error.response?.status : undefined,
      });
    }
  }

  /**
   * Get a single company by Intercom ID — the same keys the scroll returns (probed live). Unlike the
   * scroll, this also returns a company that has no contacts.
   * @returns The company, or null if not found.
   */
  async getCompany(id: string): Promise<IntercomCompany | null> {
    try {
      const response = await this.requestWithRateLimitRetry(() => this.client.get<IntercomCompany>(`/companies/${id}`));
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw intercomReadPermissionErrorOrOriginal(error, 'companies');
    }
  }

  /**
   * The attribute definitions for a model — the source of a contact's or company's
   * `custom_attributes` schema. Not paginated; archived attributes are excluded by default.
   */
  async listDataAttributes(model: 'contact' | 'company'): Promise<IntercomDataAttribute[]> {
    try {
      const response = await this.requestWithRateLimitRetry(() =>
        this.client.get<IntercomDataAttributeListResponse>('/data_attributes', { params: { model } }),
      );
      return response.data.data ?? [];
    } catch (error) {
      throw intercomReadPermissionErrorOrOriginal(error, `${model} attributes`);
    }
  }
}
