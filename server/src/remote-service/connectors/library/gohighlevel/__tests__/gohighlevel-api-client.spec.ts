import { AxiosError } from 'axios';
import { withRetry } from 'src/rate-limiter/rate-limiter';
import {
  GOHIGHLEVEL_RETRY_OPTS,
  GoHighLevelError,
  isGoHighLevelNotFoundError,
  isTransientGoHighLevelSearchError,
} from '../gohighlevel-api-client';

describe('isGoHighLevelNotFoundError', () => {
  it('treats a 404 as not-found', () => {
    expect(isGoHighLevelNotFoundError(new GoHighLevelError('gone', 404, { message: 'Not Found' }))).toBe(true);
  });

  it('treats HighLevel\'s 400 "Contact not found for id:…" as not-found (read-replica lag / just-deleted)', () => {
    const error = new GoHighLevelError('HighLevel GET /contacts/x failed (400)', 400, {
      message: 'Contact not found for id:zO9n4NyWiri3ngS2w39x',
      error: 'Bad Request',
      statusCode: 400,
    });
    expect(isGoHighLevelNotFoundError(error)).toBe(true);
  });

  it('falls back to the error message when the 400 body carries no `message` string', () => {
    expect(isGoHighLevelNotFoundError(new GoHighLevelError('record not found', 400, undefined))).toBe(true);
  });

  it('does NOT swallow a real 400 bad-request (so genuine validation errors still throw)', () => {
    const error = new GoHighLevelError('HighLevel POST /contacts failed (400)', 400, {
      message: 'phone is invalid',
      error: 'Bad Request',
    });
    expect(isGoHighLevelNotFoundError(error)).toBe(false);
  });

  it('does not treat other status codes as not-found', () => {
    expect(isGoHighLevelNotFoundError(new GoHighLevelError('server error', 500, {}))).toBe(false);
    expect(isGoHighLevelNotFoundError(new GoHighLevelError('rate limited', 429, {}))).toBe(false);
  });

  it('handles a raw AxiosError 404 defensively (interceptor bypassed)', () => {
    const axiosError = Object.assign(new AxiosError('Request failed with status code 404'), {
      response: { status: 404, data: {}, statusText: 'Not Found', headers: {}, config: {} },
    });
    expect(isGoHighLevelNotFoundError(axiosError)).toBe(true);
  });

  it('returns false for non-error inputs', () => {
    expect(isGoHighLevelNotFoundError(null)).toBe(false);
    expect(isGoHighLevelNotFoundError('not found')).toBe(false);
    expect(isGoHighLevelNotFoundError(new Error('not found'))).toBe(false);
  });
});

describe('isTransientGoHighLevelSearchError', () => {
  it("treats HighLevel's transient search 400 (server-side ES error) as retryable", () => {
    const error = new GoHighLevelError('HighLevel POST /contacts/search failed (400)', 400, {
      status: 400,
      message: 'Error occurred while searching for contact',
      name: 'HttpException',
      traceId: '4f8b91c1-90a0-4a0a-884d-bfd93dd65c54',
    });
    expect(isTransientGoHighLevelSearchError(error)).toBe(true);
  });

  it('does NOT treat a genuine 400 validation error as transient (real bad requests still surface)', () => {
    const error = new GoHighLevelError('HighLevel POST /contacts failed (400)', 400, {
      message: 'phone is invalid',
      error: 'Bad Request',
    });
    expect(isTransientGoHighLevelSearchError(error)).toBe(false);
  });

  it('does NOT treat the 400 "Contact not found for id" absence signal as transient', () => {
    const error = new GoHighLevelError('HighLevel GET /contacts/x failed (400)', 400, {
      message: 'Contact not found for id:zO9n4NyWiri3ngS2w39x',
      error: 'Bad Request',
      statusCode: 400,
    });
    expect(isTransientGoHighLevelSearchError(error)).toBe(false);
  });

  it('is strictly a 400 signature — same message on another status is not transient', () => {
    const searchMessage = { message: 'Error occurred while searching for contact' };
    expect(isTransientGoHighLevelSearchError(new GoHighLevelError('not found', 404, searchMessage))).toBe(false);
    expect(isTransientGoHighLevelSearchError(new GoHighLevelError('rate limited', 429, searchMessage))).toBe(false);
    expect(isTransientGoHighLevelSearchError(new GoHighLevelError('server error', 500, searchMessage))).toBe(false);
  });

  it('handles a raw AxiosError 400 defensively (interceptor bypassed)', () => {
    const axiosError = Object.assign(new AxiosError('Request failed with status code 400'), {
      response: {
        status: 400,
        data: { message: 'Error occurred while searching for contact', name: 'HttpException', traceId: 'x' },
        statusText: 'Bad Request',
        headers: {},
        config: {},
      },
    });
    expect(isTransientGoHighLevelSearchError(axiosError)).toBe(true);
  });

  it('returns false for non-error inputs (even when they contain the message text)', () => {
    expect(isTransientGoHighLevelSearchError(null)).toBe(false);
    expect(isTransientGoHighLevelSearchError('Error occurred while searching for contact')).toBe(false);
    expect(isTransientGoHighLevelSearchError(new Error('Error occurred while searching for contact'))).toBe(false);
  });
});

describe('GOHIGHLEVEL_RETRY_OPTS retry policy', () => {
  // Small delay so the retry backoff doesn't slow the unit test.
  const FAST_RETRY = { ...GOHIGHLEVEL_RETRY_OPTS, initialRetryDelayMs: 1, maxRetries: 3 };

  it("retries HighLevel's transient search 400 and recovers when it clears (DEV-10706)", async () => {
    const transient = new GoHighLevelError('HighLevel POST /contacts/search failed (400)', 400, {
      status: 400,
      message: 'Error occurred while searching for contact',
      name: 'HttpException',
      traceId: '4f8b91c1-90a0-4a0a-884d-bfd93dd65c54',
    });
    const fn = jest.fn().mockRejectedValueOnce(transient).mockResolvedValueOnce('ok');

    await expect(withRetry(fn, FAST_RETRY)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a genuine validation 400 — it surfaces immediately', async () => {
    const badRequest = new GoHighLevelError('HighLevel POST /contacts failed (400)', 400, {
      message: 'phone is invalid',
      error: 'Bad Request',
    });
    const fn = jest.fn().mockRejectedValue(badRequest);

    await expect(withRetry(fn, FAST_RETRY)).rejects.toBe(badRequest);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('still retries a 429 rate-limit and recovers (existing behavior intact)', async () => {
    const rateLimited = Object.assign(new AxiosError('Request failed with status code 429'), {
      response: { status: 429, data: {}, statusText: 'Too Many Requests', headers: {}, config: {} },
    });
    const fn = jest.fn().mockRejectedValueOnce(rateLimited).mockResolvedValueOnce('ok');

    await expect(withRetry(fn, FAST_RETRY)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
