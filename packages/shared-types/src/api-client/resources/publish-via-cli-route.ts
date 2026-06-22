import type { PlanJobResponse, RunJobResponse } from '../../dto/publish-plan/publish-job-responses.dto';
import type { Http } from '../http';

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
 * ║  PUBLISH — DESKTOP / `/cli/v1/workbooks/:id/publish-v2/*` ROUTE FAMILY                       ║
 * ║                                                                                            ║
 * ║  Used by the Scratch **desktop app** (device-code / `API-Token` auth). This is the CLI      ║
 * ║  controller publish surface. It is DISTINCT from the web route family in                    ║
 * ║  `publish-via-workbook-route.ts` (`/workbook/:id/publish-v2/*`, Bearer). The two have       ║
 * ║  DIFFERENT routes, request bodies, and response shapes — do NOT intermingle or copy one     ║
 * ║  into the other. If you are touching a `/workbook/...` publish endpoint, you are in the     ║
 * ║  wrong file.                                                                                ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Reached as `client.publish.viaCliRoute.*`.
 */
export function createPublishViaCliRouteApi(http: Http) {
  return {
    /**
     * POST `/cli/v1/workbooks/:id/publish-v2/plan-job` — build a publish plan for one connection
     * (desktop). Returns `{ jobId, pipelineId }`; both come back null when the dirty branch has no
     * diff against main (caller should skip the connection).
     *
     * `options.expectedBaseDirtyHead` (DEV-10316) is the dirty-branch HEAD the desktop captured right
     * after its upload landed. When provided, the server aborts the plan build if the connection's
     * dirty HEAD has since drifted, surfacing a `blockedDirtyDrift` discriminator on the plan job.
     *
     * `options.filePath` (DEV-10413) scopes the plan to a single record (connection-relative path).
     * When set, the server diffs dirty↔main and filters the plan to that one path — the single-record
     * publish flow's over-publish guard. Passed via an options object (not a positional after the
     * nullable `expectedBaseDirtyHead`) to avoid a classic mis-wire site.
     */
    planJob: async (
      workbookId: string,
      connectorAccountId: string,
      options: { expectedBaseDirtyHead?: string | null; filePath?: string } = {},
    ): Promise<PlanJobResponse> => {
      const { expectedBaseDirtyHead, filePath } = options;
      const res = await http.post<PlanJobResponse>(
        `/cli/v1/workbooks/${workbookId}/publish-v2/plan-job`,
        {
          connectorAccountId,
          runAfterPlan: false,
          ...(expectedBaseDirtyHead ? { expectedBaseDirtyHead } : {}),
          ...(filePath ? { filePath } : {}),
        },
        { fallbackMessage: 'Failed to start plan job' },
      );
      return res.data;
    },

    /**
     * POST `/cli/v1/workbooks/:id/publish-v2/run-job` — dispatch a previously-built plan through the
     * connector (desktop). Caller polls the returned `jobId` for progress.
     */
    runJob: async (workbookId: string, pipelineId: string): Promise<RunJobResponse> => {
      const res = await http.post<RunJobResponse>(
        `/cli/v1/workbooks/${workbookId}/publish-v2/run-job`,
        { pipelineId },
        { fallbackMessage: 'Failed to start run job' },
      );
      return res.data;
    },
  };
}

export type PublishViaCliRouteApi = ReturnType<typeof createPublishViaCliRouteApi>;
