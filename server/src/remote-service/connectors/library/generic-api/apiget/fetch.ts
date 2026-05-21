/**
 * apiget runner — the HTTP loop that walks pages.
 *
 * Two public functions:
 *   - apigetStream(settings, opts?) — AsyncGenerator yielding one page at a
 *     time. Use this for pulls so the caller can checkpoint between pages.
 *   - apiget(settings, opts?) — eager collect-all wrapper. Use for probe-time
 *     small reads where we want everything in memory.
 *
 * NEW in the TS port (not in Go):
 *   - Cursor-equality cycle detection: if a server bug or a wrong cursorPath
 *     would cause an infinite "same page forever" loop, halt with
 *     PaginationLoopError after page 2's cursor matches page 1's.
 *   - maxPages backstop (default 1000): runaway-protection, NOT a usage cap.
 *   - Link-header pagination (RFC 5988): the next URL comes from the previous
 *     response's `Link: <...>; rel="next"` header, not from a cursor field.
 *   - withRetry on 429 with `Retry-After`: matches the existing connector
 *     pattern (Audienceful, Intercom — see their *-api-client.ts).
 */

import { enrichRecords, findIdField } from './enrich';
import { expandNested } from './expander';
import { isRecord } from './internal-helpers';
import {
  buildNextURL,
  detectStrategyFromResponse,
  extractData,
  extractNextCursor,
  hasMorePages,
  parseNextLink,
} from './pagination';
import { ssrfSafeFetch } from './ssrf-fetch';
import {
  ApigetOpts,
  ApigetResult,
  ApigetSettings,
  ApigetStreamYield,
  FetchFn,
  FetchRequest,
  FetchResponse,
  HttpStatusError,
  MaxPagesReachedError,
  NonJsonResponseError,
  PaginationLoopError,
  Strategy,
} from './types';

const DEFAULT_MAX_PAGES = 1000;

// =============================================================================
// Public surface
// =============================================================================

/**
 * Stream apiget records page-by-page. The caller iterates with `for await ...`
 * and persists `connectorProgress` between yields so a killed pull can resume
 * from the right cursor / offset / linkUrl on retry.
 *
 * Yields one `ApigetStreamYield` per page. `detected` is populated only on
 * page 1 (the auto-detection happens once); subsequent pages carry only
 * `records + pageIndex + resume-state`.
 */
