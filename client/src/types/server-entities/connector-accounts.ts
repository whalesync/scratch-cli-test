export type TestConnectionResponse = { health: 'ok' } | { health: 'error'; error: string };

/**
 * Response from `GET /workbooks/:workbookId/connections/:id/quota`.
 *
 * Three variants:
 *   - `{ supported: true, quota }` — raw API quota data, rendered as JSON.
 *   - `{ supported: false, dashboardUrl }` — no API endpoint, but a link
 *     to the service's usage dashboard.
 *   - `{ supported: false }` — no quota concept at all.
 */
export type ApiQuotaResponse =
  | { supported: true; quota: Record<string, unknown> }
  | { supported: false; dashboardUrl?: string };

/**
 * Response from `GET /workbooks/:workbookId/connections/:id/credentials/reveal`.
 *
 * Admin-only "break glass" reveal of a connection's decrypted credentials.
 * Every call writes an audit log entry on the server.
 */
export interface RevealCredentialsResponse {
  credentials: Record<string, unknown>;
  extras: Record<string, unknown> | null;
}
