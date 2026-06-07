import { AxiosInstance, InternalAxiosRequestConfig, isAxiosError } from 'axios';
import { LogLevel, WSLogger } from 'src/logger';

/**
 * Shared request/response logging for connector axios clients (DEV-10339).
 *
 * A core motivation for removing the vendored connector SDKs (DEV-9754) was to
 * make outbound API traffic *visible* for debugging (including AI-assisted
 * debugging) — the SDKs hid which endpoints we actually hit. Now that every
 * connector routes through `createApiClient()`, a single interceptor pair lights
 * this up everywhere with no per-connector change.
 *
 * What it logs (one structured line per completed request): HTTP method, the
 * full request URL, the response status, and the round-trip duration.
 *
 * How it is gated so it is safe to leave on:
 *   - Lines are emitted at `debug` level, which the server suppresses by default
 *     (the global log level defaults to `info` — see `scratch-config.service.ts`
 *     / `LOG_LEVEL`). Raising the level to `debug` surfaces the traffic when you
 *     actually need it, so prod info logs are never flooded.
 *   - The `CONNECTOR_HTTP_LOGGING` env var chooses the mode (see below). When the
 *     effective level would drop the line anyway, we skip building the payload.
 *
 * Redaction (conservative by default — we never log raw credentials or bodies):
 *   - Request/response bodies are never logged.
 *   - Sensitive query-string values (tokens, api keys, secrets) are masked in the
 *     logged URL.
 *   - Request headers are only logged in `verbose` mode, and even then every
 *     `Authorization`/token/api-key/cookie header value is masked.
 */

/** Mode selected by the `CONNECTOR_HTTP_LOGGING` env var. */
export type ConnectorHttpLoggingMode = 'off' | 'basic' | 'verbose';

/**
 * Placeholder substituted for any value we refuse to log in the clear. Kept
 * bracket-free so it survives `URLSearchParams` serialization without percent
 * encoding (keeps redacted query strings readable in the logs).
 */
const REDACTED_PLACEHOLDER = 'REDACTED';

/**
 * Header names whose values must never be logged. Matched case-insensitively as a
 * substring of the header name, so it covers `Authorization`, `api-key`,
 * `X-Api-Key`, `x-api-token`, `X-PW-AccessToken`, `X-Shopify-Access-Token`,
 * `Cookie`, etc. across the connector fleet.
 */
const SENSITIVE_HEADER_NAME_PATTERN = /authorization|cookie|token|api[-_]?key|access[-_]?token|secret|password/i;

/**
 * Query-parameter names whose values must never be logged. A few connectors (and
 * many third-party APIs) accept credentials in the query string, so we mask these
 * even though most of our clients authenticate via headers.
 */
const SENSITIVE_QUERY_PARAM_NAME_PATTERN =
  /token|api[-_]?key|access[-_]?token|secret|password|signature|^key$|^auth$|sig/i;

/**
 * Per-request start timestamps, keyed by the axios config object so we can compute
 * the round-trip duration in the response/error interceptor. A WeakMap avoids
 * mutating the config (and the resulting `as any` type hole) and lets entries be
 * garbage-collected with their config.
 */
const requestStartTimestampMsByConfig = new WeakMap<InternalAxiosRequestConfig, number>();

/** Resolve the logging mode from the environment, defaulting to `basic`. */
export function resolveConnectorHttpLoggingModeFromEnv(): ConnectorHttpLoggingMode {
  const raw = (process.env.CONNECTOR_HTTP_LOGGING ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'verbose' || raw === 'basic') {
    return raw;
  }
  return 'basic';
}

/**
 * Install request/response logging interceptors on an axios instance. Called by
 * `createApiClient()` so it applies uniformly to every connector. Exported with an
 * explicit `mode` so tests can exercise it without touching the environment.
 */
export function applyConnectorHttpLogging(
  instance: AxiosInstance,
  mode: ConnectorHttpLoggingMode = resolveConnectorHttpLoggingModeFromEnv(),
): void {
  if (mode === 'off') return;

  instance.interceptors.request.use((config) => {
    requestStartTimestampMsByConfig.set(config, Date.now());
    return config;
  });

  instance.interceptors.response.use(
    (response) => {
      logCompletedRequest(response.config, response.status, undefined, mode);
      return response;
    },
    (error: unknown) => {
      const config = isAxiosError(error) ? error.config : undefined;
      const responseStatus = isAxiosError(error) ? error.response?.status : undefined;
      logCompletedRequest(config, responseStatus, error, mode);
      // Re-reject the original error verbatim — connectors branch on `isAxiosError(error)`
      // downstream, so logging must never reshape or swallow the rejection reason.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(error);
    },
  );
}

