import type {
  AppendBlockChildrenParameters,
  AppendBlockChildrenResponse,
  CreatePageParameters,
  CreatePageResponse,
  DeleteBlockParameters,
  DeleteBlockResponse,
  GetBlockParameters,
  GetBlockResponse,
  GetDatabaseParameters,
  GetDatabaseResponse,
  GetDataSourceParameters,
  GetDataSourceResponse,
  GetPageParameters,
  GetPageResponse,
  ListBlockChildrenParameters,
  ListBlockChildrenResponse,
  QueryDataSourceParameters,
  QueryDataSourceResponse,
  SearchParameters,
  SearchResponse,
  UpdateBlockParameters,
  UpdateBlockResponse,
  UpdatePageParameters,
  UpdatePageResponse,
} from '@notionhq/client';
import { AxiosInstance, isAxiosError } from 'axios';
import { RateLimiter, withRetry as standaloneWithRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import { createApiClient } from '../../create-api-client';

const BASE_URL = 'https://api.notion.com/v1';

/**
 * Per-request timeout, matching the v5 SDK's `DEFAULT_TIMEOUT_MS` (60s). Applied
 * per attempt (axios creates a fresh request on each retry), so it mirrors the
 * SDK, which wrapped each individual request in this timeout rather than the
 * whole retry loop. An exceeded timeout surfaces as axios `ECONNABORTED`, which
 * {@link translateNotionAxiosError} maps to {@link NotionRequestTimeoutError}.
 */
const NOTION_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Notion API version this client targets by default. Matches the v5 SDK's
 * `Client.defaultNotionVersion` but is pinned here so the next 2026-03-11
 * adoption (Phase 5 of DEV-8910) is an explicit code change rather than a
 * silent ride-along on a future dependency bump. Callers may override it
 * through the constructor.
 */
export const DEFAULT_NOTION_API_VERSION = '2025-09-03';

/**
 * Notion API error `code` strings — the `code` field of a Notion error
 * response body. Mirrors the v5 SDK's `APIErrorCode` enum values exactly so
 * connector error classification can branch on them without the SDK runtime.
 */
export const NotionApiErrorCode = {
  Unauthorized: 'unauthorized',
  RestrictedResource: 'restricted_resource',
  ObjectNotFound: 'object_not_found',
  RateLimited: 'rate_limited',
  InvalidJSON: 'invalid_json',
  InvalidRequestURL: 'invalid_request_url',
  InvalidRequest: 'invalid_request',
  ValidationError: 'validation_error',
  ConflictError: 'conflict_error',
  InternalServerError: 'internal_server_error',
  ServiceUnavailable: 'service_unavailable',
  GatewayTimeout: 'gateway_timeout',
} as const;
export type NotionApiErrorCodeValue = (typeof NotionApiErrorCode)[keyof typeof NotionApiErrorCode];

const RECOGNIZED_NOTION_API_ERROR_CODES = new Set<string>(Object.values(NotionApiErrorCode));

/**
 * Sentinel `code` used when Notion responds with a non-2xx status whose body is
 * NOT a recognizable Notion error envelope (e.g. an HTML gateway page). Mirrors
 * the v5 SDK's `ClientErrorCode.ResponseError` so {@link isNotionApiResponseError}
 * can keep these out of the connector's API-error branch (they fall back, just
 * as the SDK's `UnknownHTTPResponseError` did).
 */
const NOTION_UNKNOWN_RESPONSE_ERROR_CODE = 'notionhq_client_response_error';

/**
 * Error thrown for any non-2xx HTTP response from the Notion API. Replaces the
 * v5 SDK's `APIResponseError` / `UnknownHTTPResponseError`. `code` is the
 * Notion error code parsed from the response body when present and recognized,
 * otherwise {@link NOTION_UNKNOWN_RESPONSE_ERROR_CODE}. Exposes `status` /
 * `headers` / `body` so callers can read the HTTP status, the `retry-after`
 * header, and the raw error envelope.
 */
export class NotionError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly headers?: unknown;
  readonly body?: unknown;

  constructor(args: { code: string; message: string; status?: number; headers?: unknown; body?: unknown }) {
    super(args.message);
    this.name = 'NotionError';
    this.code = args.code;
    this.status = args.status;
    this.headers = args.headers;
    this.body = args.body;
  }
}

