import type { Asset, FileIndex, FileReference } from '../../db';
import type {
  PublishDiffAnchor,
  PublishPlanChangedFilesResponse,
  PublishPlanEntity,
  PublishPlanFileDiff,
  PublishPlanListResponse,
  PublishPlanOperationEntity,
  PublishPlanRecordsResponse,
} from '../../dto/publish-plan/publish-plan.dto';
import type { FileDiffStatus } from '../../file-types';
import type { Http } from '../http';

/**
 * Read/delete operations over already-built publish plans. These hang off the SAME
 * `/workbook/:id/publish-v2/...` routes for BOTH the web client and the desktop app (only the
 * plan-BUILD and plan-RUN endpoints diverge by auth/route — see `publish-via-workbook-route.ts`
 * and `publish-via-cli-route.ts`). Reached at the `client.publish.*` root.
 */
export function createPublishPlansApi(http: Http) {
  return {
    listPublishPlans: async (
      workbookId: string,
      options?: { connectorAccountId?: string; page?: number; pageSize?: number },
    ): Promise<PublishPlanListResponse> => {
      const res = await http.get<PublishPlanListResponse>(`/workbook/${workbookId}/publish-v2`, {
        params: {
          connectorAccountId: options?.connectorAccountId,
          page: options?.page,
          pageSize: options?.pageSize,
        },
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

    listFileIndex: async (
      workbookId: string,
      options?: { page?: number; pageSize?: number },
    ): Promise<{ data: FileIndex[]; total: number; page: number; pageSize: number }> => {
      const res = await http.get<{ data: FileIndex[]; total: number; page: number; pageSize: number }>(
        `/workbook/${workbookId}/publish-v2/index/files`,
        {
          params: { page: options?.page, pageSize: options?.pageSize },
          fallbackMessage: 'Failed to list file index',
        },
      );
      return res.data;
    },

    listRefIndex: async (
      workbookId: string,
      options?: { page?: number; pageSize?: number },
    ): Promise<{ data: FileReference[]; total: number; page: number; pageSize: number }> => {
      const res = await http.get<{ data: FileReference[]; total: number; page: number; pageSize: number }>(
        `/workbook/${workbookId}/publish-v2/index/refs`,
        {
          params: { page: options?.page, pageSize: options?.pageSize },
          fallbackMessage: 'Failed to list ref index',
        },
      );
      return res.data;
    },

    listAssetIndex: async (
      workbookId: string,
      options?: { dataFolderId?: string; page?: number; pageSize?: number },
    ): Promise<{ data: Asset[]; total: number; page: number; pageSize: number }> => {
      const res = await http.get<{ data: Asset[]; total: number; page: number; pageSize: number }>(
        `/workbook/${workbookId}/publish-v2/index/assets`,
        {
          params: { dataFolderId: options?.dataFolderId, page: options?.page, pageSize: options?.pageSize },
          fallbackMessage: 'Failed to list asset index',
        },
      );
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

    /**
     * The files that differ between two anchors of a publish (`from` → `to`,
     * default pre-publish `main` → post-publish `main`), paginated. `folderPath`
     * restricts to one folder (prefix match on the workbook path); `status`
     * restricts to added / modified / deleted. See {@link PublishPlanChangedFilesResponse}
     * and {@link PublishDiffAnchor}.
     */
    listPublishPlanChangedFiles: async (
      workbookId: string,
      planId: string,
      options?: {
        from?: PublishDiffAnchor;
        to?: PublishDiffAnchor;
        page?: number;
        pageSize?: number;
        folderPath?: string;
        status?: FileDiffStatus;
      },
    ): Promise<PublishPlanChangedFilesResponse> => {
      const res = await http.get<PublishPlanChangedFilesResponse>(
        `/workbook/${workbookId}/publish-v2/${planId}/changed-files`,
        {
          params: options,
          fallbackMessage: 'Failed to list publish plan changed files',
        },
      );
      return res.data;
    },

    /**
     * Content of one record file at two anchors of a publish (`from` → `to`,
     * default pre-publish `main` → post-publish `main`), plus a sparse
     * field-level diff. `path` is the full workbook path of the file (e.g.
     * `/Companies/rec_123.json`). See {@link PublishPlanFileDiff} and {@link PublishDiffAnchor}.
     */
    getPublishPlanFileDiff: async (
      workbookId: string,
      planId: string,
      path: string,
      options?: { from?: PublishDiffAnchor; to?: PublishDiffAnchor },
    ): Promise<PublishPlanFileDiff> => {
      const res = await http.get<PublishPlanFileDiff>(`/workbook/${workbookId}/publish-v2/${planId}/file-diff`, {
        params: { path, from: options?.from, to: options?.to },
        fallbackMessage: 'Failed to fetch publish plan file diff',
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
