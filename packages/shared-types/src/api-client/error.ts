import { isAxiosError } from 'axios';

/**
 * NestJS response body shape when an exception is thrown on the server.
 */
export interface ScratchpadApiErrorResponse {
  message: string;
  error: string;
  statusCode: number;
}

/**
 * The single typed error surfaced by the shared api-client to both frontends.
 *
 * Built in the response interceptor (see `http.ts`) so resource methods never need their
 * own try/catch. Fields mirror the web client's original `ScratchpadApiError`, with
 * `isConnectionError` folded in from desktop's `is-server-connection-error.ts`.
 */
export class ScratchpadApiError extends Error {
  /**
   * The message the server actually returned, if any. Distinct from `message`, which may
   * have been replaced with a caller-supplied fallback when the server gave us nothing.
   * The internal `http` helpers only substitute their `fallbackMessage` when this is empty.
   */
  public readonly serverMessage: string | undefined;

  /**
   * True when the failure is a connectivity/gateway problem rather than an application-level
   * error: aborted/timed-out request, no response at all, or a 502/503/504. Lets the UI show a
   * recoverable "no connection" state instead of a bare error string.
   */
  public readonly isConnectionError: boolean;

  constructor(args: {
    message: string;
    statusCode: number;
    statusText: string;
    serverMessage?: string;
    isConnectionError: boolean;
  }) {
    super(args.message);
    this.name = 'ScratchpadApiError';
    this.statusCode = args.statusCode;
    this.statusText = args.statusText;
    this.serverMessage = args.serverMessage;
    this.isConnectionError = args.isConnectionError;
  }

  public statusCode: number;
  public statusText: string;
}

const DEFAULT_CONNECTION_ERROR_MESSAGE = 'Scratch servers are currently unavailable. Please try again later.';

/**
 * Normalize any thrown value from an axios call into a {@link ScratchpadApiError}.
 *
 * Pure network failures (no HTTP response) are reported with `statusCode === 0`, matching the
 * web client's existing convention; gateway statuses (502/503/504) and aborted requests are
 * flagged via `isConnectionError` so the UI can distinguish a flaky connection from a real error.
 */
export function normalizeToScratchpadApiError(error: unknown): ScratchpadApiError {
  if (isAxiosError(error)) {
    const isAbortedOrTimedOut = error.code === 'ECONNABORTED';

    // No HTTP response at all — connection refused, DNS failure, timeout, etc.
    if (!error.response) {
      return new ScratchpadApiError({
        message: DEFAULT_CONNECTION_ERROR_MESSAGE,
        statusCode: 0,
        statusText: error.code ?? 'Connection Error',
        serverMessage: undefined,
        isConnectionError: true,
      });
    }

    const status = error.response.status;
    const isGatewayError = status === 502 || status === 503 || status === 504;
    const errorResponseBody = error.response.data as ScratchpadApiErrorResponse | undefined;
    const serverMessage = errorResponseBody?.message || errorResponseBody?.error || undefined;

    return new ScratchpadApiError({
      message: serverMessage ?? DEFAULT_CONNECTION_ERROR_MESSAGE,
      statusCode: status,
      statusText: error.response.statusText,
      serverMessage,
      isConnectionError: isAbortedOrTimedOut || isGatewayError,
    });
  }

  // Browser fetch network failure (some axios adapters surface this).
  if (error instanceof TypeError && error.message === 'Failed to fetch') {
    return new ScratchpadApiError({
      message: DEFAULT_CONNECTION_ERROR_MESSAGE,
      statusCode: 0,
      statusText: 'Connection Refused',
      serverMessage: undefined,
      isConnectionError: true,
    });
  }

  // Already our error — pass through unchanged.
  if (error instanceof ScratchpadApiError) {
    return error;
  }

  // Anything else: wrap it so callers always receive a ScratchpadApiError.
  const message = error instanceof Error ? error.message : String(error);
  return new ScratchpadApiError({
    message,
    statusCode: 0,
    statusText: 'Error',
    serverMessage: undefined,
    isConnectionError: false,
  });
}

export function getHumanReadableErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unknown error';
}

export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof ScratchpadApiError && error.statusCode === 401;
}

export function isConnectionError(error: unknown): boolean {
  return error instanceof ScratchpadApiError && error.isConnectionError;
}
