import { InternalServerErrorException } from '@nestjs/common';
import axios from 'axios';
import { WSLogger } from '../../../logger';
import { Connector } from '../connector';
import {
  ConnectorAuthError,
  exceptionForConnectorError,
  extractCommonDetailsFromAxiosError,
  isConnectorCredentialRejection,
} from '../error';
import { ConnectorErrorDetails } from '../types';

jest.mock('../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Webflow'),
}));

/** Build an axios error carrying a given HTTP status + response body. */
function makeAxiosError(status: number, data: unknown): axios.AxiosError {
  return new axios.AxiosError(`Request failed with status code ${status}`, String(status), undefined, undefined, {
    status,
    statusText: '',
    headers: {},
    config: {} as never,
    data,
  });
}

/**
 * A minimal stand-in for a connector. `exceptionForConnectorError` only reads
 * `service` and `extractConnectorErrorDetails`, so the rest of the abstract
 * surface is irrelevant here.
 */
function connectorStub(details: ConnectorErrorDetails): Connector {
  return {
    service: 'WEBFLOW',
    extractConnectorErrorDetails: () => details,
  } as unknown as Connector;
}

describe('exceptionForConnectorError', () => {
  let loggedErrors: jest.SpyInstance;

  beforeEach(() => {
    loggedErrors = jest.spyOn(WSLogger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('isConnectorCredentialRejection', () => {
    it.each([401, 403])('treats HTTP %i as a credential rejection', (status) => {
      expect(isConnectorCredentialRejection(makeAxiosError(status, {}))).toBe(true);
    });

    it.each([400, 404, 409, 429, 500])('does not treat HTTP %i as a credential rejection', (status) => {
      expect(isConnectorCredentialRejection(makeAxiosError(status, {}))).toBe(false);
    });

    it('does not treat a non-axios error as a credential rejection', () => {
      expect(isConnectorCredentialRejection(new Error('boom'))).toBe(false);
    });
  });

  // DEV-11321: a Webflow token missing `cms:read` produced a 500 on every attempt.
  // A 500 tells the user nothing and tells them to retry; the failure was theirs to fix.
  it('turns a 403 into a ConnectorAuthError carrying the user-friendly message', () => {
    const connector = connectorStub({
      userFriendlyMessage: "Scratch's connection to Webflow doesn't have permission. Webflow says: missing cms:read",
      description: 'missing cms:read',
    });

    const exception = exceptionForConnectorError(makeAxiosError(403, {}), connector);

    expect(exception).toBeInstanceOf(ConnectorAuthError);
    const authError = exception as ConnectorAuthError;
    expect(authError.userFriendlyMessage).toContain('missing cms:read');
    expect(authError.service).toBe('WEBFLOW');
  });

  it('turns a 401 into a ConnectorAuthError', () => {
    const connector = connectorStub({ userFriendlyMessage: 'creds are no longer valid' });
    expect(exceptionForConnectorError(makeAxiosError(401, {}), connector)).toBeInstanceOf(ConnectorAuthError);
  });

  /**
   * Callers outside the HTTP layer read `.message` and show it verbatim — a failed
   * pull stores it as the job's `failedReason`, which the client renders as
   * "Pull failed: <failedReason>". Using the raw `description` here regressed that
   * to "Request failed with status code 401" for services whose auth body this
   * module can't mine.
   */
  it('exposes the user-friendly text as `message`, for callers that read `.message`', () => {
    const connector = connectorStub({
      userFriendlyMessage: 'The credentials Scratch uses to communicate with Airtable are no longer valid.',
      description: 'Request failed with status code 401',
    });

    const authError = exceptionForConnectorError(makeAxiosError(401, {}), connector) as ConnectorAuthError;

    expect(authError.message).toBe('The credentials Scratch uses to communicate with Airtable are no longer valid.');
    expect(authError.message).not.toContain('Request failed with status code');
  });

  it('leaves a genuine server-side failure as a 500', () => {
    const connector = connectorStub({ userFriendlyMessage: 'Webflow is down' });

    const exception = exceptionForConnectorError(makeAxiosError(500, {}), connector);

    expect(exception).toBeInstanceOf(InternalServerErrorException);
    expect(exception).not.toBeInstanceOf(ConnectorAuthError);
  });

  it('leaves a non-HTTP failure as a 500', () => {
    const connector = connectorStub({ userFriendlyMessage: 'something went wrong' });
    expect(exceptionForConnectorError(new Error('boom'), connector)).toBeInstanceOf(InternalServerErrorException);
  });

  // The original incident produced 59 customer-facing failures over five hours and
  // zero application log lines, because both branches return an exception that
  // Nest's default filter does not log.
  it.each([
    ['a credential rejection', makeAxiosError(403, {})],
    ['a server-side failure', makeAxiosError(500, {})],
    ['a non-HTTP failure', new Error('boom')],
  ])('logs %s', (_label, error) => {
    exceptionForConnectorError(error, connectorStub({ userFriendlyMessage: 'nope' }));
    expect(loggedErrors).toHaveBeenCalledTimes(1);
  });

  // The mining helper is what turns "you are unauthorized" into "…and here is why".
  // It reached only top-level keys at first, so nested bodies produced nothing.
  describe('service-provided auth detail', () => {
    const connector = { service: 'WEBFLOW' } as unknown as Connector;

    function messageFor(status: number, body: unknown): string {
      const details = extractCommonDetailsFromAxiosError(connector, makeAxiosError(status, body));
      expect(details).not.toBeNull();
      return (details as ConnectorErrorDetails).userFriendlyMessage;
    }

    it('mines a top-level `message` (Webflow shape)', () => {
      expect(messageFor(403, { message: "You are missing the following scopes - 'cms:read'" })).toContain(
        "missing the following scopes - 'cms:read'",
      );
    });

    it('mines a nested `error.message` (Airtable shape)', () => {
      expect(
        messageFor(401, { error: { type: 'AUTHENTICATION_REQUIRED', message: 'Invalid authentication token' } }),
      ).toContain('Invalid authentication token');
    });

    it('prefers a prose `error_description` over a terse `error` code (OAuth shape)', () => {
      const message = messageFor(401, { error: 'invalid_token', error_description: 'The access token has expired' });
      expect(message).toContain('The access token has expired');
      expect(message).not.toContain('invalid_token');
    });

    it('falls back to a bare string `error`', () => {
      expect(messageFor(403, { error: 'Insufficient permission for this resource' })).toContain(
        'Insufficient permission for this resource',
      );
    });

    it('adds nothing when the body carries no usable explanation', () => {
      expect(messageFor(401, { code: 42 })).toBe(messageFor(401, {}));
    });
  });

  it('logs the status and url that identify which call failed', () => {
    const error = makeAxiosError(403, {});
    error.config = { method: 'get', url: '/sites/site1/collections' } as never;

    exceptionForConnectorError(error, connectorStub({ userFriendlyMessage: 'nope' }));

    expect(loggedErrors).toHaveBeenCalledWith(
      expect.objectContaining({
        service: 'WEBFLOW',
        status: 403,
        url: '/sites/site1/collections',
        isCredentialRejection: true,
      }),
    );
  });

  /**
   * `expandedErrorsFormat` in logger.ts expands an Error by spreading its own
   * enumerable properties, and an AxiosError carries `config` — whose
   * `headers.Authorization` the api-client interceptor has already set to the
   * customer's live token. Passing the raw error here wrote that credential into
   * Cloud Logging on every connector failure.
   */
  describe('credential safety', () => {
    function logRecordFor(error: axios.AxiosError): Record<string, unknown> {
      exceptionForConnectorError(error, connectorStub({ userFriendlyMessage: 'nope' }));
      const [firstCall] = loggedErrors.mock.calls as unknown[][];
      return firstCall[0] as Record<string, unknown>;
    }

    it('never hands the raw Error to the logger', () => {
      const error = makeAxiosError(401, {});
      const record = logRecordFor(error);

      // Any Error-valued field would be spread by `expandedErrorsFormat`.
      for (const value of Object.values(record)) {
        expect(value).not.toBeInstanceOf(Error);
      }
      expect(Object.values(record)).not.toContain(error);
    });

    it('does not log the Authorization header', () => {
      const error = makeAxiosError(403, {});
      error.config = {
        method: 'get',
        url: '/sites/site1/collections',
        headers: { Authorization: 'Bearer SUPER_SECRET_CUSTOMER_TOKEN' },
      } as never;

      expect(JSON.stringify(logRecordFor(error))).not.toContain('SUPER_SECRET_CUSTOMER_TOKEN');
    });

    it('redacts a credential passed in the query string', () => {
      const error = makeAxiosError(401, {});
      error.config = { method: 'get', url: '/v1/records', params: { api_key: 'SECRET_QUERY_KEY' } } as never;

      const record = logRecordFor(error);
      expect(JSON.stringify(record)).not.toContain('SECRET_QUERY_KEY');
      expect(record.url).toContain('REDACTED');
    });
  });
});
