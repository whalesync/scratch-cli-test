// Direct Scratch server API calls for suites that need to drive the server alongside the CLI.
//
// Every call here is hardened against a single transient transport blip. CI has repeatedly lost
// whole suites to one dropped connection between the GitLab runner and test-api — a request that
// never reaches the load balancer at all — and a bare `fetch` turns that into an exception that
// aborts the surrounding poll loop even though the server was healthy the whole time.

const serverUrl = process.env.SCRATCH_API_URL || "http://localhost:3010";
const apiKey = process.env.SCRATCH_API_KEY;

/** Total attempts allowed for one call (the first attempt plus its retries). */
const MAX_REQUEST_ATTEMPTS = 3;

/** Backoff before each retry, indexed by how many attempts have already failed. */
const RETRY_BACKOFF_MS_BY_FAILED_ATTEMPTS = [250, 1000];

/**
 * Abandon a single attempt that has produced no response this long, so a stall can be retried.
 * These are all fast control-plane calls, so silence for this long means a dead socket rather
 * than slow work.
 *
 * It has to stay comfortably below the deadline of the tightest caller that polls through this
 * helper (`waitForJob`, 60s), or attempt 1 alone would burn that whole budget and a retry that
 * then SUCCEEDED would still land past it — surfacing "the job did not complete in time" for
 * what was purely a transport stall, the exact misdiagnosis this retrying exists to prevent.
 * At these values a fully exhausted attempt chain costs ~46s, so even that fits.
 */
const PER_ATTEMPT_TIMEOUT_MS = 15_000;

/**
 * Node error codes that mean the connection was never established, so the server definitively
 * never saw the request. Replaying one of these cannot duplicate work, whatever the method.
 */
const CONNECT_LEVEL_ERROR_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/** Statuses the load balancer returns when it could not get a response out of the backend. */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

function isConnectLevelError(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
  return !!cause?.code && CONNECT_LEVEL_ERROR_CODES.has(cause.code);
}

/**
 * Whether a failed attempt may be replayed.
 *
 * A connect-level failure is safe for any method — the request never arrived. Anything after the
 * connection is up leaves us unable to tell whether the server applied the request, so only reads
 * are replayed; replaying a POST could duplicate a workbook, a folder, or a pull job.
 */
function isSafeToRetry(method: string, error: unknown): boolean {
  if (isConnectLevelError(error)) {
    return true;
  }
  return method.toUpperCase() === "GET";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call the Scratch server API directly with the test API token, retrying transient transport
 * failures. A non-2xx response that is not a load-balancer failure is surfaced as-is — this
 * retries dropped connections, never a real API error.
 */
export async function scratchApi<T>(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<T> {
  let failedAttempts = 0;

  for (;;) {
    const hasAttemptsRemaining = failedAttempts + 1 < MAX_REQUEST_ATTEMPTS;
    let response: Response;

    try {
      response = await fetch(`${serverUrl}${urlPath}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `API-Token ${apiKey}`,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(PER_ATTEMPT_TIMEOUT_MS),
      });
    } catch (error) {
      if (!hasAttemptsRemaining || !isSafeToRetry(method, error)) {
        throw new Error(
          `API ${method} ${urlPath} failed after ${failedAttempts + 1} attempt(s): ${String(error)}`,
          { cause: error },
        );
      }
      await sleep(RETRY_BACKOFF_MS_BY_FAILED_ATTEMPTS[failedAttempts]);
      failedAttempts += 1;
      continue;
    }

    if (
      !response.ok &&
      hasAttemptsRemaining &&
      RETRYABLE_STATUSES.has(response.status) &&
      method.toUpperCase() === "GET"
    ) {
      await sleep(RETRY_BACKOFF_MS_BY_FAILED_ATTEMPTS[failedAttempts]);
      failedAttempts += 1;
      continue;
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `API ${method} ${urlPath} failed (${response.status}): ${text}`,
      );
    }

    return (await response.json()) as T;
  }
}

/** GET a Scratch server route with the test API token. */
export function scratchApiGet<T>(urlPath: string): Promise<T> {
  return scratchApi<T>("GET", urlPath);
}
