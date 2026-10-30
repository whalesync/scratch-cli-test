import { InternalServerErrorException } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { Agent, createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { expandedErrorsFormat, WSLogger, WSLoggerShim } from 'src/logger';
import winston from 'winston';

// DEV-12581: an AxiosError's own `config`, `request` and `response` carry the request's credentials, and its `toJSON()`
// serializes `config` too, so a logged AxiosError must never reach the log line as itself.

const ACCESS_TOKEN_IN_THE_AUTHORIZATION_HEADER = 'tok_live_SECRET_IN_THE_AUTHORIZATION_HEADER';
const API_KEY_IN_THE_QUERY_STRING = 'key_live_SECRET_IN_THE_QUERY_STRING';
const WEBHOOK_SECRET_IN_THE_URL_PATH = 'whsec_SECRET_IN_THE_URL_PATH';
const EVERY_CREDENTIAL_A_FAILED_REQUEST_CARRIES = [
  ACCESS_TOKEN_IN_THE_AUTHORIZATION_HEADER,
  API_KEY_IN_THE_QUERY_STRING,
  WEBHOOK_SECRET_IN_THE_URL_PATH,
];

/** Where winston's formats leave the finished line (`triple-beam`'s MESSAGE, not a declared dependency). */
const FORMATTED_LOG_LINE = Symbol.for('message');

/** The two transport formats WSLogger finishes with: `json()` in the cloud, `simple()` locally. */
const LOG_LINE_FORMATS = ['json', 'simple'] as const;
type LogLineFormat = (typeof LOG_LINE_FORMATS)[number];

/** `fields` after `expandedErrorsFormat`, given the shallow copy winston-transport hands a transport's format. */
function applyExpandedErrorsFormat(fields: Record<string, unknown>): Record<string, unknown> {
  const transformed = expandedErrorsFormat().transform(
    Object.assign({ level: 'error', message: 'Something failed', source: 'logger.spec' }, fields),
  );
  if (typeof transformed !== 'object') throw new Error('the format dropped the log line');
  return transformed;
}

/** The line a WSLogger transport writes for `fields`. */
function formatLogLine(fields: Record<string, unknown>, lineFormat: LogLineFormat): string {
  const transportFormat = winston.format.combine(
    expandedErrorsFormat(),
    lineFormat === 'json' ? winston.format.json() : winston.format.simple(),
  );
  const transformed = transportFormat.transform(
    Object.assign({ level: 'error', message: 'Something failed', source: 'logger.spec' }, fields),
  );
  if (typeof transformed !== 'object') throw new Error('the format dropped the log line');
  const formattedLogLine = transformed[FORMATTED_LOG_LINE];
  if (typeof formattedLogLine !== 'string') throw new Error('the format produced no log line');
  return formattedLogLine;
}

/** The JSON log line for `fields`, parsed back. */
function loggedJsonFor(fields: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(formatLogLine(fields, 'json')) as Record<string, unknown>;
}

function expectNoCredentialIn(formattedLogLine: string): void {
  for (const credential of EVERY_CREDENTIAL_A_FAILED_REQUEST_CARRIES) {
    expect(formattedLogLine).not.toContain(credential);
  }
}

async function axiosErrorThrownBy(request: Promise<unknown>): Promise<AxiosError> {
  try {
    await request;
  } catch (error) {
    if (axios.isAxiosError(error)) return error;
    throw error;
  }
  throw new Error('the request was expected to fail');
}

async function listenOnAFreeLoopbackPort(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

class FailedOutcomeHoldingTheError {
  constructor(readonly failure: unknown) {}
}

describe('expandedErrorsFormat', () => {
  let serverAnsweringEveryRequestWith500: Server;
  let baseUrlOfTheServerAnsweringWith500: string;
  let baseUrlNobodyListensOn: string;
  /** A real HTTP 500 from a client that sends an `Authorization` header and an `api_key` query parameter. */
  let failedRequestAnsweredWith500: AxiosError;
  /** A real ECONNREFUSED from the same kind of client: a request that never got an answer. */
  let failedRequestNeverAnswered: AxiosError;

  beforeAll(async () => {
    serverAnsweringEveryRequestWith500 = createServer((_request, response) => {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ type: 'error.list', errors: [{ code: 'server_error', message: 'Server Error' }] }));
    });
    baseUrlOfTheServerAnsweringWith500 = `http://127.0.0.1:${await listenOnAFreeLoopbackPort(serverAnsweringEveryRequestWith500)}`;

    const serverClosedRightAway = createServer();
    baseUrlNobodyListensOn = `http://127.0.0.1:${await listenOnAFreeLoopbackPort(serverClosedRightAway)}`;
    await new Promise<void>((resolve) => serverClosedRightAway.close(() => resolve()));

    const clientCarryingCredentialsFor = (baseURL: string) =>
      axios.create({
        baseURL,
        headers: { Authorization: `Bearer ${ACCESS_TOKEN_IN_THE_AUTHORIZATION_HEADER}` },
        httpAgent: new Agent({ keepAlive: false }),
      });
    const dataAttributesRequestParams = { params: { model: 'contact', api_key: API_KEY_IN_THE_QUERY_STRING } };
    failedRequestAnsweredWith500 = await axiosErrorThrownBy(
      clientCarryingCredentialsFor(baseUrlOfTheServerAnsweringWith500).get(
        '/data_attributes',
        dataAttributesRequestParams,
      ),
    );
    failedRequestNeverAnswered = await axiosErrorThrownBy(
      clientCarryingCredentialsFor(baseUrlNobodyListensOn).get('/data_attributes', dataAttributesRequestParams),
    );
  });

  afterAll(async () => {
    serverAnsweringEveryRequestWith500.closeAllConnections();
    await new Promise<void>((resolve) => serverAnsweringEveryRequestWith500.close(() => resolve()));
  });

  describe.each(LOG_LINE_FORMATS)('in the %s log line', (lineFormat) => {
    it('never writes the credentials of a failed request logged as a field', () => {
      expectNoCredentialIn(formatLogLine({ error: failedRequestAnsweredWith500 }, lineFormat));
      expectNoCredentialIn(formatLogLine({ error: failedRequestNeverAnswered }, lineFormat));
    });

    it.each<[string, (failedRequest: AxiosError) => Record<string, unknown>]>([
      ['inside a plain object', (failedRequest) => ({ details: { error: failedRequest } })],
      ['inside an array', (failedRequest) => ({ errors: [failedRequest, failedRequest] })],
      [
        "inside a connector's error details, as HubSpot batch publish logs them",
        (failedRequest) => ({
          error: { message: 'Batch failed', context: { status: 207, responseData: failedRequest } },
        }),
      ],
      ['inside a class instance', (failedRequest) => ({ outcome: new FailedOutcomeHoldingTheError(failedRequest) })],
      [
        "as an HttpException's enumerable cause",
        (failedRequest) => ({ error: new InternalServerErrorException('Intercom error', { cause: failedRequest }) }),
      ],
      ["as an Error's native cause", (failedRequest) => ({ error: new Error('Wrapped', { cause: failedRequest }) })],
    ])('never writes the credentials of a failed request nested %s', (_whereItIsNested, fieldsHoldingTheError) => {
      expectNoCredentialIn(formatLogLine(fieldsHoldingTheError(failedRequestAnsweredWith500), lineFormat));
      expectNoCredentialIn(formatLogLine(fieldsHoldingTheError(failedRequestNeverAnswered), lineFormat));
    });

    it('never writes the credentials of a failed request Nest logs through WSLoggerShim', () => {
      const errorLog = jest.spyOn(WSLogger, 'error').mockImplementation(() => undefined);
      try {
        // How Nest's exception handler reports an exception no filter handled.
        new WSLoggerShim().error(failedRequestAnsweredWith500, undefined, 'ExceptionsHandler');
        const [[fieldsTheShimLogged]] = errorLog.mock.calls;

        expectNoCredentialIn(formatLogLine(fieldsTheShimLogged, lineFormat));
      } finally {
        errorLog.mockRestore();
      }
    });

    it('never writes the credentials of a failed request held in a cycle', () => {
      const detailsWithACycle: Record<string, unknown> = { error: failedRequestAnsweredWith500 };
      detailsWithACycle.itself = detailsWithACycle;

      expectNoCredentialIn(formatLogLine({ details: detailsWithACycle }, lineFormat));
    });
  });

  it('keeps which request failed and how', () => {
    expect(loggedJsonFor({ error: failedRequestAnsweredWith500 }).error).toEqual({
      name: 'AxiosError',
      message: 'Request failed with status code 500',
      code: 'ERR_BAD_RESPONSE',
      status: 500,
      method: 'GET',
      url: `${baseUrlOfTheServerAnsweringWith500}/data_attributes`,
      stack: expect.stringContaining('Request failed with status code 500') as unknown,
    });

    const loggedNetworkFailure = loggedJsonFor({ error: failedRequestNeverAnswered }).error;
    expect(loggedNetworkFailure).toMatchObject({
      code: 'ECONNREFUSED',
      method: 'GET',
      url: `${baseUrlNobodyListensOn}/data_attributes`,
    });
    expect(loggedNetworkFailure).not.toHaveProperty('status');
  });

  it("leaves the caller's nested objects holding the original AxiosError", () => {
    const details = { error: failedRequestAnsweredWith500 };

    applyExpandedErrorsFormat({ details });

    expect(details.error).toBe(failedRequestAnsweredWith500);
  });

  it('logs a cycle as [Circular]', () => {
    const detailsWithACycle: Record<string, unknown> = { error: failedRequestAnsweredWith500 };
    detailsWithACycle.itself = detailsWithACycle;

    expect(loggedJsonFor({ details: detailsWithACycle }).details).toMatchObject({ itself: '[Circular]' });
  });

  describe('the URL it keeps', () => {
    function urlLoggedFor(failedRequestConfig: Record<string, unknown>): unknown {
      const failedRequest = new AxiosError(
        'Request failed with status code 404',
        'ERR_BAD_REQUEST',
        failedRequestConfig as never,
      );
      const loggedFailure = loggedJsonFor({ error: failedRequest }).error as Record<string, unknown>;
      return loggedFailure.url;
    }

    it('is the full URL of a request made relative to the client baseURL, without its query or fragment', () => {
      expect(
        urlLoggedFor({
          baseURL: 'https://api.intercom.io/',
          url: `/data_attributes?api_key=${API_KEY_IN_THE_QUERY_STRING}#top`,
        }),
      ).toBe('https://api.intercom.io/data_attributes');
      expect(urlLoggedFor({ baseURL: 'https://api.intercom.io', url: '' })).toBe('https://api.intercom.io');
    });

    it('is only the scheme and host of a whole URL handed to the request, whose path can be the credential', () => {
      expect(
        urlLoggedFor({ url: `https://hooks.slack.com/services/T000/B000/${WEBHOOK_SECRET_IN_THE_URL_PATH}` }),
      ).toBe('https://hooks.slack.com/[path omitted]');
      expect(
        urlLoggedFor({
          baseURL: 'https://api.hubapi.com',
          url: `https://api.hubapi.com/crm/v3/objects/contacts?after=${API_KEY_IN_THE_QUERY_STRING}`,
        }),
      ).toBe('https://api.hubapi.com/[path omitted]');
    });

    it('never includes a user:password@', () => {
      expect(urlLoggedFor({ baseURL: 'https://user:p@ss@api.example.com', url: '/v1/items' })).toBe(
        'https://api.example.com/v1/items',
      );
      expect(
        urlLoggedFor({ url: `https://user:${ACCESS_TOKEN_IN_THE_AUTHORIZATION_HEADER}@hooks.example.com/x` }),
      ).toBe('https://hooks.example.com/[path omitted]');
    });

    it('appends an absolute URL to the baseURL when the client disallows absolute URLs, as axios does', () => {
      expect(
        urlLoggedFor({
          baseURL: 'https://api.example.com',
          url: 'https://other.example.com/x',
          allowAbsoluteUrls: false,
        }),
      ).toBe('https://api.example.com/https://other.example.com/x');
    });

    it('is left out when the request had no URL to go by', () => {
      expect(urlLoggedFor({ url: '/relative/without/a/base' })).toBeUndefined();
    });
  });

  it('logs a field it cannot read as a placeholder instead of throwing at the caller', () => {
    const detailsWithAThrowingGetter = {
      get brokenProperty(): unknown {
        throw new Error('getter failed');
      },
    };

    expect(loggedJsonFor({ details: detailsWithAThrowingGetter }).details).toBe('[unloggable value]');
  });

  it('still expands any other Error into its name, message, stack and own properties', () => {
    const plainError = Object.assign(new Error('Plain failure'), { workbookId: 'wkb_0001' });

    expect(loggedJsonFor({ error: plainError }).error).toEqual({
      name: 'Error',
      message: 'Plain failure',
      stack: plainError.stack,
      workbookId: 'wkb_0001',
    });
  });

  it('leaves a field with no AxiosError in it as the very same objects', () => {
    const detailsWithoutAnAxiosError = { counts: [1, 2], when: new Date(0), nested: { ok: true } };

    expect(applyExpandedErrorsFormat({ details: detailsWithoutAnAxiosError }).details).toBe(detailsWithoutAnAxiosError);
  });

  it('leaves a summary that reaches the format again unchanged', () => {
    const summaryLoggedOnce = applyExpandedErrorsFormat({ error: failedRequestAnsweredWith500 }).error;

    expect(applyExpandedErrorsFormat({ error: summaryLoggedOnce }).error).toBe(summaryLoggedOnce);
  });
});
