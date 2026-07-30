import { AxiosError } from 'axios';
import { withRetry } from 'src/rate-limiter/rate-limiter';
import { isQuickBooksThrottleError, QUICKBOOKS_RETRY_OPTS } from '../quickbooks-api-client';

/** Build a raw AxiosError as the retry predicate sees it — before any QuickBooksError wrapping. */
function axiosErrorWithStatus(status: number, data: unknown = {}): AxiosError {
  return Object.assign(new AxiosError(`Request failed with status code ${status}`), {
    response: { status, data, statusText: '', headers: {}, config: {} },
  });
}

/** The Fault body QBO returns alongside `message=ThrottleExceeded; errorCode=003001; statusCode=429`. */
const THROTTLE_FAULT_BODY = {
  Fault: { Error: [{ Message: 'ThrottleExceeded', code: '003001' }], type: 'SystemFault' },
};

describe('isQuickBooksThrottleError', () => {
  it('is true for a 429', () => {
    expect(isQuickBooksThrottleError(axiosErrorWithStatus(429, THROTTLE_FAULT_BODY))).toBe(true);
    expect(isQuickBooksThrottleError(axiosErrorWithStatus(429))).toBe(true);
  });

  it('is true for the 003001 throttle Fault under a different status', () => {
    expect(isQuickBooksThrottleError(axiosErrorWithStatus(503, THROTTLE_FAULT_BODY))).toBe(true);
  });

  it('is false for unrelated errors, including other QBO Faults', () => {
    const staleObjectFault = { Fault: { Error: [{ Message: 'Stale Object Error', code: '5010' }] } };
    expect(isQuickBooksThrottleError(axiosErrorWithStatus(400, staleObjectFault))).toBe(false);
    expect(isQuickBooksThrottleError(axiosErrorWithStatus(401))).toBe(false);
    expect(isQuickBooksThrottleError(axiosErrorWithStatus(500))).toBe(false);
  });

  it('is false for non-Axios inputs', () => {
    expect(isQuickBooksThrottleError(new Error('429'))).toBe(false);
    expect(isQuickBooksThrottleError(null)).toBe(false);
  });
});

describe('QUICKBOOKS_RETRY_OPTS retry policy', () => {
  // Small delay so the backoff ladder doesn't slow the unit test.
  const FAST_RETRY = { ...QUICKBOOKS_RETRY_OPTS, initialRetryDelayMs: 1, maxRetries: 3 };

  it('retries a ThrottleExceeded 429 and recovers when the throttle clears', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(axiosErrorWithStatus(429, THROTTLE_FAULT_BODY))
      .mockResolvedValueOnce('ok');

    await expect(withRetry(fn, FAST_RETRY)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up and surfaces the 429 once retries are exhausted', async () => {
    const throttled = axiosErrorWithStatus(429, THROTTLE_FAULT_BODY);
    const fn = jest.fn().mockRejectedValue(throttled);

    await expect(withRetry(fn, FAST_RETRY)).rejects.toBe(throttled);
    expect(fn).toHaveBeenCalledTimes(4); // initial attempt + 3 retries
  });

  it('does not retry a non-throttle failure', async () => {
    const badRequest = axiosErrorWithStatus(400);
    const fn = jest.fn().mockRejectedValue(badRequest);

    await expect(withRetry(fn, FAST_RETRY)).rejects.toBe(badRequest);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('backs off long enough to outlast QBO’s per-minute throttle window', () => {
    // QBO's quota resets on a per-minute window and it sends no Retry-After, so
    // the ladder has to span a full minute or every retry lands inside the same
    // throttled window and the pull fails for nothing.
    const { maxRetries = 0, initialRetryDelayMs = 0 } = QUICKBOOKS_RETRY_OPTS;
    let delayMs = initialRetryDelayMs;
    let totalBackoffMs = 0;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      totalBackoffMs += delayMs;
      delayMs = Math.min(delayMs * 2, 60_000);
    }

    expect(totalBackoffMs).toBeGreaterThan(60_000);
  });
});
