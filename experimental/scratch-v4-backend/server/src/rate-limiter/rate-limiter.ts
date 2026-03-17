import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { WSLogger } from 'src/logger';

const LOG_SOURCE = 'RateLimiter';

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 1000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

export interface WithRetryOpts {
  /** Return true if the error represents a rate-limit / 429 response. */
  isRateLimited: (error: unknown) => boolean;
  /** Extract retry-after seconds from the error, or undefined to use backoff. */
  getRetryAfterS?: (error: unknown) => number | undefined;
  maxRetries?: number;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

export class RateLimiter {
  constructor(private readonly limiter: RateLimiterRedis) {}

  /**
   * Wait until quota is available, then consume points.
   * Fails open on Redis errors — requests proceed without throttling.
   */
  async waitForQuota(points = 1, opts?: { maxWaitMs?: number }): Promise<void> {
    const maxWaitMs = opts?.maxWaitMs ?? 30_000;
    const deadline = Date.now() + maxWaitMs;

    while (true) {
      try {
        await this.limiter.consume(this.limiter.keyPrefix, points);
        return;
      } catch (error) {
        if (error instanceof RateLimiterRes) {
          const waitMs = error.msBeforeNext;
          if (Date.now() + waitMs > deadline) {
            WSLogger.warn({
              source: LOG_SOURCE,
              message: `Rate limit wait would exceed max wait time (${maxWaitMs}ms), proceeding without throttle`,
              key: this.limiter.keyPrefix,
            });
            return;
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
   * Calls waitForQuota before each attempt and block on rate-limit errors.
   */
  async withRetry<T>(fn: () => Promise<T>, opts: WithRetryOpts): Promise<T> {
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    const maxRetryDelayMs = opts.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    let retryDelay = opts.initialRetryDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await this.waitForQuota();

      try {
        return await fn();
      } catch (error) {
        if (!opts.isRateLimited(error) || attempt === maxRetries) {
          throw error;
        }

        const retryAfterS = opts.getRetryAfterS?.(error);
        if (retryAfterS !== undefined && retryAfterS > 0) {
          retryDelay = Math.min(retryAfterS * 1000, maxRetryDelayMs);
          await this.block(retryAfterS);
        }

        WSLogger.warn({
          source: LOG_SOURCE,
          message: `Rate limited (429), retrying in ${retryDelay}ms (attempt ${attempt + 1}/${maxRetries})`,
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
 * Same retry logic but without proactive quota or block calls.
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
