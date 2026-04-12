import { JsonSafeObject } from 'src/utils/objects';

/**
 * Response shape for `GET /workbooks/:workbookId/connections/:id/quota`.
 *
 * The `quota` payload is intentionally connector-specific raw JSON — the client
 * renders it pretty-printed without interpretation. When a connector does not
 * expose any API quota / rate-limit endpoint, the server returns
 * `{ supported: false }` so the client can show an "unsupported" message.
 */
export type ApiQuotaResponse = { supported: true; quota: JsonSafeObject } | { supported: false };
