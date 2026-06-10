import axios, { AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { normalizeToScratchpadApiError, ScratchpadApiError, ScratchpadApiErrorResponse } from './error';
import { AuthConfig, RequestLog, ScratchApiClientConfig } from './types';

type RequestConfigWithTiming = InternalAxiosRequestConfig & {
  metadata?: { startedAt: number };
  /** Set once a request has been retried after a transparent reauthorize — guards against loops. */
  reauthRetried?: boolean;
  /** The token this request actually carried, captured so a 401 can detect a burst refresh. */
  sentToken?: string | null;
};

/**
 * Per-call options accepted by the internal {@link Http} helpers. A subset of axios request
 * config plus `fallbackMessage`, the user-facing message used only when the server returned
 * no message of its own (mirrors the web client's old per-method `handleAxiosError` fallback).
 */
export interface HttpRequestOptions {
  params?: unknown;
  headers?: Record<string, string>;
  responseType?: 'json' | 'blob' | 'text' | 'arraybuffer';
  signal?: AbortSignal;
  fallbackMessage?: string;
}

/** Config for the generic {@link Http.request} escape hatch (arbitrary verb — e.g. a proxy). */
export interface HttpRequestConfig extends HttpRequestOptions {
  method: string;
  url: string;
  data?: unknown;
}

/**
 * The thin HTTP handle each resource factory is constructed with. Methods resolve to the raw
 * axios response so resource methods read as `const res = await http.get<T>(url); return res.data;`.
 * Errors are already normalized to {@link ScratchpadApiError} by the response interceptor.
 */
export interface Http {
  get<T>(url: string, options?: HttpRequestOptions): Promise<AxiosResponse<T>>;
  post<T>(url: string, data?: unknown, options?: HttpRequestOptions): Promise<AxiosResponse<T>>;
  put<T>(url: string, data?: unknown, options?: HttpRequestOptions): Promise<AxiosResponse<T>>;
  patch<T>(url: string, data?: unknown, options?: HttpRequestOptions): Promise<AxiosResponse<T>>;
  delete<T>(url: string, options?: HttpRequestOptions): Promise<AxiosResponse<T>>;
  /** Generic escape hatch for callers that need an arbitrary verb (e.g. a passthrough proxy). */
  request<T>(config: HttpRequestConfig): Promise<AxiosResponse<T>>;
}

function toAxiosConfig(options: HttpRequestOptions | undefined) {
  if (!options) return undefined;
  const { params, headers, responseType, signal } = options;
  return { params, headers, responseType, signal };
}

/**
 * Substitute the caller's `fallbackMessage` only when the failure carries no server-provided
 * message — exactly the web client's old `errorResponse?.message || ... || fallbackMessage` rule.
 */
async function applyFallbackMessage<T>(request: Promise<T>, fallbackMessage: string | undefined): Promise<T> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof ScratchpadApiError && !error.serverMessage && fallbackMessage) {
      error.message = fallbackMessage;
    }
    throw error;
  }
}

function buildRequestLog(
  config: RequestConfigWithTiming,
  status: number | undefined,
  errorSummary?: string,
): RequestLog {
  const startedAt = config.metadata?.startedAt;
  return {
    method: (config.method ?? 'GET').toUpperCase(),
    url: config.url ?? '',
    status,
    durationMs: startedAt === undefined ? 0 : performance.now() - startedAt,
    errorSummary,
  };
}

function summarizeErrorBody(responseData: unknown, fallback: string): string {
  if (typeof responseData === 'string') {
    return responseData;
  }
  if (responseData && typeof responseData === 'object' && 'message' in responseData) {
    return String((responseData as ScratchpadApiErrorResponse).message);
  }
  return fallback;
}

/**
 * Build a configured axios instance: base URL, JSON headers, a request interceptor that injects
 * the auth header (when `withAuth`) and timing metadata, and a response interceptor that emits
 * `onRequestComplete`, transparently reauthorizes + retries once on a 401 (when `auth.reauthorize`
 * is provided), fires `onUnauthorized` on a *terminal* 401, and normalizes every error to
 * {@link ScratchpadApiError}.
 *
 * Logging note: a transparently-recovered 401 emits a SINGLE `onRequestComplete` for the final
 * outcome — the intermediate 401 is intentionally not reported, so recovered requests don't skew
 * error-rate metrics. Only a terminal 401 is logged as a failure.
 */
