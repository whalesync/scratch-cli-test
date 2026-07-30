import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { WSLogger } from 'src/logger';

const LOG_SOURCE = 'RateLimiter';

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 1000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

/**
 * How long to freeze the shared quota bucket after a 429 that carries no
 * `Retry-After` header. Many services (QuickBooks Online, for one) throttle
 * without ever telling you for how long; without a cooldown, the sibling
 * requests sharing this connector account's bucket keep firing straight into
 * the throttle while the one that got the 429 backs off alone.
 */
const DEFAULT_COOLDOWN_ON_RATE_LIMIT_S = 5;

/**
 * Extra headroom added to a limiter's own window when deriving the default
 * `maxWaitMs`, so a caller can always wait out one full window plus scheduling
 * slop before {@link RateLimitWaitTimeoutError} is raised.
 */
const QUOTA_WAIT_WINDOW_HEADROOM_MS = 5_000;

/**
 * Floor for the derived `maxWaitMs`. A short window does not imply a short wait:
 * a `block()` cooldown outlives a 1s window several times over, and a caller that
 * gave up sooner than the cooldown would burn its retry budget on wait timeouts
 * instead of simply sitting out the freeze.
 */
const MIN_QUOTA_WAIT_MS = 30_000;

/**
 * Thrown by {@link RateLimiter.waitForQuota} when quota did not become available
 * within the caller's wait budget.
 *
 * This is deliberately an error rather than a "proceed anyway" fallback: issuing
 * the request regardless would breach the very limit the caller asked us to
 * respect, and it does so at the exact moment the service is most likely to
 * answer with a 429. {@link RateLimiter.withRetry} treats it as a retryable
 * rate-limit condition, so callers that go through `withRetry` see a slower
 * request, not a failure — and callers that don't get an honest error.
 */
export class RateLimitWaitTimeoutError extends Error {
  constructor(
    public readonly key: string,
    public readonly waitedMs: number,
  ) {
    super(`Timed out after ${waitedMs}ms waiting for rate limit quota (${key})`);
    this.name = 'RateLimitWaitTimeoutError';
  }
}

export interface WithRetryOpts {
  /** Return true if the error represents a rate-limit / 429 response. */
  isRateLimited: (error: unknown) => boolean;
  /** Extract retry-after seconds from the error, or undefined to use backoff. */
  getRetryAfterS?: (error: unknown) => number | undefined;
  /**
   * Seconds to freeze the shared quota bucket when a rate-limit error carries no
   * `Retry-After` (see {@link DEFAULT_COOLDOWN_ON_RATE_LIMIT_S}). Raise this for
   * services whose throttle window is long — a per-minute quota needs a longer
   * cooldown than a per-second one to be worth anything. Applies only to
   * {@link RateLimiter.withRetry}; the standalone {@link withRetry} has no shared
   * bucket to freeze.
   */
  defaultCooldownS?: number;
  maxRetries?: number;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

export class RateLimiter {
  constructor(private readonly limiter: RateLimiterRedis) {}

