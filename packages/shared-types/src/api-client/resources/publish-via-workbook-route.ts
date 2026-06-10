import type { PublishPlanBuildDto, PublishPlanRunDto } from '../../dto/publish-plan/publish-plan.dto';
import type { Http } from '../http';

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
 * ║  PUBLISH — WEB / `/workbook/:id/publish-v2/*` ROUTE FAMILY                                  ║
 * ║                                                                                            ║
 * ║  Used by the Scratch **web client** (Clerk / `Bearer` auth). This is the WorkbookController ║
 * ║  publish surface. It is DISTINCT from the desktop CLI route family in                      ║
 * ║  `publish-via-cli-route.ts` (`/cli/v1/workbooks/:id/publish-v2/*`, API-Token). The two      ║
 * ║  have DIFFERENT routes, request bodies, and response shapes — do NOT intermingle or copy    ║
 * ║  one into the other. If you are touching a `/cli/v1/...` endpoint, you are in the wrong file.║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Reached as `client.publish.viaWorkbookRoute.*`.
 */
export function createPublishViaWorkbookRouteApi(http: Http) {
  return {
    /** POST `/workbook/:id/publish-v2/plan-job` — build a publish plan (web). */
    planJob: async (
      workbookId: string,
      connectorAccountId?: string,
      runAfterPlan?: boolean,
      folderPath?: string,
      filePath?: string,
    ): Promise<{ jobId: string; publishPlanId: string }> => {
      const body: PublishPlanBuildDto = { connectorAccountId, runAfterPlan, folderPath, filePath };
      const res = await http.post<{ jobId: string; publishPlanId: string }>(
        `/workbook/${workbookId}/publish-v2/plan-job`,
        body,
        { fallbackMessage: 'Failed to start plan job' },
      );
      return res.data;
    },

    /** POST `/workbook/:id/publish-v2/run-job` — dispatch a previously-built plan (web). */
    runJob: async (
      workbookId: string,
      publishPlanId: string,
      executeSinglePhase?: boolean,
    ): Promise<{ jobId: string }> => {
      const body: PublishPlanRunDto = { pipelineId: publishPlanId, executeSinglePhase };
      const res = await http.post<{ jobId: string }>(`/workbook/${workbookId}/publish-v2/run-job`, body, {
        fallbackMessage: 'Failed to start run job',
      });
      return res.data;
    },
  };
}

export type PublishViaWorkbookRouteApi = ReturnType<typeof createPublishViaWorkbookRouteApi>;
