import { AxiosError } from 'axios';
import { withRetry } from 'src/rate-limiter/rate-limiter';
import { ATTIO_RETRY_OPTS, AttioError, isAttioRateLimitError, isTransientAttioServerError } from '../attio-api-client';

/** Build a raw AxiosError carrying the given HTTP status, as the retry predicate sees it. */
function axiosErrorWithStatus(status: number): AxiosError {
  return Object.assign(new AxiosError(`Request failed with status code ${status}`), {
    response: { status, data: {}, statusText: '', headers: {}, config: {} },
  });
}

describe('isAttioRateLimitError', () => {
  it('is true only for an AxiosError 429', () => {
    expect(isAttioRateLimitError(axiosErrorWithStatus(429))).toBe(true);
    expect(isAttioRateLimitError(axiosErrorWithStatus(503))).toBe(false);
    expect(isAttioRateLimitError(axiosErrorWithStatus(400))).toBe(false);
  });

  it('is false for non-Axios inputs', () => {
    expect(isAttioRateLimitError(new Error('429'))).toBe(false);
    expect(isAttioRateLimitError(null)).toBe(false);
    expect(isAttioRateLimitError(new AttioError('boom', 429))).toBe(false);
  });
});

describe('isTransientAttioServerError', () => {
  it('is true for the gateway/availability 5xx set (502/503/504)', () => {
    expect(isTransientAttioServerError(axiosErrorWithStatus(502))).toBe(true);
    expect(isTransientAttioServerError(axiosErrorWithStatus(503))).toBe(true);
    expect(isTransientAttioServerError(axiosErrorWithStatus(504))).toBe(true);
  });

  it('is false for 500 — a create may have landed, so a POST retry could duplicate', () => {
    expect(isTransientAttioServerError(axiosErrorWithStatus(500))).toBe(false);
  });

  it('is false for 4xx and non-Axios inputs', () => {
    expect(isTransientAttioServerError(axiosErrorWithStatus(429))).toBe(false);
    expect(isTransientAttioServerError(axiosErrorWithStatus(404))).toBe(false);
    expect(isTransientAttioServerError(new Error('503'))).toBe(false);
    expect(isTransientAttioServerError(null)).toBe(false);
  });
});

describe('ATTIO_RETRY_OPTS retry policy', () => {
  // Small delay so the retry backoff doesn't slow the unit test.
  const FAST_RETRY = { ...ATTIO_RETRY_OPTS, initialRetryDelayMs: 1, maxRetries: 3 };

  it('retries a transient 503 and recovers when it clears', async () => {
    const fn = jest.fn().mockRejectedValueOnce(axiosErrorWithStatus(503)).mockResolvedValueOnce('ok');

    await expect(withRetry(fn, FAST_RETRY)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('still retries a 429 rate-limit and recovers (existing behavior intact)', async () => {
    const fn = jest.fn().mockRejectedValueOnce(axiosErrorWithStatus(429)).mockResolvedValueOnce('ok');

    await expect(withRetry(fn, FAST_RETRY)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 500 — it surfaces immediately (create-duplicate safety)', async () => {
    const serverError = axiosErrorWithStatus(500);
    const fn = jest.fn().mockRejectedValue(serverError);

    await expect(withRetry(fn, FAST_RETRY)).rejects.toBe(serverError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a genuine 4xx validation error — it surfaces immediately', async () => {
    const badRequest = axiosErrorWithStatus(400);
    const fn = jest.fn().mockRejectedValue(badRequest);

    await expect(withRetry(fn, FAST_RETRY)).rejects.toBe(badRequest);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
