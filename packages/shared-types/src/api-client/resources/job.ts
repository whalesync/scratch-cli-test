import type { Job } from '../../db/job';
import type { Http } from '../http';

/**
 * Job operations: listing, bulk-status polling, active-by-workbook lookup, raw inspection,
 * cancellation, and run-id lookup. Reached as `client.job.*`.
 *
 * Web (`client/src/lib/api/job.ts`) and desktop (`scratch-desktop/.../job-api.ts`) overlap on
 * `getJobsStatus` (identical) and `getJobRaw` (same route/body; web typed the return `object`,
 * desktop typed it `unknown` — kept as `object`, which is assignable to `unknown`, so both call
 * sites are satisfied). Remaining divergences:
 *   - `getActiveJobsByWorkbook` (web name) vs `getActiveJobs` (desktop name) hit the SAME route
 *     `GET /jobs/workbook/:id/active`. Both names are exposed so each frontend's repoint stays a
 *     pure rename (do NOT collapse — follow the publish via*Route precedent for divergent names).
 *   - `getJobs`, `cancelJob`, `getJobsByRunId` are WEB-ONLY.
 */
export function createJobApi(http: Http) {
  return {
    /** GET `/jobs` — list jobs with paging and optional filters. (WEB-ONLY) */
    getJobs: async (
      limit?: number,
      offset?: number,
      workbookId?: string,
      filter?: { type?: string; syncId?: string; dataFolderId?: string },
    ): Promise<Job[]> => {
      const res = await http.get<Job[]>('/jobs', {
        params: {
          limit,
          offset,
          workbookId,
          type: filter?.type,
          syncId: filter?.syncId,
          dataFolderId: filter?.dataFolderId,
        },
        fallbackMessage: 'Failed to fetch jobs',
      });
      return res.data;
    },

    /** POST `/jobs/bulk-status` — fetch status for a set of job ids. (both web + desktop) */
    getJobsStatus: async (jobIds: string[]): Promise<Job[]> => {
      const res = await http.post<Job[]>(
        '/jobs/bulk-status',
        { jobIds },
        { fallbackMessage: 'Failed to fetch bulk job status' },
      );
      return res.data;
    },

    /**
     * GET `/jobs/workbook/:id/active` — active jobs for a workbook. Used by both apps (the web
     * client named this `getActiveJobsByWorkbook`, the desktop app `getActiveJobs` — same route).
     */
    getActiveJobsByWorkbook: async (workbookId: string): Promise<Job[]> => {
      const res = await http.get<Job[]>(`/jobs/workbook/${workbookId}/active`, {
        fallbackMessage: 'Failed to fetch active jobs for workspace',
      });
      return res.data;
    },

    /** GET `/jobs/:id/raw` — raw job record. (both web + desktop; web typed `object`, desktop `unknown`) */
    getJobRaw: async (jobId: string): Promise<object> => {
      const res = await http.get<object>(`/jobs/${jobId}/raw`, { fallbackMessage: 'Failed to fetch raw job data' });
      return res.data;
    },

    /** POST `/jobs/:id/cancel` — cancel a running job. (WEB-ONLY) */
    cancelJob: async (jobId: string): Promise<void> => {
      await http.post(`/jobs/${jobId}/cancel`, undefined, { fallbackMessage: 'Failed to cancel job' });
    },

    /** GET `/jobs/run/:runId` — jobs belonging to a run. (WEB-ONLY) */
    getJobsByRunId: async (runId: string): Promise<Job[]> => {
      const res = await http.get<Job[]>(`/jobs/run/${runId}`, { fallbackMessage: 'Failed to fetch jobs for run' });
      return res.data;
    },
  };
}

export type JobApi = ReturnType<typeof createJobApi>;