/**
 * Error thrown when a Notion request times out at the socket level. Replaces
 * the v5 SDK's `RequestTimeoutError` so the connector's timeout branch keeps
 * working. (This client sets no explicit request timeout — matching the house
 * api-client pattern — so this only surfaces an underlying socket timeout.)
 */
export class NotionRequestTimeoutError extends Error {
  constructor(message = 'Request to Notion API has timed out') {
    super(message);
    this.name = 'NotionRequestTimeoutError';
  }
}

/**
 * `true` when `error` is a {@link NotionError} carrying a recognized Notion API
 * error code. Mirrors the v5 SDK's `APIResponseError.isAPIResponseError`: an
 * unrecognized HTTP error body (the SDK's `UnknownHTTPResponseError`) is
 * deliberately excluded so it falls through to generic error handling.
 */
export function isNotionApiResponseError(error: unknown): error is NotionError {
  return error instanceof NotionError && RECOGNIZED_NOTION_API_ERROR_CODES.has(error.code);
}

/**
 * Retry options for Notion API calls — detect HTTP 429 / `rate_limited` and
 * honour the `retry-after` header. Lives here (not on the connector) so
 * retry/backoff is owned by the HTTP layer, matching the house api-client
 * pattern. 429-only by design (NOT the SDK's 408/409/5xx transport retry):
 * acceptable because every Notion job is idempotent and resumable.
 */
const NOTION_RETRY_OPTS: WithRetryOpts = {
  isRateLimited: (error) =>
    error instanceof NotionError && (error.code === NotionApiErrorCode.RateLimited || error.status === 429),
  getRetryAfterS: (error) => {
    if (!(error instanceof NotionError)) return undefined;
    const seconds = parseRetryAfterSeconds(error.headers);
    return seconds !== undefined && seconds > 0 ? seconds : undefined;
  },
};

/** Read a `retry-after` header (seconds) off an axios response-headers object. */
function parseRetryAfterSeconds(headers: unknown): number | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const record = headers as Record<string, unknown>;
  const raw = record['retry-after'] ?? record['Retry-After'];
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  const seconds = parseInt(String(raw), 10);
  return Number.isNaN(seconds) ? undefined : seconds;
}

/** Parse a Notion error envelope `{ code, message }` out of a response body. */
function parseNotionApiErrorBody(body: unknown): { code: string; message: string } | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  const code = record['code'];
  const message = record['message'];
  if (typeof code === 'string' && typeof message === 'string' && RECOGNIZED_NOTION_API_ERROR_CODES.has(code)) {
    return { code, message };
  }
  return undefined;
}

/**
 * Convert an axios failure into the connector-facing error model: socket
 * timeouts → {@link NotionRequestTimeoutError}, HTTP error responses →
 * {@link NotionError} (recognized Notion code, or the unknown-response
 * sentinel). Non-axios / no-response (network) errors propagate unchanged,
 * matching the v5 SDK (which let non-`NotionClientError`s through).
 */
function translateNotionAxiosError(error: unknown): unknown {
  if (!isAxiosError(error)) return error;
  if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
    return new NotionRequestTimeoutError(error.message);
  }
  const response = error.response;
  if (!response) return error;
  const body: unknown = response.data;
  const apiError = parseNotionApiErrorBody(body);
  if (apiError) {
    return new NotionError({
      code: apiError.code,
      message: apiError.message,
      status: response.status,
      headers: response.headers,
      body,
    });
  }
  return new NotionError({
    code: NOTION_UNKNOWN_RESPONSE_ERROR_CODE,
    message: `Request to Notion API failed with status: ${response.status}`,
    status: response.status,
    headers: response.headers,
    body,
  });
}

/**
 * Pick a subset of keys off an args object (keeping `undefined` values for
 * present keys), reproducing the v5 SDK's `pick(args, queryParams|bodyParams)`.
 * `JSON.stringify` / axios then drop the `undefined`-valued keys on the wire,
 * so the request is byte-identical to the one the SDK built.
 */
function pickParams(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    result[key] = source[key];
  }
  return result;
}

type NotionHttpMethod = 'get' | 'post' | 'patch' | 'delete';

