export type TestConnectionResponse = { health: 'ok' } | { health: 'error'; error: string };

/**
 * Response from `GET /workbooks/:workbookId/connections/:id/quota`. The
 * `quota` payload is connector-specific raw JSON; the dialog renders it
 * pretty-printed without interpretation. `{ supported: false }` means the
 * connector does not expose any API quota / rate-limit endpoint.
 */
export type ApiQuotaResponse = { supported: true; quota: Record<string, unknown> } | { supported: false };
