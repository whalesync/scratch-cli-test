import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { RateLimiter, RateLimitWaitTimeoutError, withRetry } from '../rate-limiter';

/**
 * A stand-in for `RateLimiterRedis` with only the surface {@link RateLimiter}
 * touches. `consume` is a jest mock so each test scripts its own sequence of
 * "quota available" / "bucket saturated" outcomes.
 */
function fakeLimiter(opts?: { duration?: number }): RateLimiterRedis & {
  consume: jest.Mock;
  block: jest.Mock;
} {
  return {
    keyPrefix: 'rl:test:coa_1',
    duration: opts?.duration ?? 1,
    consume: jest.fn().mockResolvedValue(undefined),
    block: jest.fn().mockResolvedValue(undefined),
  } as unknown as RateLimiterRedis & { consume: jest.Mock; block: jest.Mock };
}

/** The rejection `rate-limiter-flexible` raises when the bucket is spent. */
function saturatedBucket(msBeforeNext: number): RateLimiterRes {
  return new RateLimiterRes(0, msBeforeNext, 0, undefined);
}

const RATE_LIMIT_ERROR = new Error('429 Too Many Requests');
const RETRY_OPTS_WITHOUT_COOLDOWN = { isRateLimited: (e: unknown) => e === RATE_LIMIT_ERROR, defaultCooldownS: 0 };

