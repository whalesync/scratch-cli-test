import type { Http } from '../http';
import { createPublishPlansApi } from './publish-plans';
import { createPublishViaCliRouteApi } from './publish-via-cli-route';
import { createPublishViaWorkbookRouteApi } from './publish-via-workbook-route';

/**
 * The `publish` namespace. The plan-BUILD and plan-RUN endpoints are deliberately split into two
 * route-family sub-namespaces that must NEVER be intermingled — they have different routes, bodies,
 * and response shapes:
 *
 *   - `client.publish.viaWorkbookRoute.*` → web,     `/workbook/:id/publish-v2/*`        (Bearer)
 *   - `client.publish.viaCliRoute.*`      → desktop, `/cli/v1/workbooks/:id/publish-v2/*` (API-Token)
 *
 * Read-only plan queries (list/get/records/operations/delete/indexes) are shared by both apps on
 * the `/workbook/:id/publish-v2/...` routes and live at the `client.publish.*` root.
 */
export function createPublishApi(http: Http) {
  return {
    ...createPublishPlansApi(http),
    viaWorkbookRoute: createPublishViaWorkbookRouteApi(http),
    viaCliRoute: createPublishViaCliRouteApi(http),
  };
}

export type PublishApi = ReturnType<typeof createPublishApi>;
