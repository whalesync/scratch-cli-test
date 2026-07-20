import type {
  PlanJobResponse,
  PublishFailedOperationsResponse,
  RunJobResponse,
} from '../../dto/publish-plan/publish-job-responses.dto';
import type { PublishPlanRunDto } from '../../dto/publish-plan/publish-plan.dto';
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
     *
     * Always sends `publishOrigin: 'desktop'` (publish redesign, DEV-10048): this route is the
     * desktop/CLI path, which owns a local working tree, so the server strips connector-rejected
     * paths from its `dirty` branch and the failures travel back to the client (the run-job's
     * `failedOperations` → `failed-patches.json`) instead of being kept on `dirty`.
     */
    runJob: async (workbookId: string, pipelineId: string): Promise<RunJobResponse> => {
      const body: PublishPlanRunDto = { pipelineId, publishOrigin: 'desktop' };
      const res = await http.post<RunJobResponse>(`/cli/v1/workbooks/${workbookId}/publish-v2/run-job`, body, {
        fallbackMessage: 'Failed to start run job',
      });
      return res.data;
    },

    /**
     * GET `/cli/v1/workbooks/:id/publish-v2/:planId/failed-operations` — the COMPLETE set of a
     * plan's connector-rejected records (`failed-batch` operations), one entry per file path,
     * paginated (DEV-10756). The post-publish reconcile uses this — not the capped
     * `publicProgress.failedOperations` — so every failure lands in `failed-patches.json`.
     *
     * The load-bearing runtime consumer is the Rust CLI (`scratchmd files reconcile-after-publish
     * --pipeline-id`), which mirrors this route directly via reqwest; this TypeScript method exists
     * for the shared-types contract (no shadow types) and any future TS caller.
     */
    failedOperations: async (
      workbookId: string,
      pipelineId: string,
      options?: { page?: number; pageSize?: number },
    ): Promise<PublishFailedOperationsResponse> => {
      const res = await http.get<PublishFailedOperationsResponse>(
        `/cli/v1/workbooks/${workbookId}/publish-v2/${pipelineId}/failed-operations`,
        {
          params: { page: options?.page, pageSize: options?.pageSize },
          fallbackMessage: 'Failed to list failed publish operations',
        },
      );
      return res.data;
    },
  };
}

export type PublishViaCliRouteApi = ReturnType<typeof createPublishViaCliRouteApi>;