describe('RateLimiter.waitForQuota', () => {
  it('consumes a point and returns when quota is available', async () => {
    const limiter = fakeLimiter();

    await new RateLimiter(limiter).waitForQuota();

    expect(limiter.consume).toHaveBeenCalledWith('rl:test:coa_1', 1);
  });

  it('waits out a saturated bucket rather than issuing the request early', async () => {
    const limiter = fakeLimiter();
    limiter.consume.mockRejectedValueOnce(saturatedBucket(5)).mockResolvedValueOnce(undefined);

    await new RateLimiter(limiter).waitForQuota();

    expect(limiter.consume).toHaveBeenCalledTimes(2);
  });

  it('throws instead of proceeding unthrottled when the wait exceeds the budget', async () => {
    // The whole point of the limiter is that we know the limit and know we are at
    // it; issuing the request anyway would breach it exactly when the service is
    // most likely to answer 429.
    const limiter = fakeLimiter();
    limiter.consume.mockRejectedValue(saturatedBucket(60_000));

    await expect(new RateLimiter(limiter).waitForQuota(1, { maxWaitMs: 10 })).rejects.toBeInstanceOf(
      RateLimitWaitTimeoutError,
    );
    expect(limiter.consume).toHaveBeenCalledTimes(1);
  });

  it('derives the default wait budget from the limiter window, floored at 30s', async () => {
    // A 60s wait exceeds the floor a 1s-window limiter gets, but is well inside
    // budget for a 60s-window one, so "sit out the rest of the window" never
    // becomes a timeout.
    const shortWindow = fakeLimiter({ duration: 1 });
    shortWindow.consume.mockRejectedValue(saturatedBucket(60_000));
    await expect(new RateLimiter(shortWindow).waitForQuota()).rejects.toBeInstanceOf(RateLimitWaitTimeoutError);

    jest.useFakeTimers();
    try {
      const longWindow = fakeLimiter({ duration: 60 });
      longWindow.consume.mockRejectedValueOnce(saturatedBucket(30_000)).mockResolvedValueOnce(undefined);

      const waited = new RateLimiter(longWindow).waitForQuota();
      await jest.advanceTimersByTimeAsync(30_000);

      await expect(waited).resolves.toBeUndefined();
      expect(longWindow.consume).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('waits out a cooldown block that outlasts a short window, rather than burning the caller’s retries', async () => {
    // A 15s `block()` on a 1s-window limiter: without the 30s floor the sibling
    // requests would time out immediately and spend retries on nothing.
    jest.useFakeTimers();
    try {
      const limiter = fakeLimiter({ duration: 1 });
      limiter.consume.mockRejectedValueOnce(saturatedBucket(15_000)).mockResolvedValueOnce(undefined);

      const waited = new RateLimiter(limiter).waitForQuota();
      await jest.advanceTimersByTimeAsync(15_000);

      await expect(waited).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails open on a Redis error — an outage must not stall every connector', async () => {
    const limiter = fakeLimiter();
    limiter.consume.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(new RateLimiter(limiter).waitForQuota()).resolves.toBeUndefined();
  });
});

describe('RateLimiter.withRetry', () => {
  it('freezes the shared bucket on a 429 with no Retry-After, so siblings back off too', async () => {
    const limiter = fakeLimiter();
    const fn = jest.fn().mockRejectedValueOnce(RATE_LIMIT_ERROR).mockResolvedValueOnce('ok');

    await expect(
      new RateLimiter(limiter).withRetry(fn, {
        isRateLimited: (e) => e === RATE_LIMIT_ERROR,
        initialRetryDelayMs: 1,
      }),
    ).resolves.toBe('ok');

    expect(limiter.block).toHaveBeenCalledWith('rl:test:coa_1', 5);
  });

  it('honors an explicit Retry-After over the default cooldown', async () => {
    const limiter = fakeLimiter();
    const fn = jest.fn().mockRejectedValueOnce(RATE_LIMIT_ERROR).mockResolvedValueOnce('ok');

    await expect(
      new RateLimiter(limiter).withRetry(fn, {
        isRateLimited: (e) => e === RATE_LIMIT_ERROR,
        getRetryAfterS: () => 2,
        defaultCooldownS: 30,
        initialRetryDelayMs: 1,
      }),
    ).resolves.toBe('ok');

    expect(limiter.block).toHaveBeenCalledWith('rl:test:coa_1', 2);
  });

  it('retries a saturated bucket instead of surfacing the wait timeout', async () => {
    const limiter = fakeLimiter();
    limiter.consume.mockRejectedValueOnce(saturatedBucket(60_000)).mockResolvedValue(undefined);
    const fn = jest.fn().mockResolvedValue('ok');

    await expect(
      new RateLimiter(limiter).withRetry(fn, { ...RETRY_OPTS_WITHOUT_COOLDOWN, initialRetryDelayMs: 1 }),
    ).resolves.toBe('ok');

    // No block: the bucket is already full, freezing it further helps nobody.
    expect(limiter.block).not.toHaveBeenCalled();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('surfaces the wait timeout once retries are exhausted', async () => {
    const limiter = fakeLimiter();
    limiter.consume.mockRejectedValue(saturatedBucket(60_000));
    const fn = jest.fn();

    await expect(
      new RateLimiter(limiter).withRetry(fn, {
        ...RETRY_OPTS_WITHOUT_COOLDOWN,
        initialRetryDelayMs: 1,
        maxRetries: 2,
      }),
    ).rejects.toBeInstanceOf(RateLimitWaitTimeoutError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('rethrows a non-rate-limit error immediately without blocking the bucket', async () => {
    const limiter = fakeLimiter();
    const boom = new Error('400 Bad Request');
    const fn = jest.fn().mockRejectedValue(boom);

    await expect(new RateLimiter(limiter).withRetry(fn, RETRY_OPTS_WITHOUT_COOLDOWN)).rejects.toBe(boom);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(limiter.block).not.toHaveBeenCalled();
  });
});

describe('standalone withRetry', () => {
  it('ignores defaultCooldownS — there is no shared bucket to freeze', async () => {
    const fn = jest.fn().mockRejectedValueOnce(RATE_LIMIT_ERROR).mockResolvedValueOnce('ok');
    const startedAtMs = Date.now();

    await expect(
      withRetry(fn, {
        isRateLimited: (e) => e === RATE_LIMIT_ERROR,
        defaultCooldownS: 30,
        initialRetryDelayMs: 1,
      }),
    ).resolves.toBe('ok');

    expect(Date.now() - startedAtMs).toBeLessThan(1000);
  });
});
