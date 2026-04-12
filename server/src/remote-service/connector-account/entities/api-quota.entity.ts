import { JsonSafeObject } from 'src/utils/objects';

/**
 * Response shape for `GET /workbooks/:workbookId/connections/:id/quota`.
 *
 * Three variants:
 *   - `{ supported: true; quota }` — raw API quota data, rendered as JSON.
 *   - `{ supported: false; dashboardUrl }` — no API endpoint, but a link to
 *     the service's usage dashboard where the user can check manually.
 *   - `{ supported: false }` — no quota concept at all.
 */
export type ApiQuotaResponse = { supported: true; quota: JsonSafeObject } | { supported: false; dashboardUrl?: string };
