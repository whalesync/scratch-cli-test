import type {
  PublishPlanEntity,
  PublishPlanOperationEntity,
  PublishPlanRecordsResponse,
} from '../../dto/publish-plan/publish-plan.dto';
import type { Http } from '../http';

/**
 * Read/delete operations over already-built publish plans. These hang off the SAME
 * `/workbook/:id/publish-v2/...` routes for BOTH the web client and the desktop app (only the
 * plan-BUILD and plan-RUN endpoints diverge by auth/route — see `publish-via-workbook-route.ts`
 * and `publish-via-cli-route.ts`). Reached at the `client.publish.*` root.
 */
export function createPublishPlansApi(http: Http) {
  return {
    listPublishPlans: async (workbookId: string, connectorAccountId?: string): Promise<PublishPlanEntity[]> => {
      const res = await http.get<PublishPlanEntity[]>(`/workbook/${workbookId}/publish-v2`, {
        params: { connectorAccountId },
        fallbackMessage: 'Failed to list publish plans',
      });
      return res.data;
    },

    getPublishPlanByJobId: async (workbookId: string, jobId: string): Promise<PublishPlanEntity | null> => {
      const res = await http.get<PublishPlanEntity | null>(`/workbook/${workbookId}/publish-v2/by-job/${jobId}`, {
        fallbackMessage: 'Failed to fetch publish plan by job ID',
      });
      return res.data;
    },

    getPublishPlan: async (workbookId: string, planId: string): Promise<PublishPlanEntity | null> => {
      const res = await http.get<PublishPlanEntity | null>(`/workbook/${workbookId}/publish-v2/${planId}`, {
        fallbackMessage: 'Failed to fetch publish plan',
      });
      return res.data;
    },

    listPublishPlanRecords: async (
      workbookId: string,
      planId: string,
      options?: { page?: number; pageSize?: number; dataFolderId?: string; phase?: string; filename?: string },
    ): Promise<PublishPlanRecordsResponse> => {
      const res = await http.get<PublishPlanRecordsResponse>(`/workbook/${workbookId}/publish-v2/${planId}/records`, {
        params: options,
        fallbackMessage: 'Failed to list publish plan records',
      });
      return res.data;
    },

    listFileIndex: async (workbookId: string): Promise<unknown[]> => {
      const res = await http.get<unknown[]>(`/workbook/${workbookId}/publish-v2/index/files`, {
        fallbackMessage: 'Failed to list file index',
      });
      return res.data;
    },

    listRefIndex: async (workbookId: string): Promise<unknown[]> => {
      const res = await http.get<unknown[]>(`/workbook/${workbookId}/publish-v2/index/refs`, {
        fallbackMessage: 'Failed to list ref index',
      });
      return res.data;
    },

    listAssetIndex: async (workbookId: string, dataFolderId?: string): Promise<unknown[]> => {
      const res = await http.get<unknown[]>(`/workbook/${workbookId}/publish-v2/index/assets`, {
        params: dataFolderId ? { dataFolderId } : {},
        fallbackMessage: 'Failed to list asset index',
      });
      return res.data;
    },

    listPublishPlanOperations: async (
      workbookId: string,
      publishPlanId: string,
      options?: { page?: number; pageSize?: number; phase?: string; filePath?: string; hasError?: boolean },
    ): Promise<{ data: PublishPlanOperationEntity[]; total: number; page: number; pageSize: number }> => {
      const res = await http.get<{
        data: PublishPlanOperationEntity[];
        total: number;
        page: number;
        pageSize: number;
      }>(`/workbook/${workbookId}/publish-v2/${publishPlanId}/operations`, {
        params: {
          page: options?.page,
          pageSize: options?.pageSize,
          phase: options?.phase,
          filePath: options?.filePath,
          hasError: options?.hasError ? 'true' : undefined,
        },
        fallbackMessage: 'Failed to list publish plan operations',
      });
      return res.data;
    },

    deletePublishPlan: async (workbookId: string, publishPlanId: string): Promise<void> => {
      await http.delete(`/workbook/${workbookId}/publish-v2/${publishPlanId}`, {
        fallbackMessage: 'Failed to delete publish plan',
      });
    },
  };
}

export type PublishPlansApi = ReturnType<typeof createPublishPlansApi>;
