import { AxiosError } from 'axios';
import { GoHighLevelError, isGoHighLevelNotFoundError } from '../gohighlevel-api-client';

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
