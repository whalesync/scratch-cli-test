import { API_CONFIG } from './api';

export interface PlanJobResponse {
  jobId: string | number | null;
  pipelineId: string | null;
}

export interface RunJobResponse {
  jobId: string | number | null;
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
};
