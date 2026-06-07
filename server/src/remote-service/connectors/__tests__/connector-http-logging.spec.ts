/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import axios, { AxiosError, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { LogLevel, WSLogger } from 'src/logger';
import {
  applyConnectorHttpLogging,
  describeRequestUrlForLogging,
  redactSensitiveHeadersForLogging,
  resolveConnectorHttpLoggingModeFromEnv,
} from '../connector-http-logging';

/**
 * An axios adapter that resolves a canned 200 response without any network I/O,
 * so the interceptor under test runs against a real axios instance.
 */
function fixedSuccessAdapter(status = 200) {
  return (config: InternalAxiosRequestConfig): Promise<AxiosResponse> =>
    Promise.resolve({
      data: { ok: true },
      status,
      statusText: 'OK',
      headers: {},
      config,
      request: {},
    });
}

/** An axios adapter that rejects with an AxiosError carrying the given response status. */
function fixedErrorAdapter(status: number) {
  return (config: InternalAxiosRequestConfig): Promise<AxiosResponse> =>
    Promise.reject(
      new AxiosError('Request failed', 'ERR_BAD_REQUEST', config, {}, {
        data: { message: 'nope' },
        status,
        statusText: 'Bad Request',
        headers: {},
        config,
      } as AxiosResponse),
    );
}

describe('connector-http-logging', () => {
  describe('redactSensitiveHeadersForLogging', () => {
    it('masks Authorization and token/api-key style headers, keeps benign ones', () => {
      const redacted = redactSensitiveHeadersForLogging({
        Authorization: 'Bearer super-secret',
        'api-key': 'brevo-secret',
        'X-Api-Key': 'audienceful-secret',
        'x-api-token': 'pipedrive-secret',
        'X-PW-AccessToken': 'copper-secret',
        'X-Shopify-Access-Token': 'shopify-secret',
        Cookie: 'session=abc',
        'Content-Type': 'application/json',
        'Intercom-Version': '2.11',
      });

      expect(redacted).toEqual({
        Authorization: 'REDACTED',
        'api-key': 'REDACTED',
        'X-Api-Key': 'REDACTED',
        'x-api-token': 'REDACTED',
        'X-PW-AccessToken': 'REDACTED',
        'X-Shopify-Access-Token': 'REDACTED',
        Cookie: 'REDACTED',
        'Content-Type': 'application/json',
        'Intercom-Version': '2.11',
      });
    });

    it('reads values out of an AxiosHeaders instance and masks them', () => {
      const headers = axios.AxiosHeaders.from({ Authorization: 'Bearer secret', Accept: 'application/json' });
      const redacted = redactSensitiveHeadersForLogging(headers);
      expect(redacted.Authorization).toBe('REDACTED');
      expect(redacted.Accept).toBe('application/json');
    });

    it('returns an empty object for nullish input', () => {
      expect(redactSensitiveHeadersForLogging(undefined)).toEqual({});
      expect(redactSensitiveHeadersForLogging(null)).toEqual({});
    });
  });

  describe('describeRequestUrlForLogging', () => {
    it('joins baseURL and relative path', () => {
      expect(describeRequestUrlForLogging({ baseURL: 'https://api.webflow.com/v2', url: '/sites' })).toBe(
        'https://api.webflow.com/v2/sites',
      );
    });

    it('uses an absolute url as-is, ignoring baseURL', () => {
      expect(
        describeRequestUrlForLogging({ baseURL: 'https://api.webflow.com/v2', url: 'https://s3.amazonaws.com/upload' }),
      ).toBe('https://s3.amazonaws.com/upload');
    });

    it('appends non-sensitive query params from config.params', () => {
      const url = describeRequestUrlForLogging({
        baseURL: 'https://api.webflow.com/v2',
        url: '/collections/c1/items',
        params: { offset: 100, limit: 100 },
      });
      expect(url).toBe('https://api.webflow.com/v2/collections/c1/items?offset=100&limit=100');
    });

    it('masks sensitive query-param values from both the url and config.params', () => {
      const url = describeRequestUrlForLogging({
        url: 'https://example.com/data?access_token=leaked-in-url&page=2',
        params: { api_key: 'leaked-in-params', q: 'hello' },
      });

      const query = new URLSearchParams(new URL(url).search);
      expect(query.get('access_token')).toBe('REDACTED');
      expect(query.get('api_key')).toBe('REDACTED');
      expect(query.get('page')).toBe('2');
      expect(query.get('q')).toBe('hello');
    });
  });

  describe('resolveConnectorHttpLoggingModeFromEnv', () => {
    const original = process.env.CONNECTOR_HTTP_LOGGING;
    afterEach(() => {
      if (original === undefined) delete process.env.CONNECTOR_HTTP_LOGGING;
      else process.env.CONNECTOR_HTTP_LOGGING = original;
    });

    it('defaults to basic when unset or unrecognized', () => {
      delete process.env.CONNECTOR_HTTP_LOGGING;
      expect(resolveConnectorHttpLoggingModeFromEnv()).toBe('basic');
      process.env.CONNECTOR_HTTP_LOGGING = 'nonsense';
      expect(resolveConnectorHttpLoggingModeFromEnv()).toBe('basic');
    });

    it('honours off and verbose (case/space insensitive)', () => {
      process.env.CONNECTOR_HTTP_LOGGING = '  OFF ';
      expect(resolveConnectorHttpLoggingModeFromEnv()).toBe('off');
      process.env.CONNECTOR_HTTP_LOGGING = 'Verbose';
      expect(resolveConnectorHttpLoggingModeFromEnv()).toBe('verbose');
    });
  });

  describe('interceptor', () => {
    let debugSpy: jest.SpyInstance;

    beforeEach(() => {
      // The interceptor logs at debug, which the logger suppresses by default.
      WSLogger.setOutputLevel(LogLevel.DEBUG);
      debugSpy = jest.spyOn(WSLogger, 'debug').mockImplementation(() => undefined);
    });

    afterEach(() => {
      debugSpy.mockRestore();
      WSLogger.setOutputLevel(LogLevel.INFO);
    });

    it('logs method, URL and status for a successful request', async () => {
      const instance = axios.create({ baseURL: 'https://api.webflow.com/v2', adapter: fixedSuccessAdapter(200) });
      applyConnectorHttpLogging(instance, 'basic');

      await instance.get('/sites');

      expect(debugSpy).toHaveBeenCalledTimes(1);
      const payload = debugSpy.mock.calls[0][0];
      expect(payload).toMatchObject({
        source: 'connector-http',
        method: 'GET',
        url: 'https://api.webflow.com/v2/sites',
        status: 200,
      });
      expect(payload.message).toContain('GET https://api.webflow.com/v2/sites → 200');
      expect(typeof payload.durationMs).toBe('number');
      // Basic mode must not log headers at all.
      expect(payload.requestHeaders).toBeUndefined();
    });

    it('redacts the Authorization header in verbose mode', async () => {
      const instance = axios.create({
        baseURL: 'https://api.webflow.com/v2',
        headers: { Authorization: 'Bearer super-secret', 'Content-Type': 'application/json' },
        adapter: fixedSuccessAdapter(200),
      });
      applyConnectorHttpLogging(instance, 'verbose');

      await instance.get('/sites');

      const payload = debugSpy.mock.calls[0][0];
      expect(payload.requestHeaders.Authorization).toBe('REDACTED');
      expect(payload.requestHeaders['Content-Type']).toBe('application/json');
      // The raw token must never appear anywhere in the logged payload.
      expect(JSON.stringify(payload)).not.toContain('super-secret');
    });

    it('logs the status of a failed request and still rejects', async () => {
      const instance = axios.create({ baseURL: 'https://api.hubspot.com', adapter: fixedErrorAdapter(429) });
      applyConnectorHttpLogging(instance, 'basic');

      await expect(instance.get('/crm/v3/objects/contacts')).rejects.toBeInstanceOf(AxiosError);

      expect(debugSpy).toHaveBeenCalledTimes(1);
      const payload = debugSpy.mock.calls[0][0];
      expect(payload).toMatchObject({ method: 'GET', status: 429 });
      expect(payload.message).toContain('→ 429');
      expect(payload.error).toContain('Request failed');
    });

    it('installs nothing and logs nothing when mode is off', async () => {
      const instance = axios.create({ baseURL: 'https://api.webflow.com/v2', adapter: fixedSuccessAdapter(200) });
      applyConnectorHttpLogging(instance, 'off');

      await instance.get('/sites');

      expect(debugSpy).not.toHaveBeenCalled();
    });

    it('does not build a payload when the debug level is suppressed', async () => {
      WSLogger.setOutputLevel(LogLevel.INFO);
      const instance = axios.create({ baseURL: 'https://api.webflow.com/v2', adapter: fixedSuccessAdapter(200) });
      applyConnectorHttpLogging(instance, 'basic');

      await instance.get('/sites');

      expect(debugSpy).not.toHaveBeenCalled();
    });
  });
});