/**
 * Endpoint contract copied verbatim from the v5 SDK's generated
 * `api-endpoints/*` files (`method`, `queryParams`, `bodyParams`, `path`). The
 * `bodyParams`/`queryParams` lists are what make the request byte-identical:
 * they are the exact keys the SDK's `pick()` extracted, so non-body keys like
 * `has_children`/`object`/`id` are dropped from PATCH bodies just as before.
 */
interface NotionEndpoint {
  method: NotionHttpMethod;
  queryParams: readonly string[];
  bodyParams: readonly string[];
  path: (args: Record<string, unknown>) => string;
}

const enc = encodeURIComponent;

const ENDPOINTS = {
  retrieveDatabase: {
    method: 'get',
    queryParams: [],
    bodyParams: [],
    path: (a) => `/databases/${enc(String(a.database_id))}`,
  },
  retrieveDataSource: {
    method: 'get',
    queryParams: [],
    bodyParams: [],
    path: (a) => `/data_sources/${enc(String(a.data_source_id))}`,
  },
  queryDataSource: {
    method: 'post',
    queryParams: ['filter_properties'],
    bodyParams: ['archived', 'sorts', 'filter', 'start_cursor', 'page_size', 'in_trash', 'result_type'],
    path: (a) => `/data_sources/${enc(String(a.data_source_id))}/query`,
  },
  search: {
    method: 'post',
    queryParams: [],
    bodyParams: ['sort', 'query', 'start_cursor', 'page_size', 'filter'],
    path: () => `/search`,
  },
  listBlockChildren: {
    method: 'get',
    queryParams: ['start_cursor', 'page_size'],
    bodyParams: [],
    path: (a) => `/blocks/${enc(String(a.block_id))}/children`,
  },
  retrieveBlock: {
    method: 'get',
    queryParams: [],
    bodyParams: [],
    path: (a) => `/blocks/${enc(String(a.block_id))}`,
  },
  appendBlockChildren: {
    method: 'patch',
    queryParams: [],
    bodyParams: ['after', 'children', 'position'],
    path: (a) => `/blocks/${enc(String(a.block_id))}/children`,
  },
  updateBlock: {
    method: 'patch',
    queryParams: [],
    // Verbatim from the SDK's `updateBlock.bodyParams`. The omission of
    // `has_children`/`object`/`id`/`children` is load-bearing: the executor
    // spreads a cleaned block in, and those keys must NOT reach the wire.
    bodyParams: [
      'archived',
      'embed',
      'type',
      'in_trash',
      'bookmark',
      'image',
      'video',
      'pdf',
      'file',
      'audio',
      'code',
      'equation',
      'divider',
      'breadcrumb',
      'tab',
      'table_of_contents',
      'link_to_page',
      'table_row',
      'heading_1',
      'heading_2',
      'heading_3',
      'heading_4',
      'paragraph',
      'bulleted_list_item',
      'numbered_list_item',
      'quote',
      'to_do',
      'toggle',
      'template',
      'callout',
      'synced_block',
      'table',
      'column',
    ],
    path: (a) => `/blocks/${enc(String(a.block_id))}`,
  },
  deleteBlock: {
    method: 'delete',
    queryParams: [],
    bodyParams: [],
    path: (a) => `/blocks/${enc(String(a.block_id))}`,
  },
  retrievePage: {
    method: 'get',
    queryParams: ['filter_properties'],
    bodyParams: [],
    path: (a) => `/pages/${enc(String(a.page_id))}`,
  },
  createPage: {
    method: 'post',
    queryParams: [],
    bodyParams: ['parent', 'properties', 'icon', 'cover', 'content', 'children', 'markdown', 'template', 'position'],
    path: () => `/pages`,
  },
  updatePage: {
    method: 'patch',
    queryParams: [],
    bodyParams: [
      'archived',
      'properties',
      'icon',
      'cover',
      'is_locked',
      'template',
      'erase_content',
      'in_trash',
      'is_archived',
    ],
    path: (a) => `/pages/${enc(String(a.page_id))}`,
  },
} satisfies Record<string, NotionEndpoint>;

