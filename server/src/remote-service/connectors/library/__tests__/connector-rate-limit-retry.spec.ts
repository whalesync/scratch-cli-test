import { AxiosError } from 'axios';
import { withRetry } from 'src/rate-limiter/rate-limiter';
import { BREVO_RETRY_OPTS, isBrevoRateLimitError } from '../brevo/brevo-api-client';
import { INTERCOM_RETRY_OPTS, isIntercomRateLimitError } from '../intercom/intercom-api-client';
import { isMemberstackRateLimitError, MEMBERSTACK_RETRY_OPTS } from '../memberstack/memberstack-api-client';
import { isStripeRateLimitError, STRIPE_RETRY_OPTS } from '../stripe/stripe-api-client';

/**
 * Cross-connector coverage for the four connectors that declared a
 * `rateLimiterSpec` but never wired a limiter or a retry (DEV-11151 follow-up).
 * Each service detects and paces throttling differently, so the shared contract
 * is asserted per connector rather than assumed.
 */

/** Build a raw AxiosError as the retry predicates see it — before any wrapping. */
function axiosError(status: number, opts?: { data?: unknown; headers?: Record<string, string> }): AxiosError {
  return Object.assign(new AxiosError(`Request failed with status code ${status}`), {
    response: { status, data: opts?.data ?? {}, statusText: '', headers: opts?.headers ?? {}, config: {} },
  });
}

describe.each([
  ['Stripe', isStripeRateLimitError, STRIPE_RETRY_OPTS],
  ['Brevo', isBrevoRateLimitError, BREVO_RETRY_OPTS],
  ['Memberstack', isMemberstackRateLimitError, MEMBERSTACK_RETRY_OPTS],
  ['Intercom', isIntercomRateLimitError, INTERCOM_RETRY_OPTS],
] as const)('%s throttle detection', (_service, isRateLimited, retryOpts) => {
  it('matches a 429', () => {
    expect(isRateLimited(axiosError(429))).toBe(true);
  });

  it('does not match unrelated failures', () => {
    expect(isRateLimited(axiosError(401))).toBe(false);
    expect(isRateLimited(axiosError(404))).toBe(false);
    expect(isRateLimited(axiosError(500))).toBe(false);
  });

  it('does not match non-Axios inputs', () => {
    expect(isRateLimited(new Error('429'))).toBe(false);
    expect(isRateLimited(null)).toBe(false);
    expect(isRateLimited(undefined)).toBe(false);
  });

  it('retries a 429 and recovers when the throttle clears', async () => {
    const fn = jest.fn().mockRejectedValueOnce(axiosError(429)).mockResolvedValueOnce('ok');

    await expect(withRetry(fn, { ...retryOpts, initialRetryDelayMs: 1, maxRetries: 2 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('surfaces a non-throttle error immediately, without retrying', async () => {
    const badRequest = axiosError(400);
    const fn = jest.fn().mockRejectedValue(badRequest);

    await expect(withRetry(fn, { ...retryOpts, initialRetryDelayMs: 1, maxRetries: 2 })).rejects.toBe(badRequest);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('Stripe rate-limit specifics', () => {
  it('matches lock_timeout, which Stripe also returns as 429 and tells you to retry', () => {
    const lockTimeout = axiosError(429, { data: { error: { code: 'lock_timeout', type: 'invalid_request_error' } } });
    expect(isStripeRateLimitError(lockTimeout)).toBe(true);
  });

  it('does not depend on error.type — Stripe omits `rate_limit_error` from its documented enum', () => {
    // A 429 with no usable body must still be detected; keying off `error.type`
    // here would fail closed and the retry would never fire.
    expect(isStripeRateLimitError(axiosError(429, { data: {} }))).toBe(true);
  });

  it('does not claim a Retry-After Stripe never documents', () => {
    expect(STRIPE_RETRY_OPTS.getRetryAfterS).toBeUndefined();
  });
});

describe('Brevo rate-limit specifics', () => {
  it('reads x-sib-ratelimit-reset as a RELATIVE duration in seconds', () => {
    const throttled = axiosError(429, { headers: { 'x-sib-ratelimit-reset': '45' } });
    expect(BREVO_RETRY_OPTS.getRetryAfterS?.(throttled)).toBe(45);
  });

  it('falls back to backoff when the header is absent or unusable', () => {
    expect(BREVO_RETRY_OPTS.getRetryAfterS?.(axiosError(429))).toBeUndefined();
    expect(BREVO_RETRY_OPTS.getRetryAfterS?.(axiosError(429, { headers: { 'x-sib-ratelimit-reset': 'soon' } }))).toBe(
      undefined,
    );
    expect(BREVO_RETRY_OPTS.getRetryAfterS?.(axiosError(429, { headers: { 'x-sib-ratelimit-reset': '0' } }))).toBe(
      undefined,
    );
  });

  it('caps an implausible reset so a units change cannot cause an hours-long sleep', () => {
    // 45000 would be the same 45s expressed in milliseconds.
    const inMilliseconds = axiosError(429, { headers: { 'x-sib-ratelimit-reset': '45000' } });
    expect(BREVO_RETRY_OPTS.getRetryAfterS?.(inMilliseconds)).toBe(120);
  });
});

describe('Intercom rate-limit specifics', () => {
  it('reads X-RateLimit-Reset as an ABSOLUTE Unix timestamp, not a duration', () => {
    // The unit trap: Brevo's reset header is relative, Intercom's is absolute.
    // Treating this one as a duration would sleep for decades.
    const resetAtUnixSeconds = Math.floor(Date.now() / 1000) + 8;
    const throttled = axiosError(429, { headers: { 'x-ratelimit-reset': String(resetAtUnixSeconds) } });

    const waitSeconds = INTERCOM_RETRY_OPTS.getRetryAfterS?.(throttled);
    expect(waitSeconds).toBeGreaterThan(0);
    expect(waitSeconds).toBeLessThanOrEqual(9);
  });

  it('prefers Retry-After when Intercom happens to send one', () => {
    const throttled = axiosError(429, {
      headers: { 'retry-after': '3', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 30) },
    });
    expect(INTERCOM_RETRY_OPTS.getRetryAfterS?.(throttled)).toBe(3);
  });

  it('falls back to backoff for a reset that has already passed', () => {
    const alreadyReset = axiosError(429, {
      headers: { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) - 30) },
    });
    expect(INTERCOM_RETRY_OPTS.getRetryAfterS?.(alreadyReset)).toBeUndefined();
  });

  it('matches the documented throttle codes even without a 429 status', () => {
    const rateLimited = axiosError(400, { data: { type: 'error.list', errors: [{ code: 'rate_limit_exceeded' }] } });
    const retryAfter = axiosError(400, { data: { type: 'error.list', errors: [{ code: 'retry_after' }] } });
    const unrelated = axiosError(400, { data: { type: 'error.list', errors: [{ code: 'parameter_invalid' }] } });

    expect(isIntercomRateLimitError(rateLimited)).toBe(true);
    expect(isIntercomRateLimitError(retryAfter)).toBe(true);
    expect(isIntercomRateLimitError(unrelated)).toBe(false);
  });
});
