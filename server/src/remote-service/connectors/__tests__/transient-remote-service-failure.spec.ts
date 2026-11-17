import { AxiosError, CanceledError } from 'axios';
import { HubspotError } from '../library/hubspot/hubspot-api-client';
import { NotionError } from '../library/notion/notion-api-client';
import { isTransientRemoteServiceFailure } from '../transient-remote-service-failure';

/** A raw AxiosError for a response the service sent with this HTTP status. */
function axiosErrorWithResponseStatus(status: number): AxiosError {
  return Object.assign(new AxiosError(`Request failed with status code ${status}`, AxiosError.ERR_BAD_RESPONSE), {
    response: { status, data: {}, statusText: '', headers: {}, config: {} },
  });
}

/** A raw AxiosError for a request that never got a response, as axios reports a socket-level failure. */
function axiosErrorWithNoResponse(networkErrorCode: string, message: string): AxiosError {
  return new AxiosError(message, networkErrorCode);
}

/** A Node system error, as `net`/`tls` (and the clients built on them) throw it. */
function nodeSystemError(networkErrorCode: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`read ${networkErrorCode}`), { code: networkErrorCode });
}

describe('isTransientRemoteServiceFailure', () => {
  it('is true for the dropped connection that failed the VITL HubSpot Live Export (DEV-12926)', () => {
    expect(isTransientRemoteServiceFailure(axiosErrorWithNoResponse('ECONNRESET', 'read ECONNRESET'))).toBe(true);
  });

  it.each(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'EHOSTUNREACH'])(
    'is true for an axios request that got no response because of %s',
    (networkErrorCode) => {
      expect(isTransientRemoteServiceFailure(axiosErrorWithNoResponse(networkErrorCode, 'failed'))).toBe(true);
    },
  );

  it.each(['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'])(
    'is true for a Node or undici system error with code %s',
    (networkErrorCode) => {
      expect(isTransientRemoteServiceFailure(nodeSystemError(networkErrorCode))).toBe(true);
    },
  );

  it('is false for a host that does not resolve, which a retry cannot fix', () => {
    expect(isTransientRemoteServiceFailure(axiosErrorWithNoResponse('ENOTFOUND', 'getaddrinfo ENOTFOUND'))).toBe(false);
  });

  it.each([500, 502, 503, 504])('is true for an axios response with status %i', (status) => {
    expect(isTransientRemoteServiceFailure(axiosErrorWithResponseStatus(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 422, 429, 501])('is false for an axios response with status %i', (status) => {
    expect(isTransientRemoteServiceFailure(axiosErrorWithResponseStatus(status))).toBe(false);
  });

  it("reads a connector error class's numeric statusCode", () => {
    expect(isTransientRemoteServiceFailure(new HubspotError('HubSpot is down', 503))).toBe(true);
    expect(isTransientRemoteServiceFailure(new HubspotError('Not found', 404))).toBe(false);
    expect(isTransientRemoteServiceFailure(new HubspotError('No status'))).toBe(false);
  });

  it("reads a connector error class's numeric status", () => {
    const notionServerError = new NotionError({
      code: 'internal_server_error',
      message: 'Unexpected error',
      status: 500,
      headers: {},
      body: {},
    });
    expect(isTransientRemoteServiceFailure(notionServerError)).toBe(true);
  });

  it('ignores a status that is not a number', () => {
    expect(isTransientRemoteServiceFailure(Object.assign(new Error('failed'), { status: '503' }))).toBe(false);
  });

  it('finds a transient failure wrapped as the cause of another error', () => {
    const wrappedDroppedConnection = new Error('Fetching conversations failed', {
      cause: axiosErrorWithNoResponse('ECONNRESET', 'socket hang up'),
    });
    expect(isTransientRemoteServiceFailure(wrappedDroppedConnection)).toBe(true);
  });

  it('is false for a request we canceled ourselves', () => {
    expect(isTransientRemoteServiceFailure(new CanceledError())).toBe(false);
  });

  it('is false for errors that carry no network code or HTTP status', () => {
    expect(isTransientRemoteServiceFailure(new Error('read ECONNRESET'))).toBe(false);
    expect(isTransientRemoteServiceFailure(Object.assign(new Error('Unique constraint'), { code: 'P2002' }))).toBe(
      false,
    );
    expect(isTransientRemoteServiceFailure(null)).toBe(false);
    expect(isTransientRemoteServiceFailure(undefined)).toBe(false);
    expect(isTransientRemoteServiceFailure('ECONNRESET')).toBe(false);
  });

  it('stops following a cause chain that loops back on itself', () => {
    const errorThatIsItsOwnCause = new Error('loop');
    Object.assign(errorThatIsItsOwnCause, { cause: errorThatIsItsOwnCause });
    expect(isTransientRemoteServiceFailure(errorThatIsItsOwnCause)).toBe(false);
  });
});