/**
 * Low-level HTTP client for the Notion API, replacing the vendored
 * `@notionhq/client` runtime. Returns the raw `response.data` for every method
 * — byte-identical to the SDK, whose response handling was a plain
 * `JSON.parse(body)` with no key renames, date coercion, or reshaping. The API
 * version travels in the `Notion-Version` header; the `/v1` path is in the base
 * URL. Retry (429-only) and error translation are owned here, per the house
 * api-client pattern, so the connector just calls flat methods.
 */
export class NotionApiClient {
  private readonly http: AxiosInstance;
  private readonly rateLimiter?: RateLimiter;

  constructor(apiKey: string, opts?: { rateLimiter?: RateLimiter; notionVersion?: string }) {
    this.http = createApiClient({
      baseURL: BASE_URL,
      timeout: NOTION_REQUEST_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Notion-Version': opts?.notionVersion ?? DEFAULT_NOTION_API_VERSION,
      },
    });
    this.rateLimiter = opts?.rateLimiter;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.withRetry(fn, NOTION_RETRY_OPTS);
    }
    return standaloneWithRetry(fn, NOTION_RETRY_OPTS);
  }

  /**
   * Issue a single request against an endpoint contract, returning the raw
   * `response.data`. Splits `args` into path / query / body exactly as the SDK
   * did, retries on 429, and translates axios failures into
   * {@link NotionError} / {@link NotionRequestTimeoutError}.
   */
  private async request<T>(endpoint: NotionEndpoint, args: object): Promise<T> {
    const record = args as Record<string, unknown>;
    const url = endpoint.path(record);
    const params = pickParams(record, endpoint.queryParams);
    const body = pickParams(record, endpoint.bodyParams);
    const hasBody = Object.keys(body).length > 0;
    return this.withRetry(async () => {
      try {
        const response = await this.http.request<T>({
          method: endpoint.method,
          url,
          params,
          data: hasBody ? body : undefined,
        });
        return response.data;
      } catch (error) {
        throw translateNotionAxiosError(error);
      }
    });
  }

  search(args: SearchParameters): Promise<SearchResponse> {
    return this.request<SearchResponse>(ENDPOINTS.search, args);
  }

  retrieveDatabase(args: GetDatabaseParameters): Promise<GetDatabaseResponse> {
    return this.request<GetDatabaseResponse>(ENDPOINTS.retrieveDatabase, args);
  }

  retrieveDataSource(args: GetDataSourceParameters): Promise<GetDataSourceResponse> {
    return this.request<GetDataSourceResponse>(ENDPOINTS.retrieveDataSource, args);
  }

  queryDataSource(args: QueryDataSourceParameters): Promise<QueryDataSourceResponse> {
    return this.request<QueryDataSourceResponse>(ENDPOINTS.queryDataSource, args);
  }

  listBlockChildren(args: ListBlockChildrenParameters): Promise<ListBlockChildrenResponse> {
    return this.request<ListBlockChildrenResponse>(ENDPOINTS.listBlockChildren, args);
  }

  retrieveBlock(args: GetBlockParameters): Promise<GetBlockResponse> {
    return this.request<GetBlockResponse>(ENDPOINTS.retrieveBlock, args);
  }

  appendBlockChildren(args: AppendBlockChildrenParameters): Promise<AppendBlockChildrenResponse> {
    return this.request<AppendBlockChildrenResponse>(ENDPOINTS.appendBlockChildren, args);
  }

  updateBlock(args: UpdateBlockParameters): Promise<UpdateBlockResponse> {
    return this.request<UpdateBlockResponse>(ENDPOINTS.updateBlock, args);
  }

  deleteBlock(args: DeleteBlockParameters): Promise<DeleteBlockResponse> {
    return this.request<DeleteBlockResponse>(ENDPOINTS.deleteBlock, args);
  }

  retrievePage(args: GetPageParameters): Promise<GetPageResponse> {
    return this.request<GetPageResponse>(ENDPOINTS.retrievePage, args);
  }

  createPage(args: CreatePageParameters): Promise<CreatePageResponse> {
    return this.request<CreatePageResponse>(ENDPOINTS.createPage, args);
  }

  updatePage(args: UpdatePageParameters): Promise<UpdatePageResponse> {
    return this.request<UpdatePageResponse>(ENDPOINTS.updatePage, args);
  }
}
