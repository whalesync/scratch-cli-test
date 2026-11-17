import { isAxiosError, isCancel } from 'axios';

/**
 * Node, axios, and undici error codes meaning the request never got a complete answer because the connection
 * failed, not because the service rejected it. The same request can succeed a moment later.
 *
 * `ENOTFOUND` (the host doesn't resolve) is deliberately absent: it almost always means a wrong host name, which no
 * retry fixes. `EAI_AGAIN` is the temporary DNS failure.
 */
const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  // The service, or something between us and it, dropped the connection mid-request (DEV-12926: HubSpot did this
  // 80,200 records into a Live Export pull). Also what axios reports for "socket hang up".
  'ECONNRESET',
  'ETIMEDOUT',
  // Axios's own request timeout.
  'ECONNABORTED',
  'ECONNREFUSED',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  // undici, which backs Node's `fetch`.
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * HTTP statuses where the service failed to handle a request it may well handle on a retry: an internal error, a
 * gateway that couldn't reach the service, the service being briefly unavailable, or a gateway timeout. 429 is not
 * here: every connector already retries its rate limits, honoring the service's own `Retry-After`.
 */
const TRANSIENT_HTTP_STATUSES = new Set([500, 502, 503, 504]);

/** How many `cause` links to follow from the thrown error before giving up. */
const MAX_ERROR_CAUSE_CHAIN_DEPTH = 5;

/**
 * True when `error` is a failure of the network or of the remote service itself (a dropped connection, a timeout, or
 * a 500/502/503/504) rather than a rejection of the request (401, 403, 404, other 4xx) or a bug on our side.
 *
 * It is the caller's job to decide whether retrying is SAFE. A read can always be retried; a write that failed this
 * way may still have reached the service, so retrying it can apply the write twice.
 *
 * Connector-agnostic on purpose. It recognizes the shapes connector code throws:
 *  - an axios error: its network `code`, or its `response.status`;
 *  - a Node or undici system error: its `code`;
 *  - a connector's own error class: a numeric `statusCode` (most connectors) or `status` (Notion, the generic API);
 *  - any of the above wrapped as the `cause` of another error.
 * A canceled axios request is never transient: the caller asked for it to stop.
 */
export function isTransientRemoteServiceFailure(error: unknown): boolean {
  let errorInCauseChain: unknown = error;
  for (let depth = 0; depth < MAX_ERROR_CAUSE_CHAIN_DEPTH; depth++) {
    if (typeof errorInCauseChain !== 'object' || errorInCauseChain === null) {
      return false;
    }
    if (isCancel(errorInCauseChain)) {
      return false;
    }
    if (hasTransientNetworkErrorCode(errorInCauseChain) || hasTransientHttpStatus(errorInCauseChain)) {
      return true;
    }
    errorInCauseChain = (errorInCauseChain as { cause?: unknown }).cause;
  }
  return false;
}

function hasTransientNetworkErrorCode(errorObject: object): boolean {
  const errorCode = (errorObject as { code?: unknown }).code;
  return typeof errorCode === 'string' && TRANSIENT_NETWORK_ERROR_CODES.has(errorCode);
}

function hasTransientHttpStatus(errorObject: object): boolean {
  const httpStatus = readHttpStatusFromError(errorObject);
  return httpStatus !== undefined && TRANSIENT_HTTP_STATUSES.has(httpStatus);
}

function readHttpStatusFromError(errorObject: object): number | undefined {
  if (isAxiosError(errorObject)) {
    return errorObject.response?.status;
  }
  const { statusCode, status } = errorObject as { statusCode?: unknown; status?: unknown };
  if (typeof statusCode === 'number') {
    return statusCode;
  }
  if (typeof status === 'number') {
    return status;
  }
  return undefined;
}
