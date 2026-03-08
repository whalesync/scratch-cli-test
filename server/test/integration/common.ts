// Common configuration and utilities for integration tests.
// Provides environment-based service URLs (client, API) and Clerk authentication helpers.
// Supports both local (http/ws) and deployed (https/wss) environments.

const clientDomain = process.env.INTEGRATION_TEST_CLIENT_DOMAIN || 'test.scratch.md';
const apiDomain = process.env.INTEGRATION_TEST_API_DOMAIN || 'test-api.scratch.md';
export const getProtocol = (domain: string): string => {
  if (domain.includes('://')) {
    return '';
  }
  return domain.includes('localhost') ? 'http://' : 'https://';
};

export const getClientUrl = () => `${getProtocol(clientDomain)}${clientDomain}`;
export const getApiUrl = () => `${getProtocol(apiDomain)}${apiDomain}`;
// Re-export auth utilities from shared package
export { getAuthToken, type AuthConfig } from '@spinner/test-utils';
