import { createScratchApiClient, type RequestLog } from '@spinner/shared-types/api-client';

/**
 * The shared Scratch REST client for the desktop renderer, plus the small bit of app-local session
 * state it closes over. One long-lived instance with namespaced resource access
 * (`scratchApiClient.users.activeUser()`).
 *
 * Auth uses the `API-Token` scheme. The client reads a mutable token cell (not a captured value),
 * so a login / logout is picked up on the next request without rebuilding the client. The app
 * updates this state through the setters below:
 *   - `setScratchApiToken` — on login (the device-code token) and logout (`null`).
 *   - `setScratchApiUnauthorizedHandler` — the logout-on-401 handler (fired only while authenticated).
 *   - `setScratchApiActiveWorkspacePath` — gates request logging to the active workspace.
 */
const baseUrl = (import.meta.env.VITE_SCRATCH_API_URL as string) || 'http://localhost:3010';

let currentToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;
let activeWorkspacePath: string | null = null;

/** Base URL of the Scratch API server (e.g. for storing the server URL alongside saved credentials). */
export function getScratchApiBaseUrl(): string {
  return baseUrl;
}

/** Set the device-code API token on login; pass `null` on logout. */
export function setScratchApiToken(token: string | null): void {
  currentToken = token;
}

/** Register (or clear with `null`) the handler fired on a terminal 401 while authenticated. */
export function setScratchApiUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

/** Set the active workspace's local path (request logging is gated on this); `null` clears it. */
export function setScratchApiActiveWorkspacePath(path: string | null): void {
  activeWorkspacePath = path;
}

// URLs excluded from the desktop's per-request IPC log (high-frequency / low-signal polls).
const LOG_EXCLUDED_URLS = new Set(['/users/current', '/jobs/bulk-status']);

function emitRequestLog(log: RequestLog): void {
  if (!activeWorkspacePath) return;
  const desktopApi = window.scratchDesktop;
  if (!desktopApi?.logApiCall) return;
  const path = (log.url.startsWith('/') ? log.url : `/${log.url}`).split('?')[0];
  if (LOG_EXCLUDED_URLS.has(path)) return;
  desktopApi.logApiCall(activeWorkspacePath, {
    method: log.method,
    url: log.url,
    status: log.status,
    durationMs: log.durationMs,
    errorSummary: log.errorSummary,
  });
}

export const scratchApiClient = createScratchApiClient({
  baseUrl,
  auth: {
    scheme: 'API-Token',
    getToken: () => currentToken,
  },
  // Only fire the logout handler while authenticated (matches the legacy guard).
  onUnauthorized: () => {
    if (currentToken) unauthorizedHandler?.();
  },
  onRequestComplete: emitRequestLog,
});
