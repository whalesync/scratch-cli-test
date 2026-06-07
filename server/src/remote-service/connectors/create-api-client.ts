import axios, { CreateAxiosDefaults } from 'axios';
import { applyUrlOverrides } from './api-url-overrides';
import { applyConnectorHttpLogging } from './connector-http-logging';

/**
 * Create an Axios instance with shared interceptors (URL overrides, request/response
 * logging, etc.).
 *
 * All connector API clients should use this instead of calling axios.create() directly,
 * so that cross-cutting concerns like API URL overrides and outbound-traffic logging are
 * applied consistently across every connector.
 */
export function createApiClient(config?: CreateAxiosDefaults) {
  const instance = axios.create(config);
  applyUrlOverrides(instance);
  applyConnectorHttpLogging(instance);
  return instance;
}
