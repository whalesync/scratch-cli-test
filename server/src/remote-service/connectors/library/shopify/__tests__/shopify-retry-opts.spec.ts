import { AxiosError } from 'axios';
import { withRetry, WithRetryOpts } from 'src/rate-limiter/rate-limiter';
import {
  isShopifyRateLimitError,
  isTransientShopifyServerError,
  SHOPIFY_RETRY_OPTS,
  ShopifyError,
} from '../shopify-api-client';

/** Build a raw AxiosError carrying the given HTTP status (+ optional headers), as the retry predicate sees it. */
function axiosErrorWithStatus(status: number, headers: Record<string, string> = {}): AxiosError {
  return Object.assign(new AxiosError(`Request failed with status code ${status}`), {
    response: { status, data: {}, statusText: '', headers, config: {} },
  });
}

describe('isShopifyRateLimitError', () => {
  it('is true for a transport-layer AxiosError 429', () => {
    expect(isShopifyRateLimitError(axiosErrorWithStatus(429))).toBe(true);
    expect(isShopifyRateLimitError(axiosErrorWithStatus(503))).toBe(false);
    expect(isShopifyRateLimitError(axiosErrorWithStatus(400))).toBe(false);
  });

  it('is true for a GraphQL-level THROTTLED ShopifyError (HTTP 200 body)', () => {
    expect(isShopifyRateLimitError(new ShopifyError('Throttled', 400, 'THROTTLED'))).toBe(true);
    expect(isShopifyRateLimitError(new ShopifyError('Query cost exceeds throttle limit', 400))).toBe(true);
  });

  it('is false for a non-throttle ShopifyError and non-error inputs', () => {
    expect(isShopifyRateLimitError(new ShopifyError('Bad input', 400, 'USER_ERROR'))).toBe(false);
    expect(isShopifyRateLimitError(new Error('429'))).toBe(false);
    expect(isShopifyRateLimitError(null)).toBe(false);
  });
});

describe('isTransientShopifyServerError', () => {
  it('is true for the gateway/availability 5xx set (502/503/504)', () => {
    expect(isTransientShopifyServerError(axiosErrorWithStatus(502))).toBe(true);
    expect(isTransientShopifyServerError(axiosErrorWithStatus(503))).toBe(true);
    expect(isTransientShopifyServerError(axiosErrorWithStatus(504))).toBe(true);
  });

  it('is false for 500 — a mutation may have landed, so a POST retry could duplicate', () => {
    expect(isTransientShopifyServerError(axiosErrorWithStatus(500))).toBe(false);
  });

  it('is false for 4xx and non-Axios inputs', () => {
    expect(isTransientShopifyServerError(axiosErrorWithStatus(429))).toBe(false);
    expect(isTransientShopifyServerError(axiosErrorWithStatus(404))).toBe(false);
    expect(isTransientShopifyServerError(new Error('503'))).toBe(false);
    expect(isTransientShopifyServerError(null)).toBe(false);
  });
});

describe('SHOPIFY_RETRY_OPTS.getRetryAfterS', () => {
  it('parses a positive Retry-After header from a 429', () => {
    expect(SHOPIFY_RETRY_OPTS.getRetryAfterS?.(axiosErrorWithStatus(429, { 'retry-after': '2' }))).toBe(2);
  });

  it('returns undefined when the header is absent, non-numeric, or non-positive', () => {
    expect(SHOPIFY_RETRY_OPTS.getRetryAfterS?.(axiosErrorWithStatus(429))).toBeUndefined();
    expect(SHOPIFY_RETRY_OPTS.getRetryAfterS?.(axiosErrorWithStatus(429, { 'retry-after': 'soon' }))).toBeUndefined();
    expect(SHOPIFY_RETRY_OPTS.getRetryAfterS?.(axiosErrorWithStatus(429, { 'retry-after': '0' }))).toBeUndefined();
    expect(SHOPIFY_RETRY_OPTS.getRetryAfterS?.(new ShopifyError('Throttled', 400, 'THROTTLED'))).toBeUndefined();
  });
});

describe('SHOPIFY_RETRY_OPTS retry policy', () => {
  // Small delay so the retry backoff doesn't slow the unit test.
  const FAST_RETRY: WithRetryOpts = { ...SHOPIFY_RETRY_OPTS, initialRetryDelayMs: 1, maxRetries: 3 };

  it('retries a transient 503 and recovers when it clears', async () => {
    const fn = jest.fn().mockRejectedValueOnce(axiosErrorWithStatus(503)).mockResolvedValueOnce('ok');

    await expect(withRetry(fn, FAST_RETRY)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries a transport-layer 429 and recovers', async () => {
    const fn = jest.fn().mockRejectedValueOnce(axiosErrorWithStatus(429)).mockResolvedValueOnce('ok');

    await expect(withRetry(fn, FAST_RETRY)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries a GraphQL-level THROTTLED ShopifyError and recovers (existing behavior intact)', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new ShopifyError('Throttled', 400, 'THROTTLED'))
      .mockResolvedValueOnce('ok');

    await expect(withRetry(fn, FAST_RETRY)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 500 — it surfaces immediately (mutation-duplicate safety)', async () => {
    const serverError = axiosErrorWithStatus(500);
    const fn = jest.fn().mockRejectedValue(serverError);

    await expect(withRetry(fn, FAST_RETRY)).rejects.toBe(serverError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a genuine GraphQL user error — it surfaces immediately', async () => {
    const userError = new ShopifyError('Title is required', 400, 'USER_ERROR');
    const fn = jest.fn().mockRejectedValue(userError);

    await expect(withRetry(fn, FAST_RETRY)).rejects.toBe(userError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
