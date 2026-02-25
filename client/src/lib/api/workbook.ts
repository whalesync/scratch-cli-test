import {} from '@/types/server-entities/workbook';
import {
  CreateWorkbookDto,
  DataFolderGroup,
  DataFolderPublishStatus,
  DirtyFileCountResponse,
  HasDirtyFilesResponse,
  PublishPlanBuildDto,
  PublishPlanEntity,
  PublishPlanOperationEntity,
  PublishPlanRunDto,
  TestTransformerDto,
  TestTransformerResponse,
  TransformerConfig,
  UpdateWorkbookDto,
  Workbook,
  WorkbookId,
} from '@spinner/shared-types';
import { API_CONFIG } from './config';
import { handleAxiosError } from './error';

export type WorkbookSortBy = 'name' | 'createdAt' | 'updatedAt';
export type WorkbookSortOrder = 'asc' | 'desc';

export interface GitFile {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

export const workbookApi = {
  list: async (
    connectorAccountId?: string,
    sortBy: WorkbookSortBy = 'createdAt',
    sortOrder: WorkbookSortOrder = 'desc',
  ): Promise<Workbook[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<Workbook[]>('/workbook', {
        params: {
          connectorAccountId,
          sortBy,
          sortOrder,
        },
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch workbooks');
    }
  },

  detail: async (id: WorkbookId): Promise<Workbook> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<Workbook>(`/workbook/${id}`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch workbook');
    }
  },

  async create(dto: CreateWorkbookDto): Promise<Workbook> {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<Workbook>('/workbook', dto);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to create a workbook');
    }
  },