export async function* apigetStream(
  settings: ApigetSettings,
  opts: ApigetOpts = {},
): AsyncGenerator<ApigetStreamYield> {
  const fetchFn = opts.fetch ?? defaultFetch;
  const signal = opts.signal;
  const maxPages = settings.maxPages ?? DEFAULT_MAX_PAGES;

  // ── Page 1 ─────────────────────────────────────────────────────────────
  // When pagination strategy is pre-supplied (via overrides), apply its
  // offset/limit params to the page 1 URL too — same way they get applied to
  // page 2+ via buildNextURL. This keeps the fixture URL clean (just base
  // path + service-specific filters) and avoids the page-1-vs-page-2 size
  // mismatch when overrides.request.maxPageSize doesn't equal whatever
  // `?limit=...` happened to be in the URL.
  //
  // Auto-detection case (settings.pagination unset) stays unchanged: page 1
  // uses the URL as-is, strategy is detected from the response, page 2+
  // applies the detected params.
  const page1Settings = settings.pagination
    ? { ...settings, url: augmentUrlForPage1(settings.url, settings.pagination) }
    : settings;
  const page1Response = await sendRequest(fetchFn, buildPage1Request(page1Settings), signal);
  const strategy: Strategy | null =
    settings.pagination ?? detectStrategyFromResponse({ ...page1Response, url: settings.url });

  let records = await postprocessRecords(extractData(page1Response.body, strategy), settings, fetchFn, signal);

  // First-page-only detection signal
  const idField = records.length > 0 && isRecord(records[0]) ? findIdField(records[0])[0] : null;

  // Resume-state for page 1
  let currentCursor: string | undefined;
  let currentOffset: number | undefined;
  let currentLinkUrl: string | undefined;
  if (strategy) {
    if (strategy.type === 'cursor' || strategy.type === 'graphql') {
      currentCursor = extractNextCursor(page1Response.body, strategy) || undefined;
    } else if (strategy.type === 'offset') {
      currentOffset = 0; // page 1 is offset=0
    } else if (strategy.type === 'link-header') {
      const next = parseNextLink(page1Response.headers['link'] ?? '');
      currentLinkUrl = next ?? undefined;
    }
  }

  yield {
    records,
    pageIndex: 1,
    cursor: currentCursor,
    offset: currentOffset,
    linkUrl: currentLinkUrl,
    detected: { pagination: strategy, idField },
  };

  if (!strategy) return; // single-page response

  // ── Pages 2..N ─────────────────────────────────────────────────────────
  let previousCursor = currentCursor;
  let pageIndex = 1;

  while (true) {
    pageIndex++;
    if (pageIndex > maxPages) throw new MaxPagesReachedError(maxPages);

    // Figure out the request for the next page
    let nextRequest: FetchRequest;
    if (strategy.type === 'link-header') {
      if (!currentLinkUrl) return; // no more pages
      nextRequest = { ...buildPage1Request(settings), url: currentLinkUrl };
    } else if (strategy.type === 'cursor') {
      if (!currentCursor) return;
      const nextURL = buildNextURL(settings.url, currentCursor, strategy);
      if (nextURL === '') return;
      nextRequest = { ...buildPage1Request(settings), url: nextURL };
    } else if (strategy.type === 'graphql') {
      // GraphQL injects the cursor into the POST body's variables, not the URL.
      // Reuse the original URL; mutate the body.
      if (!currentCursor) return;
      nextRequest = buildGraphqlPageRequest(settings, strategy.cursorParam ?? 'after', currentCursor);
    } else if (strategy.type === 'offset') {
      currentOffset = (currentOffset ?? 0) + (strategy.limit ?? 0);
      // hasMorePages was already checked at the bottom of the loop; if the
      // previous page said "more available", we keep going.
      const nextURL = buildNextURL(settings.url, String(currentOffset), strategy);
      if (nextURL === '') return;
      nextRequest = { ...buildPage1Request(settings), url: nextURL };
    } else {
      return;
    }

    const pageResponse = await sendRequest(fetchFn, nextRequest, signal);
    records = await postprocessRecords(extractData(pageResponse.body, strategy), settings, fetchFn, signal);

    // Resume-state + cycle detection
    if (strategy.type === 'cursor' || strategy.type === 'graphql') {
      currentCursor = extractNextCursor(pageResponse.body, strategy) || undefined;
      if (currentCursor && currentCursor === previousCursor) {
        throw new PaginationLoopError(currentCursor);
      }
      previousCursor = currentCursor;
    } else if (strategy.type === 'link-header') {
      const next = parseNextLink(pageResponse.headers['link'] ?? '');
      if (next && next === currentLinkUrl) {
        throw new PaginationLoopError(next);
      }
      currentLinkUrl = next ?? undefined;
    }

    yield {
      records,
      pageIndex,
      cursor: currentCursor,
      offset: currentOffset,
      linkUrl: currentLinkUrl,
    };

    // Termination check
    if (strategy.type === 'cursor' || strategy.type === 'graphql') {
      if (!currentCursor) return;
    } else if (strategy.type === 'offset') {
      if (!hasMorePages(pageResponse.body, strategy, currentOffset ?? 0)) return;
    } else if (strategy.type === 'link-header') {
      if (!currentLinkUrl) return;
    }
  }
}

/**
 * Eager collect-all wrapper. Drains apigetStream into memory and returns
 * everything. Don't use this for pulls; use apigetStream so the caller can
 * checkpoint per page.
 */
export async function apiget(settings: ApigetSettings, opts: ApigetOpts = {}): Promise<ApigetResult> {
  const allRecords: unknown[] = [];
  let detected: { pagination: Strategy | null; idField: string | null } = {
    pagination: null,
    idField: null,
  };
  let pages = 0;

  for await (const page of apigetStream(settings, opts)) {
    allRecords.push(...page.records);
    pages = page.pageIndex;
    if (page.detected) detected = page.detected;
  }

  return { records: allRecords, detected, pages };
}

// =============================================================================
// Request building
// =============================================================================

function buildPage1Request(settings: ApigetSettings): FetchRequest {
  const headers: Record<string, string> = {};
  for (const h of settings.headers) {
    headers[h.name] = h.value;
  }
  // Sensible defaults — the user's headers win if they set them explicitly.
  if (!hasHeaderIgnoreCase(headers, 'accept')) headers['Accept'] = 'application/json';
  if (settings.method === 'POST' && settings.body !== undefined) {
    if (!hasHeaderIgnoreCase(headers, 'content-type')) headers['Content-Type'] = 'application/json';
  }

  return {
    url: settings.url,
    method: settings.method ?? 'GET',
    headers,
    body: settings.body === undefined ? undefined : JSON.stringify(settings.body),
  };
}

