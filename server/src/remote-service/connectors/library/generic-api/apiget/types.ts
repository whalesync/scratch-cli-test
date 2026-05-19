/**
 * apiget — TypeScript port of the Go apiget CLI's pagination / enrich / expand
 * primitives. Lives inline in the GENERIC_API connector folder; no separate
 * package. See ~/.gstack/projects/whalesync-spinner/ijd-apiget-impl-plan-*.md
 * (or projects/2026-05-18-generic-connector/impl-plan.md in the internal repo)
 * for design context.
 *
 * Field names mirror the Go source 1:1 so persisted Strategy JSON cross-loads
 * between the Go CLI and this TS port.
 */

/** One HTTP header to send with every request. */
export interface Header {
  name: string;
  value: string;
  description?: string;
}

/**
 * Pagination Strategy detected from a response (or supplied as an override).
 * Mirrors `pagination.Strategy` in apiget/pagination/pagination.go.
 *
 * - `cursor` — opaque token returned in a response field; appended as a query
 *   param on subsequent requests. Common shape.
 * - `offset` — numeric offset + limit query params; uses total-count metadata
 *   in the response to know when to stop.
 * - `graphql` — Relay-style cursor under `pageInfo.endCursor`; halts when
 *   `pageInfo.hasNextPage === false`. `cursorPath` for this type is
 *   `data.<queryName>.pageInfo.endCursor`; `dataPath` is
 *   `data.<queryName>.nodes` (or `edges` / first array field).
 * - `link-header` — RFC 5988 `Link: <url>; rel="next"` response header. NEW in
 *   the TS port; not detected by the Go original. The "next URL" is read off
 *   the previous response's `Link` header rather than constructed.
 */
export interface Strategy {
  type: 'cursor' | 'offset' | 'graphql' | 'link-header';
  cursorPath?: string;
  dataPath?: string;
  cursorParam?: string;
  offsetParam?: string;
  limitParam?: string;
  limit?: number;
}

/**
 * Per-pull resume state checkpointed between pages. The connector persists
 * one of these to Redis after each successful page so a killed pull resumes
 * from the right cursor / offset / linkUrl rather than restarting.
 */
export interface ApigetProgress {
  /** For type=cursor or type=graphql */
  cursor?: string;
  /** For type=offset (numeric offset that increments by Strategy.limit) */
  offset?: number;
  /** For type=link-header: the full URL of the page we're about to fetch */
  linkUrl?: string;
  /** Monotonically increasing page index, starting at 1 for page 1 */
  pageIndex: number;
}

/**
 * Configuration for recursively expanding nested content (Notion blocks,
 * Shopify product variants, anywhere the list response is shallow and the
 * full record requires a per-ID fetch with its own pagination).
 *
 * Mirrors `expander.Config` in apiget/expander/expander.go.
 */
export interface ExpanderConfig {
  enabled: boolean;
  /** 0 = unlimited; recommended 2-5 to bound runaway nesting */
  maxDepth: number;
  /** Field name on a record that signals "this has nested content" (e.g. `has_children`) */
  hasNestedField: string;
  /** Optional expected value; if unset, presence of the field is enough */
  hasNestedValue?: unknown;
  /** Field name to insert expanded children under (e.g. `children`) */
  childrenField: string;
  /** URL pattern with `{fieldName}` placeholders (e.g. `/v1/blocks/{id}/children`) */
  childrenURLPattern: string;
  /** Scheme + host the pattern is joined against */
  baseURL: string;
}

/** Enrichment: fetch the full record for each list item via a per-ID URL. */
export interface EnrichConfig {
  enabled: boolean;
  /** Optional URL pattern with `{id}` placeholder. If unset, apiget infers
   *  `<list URL with query stripped>/<id>`. */
  urlPattern?: string;
}

/** Inputs to `apiget(...)` and `apigetStream(...)`. */
export interface ApigetSettings {
  url: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  headers: Header[];
  /** Omit to auto-detect from the first response. */
  pagination?: Strategy;
  enrich?: EnrichConfig;
  expand?: ExpanderConfig;
  /** Default 1000 — runaway protection, not a usage cap. */
  maxPages?: number;
}

/** What `apiget(...)` returns when used in eager (collect-all) mode. */
export interface ApigetResult {
  records: unknown[];
  detected: {
    pagination: Strategy | null;
    idField: string | null;
  };
  pages: number;
}

/** One page yielded by `apigetStream(...)`. */
export interface ApigetStreamYield {
  records: unknown[];
  /** Monotonic, starts at 1. */
  pageIndex: number;
  /** Resume state for cursor / graphql types */
  cursor?: string;
  /** Resume state for offset type */
  offset?: number;
  /** Resume state for link-header type */
  linkUrl?: string;
  /** Populated only on page 1, undefined thereafter. */
  detected?: {
    pagination: Strategy | null;
    idField: string | null;
  };
}

/** HTTP function signature. Injectable so callers can wire their own
 *  fetch-shaped function (axios via createApiClient, mocked fetch in tests, etc). */
export type FetchFn = (request: FetchRequest) => Promise<FetchResponse>;

export interface FetchRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface FetchResponse {
  status: number;
  /** Lowercase header names. */
  headers: Record<string, string>;
  /** Raw response body as a string (NOT JSON-parsed). */
  body: string;
}

/** Optional knobs for the apiget / apigetStream calls. */
export interface ApigetOpts {
  fetch?: FetchFn;
  signal?: AbortSignal;
}

/** Error class for pagination loops (cursor didn't advance between pages). */
export class PaginationLoopError extends Error {
  constructor(cursor: string) {
    super(
      `Pagination loop detected — cursor "${cursor}" was returned twice in a row. ` +
        `Your cursor path or pagination override may be wrong.`,
    );
    this.name = 'PaginationLoopError';
  }
}

/** Error class for the maxPages backstop. */
export class MaxPagesReachedError extends Error {
  constructor(maxPages: number) {
    super(
      `Hit the ${maxPages}-page maxPages backstop. If your endpoint legitimately ` +
        `has more pages, raise maxPages in advanced settings.`,
    );
    this.name = 'MaxPagesReachedError';
  }
}

/** Error class for non-JSON responses where JSON was expected. */
export class NonJsonResponseError extends Error {
  constructor(public readonly contentType: string | undefined) {
    super(`Expected JSON; got ${contentType ?? '(no content-type)'}.`);
    this.name = 'NonJsonResponseError';
  }
}

/**
 * Error class for non-2xx HTTP responses. Carries the status, response body
 * (trimmed), and content-type so callers can surface a useful message instead
 * of treating the error body as data.
 */
export class HttpStatusError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly contentType: string | undefined,
  ) {
    const trimmedBody = body.length > 500 ? body.slice(0, 500) + '…' : body;
    super(`HTTP ${status} from upstream API. Response body: ${trimmedBody}`);
    this.name = 'HttpStatusError';
  }
}
