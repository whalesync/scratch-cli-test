import axios, { AxiosInstance, CreateAxiosDefaults } from 'axios';
import { applyUrlOverrides } from './api-url-overrides';
import { ConnectorAuthTokenProvider } from './connector-auth-token';
import { applyConnectorHttpLogging } from './connector-http-logging';

export interface CreateApiClientOptions {
  /**
   * Resolves the full `Authorization` header **value** (scheme included, e.g.
   * `Bearer abc123`, `Zoho-oauthtoken abc123`, or a bare token for APIs that want
   * one) immediately before each request is sent.
   *
   * Pass this instead of a static `Authorization` entry in `config.headers`
   * whenever the credential can change during the client's lifetime — which is
   * every OAuth connection, since the host refreshes the access token roughly
   * hourly. A client that captured the token once kept 401-ing for the rest of a
   * long publish/pull/sync once the original token expired (DEV-11270).
   */
  authorizationHeaderValueProvider?: ConnectorAuthTokenProvider;
}

/**
 * Create an Axios instance with shared interceptors (URL overrides, request/response
 * logging, etc.).
 *
 * All connector API clients should use this instead of calling axios.create() directly,
 * so that cross-cutting concerns like API URL overrides and outbound-traffic logging are
 * applied consistently across every connector.
 */
export function createApiClient(config?: CreateAxiosDefaults, options?: CreateApiClientOptions): AxiosInstance {
  const instance = axios.create(config);
  if (options?.authorizationHeaderValueProvider) {
    applyPerRequestAuthorizationHeader(instance, options.authorizationHeaderValueProvider);
  }
  applyUrlOverrides(instance);
  applyConnectorHttpLogging(instance);
  return instance;
}

/**
 * Stamp a freshly resolved `Authorization` header onto every outgoing request.
 *
 * Registered as a request interceptor rather than an instance default so the value
 * is resolved per request: a retry issued minutes after the original attempt (and
 * every call in a job that runs for hours) carries the credential that is valid
 * *now*, not the one that happened to be valid when the client was constructed.
 */
function applyPerRequestAuthorizationHeader(
  instance: AxiosInstance,
  authorizationHeaderValueProvider: ConnectorAuthTokenProvider,
): void {
  instance.interceptors.request.use(async (config) => {
    config.headers.set('Authorization', await authorizationHeaderValueProvider());
    return config;
  });
}
