// Common configuration and utilities for integration tests.
// Provides environment-based service URLs (client, API) and Clerk authentication helpers.
// Supports both local (http/ws) and deployed (https/wss) environments.

import axios, { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios';

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

/**
 * Abandon a single attempt that has produced no response this long. A bare `axios` call has NO
 * timeout, so one dropped connection hangs until Jest kills the whole test at its 60s cap — with
 * a message that names no request. Failing the attempt first is what makes a retry possible and
 * the eventual error legible.
 *
 * Every call this client makes is a fast control-plane request, so silence for this long means a
 * dead socket rather than slow work — which is why a timeout here is treated as retryable. (The
 * `scratchmd` CLI deliberately does the opposite: its bound is minutes, long enough that tripping
 * it can mean genuinely slow server work, so it surfaces the timeout instead of replaying it.)
 */
const PER_ATTEMPT_TIMEOUT_MS = 15_000;

/** Total attempts allowed for one call (the first attempt plus its retries). */
const MAX_REQUEST_ATTEMPTS = 3;

/** Backoff before each retry, indexed by how many attempts have already failed. */
const RETRY_BACKOFF_MS_BY_FAILED_ATTEMPTS = [250, 1000];

/**
 * Error codes meaning the connection was never established, so the server definitively never saw
 * the request. Replaying one of these cannot duplicate work, whatever the method.
 */
const CONNECT_LEVEL_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_SOCKET_CONNECTION_TIMEOUT']);

/** The in-flight request config, carrying how many attempts have already failed for it. */
type RetryTrackingRequestConfig = InternalAxiosRequestConfig & { failedAttempts?: number };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether a failed attempt may be replayed.
 *
 * Only transport failures are considered — an attempt that produced ANY response, including a
 * 5xx, is left alone so every status the API returns still reaches the assertion untouched. A
 * connect-level failure is safe for any method because the request never arrived; anything after
 * the connection is up leaves us unable to tell whether the server applied it, so only reads are
 * replayed.
 */
const isTransportFailureSafeToRetry = (error: AxiosError): boolean => {
  if (error.response) {
    return false;
  }
  if (error.code && CONNECT_LEVEL_ERROR_CODES.has(error.code)) {
    return true;
  }
  return (error.config?.method ?? 'get').toUpperCase() === 'GET';
};

/**
 * An `axios` instance for talking to the Scratch API from an integration test, bounded by a
 * per-attempt timeout and retrying transient transport failures.
 *
 * CI has repeatedly lost post-deploy runs to a single dropped connection between the GitLab
 * runner and test-api — a request that never reaches the load balancer at all — while the server
 * itself stayed healthy. Retries are deliberately limited to failures that produced no response,
 * so this never masks a real API error or changes what a test asserts.
 */
export const createScratchApiClient = (): AxiosInstance => {
  const client = axios.create({ timeout: PER_ATTEMPT_TIMEOUT_MS });

  client.interceptors.response.use(undefined, async (error: AxiosError) => {
    const config: RetryTrackingRequestConfig | undefined = error.config;
    if (!config) {
      throw error;
    }

    const failedAttempts = config.failedAttempts ?? 0;
    const hasAttemptsRemaining = failedAttempts + 1 < MAX_REQUEST_ATTEMPTS;
    if (!hasAttemptsRemaining || !isTransportFailureSafeToRetry(error)) {
      throw error;
    }

    await sleep(RETRY_BACKOFF_MS_BY_FAILED_ATTEMPTS[failedAttempts]);
    const configForNextAttempt: RetryTrackingRequestConfig = { ...config, failedAttempts: failedAttempts + 1 };
    return client.request(configForNextAttempt);
  });

  return client;
};
