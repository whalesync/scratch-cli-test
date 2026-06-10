/**
 * `@spinner/shared-types/api-client` — the single shared Scratch REST client for the web client
 * and the desktop renderer. Isolated behind this subpath so the NestJS server (which imports the
 * root barrel, types-only) never pulls axios into its bundle. Do NOT re-export any of this from
 * `src/index.ts`.
 */
export { createScratchApiClient } from './client';
export type { ScratchApiClient } from './client';

export {
  ScratchpadApiError,
  getHumanReadableErrorMessage,
  isConnectionError,
  isUnauthorizedError,
  normalizeToScratchpadApiError,
} from './error';
export type { ScratchpadApiErrorResponse } from './error';

export type { Http, HttpRequestConfig, HttpRequestOptions } from './http';
export type { WorkbookSortBy, WorkbookSortOrder } from './resources/workspaces';
export type { AuthConfig, AuthScheme, RequestLog, ScratchApiClientConfig } from './types';