function hasHeaderIgnoreCase(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

/**
 * Add pagination query params (offset + limit) to the page 1 URL when the
 * strategy is offset, or just `limit` when it's cursor and a value is set.
 * Preserves any other query params the user put in the URL (filters, sort,
 * etc.). Called only when settings.pagination is pre-supplied; auto-detected
 * strategies still use the URL as-is on page 1 (no strategy to apply yet).
 */
function augmentUrlForPage1(url: string, strategy: Strategy): string {
  if (strategy.type !== 'offset' && strategy.type !== 'cursor') return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url; // unparseable — leave as-is
  }
  if (strategy.type === 'offset') {
    u.searchParams.set(strategy.offsetParam ?? 'offset', '0');
  }
  if (strategy.limit !== undefined && strategy.limit > 0) {
    u.searchParams.set(strategy.limitParam ?? 'limit', String(strategy.limit));
  }
  return u.toString();
}

/**
 * Build the request for page N (N >= 2) of a GraphQL pagination flow. The
 * cursor goes into the POST body's `variables[cursorParam]`, not the URL.
 *
 * The Go original handles this via string-level body mutation; we do it
 * structurally (parse → mutate → re-stringify), which is robust to whitespace
 * differences in the user-supplied query.
 */
function buildGraphqlPageRequest(settings: ApigetSettings, cursorParam: string, cursor: string): FetchRequest {
  const base = buildPage1Request(settings);
  // Parse the body (if it's JSON) and inject variables[cursorParam] = cursor.
  let bodyObj: Record<string, unknown> = {};
  if (typeof base.body === 'string' && base.body !== '') {
    try {
      const parsed: unknown = JSON.parse(base.body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        bodyObj = parsed as Record<string, unknown>;
      }
    } catch {
      // Non-JSON body for a GraphQL request shouldn't happen; fall through to
      // an empty body and let the upstream reject if it's truly malformed.
    }
  }
  const existingVars = bodyObj['variables'];
  const variables: Record<string, unknown> =
    existingVars && typeof existingVars === 'object' && !Array.isArray(existingVars)
      ? { ...(existingVars as Record<string, unknown>) }
      : {};
  variables[cursorParam] = cursor;
  bodyObj = { ...bodyObj, variables };
  return { ...base, body: JSON.stringify(bodyObj) };
}

// =============================================================================
// Per-page postprocessing (enrich + expand)
// =============================================================================

async function postprocessRecords(
  records: unknown[],
  settings: ApigetSettings,
  fetchFn: FetchFn,
  signal: AbortSignal | undefined,
): Promise<unknown[]> {
  // Enrich: replace each shallow record with the full detail-endpoint record
  if (settings.enrich?.enabled) {
    const enrichFetch: FetchFn = (req) => fetchFn({ ...req, signal });
    await enrichRecords(records, settings.url, enrichFetch);
  }
  // Expand: recursively inline nested children
  if (settings.expand?.enabled) {
    const expandFetch: FetchFn = (req) => fetchFn({ ...req, signal });
    await expandNested(records, settings.expand, expandFetch);
  }
  return records;
}

// =============================================================================
// Default HTTP transport + 429 retry
// =============================================================================

/**
 * Default fetch transport — routes through the SSRF-safe transport in
 * `ssrf-fetch.ts` which performs HTTPS-only + DNS + private-IP + redirect
 * + body-cap checks. The caller can inject a different `FetchFn` via
 * `opts.fetch` to bypass this (e.g. tests, or a connector that wraps the
 * safe transport with rate-limiting / retry).
 */
const defaultFetch: FetchFn = ssrfSafeFetch;

/**
 * Send a request with one retry on 429 (honoring `Retry-After`). This is the
 * ONLY retry inside apiget — every other error propagates to the caller for
 * the pull scheduler to handle on its normal cadence, matching the pattern
 * other Scratch connectors use.
 *
 * Also validates that successful responses are JSON — non-JSON gets a clear
 * NonJsonResponseError ("Expected JSON; got <content-type>").
 */
async function sendRequest(
  fetchFn: FetchFn,
  request: FetchRequest,
  signal: AbortSignal | undefined,
): Promise<FetchResponse> {
  const req = signal ? { ...request, signal } : request;

  let response = await fetchFn(req);
  if (response.status === 429) {
    const retryAfter = parseRetryAfter(response.headers['retry-after']);
    if (retryAfter !== null && retryAfter >= 0) {
      if (retryAfter > 0) await sleep(retryAfter * 1000, signal);
      response = await fetchFn(req);
    }
  }

  if (response.status < 200 || response.status >= 300) {
    throw new HttpStatusError(response.status, response.body, response.headers['content-type']);
  }
  const contentType = response.headers['content-type'];
  if (contentType && !contentType.includes('json')) {
    throw new NonJsonResponseError(contentType);
  }
  return response;
}

function parseRetryAfter(headerValue: string | undefined): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  // 0 is valid — means "retry immediately, no delay". Negative is invalid.
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  // HTTP-date form is also valid per the spec; not handled here. The Go
  // original also only handles numeric seconds.
  return null;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Aborted'));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