/** Emit a single structured log line describing a completed (or failed) request. */
function logCompletedRequest(
  config: InternalAxiosRequestConfig | undefined,
  responseStatus: number | undefined,
  error: unknown,
  mode: ConnectorHttpLoggingMode,
): void {
  // Skip all payload construction when the line would be dropped anyway — keeps
  // the interceptor's per-request overhead negligible when left on in prod.
  if (!WSLogger.isLevelEnabled(LogLevel.DEBUG)) return;
  if (!config) return;

  const httpMethod = (config.method ?? 'get').toUpperCase();
  const redactedUrl = describeRequestUrlForLogging(config);
  const requestStartTimestampMs = requestStartTimestampMsByConfig.get(config);
  const durationMs = requestStartTimestampMs !== undefined ? Date.now() - requestStartTimestampMs : undefined;
  const statusLabel = statusLabelFor(responseStatus, error);

  WSLogger.debug({
    source: 'connector-http',
    message: `${httpMethod} ${redactedUrl} → ${statusLabel}` + (durationMs !== undefined ? ` (${durationMs}ms)` : ''),
    method: httpMethod,
    url: redactedUrl,
    status: responseStatus ?? null,
    durationMs: durationMs ?? null,
    ...(error ? { error: describeRequestError(error) } : {}),
    ...(mode === 'verbose' ? { requestHeaders: redactSensitiveHeadersForLogging(config.headers) } : {}),
  });
}

/** Human-readable status token: the HTTP status, the network error code, or `ERROR`. */
function statusLabelFor(responseStatus: number | undefined, error: unknown): string {
  if (responseStatus !== undefined) return String(responseStatus);
  if (isAxiosError(error) && error.code) return error.code;
  if (error) return 'ERROR';
  return 'unknown';
}

/** A short, non-sensitive description of a request failure (no body, no headers). */
function describeRequestError(error: unknown): string {
  if (isAxiosError(error)) return error.code ? `${error.code}: ${error.message}` : error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Build the full request URL for logging from an axios config, merging `baseURL`,
 * `url`, and `params`, and masking any sensitive query-parameter values. Mirrors
 * how axios assembles the outgoing URL so the log reflects what we actually sent.
 */
export function describeRequestUrlForLogging(config: { url?: string; baseURL?: string; params?: unknown }): string {
  const baseUrl = config.baseURL ?? '';
  const path = config.url ?? '';

  let fullUrl: string;
  if (!path) {
    fullUrl = baseUrl;
  } else if (/^https?:\/\//i.test(path) || !baseUrl) {
    fullUrl = path;
  } else {
    fullUrl = `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  }

  const queryStringStartIndex = fullUrl.indexOf('?');
  const urlWithoutQuery = queryStringStartIndex === -1 ? fullUrl : fullUrl.slice(0, queryStringStartIndex);
  const existingQueryString = queryStringStartIndex === -1 ? '' : fullUrl.slice(queryStringStartIndex + 1);

  const queryParams = new URLSearchParams(existingQueryString);
  appendAxiosParamsToQuery(queryParams, config.params);

  for (const paramName of [...queryParams.keys()]) {
    if (SENSITIVE_QUERY_PARAM_NAME_PATTERN.test(paramName)) {
      queryParams.set(paramName, REDACTED_PLACEHOLDER);
    }
  }

  const redactedQueryString = queryParams.toString();
  return redactedQueryString ? `${urlWithoutQuery}?${redactedQueryString}` : urlWithoutQuery;
}

/** Fold axios `config.params` (plain object or `URLSearchParams`) into a query bag. */
function appendAxiosParamsToQuery(target: URLSearchParams, params: unknown): void {
  if (params == null) return;

  if (params instanceof URLSearchParams) {
    for (const [name, value] of params) {
      target.append(name, value);
    }
    return;
  }

  if (typeof params === 'object') {
    for (const [name, value] of Object.entries(params as Record<string, unknown>)) {
      if (value == null) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          const itemAsString = coercePrimitiveToLoggableString(item);
          if (itemAsString !== undefined) target.append(name, itemAsString);
        }
      } else {
        const valueAsString = coercePrimitiveToLoggableString(value);
        if (valueAsString !== undefined) target.append(name, valueAsString);
      }
    }
  }
}

/**
 * Stringify a primitive query-param / header value for logging. Returns undefined
 * for objects, functions, and symbols so we never log an opaque `[object Object]`
 * (and never accidentally serialize a nested value we haven't reasoned about).
 */
function coercePrimitiveToLoggableString(value: unknown): string | undefined {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    default:
      return undefined;
  }
}

/**
 * Return a logging-safe copy of request headers with every sensitive value masked.
 * Accepts an `AxiosHeaders` instance (duck-typed via `toJSON`) or a plain object.
 * Only scalar header values are kept; nested method buckets (`common`/`get`/…) are
 * dropped, since per-request config headers are already flattened.
 */
export function redactSensitiveHeadersForLogging(headers: unknown): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [headerName, headerValue] of normalizeHeaderEntries(headers)) {
    const headerValueAsString = coercePrimitiveToLoggableString(headerValue);
    if (headerValueAsString === undefined) continue;
    redacted[headerName] = SENSITIVE_HEADER_NAME_PATTERN.test(headerName) ? REDACTED_PLACEHOLDER : headerValueAsString;
  }
  return redacted;
}

function normalizeHeaderEntries(headers: unknown): [string, unknown][] {
  if (!headers || typeof headers !== 'object') return [];
  const maybeAxiosHeaders = headers as { toJSON?: () => Record<string, unknown> };
  const plain = typeof maybeAxiosHeaders.toJSON === 'function' ? maybeAxiosHeaders.toJSON() : headers;
  return Object.entries(plain as Record<string, unknown>);
}
