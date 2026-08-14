import { Prisma } from '@prisma/client';
import { sleep } from 'src/util';

/**
 * Transient Prisma connection-error codes. Both mean the query **never executed** — the client
 * either could not reach the server (`P1001`) or never obtained a pooled connection (`P2024`) — so
 * a *read* that fails with one of these is unconditionally safe to retry (no partial write can have
 * committed). These are common in the first seconds of a fresh Cloud Run worker revision, when the
 * private-IP egress to Cloud SQL is briefly cold (DEV-11312).
 *
 * Intentionally narrow: anything not in this set (e.g. `P2002` unique-constraint) must fail fast, per
 * "Surface failures; never silently succeed." `P1017` ("server has closed the connection") is a
 * candidate to add here if we ever observe it in this path.
 */
const TRANSIENT_PRISMA_CONNECTION_ERROR_CODES = new Set(['P1001', 'P2024']);

export function isTransientPrismaConnectionError(error: unknown): boolean {
  // A cold `$connect` that can't reach the server surfaces as an initialization error carrying P1001.
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return error.errorCode === 'P1001';
  }
  // A mid-life "can't reach server" (P1001) or a pool-acquisition timeout (P2024) surfaces here.
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return TRANSIENT_PRISMA_CONNECTION_ERROR_CODES.has(error.code);
  }
  return false;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 2000;
const DEFAULT_JITTER_MS = 250;

export interface RetryOnTransientDbConnectionErrorOpts {
  /**
   * Total attempts including the first (so `4` = up to 3 retries). Keep this small: a `P2024` failure
   * already blocks ~10s inside Prisma before throwing, and the whole ladder must stay comfortably
   * under the worker's BullMQ `lockDuration` (120s) so a retrying handler is never seen as stalled.
   */
  maxAttempts?: number;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  /** Invoked before each backoff sleep — i.e. exactly once per retry, never on the initial attempt. */
  onRetry?: (info: { attempt: number; error: unknown; delayMs: number }) => void;
}

/**
 * Run `fn`, retrying with exponential backoff + jitter **only** when it throws a transient Prisma
 * connection error (see {@link isTransientPrismaConnectionError}). Any other error — including a
 * non-transient Prisma error — is rethrown immediately, unwrapped, on the first attempt. When retries
 * are exhausted the **original** last error is rethrown (not a wrapper), so callers can re-classify it.
 *
 * Backoff shape mirrors the standalone `withRetry` in `src/rate-limiter/rate-limiter.ts`, but this
 * helper is DB-connection-specific: correct naming, no rate-limit log line, and a caller-supplied
 * `onRetry` hook for logging/metrics.
 */
export async function retryOnTransientDbConnectionError<T>(
  fn: () => Promise<T>,
  opts: RetryOnTransientDbConnectionErrorOpts = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxRetryDelayMs = opts.maxRetryDelayMs ?? DEFAULT_MAX_DELAY_MS;
  let retryDelayMs = opts.initialRetryDelayMs ?? DEFAULT_INITIAL_DELAY_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isLastAttempt = attempt === maxAttempts;
      if (!isTransientPrismaConnectionError(error) || isLastAttempt) {
        throw error;
      }

      opts.onRetry?.({ attempt, error, delayMs: retryDelayMs });
      await sleep(retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2 + Math.random() * DEFAULT_JITTER_MS, maxRetryDelayMs);
    }
  }

  // Unreachable: the loop returns on success and throws on the last attempt.
  throw new Error('retryOnTransientDbConnectionError: exhausted the retry loop without returning');
}
