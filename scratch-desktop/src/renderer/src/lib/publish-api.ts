import type { PublishPlanEntity, PublishPlanOperationEntity, PublishPlanRecordsResponse } from '@spinner/shared-types';
import { API_CONFIG } from './api';

export interface PlanJobResponse {
  jobId: string | number | null;
  pipelineId: string | null;
}

export interface RunJobResponse {
  jobId: string | number | null;
}

export interface RepoFileResponse {
  content: string;
}

export const publishApi = {
  /**
   * Build a publish plan for one connection. Returns `{ jobId, pipelineId }`
   * to track the plan-job to completion. When the server-side dirty branch
   * has no diff against main both fields come back null — caller should
   * skip the connection.
   */
  startPlanJob: async (workbookId: string, connectorAccountId: string): Promise<PlanJobResponse> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.post<PlanJobResponse>(`/cli/v1/workbooks/${workbookId}/publish-v2/plan-job`, {
      connectorAccountId,
      runAfterPlan: false,
    });
    return res.data;
  },

  /**
   * Dispatch a previously-built plan through the connector. Caller polls the
   * returned `jobId` for progress (publishing/done/failed).
   */
  startRunJob: async (workbookId: string, pipelineId: string): Promise<RunJobResponse> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.post<RunJobResponse>(`/cli/v1/workbooks/${workbookId}/publish-v2/run-job`, {
      pipelineId,
    });
    return res.data;
  },

  /**
   * List recent publish plans for a workbook (newest first). Returns up to
   * 20 plans server-side. Optionally filtered to a single connection.
   */
  listPublishPlans: async (workbookId: string, connectorAccountId?: string): Promise<PublishPlanEntity[]> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.get<PublishPlanEntity[]>(`/workbook/${workbookId}/publish-v2`, {
      params: { connectorAccountId },
    });
    return res.data;
  },

  /**
   * Fetch a single publish plan by id, including author + connector relation.
   * Returns null when the plan no longer exists.
   */
  getPublishPlan: async (workbookId: string, planId: string): Promise<PublishPlanEntity | null> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.get<PublishPlanEntity | null>(`/workbook/${workbookId}/publish-v2/${planId}`);
    return res.data;
  },

  /**
   * List records (operations grouped by filePath) for a publish plan. Supports
   * pagination + filtering by folder and phase. Returns aggregate filter
   * options (folders + phases with counts) for filter dropdowns.
   */
  listPublishPlanRecords: async (
    workbookId: string,
    planId: string,
    options?: { page?: number; pageSize?: number; dataFolderId?: string; phase?: string; filename?: string },
  ): Promise<PublishPlanRecordsResponse> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.get<PublishPlanRecordsResponse>(`/workbook/${workbookId}/publish-v2/${planId}/records`, {
      params: options,
    });
    return res.data;
  },

  /**
   * List operations on a publish plan, optionally filtered to one phase or
   * one filePath. Used by the "operation detail" sub-modal which fetches a
   * single (filePath, phase) row by setting `pageSize: 1`.
   */
  listPublishPlanOperations: async (
    workbookId: string,
    planId: string,
    options?: { page?: number; pageSize?: number; phase?: string; filePath?: string; hasError?: boolean },
  ): Promise<{ data: PublishPlanOperationEntity[]; total: number; page: number; pageSize: number }> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.get<{
      data: PublishPlanOperationEntity[];
      total: number;
      page: number;
      pageSize: number;
    }>(`/workbook/${workbookId}/publish-v2/${planId}/operations`, {
      params: {
        page: options?.page,
        pageSize: options?.pageSize,
        phase: options?.phase,
        filePath: options?.filePath,
        hasError: options?.hasError ? 'true' : undefined,
      },
    });
    return res.data;
  },

  /**
   * Delete a publish plan + its operations. Returns void on success.
   */
  deletePublishPlan: async (workbookId: string, planId: string): Promise<void> => {
    const axios = API_CONFIG.getAxiosInstance();
    await axios.delete(`/workbook/${workbookId}/publish-v2/${planId}`);
  },

  /**
   * Read a file from a connection's bare git repo at a specific ref. `branch`
   * accepts branch names ("main", "dirty") and tag names ("main_pre_plan_X",
   * "dirty_plan_X", "main_plan_X"). Returns null when the file is missing
   * at that ref (e.g. deleted record on the post side, created record on
   * the pre side).
   */
  getRepoFile: async (
    workbookId: string,
    path: string,
    branch: string,
    connectorAccountId?: string,
  ): Promise<RepoFileResponse | null> => {
    const axios = API_CONFIG.getAxiosInstance();
    try {
      const res = await axios.get<RepoFileResponse | null>(`/scratch-git/${workbookId}/file`, {
        params: { branch, path, connectorAccountId },
      });
      return res.data;
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 404) return null;
      throw err;
    }
  },
};