  /**
   * Wait until quota is available, then consume points.
   *
   * Fails open on Redis errors — if the limiter's own backing store is down we
   * cannot know the quota, and stalling every connector on a Redis outage is
   * worse than briefly exceeding a limit. A *saturated* bucket is the opposite
   * case: we know exactly what the limit is and that we are at it, so waiting
   * longer than `maxWaitMs` raises {@link RateLimitWaitTimeoutError} rather than
   * issuing the request anyway.
   *
   * `maxWaitMs` defaults to one full limiter window plus slop (never less than
   * {@link MIN_QUOTA_WAIT_MS}), so the common case — "the window is nearly spent,
   * sit out the rest of it" — always waits rather than timing out.
   */
  async waitForQuota(points = 1, opts?: { maxWaitMs?: number }): Promise<void> {
    const maxWaitMs =
      opts?.maxWaitMs ?? Math.max(MIN_QUOTA_WAIT_MS, this.limiter.duration * 1000 + QUOTA_WAIT_WINDOW_HEADROOM_MS);
    const startedAtMs = Date.now();
    const deadline = startedAtMs + maxWaitMs;

    while (true) {
      try {
        await this.limiter.consume(this.limiter.keyPrefix, points);
        return;
      } catch (error) {
        if (error instanceof RateLimiterRes) {
          const waitMs = error.msBeforeNext;
          if (Date.now() + waitMs > deadline) {
            throw new RateLimitWaitTimeoutError(this.limiter.keyPrefix, Date.now() - startedAtMs);
          }
          WSLogger.warn({
            source: LOG_SOURCE,
            message: `Rate limit reached, waiting ${waitMs}ms before next request`,
            key: this.limiter.keyPrefix,
          });
          await sleep(waitMs);
          continue;
        }

        // Redis error — fail open
        WSLogger.warn({
          source: LOG_SOURCE,
          message: `Rate limiter Redis error, failing open`,
          key: this.limiter.keyPrefix,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
  }

  /**
   * Block all requests for a duration (e.g. on 429 with retry-after).
   * Fails open on Redis errors.
   */
  async block(durationS: number): Promise<void> {
    try {
      await this.limiter.block(this.limiter.keyPrefix, durationS);
      WSLogger.warn({
        source: LOG_SOURCE,
        message: `Blocking all requests for ${durationS}s after 429 response`,
        key: this.limiter.keyPrefix,
      });
    } catch (error) {
      WSLogger.warn({
        source: LOG_SOURCE,
        message: `Rate limiter block failed, failing open`,
        key: this.limiter.keyPrefix,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Execute fn with proactive rate limiting and retry-on-429.
   *
   * Waits for quota before each attempt, and on a rate-limit response freezes
   * the whole connector account's bucket via {@link block} — using `Retry-After`
   * when the service sends one, otherwise `defaultCooldownS` — so every sibling
   * request sharing this bucket backs off too, not just this one. The local
   * sleep still follows the exponential ladder unless the service named a
   * concrete `Retry-After`.
   *
   * A {@link RateLimitWaitTimeoutError} from the proactive wait is itself
   * retryable: the bucket is saturated, which is exactly what the backoff ladder
   * is for. No `block` is issued for it — the bucket is already full.
   *
   * Note that the cooldown follows the caller's own `isRateLimited` predicate, so
   * a connector that folds transient 5xx into it (Attio does) also freezes the
   * bucket on those — easing off a service that is already struggling, which is
   * the behavior we want either way.
   */
  async withRetry<T>(fn: () => Promise<T>, opts: WithRetryOpts): Promise<T> {
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    const maxRetryDelayMs = opts.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    const cooldownS = opts.defaultCooldownS ?? DEFAULT_COOLDOWN_ON_RATE_LIMIT_S;
    let retryDelay = opts.initialRetryDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.waitForQuota();
        return await fn();
      } catch (error) {
        const isQuotaWaitTimeout = error instanceof RateLimitWaitTimeoutError;
        if ((!isQuotaWaitTimeout && !opts.isRateLimited(error)) || attempt === maxRetries) {
          throw error;
        }

        if (!isQuotaWaitTimeout) {
          const retryAfterS = opts.getRetryAfterS?.(error);
          if (retryAfterS !== undefined && retryAfterS > 0) {
            retryDelay = Math.min(retryAfterS * 1000, maxRetryDelayMs);
            await this.block(retryAfterS);
          } else if (cooldownS > 0) {
            await this.block(cooldownS);
          }
        }

        WSLogger.warn({
          source: LOG_SOURCE,
          message: isQuotaWaitTimeout
            ? `Timed out waiting for quota, retrying in ${retryDelay}ms (attempt ${attempt + 1}/${maxRetries})`
            : `Rate limited (429), retrying in ${retryDelay}ms (attempt ${attempt + 1}/${maxRetries})`,
          key: this.limiter.keyPrefix,
        });
        await sleep(retryDelay);

        retryDelay = Math.min(retryDelay * 2 + Math.random() * 500, maxRetryDelayMs);
      }
    }

    throw new Error('Rate limit retries exhausted');
  }
}

/**
 * Standalone retry-on-429 for use when no RateLimiter instance is available.
 *
 * Same retry logic but without proactive quota or block calls. `defaultCooldownS`
 * has no effect here by design — it exists to freeze the *shared* bucket so
 * sibling requests back off, and in single-process mode there is no shared bucket
 * and no sibling to protect; this caller's own backoff is the exponential ladder.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: WithRetryOpts): Promise<T> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxRetryDelayMs = opts.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  let retryDelay = opts.initialRetryDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!opts.isRateLimited(error) || attempt === maxRetries) {
        throw error;
      }

      const retryAfterS = opts.getRetryAfterS?.(error);
      if (retryAfterS !== undefined && retryAfterS > 0) {
        retryDelay = Math.min(retryAfterS * 1000, maxRetryDelayMs);
      }

      WSLogger.warn({
        source: LOG_SOURCE,
        message: `Rate limited (429), retrying in ${retryDelay}ms (attempt ${attempt + 1}/${maxRetries})`,
      });
      await sleep(retryDelay);

      retryDelay = Math.min(retryDelay * 2 + Math.random() * 500, maxRetryDelayMs);
    }
  }

  throw new Error('Rate limit retries exhausted');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
