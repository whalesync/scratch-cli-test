import axios, { CreateAxiosDefaults } from 'axios';
import { applyUrlOverrides } from './api-url-overrides';

/**
 * Create an Axios instance with shared interceptors (URL overrides, etc.).
 *
 * All connector API clients should use this instead of calling axios.create() directly,
 * so that cross-cutting concerns like API URL overrides are applied consistently.
 */
export function createApiClient(config?: CreateAxiosDefaults) {
  const instance = axios.create(config);
  applyUrlOverrides(instance);
  return instance;
}