export function createConfiguredAxiosInstance(
  config: ScratchApiClientConfig,
  options: { withAuth: boolean },
): AxiosInstance {
  const instance = axios.create({
    baseURL: config.baseUrl,
    headers: {
      'Content-Type': 'application/json',
    },
  });

  // Single-flight `reauthorize`: N concurrent requests that all 401 on the same dead token trigger
  // exactly ONE `reauthorize()` call and then all replay with its result. Cleared once it settles
  // so a later dead token starts a fresh mint.
  let reauthorizeInFlight: Promise<string | null> | null = null;
  const mintFreshTokenSingleFlight = (reauthorize: NonNullable<AuthConfig['reauthorize']>): Promise<string | null> => {
    reauthorizeInFlight ??= (async () => {
      try {
        return await reauthorize();
      } finally {
        reauthorizeInFlight = null;
      }
    })();
    return reauthorizeInFlight;
  };

  instance.interceptors.request.use(async (requestConfig) => {
    const cfg = requestConfig as RequestConfigWithTiming;
    // On a reauth retry the Authorization header is already set to the chosen fresh token, so we
    // must NOT overwrite it with a (possibly still-stale) `getToken()` read.
    if (options.withAuth && !cfg.reauthRetried) {
      const token = await config.auth.getToken();
      cfg.sentToken = token ?? null;
      if (token) {
        requestConfig.headers.Authorization = `${config.auth.scheme} ${token}`;
      }
    }
    cfg.metadata = { startedAt: performance.now() };
    return requestConfig;
  });

  const emitErrorLog = (requestConfig: RequestConfigWithTiming | undefined, error: unknown, statusCode: number) => {
    if (!requestConfig) return;
    const errorSummary = axios.isAxiosError(error)
      ? summarizeErrorBody(error.response?.data, error.message)
      : normalizeToScratchpadApiError(error).message;
    config.onRequestComplete?.(buildRequestLog(requestConfig, statusCode || undefined, errorSummary));
  };

  instance.interceptors.response.use(
    (response) => {
      config.onRequestComplete?.(buildRequestLog(response.config as RequestConfigWithTiming, response.status));
      return response;
    },
    async (error: unknown) => {
      const requestConfig = (axios.isAxiosError(error) ? error.config : undefined) as
        | RequestConfigWithTiming
        | undefined;
      const is401 = axios.isAxiosError(error) && error.response?.status === 401;

      // Transparent reauthorize + retry-once. Only on the authenticated instance, only when a
      // `reauthorize` is wired, and only if this request has not already been retried.
      if (is401 && options.withAuth && config.auth.reauthorize && requestConfig && !requestConfig.reauthRetried) {
        requestConfig.reauthRetried = true;

        // Burst refinement: a sibling request or a proactive refresh timer may have advanced the
        // shared token cell since this request went out. Re-read `getToken` first; if it now
        // differs from the token this request carried, that newer token is worth trying before
        // paying for a fresh mint. Only when the cell still holds the same dead token do we
        // actually invoke `reauthorize`. (Single-flight alone can't catch this — it dedupes
        // *concurrent* mints, not a 401 arriving just after a refresh already resolved.)
        const currentToken = await config.auth.getToken();
        let retryToken: string | null;
        if (currentToken && currentToken !== requestConfig.sentToken) {
          retryToken = currentToken;
        } else {
          try {
            retryToken = await mintFreshTokenSingleFlight(config.auth.reauthorize);
          } catch {
            retryToken = null; // a throwing `reauthorize` is terminal
          }
        }
        if (retryToken) {
          // Replay the original request with the chosen token. The request interceptor skips its
          // `getToken()` read (see `reauthRetried`), so this exact token is what goes on the wire.
          requestConfig.headers.Authorization = `${config.auth.scheme} ${retryToken}`;
          return instance.request(requestConfig);
        }
        // null/throw → fall through to terminal handling below.
      }

      const normalizedError = normalizeToScratchpadApiError(error);
      emitErrorLog(requestConfig, error, normalizedError.statusCode);

      if (normalizedError.statusCode === 401) {
        config.onUnauthorized?.();
      }

      return Promise.reject(normalizedError);
    },
  );

  return instance;
}

/** Wrap a configured axios instance in the {@link Http} handle resource factories consume. */
export function createHttp(instance: AxiosInstance): Http {
  return {
    get: (url, options) => applyFallbackMessage(instance.get(url, toAxiosConfig(options)), options?.fallbackMessage),
    post: (url, data, options) =>
      applyFallbackMessage(instance.post(url, data, toAxiosConfig(options)), options?.fallbackMessage),
    put: (url, data, options) =>
      applyFallbackMessage(instance.put(url, data, toAxiosConfig(options)), options?.fallbackMessage),
    patch: (url, data, options) =>
      applyFallbackMessage(instance.patch(url, data, toAxiosConfig(options)), options?.fallbackMessage),
    delete: (url, options) =>
      applyFallbackMessage(instance.delete(url, toAxiosConfig(options)), options?.fallbackMessage),
    request: (config) =>
      applyFallbackMessage(
        instance.request({ method: config.method, url: config.url, data: config.data, ...toAxiosConfig(config) }),
        config.fallbackMessage,
      ),
  };
}