  update: async (id: WorkbookId, updateDto: UpdateWorkbookDto): Promise<Workbook> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.patch<Workbook>(`/workbook/${id}`, updateDto);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to update workbook');
    }
  },

  async pullFiles(id: WorkbookId, dataFolderIds?: string[]): Promise<{ jobIds?: string[] }> {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<{ jobIds?: string[] }>(`/workbook/${id}/pull-files`, { dataFolderIds });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to start files pull');
    }
  },

  async delete(id: WorkbookId): Promise<void> {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.delete(`/workbook/${id}`);
    } catch (error) {
      handleAxiosError(error, 'Failed to delete workbook');
    }
  },

  listDataFolders: async (workbookId: WorkbookId): Promise<DataFolderGroup[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<DataFolderGroup[]>(`/workbook/${workbookId}/data-folders/list`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to list data folders');
    }
  },

  getDataFoldersPublishStatus: async (workbookId: WorkbookId): Promise<DataFolderPublishStatus[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<DataFolderPublishStatus[]>(`/workbook/${workbookId}/data-folders/publish-status`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to get data folders publish status');
    }
  },

  createDataFolderFile: async (
    folderId: string,
    name: string,
    useTemplate: boolean,
    workbookId: WorkbookId,
  ): Promise<unknown> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post(`/data-folder/${folderId}/files`, { name, useTemplate, workbookId });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to create file in data folder');
      throw error;
    }
  },

  getSchemaPaths: async (
    folderId: string,
  ): Promise<{ path: string; type: string; suggestedTransformer?: TransformerConfig }[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<{ path: string; type: string; suggestedTransformer?: TransformerConfig }[]>(
        `/data-folder/${folderId}/schema-paths`,
      );
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch schema paths');
      return [];
    }
  },

  backupWorkbookToRepo: async (workbookId: WorkbookId): Promise<{ success: boolean; message: string }> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<{ success: boolean; message: string }>(`/scratch-git/${workbookId}/backup`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to backup workbook');
      throw error;
    }
  },
  listRepoFiles: async (workbookId: WorkbookId, branch = 'main', folder = ''): Promise<GitFile[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<GitFile[]>(`/scratch-git/${workbookId}/list`, {
        params: { branch, folder },
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to list repository files');
      throw error;
    }
  },
  getRepoFile: async (workbookId: WorkbookId, path: string, branch = 'main'): Promise<{ content: string }> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<{ content: string }>(`/scratch-git/${workbookId}/file`, {
        params: { branch, path },
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to get file content');
      throw error;
    }
  },

  getRepoStatus: async (workbookId: WorkbookId): Promise<object> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<object>(`/scratch-git/${workbookId}/git-status`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to get repo status');
      throw error;
    }
  },

  getRepoDiff: async (workbookId: WorkbookId, path: string): Promise<string> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<string>(`/scratch-git/${workbookId}/git-diff`, {
        params: { path },
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to get file diff');
      throw error;
    }
  },

  getGraph: async (workbookId: WorkbookId): Promise<{ commits: unknown[]; refs: unknown[] }> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<{ commits: unknown[]; refs: unknown[] }>(`/scratch-git/${workbookId}/graph`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to get git graph');
      throw error;
    }
  },

  rebaseDirty: async (workbookId: WorkbookId): Promise<void> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.post(`/scratch-git/${workbookId}/rebase`);
    } catch (error) {
      handleAxiosError(error, 'Failed to rebase dirty branch');
      throw error;
    }
  },

  hasDirtyFiles: async (workbookId: WorkbookId): Promise<HasDirtyFilesResponse> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<HasDirtyFilesResponse>(`/scratch-git/${workbookId}/git-has-dirty`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to check dirty status');
      throw error;
    }
  },

  getStatusCount: async (workbookId: WorkbookId): Promise<DirtyFileCountResponse> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<DirtyFileCountResponse>(`/scratch-git/${workbookId}/git-status-count`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to get git status count');
      throw error;
    }
  },

  getStatus: async (workbookId: WorkbookId): Promise<unknown> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get(`/scratch-git/${workbookId}/git-status`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to get git status');
      throw error;
    }
  },

  async createCheckpoint(workbookId: WorkbookId, name: string): Promise<void> {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.post(`/scratch-git/${workbookId}/checkpoint`, { name });
    } catch (error) {
      handleAxiosError(error, 'Failed to create checkpoint');
      throw error;
    }
  },

  async listCheckpoints(workbookId: WorkbookId): Promise<{ name: string; timestamp: number; message: string }[]> {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<{ name: string; timestamp: number; message: string }[]>(
        `/scratch-git/${workbookId}/checkpoints`,
      );
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to list checkpoints');
      throw error;
    }
  },

  async revertToCheckpoint(workbookId: WorkbookId, name: string): Promise<void> {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.post(`/scratch-git/${workbookId}/checkpoint/revert`, { name });
    } catch (error) {
      handleAxiosError(error, 'Failed to revert to checkpoint');
      throw error;
    }
  },

  async deleteCheckpoint(workbookId: WorkbookId, name: string): Promise<void> {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.delete(`/scratch-git/${workbookId}/checkpoint/${name}`);
    } catch (error) {
      handleAxiosError(error, 'Failed to delete checkpoint');
      throw error;
    }
  },

  async discardChanges(workbookId: WorkbookId, path?: string): Promise<void> {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.post(`/workbook/${workbookId}/discard-changes`, { path });
    } catch (error) {
      handleAxiosError(error, 'Failed to discard changes');
      throw error;
    }
  },

  async resetWorkbook(workbookId: WorkbookId): Promise<void> {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.post(`/workbook/${workbookId}/reset`);
    } catch (error) {
      handleAxiosError(error, 'Failed to reset workbook');
      throw error;
    }
  },

  testTransformer: async (workbookId: WorkbookId, dto: TestTransformerDto): Promise<TestTransformerResponse> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<TestTransformerResponse>('/sync/transformers/test', dto);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to test transformer');
      throw error;
    }
  },

  deleteFile: async (workbookId: WorkbookId, path: string): Promise<void> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.delete(`/workbooks/${workbookId}/files/by-path`, {
        params: { path },
      });
    } catch (error) {
      handleAxiosError(error, 'Failed to delete file');
      throw error;
    }
  },

  planPublishV2: async (
    workbookId: WorkbookId,
    connectorAccountId?: string,
    runAfterPlan?: boolean,
    folderPath?: string,
    filePath?: string,
  ): Promise<{ jobId: string; publishPlanId: string }> => {
    const body: PublishPlanBuildDto = { connectorAccountId, runAfterPlan, folderPath, filePath };
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<{ jobId: string; publishPlanId: string }>(
        `/workbook/${workbookId}/publish-v2/plan-job`,
        body,
      );
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to start plan job');
      throw error;
    }
  },

  runPublishV2: async (
    workbookId: WorkbookId,
    publishPlanId: string,
    executeSinglePhase?: boolean,
  ): Promise<{ jobId: string }> => {
    const body: PublishPlanRunDto = { pipelineId: publishPlanId, executeSinglePhase };
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<{ jobId: string }>(`/workbook/${workbookId}/publish-v2/run-job`, body);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to start run job');
      throw error;
    }
  },

  listPublishPlans: async (workbookId: WorkbookId, connectorAccountId?: string): Promise<PublishPlanEntity[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<PublishPlanEntity[]>(`/workbook/${workbookId}/publish-v2`, {
        params: { connectorAccountId },
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to list publish plans');
      throw error;
    }
  },

  listFileIndex: async (workbookId: WorkbookId): Promise<unknown[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<unknown[]>(`/workbook/${workbookId}/publish-v2/index/files`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to list file index');
      throw error;
    }
  },

  listRefIndex: async (workbookId: WorkbookId): Promise<unknown[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<unknown[]>(`/workbook/${workbookId}/publish-v2/index/refs`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to list ref index');
      throw error;
    }
  },

  listPublishPlanOperations: async (
    workbookId: WorkbookId,
    publishPlanId: string,
  ): Promise<PublishPlanOperationEntity[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<PublishPlanOperationEntity[]>(
        `/workbook/${workbookId}/publish-v2/${publishPlanId}/operations`,
      );
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to list publish plan operations');
      throw error;
    }
  },

  deletePublishPlan: async (workbookId: WorkbookId, publishPlanId: string): Promise<void> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.delete(`/workbook/${workbookId}/publish-v2/${publishPlanId}`);
    } catch (error) {
      handleAxiosError(error, 'Failed to delete publish plan');
      throw error;
    }
  },
};
