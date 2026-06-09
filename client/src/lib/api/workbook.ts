import {} from '@/types/server-entities/workbook';
import {
  AddWorkspacePermissionDto,
  AdminWorkbookDto,
  CreateWorkbookDto,
  DataFolderGroup,
  DeleteWorkbookResponseDto,
  DirtyFile,
  DirtyFileCountResponse,
  GitGcResponse,
  GitObjectCountsResponse,
  HasDirtyFilesResponse,
  PublishPlanBuildDto,
  PublishPlanEntity,
  PublishPlanOperationEntity,
  PublishPlanRecordsResponse,
  PublishPlanRunDto,
  TestTransformerDto,
  TestTransformerResponse,
  TransformerConfig,
  UpdateWorkbookDto,
  UpdateWorkspacePermissionDto,
  WorkbookId,
  Workspace,
  WorkspaceInvite,
  WorkspaceInviteId,
  WorkspacePermission,
  WorkspacePermissionId,
} from '@spinner/shared-types';
import { API_CONFIG } from './config';
import { handleAxiosError } from './error';

export type WorkbookSortBy = 'name' | 'createdAt' | 'updatedAt';

export interface StripPrefixConnectionResult {
  connectorAccountId: string;
  displayName: string;
  repoId: string;
  case: string;
  foldersUpdated: number;
  error?: string;
}
export type WorkbookSortOrder = 'asc' | 'desc';

export interface GitFile {
  name: string;
  path: string;
  type: 'file' | 'directory';
}

export interface GitIndexFile {
  folder: string;
  filename: string;
  remoteId: string | null;
}

export interface GitIndexReference {
  sourceFolder: string;
  sourceFilename: string;
  targetTableId: string;
  targetRemoteId: string;
}

export interface GitIndexDump {
  files: GitIndexFile[];
  references: GitIndexReference[];
}

export const workbookApi = {
  list: async (
    connectorAccountId?: string,
    sortBy: WorkbookSortBy = 'createdAt',
    sortOrder: WorkbookSortOrder = 'desc',
  ): Promise<Workspace[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<Workspace[]>('/workbook', {
        params: {
          connectorAccountId,
          sortBy,
          sortOrder,
        },
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch workspaces');
    }
  },

  detail: async (id: WorkbookId): Promise<Workspace> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<Workspace>(`/workbook/${id}`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch workspace');
    }
  },

  async create(dto: CreateWorkbookDto): Promise<Workspace> {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<Workspace>('/workbook', dto);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to create a workspace');
    }
  },

  update: async (id: WorkbookId, updateDto: UpdateWorkbookDto): Promise<Workspace> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.patch<Workspace>(`/workbook/${id}`, updateDto);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to update workspace');
    }
  },

  async pullFiles(
    id: WorkbookId,
    dataFolderIds?: string[],
    mode?: 'full' | 'incremental',
  ): Promise<{ jobIds?: string[] }> {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<{ jobIds?: string[] }>(`/workbook/${id}/pull-files`, { dataFolderIds, mode });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to start files pull');
    }
  },

  async pullAssets(
    id: WorkbookId,
    dataFolderIds: string[],
    options?: { rehost?: boolean },
  ): Promise<{ jobIds?: string[] }> {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<{ jobIds?: string[] }>(`/workbook/${id}/pull-assets`, {
        dataFolderIds,
        rehost: options?.rehost,
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to start asset pull');
    }
  },

  async delete(id: WorkbookId, options?: { force?: boolean }): Promise<DeleteWorkbookResponseDto> {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.delete<DeleteWorkbookResponseDto>(`/workbook/${id}`, {
        params: options?.force ? { force: 'true' } : undefined,
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to delete workspace');
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
  ): Promise<{ path: string; type: string; displayLabel?: string; suggestedTransformer?: TransformerConfig }[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<
        { path: string; type: string; displayLabel?: string; suggestedTransformer?: TransformerConfig }[]
      >(`/data-folder/${folderId}/schema-paths`);
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
      handleAxiosError(error, 'Failed to backup workspace');
      throw error;
    }
  },
  listRepoFiles: async (
    workbookId: WorkbookId,
    branch = 'main',
    folder = '',
    connectorAccountId?: string,
    useConfigRepo?: boolean,
  ): Promise<GitFile[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<GitFile[]>(`/scratch-git/${workbookId}/list`, {
        params: { branch, folder, connectorAccountId, useConfigRepo: useConfigRepo ? 'true' : undefined },
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to list repository files');
      throw error;
    }
  },
  getRepoFile: async (
    workbookId: WorkbookId,
    path: string,
    branch = 'main',
    connectorAccountId?: string,
    useConfigRepo?: boolean,
  ): Promise<{ content: string }> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<{ content: string }>(`/scratch-git/${workbookId}/file`, {
        params: { branch, path, connectorAccountId, useConfigRepo: useConfigRepo ? 'true' : undefined },
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

  getGraph: async (
    workbookId: WorkbookId,
    connectorAccountId?: string,
    useConfigRepo?: boolean,
  ): Promise<{ commits: unknown[]; refs: unknown[] }> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<{ commits: unknown[]; refs: unknown[] }>(`/scratch-git/${workbookId}/graph`, {
        params: { connectorAccountId, useConfigRepo: useConfigRepo ? 'true' : undefined },
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to get git graph');
      throw error;
    }
  },

  rebaseDirty: async (workbookId: WorkbookId, connectorAccountId?: string): Promise<void> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.post(`/scratch-git/${workbookId}/rebase`, {}, { params: { connectorAccountId } });
    } catch (error) {
      handleAxiosError(error, 'Failed to rebase dirty branch');
      throw error;
    }
  },
  runGitGc: async (
    workbookId: WorkbookId,
    aggressive?: boolean,
    connectorAccountId?: string,
  ): Promise<GitGcResponse> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<GitGcResponse>(
        `/scratch-git/${workbookId}/gc`,
        { aggressive },
        { params: { connectorAccountId } },
      );
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to run git gc');
      throw error;
    }
  },
  getObjectCounts: async (workbookId: WorkbookId, connectorAccountId?: string): Promise<GitObjectCountsResponse> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<GitObjectCountsResponse>(`/scratch-git/${workbookId}/object-counts`, {
        params: { connectorAccountId },
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to get object counts');
      throw error;
    }
  },

  buildIndex: async (workbookId: WorkbookId, connectorAccountId?: string): Promise<{ count: number }> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<{ count: number }>(
        `/scratch-git/${workbookId}/index/build`,
        {},
        { params: { connectorAccountId } },
      );
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to build index');
      throw error;
    }
  },

  dumpIndex: async (workbookId: WorkbookId, connectorAccountId?: string): Promise<GitIndexDump> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<GitIndexDump>(`/scratch-git/${workbookId}/index/dump`, {
        params: { connectorAccountId },
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to dump index');
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

  getStatus: async (workbookId: WorkbookId): Promise<DirtyFile[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<DirtyFile[]>(`/scratch-git/${workbookId}/git-status`);
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
      handleAxiosError(error, 'Failed to reset workspace');
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

  getPublishPlanByJobId: async (workbookId: WorkbookId, jobId: string): Promise<PublishPlanEntity | null> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<PublishPlanEntity | null>(`/workbook/${workbookId}/publish-v2/by-job/${jobId}`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch publish plan by job ID');
      throw error;
    }
  },

  getPublishPlan: async (workbookId: WorkbookId, planId: string): Promise<PublishPlanEntity | null> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<PublishPlanEntity | null>(`/workbook/${workbookId}/publish-v2/${planId}`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch publish plan');
      throw error;
    }
  },

  listPublishPlanRecords: async (
    workbookId: WorkbookId,
    planId: string,
    options?: { page?: number; pageSize?: number; dataFolderId?: string; phase?: string },
  ): Promise<PublishPlanRecordsResponse> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<PublishPlanRecordsResponse>(`/workbook/${workbookId}/publish-v2/${planId}/records`, {
        params: options,
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to list publish plan records');
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

  listAssetIndex: async (workbookId: WorkbookId, dataFolderId?: string): Promise<unknown[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const params = dataFolderId ? { dataFolderId } : {};
      const res = await axios.get<unknown[]>(`/workbook/${workbookId}/publish-v2/index/assets`, { params });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to list asset index');
      throw error;
    }
  },

  listPublishPlanOperations: async (
    workbookId: WorkbookId,
    publishPlanId: string,
    options?: { page?: number; pageSize?: number; phase?: string; filePath?: string; hasError?: boolean },
  ): Promise<{ data: PublishPlanOperationEntity[]; total: number; page: number; pageSize: number }> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<{
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
      });
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

  adminListWorkbooks: async (params: {
    search?: string;
    services?: string[];
    serviceMode?: 'AND' | 'OR';
    limit?: number;
    offset?: number;
  }): Promise<{ workbooks: AdminWorkbookDto[]; total: number }> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<{ workbooks: AdminWorkbookDto[]; total: number }>('/dev-tools/workbooks', {
        params: {
          search: params.search || undefined,
          services: params.services?.length ? params.services.join(',') : undefined,
          serviceMode: params.serviceMode,
          limit: params.limit,
          offset: params.offset,
        },
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to list workspaces');
      throw error;
    }
  },

  migrateToV2: async (workbookId: WorkbookId): Promise<{ success: boolean }> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<{ success: boolean }>(`/scratch-git/${workbookId}/migrate-to-v2`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to migrate workspace to v2');
      throw error;
    }
  },

  stripConnectionPrefix: async (
    workbookId: WorkbookId,
    connectorAccountId?: string,
  ): Promise<{ results: StripPrefixConnectionResult[] }> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<{ results: StripPrefixConnectionResult[] }>(
        `/scratch-git/${workbookId}/strip-connection-prefix`,
        {},
        { params: { connectorAccountId } },
      );
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to strip connection prefix');
      throw error;
    }
  },

  listInvites: async (workbookId: WorkbookId): Promise<WorkspaceInvite[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<WorkspaceInvite[]>(`/workbook/${workbookId}/invites`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to list workspace invites');
    }
  },

  listPermissions: async (workbookId: WorkbookId): Promise<WorkspacePermission[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<WorkspacePermission[]>(`/workbook/${workbookId}/permissions`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to list workspace permissions');
    }
  },

  addPermission: async (workbookId: WorkbookId, dto: AddWorkspacePermissionDto): Promise<void> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.post<WorkspacePermission>(`/workbook/${workbookId}/permissions/add`, dto);
    } catch (error) {
      handleAxiosError(error, 'Failed to add workspace permission');
    }
  },

  removePermission: async (workbookId: WorkbookId, permissionId: WorkspacePermissionId): Promise<void> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.delete(`/workbook/${workbookId}/permission/${permissionId}`);
    } catch (error) {
      handleAxiosError(error, 'Failed to remove workspace permission');
    }
  },

  deleteInvite: async (workbookId: WorkbookId, inviteId: WorkspaceInviteId): Promise<void> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.delete(`/workbook/${workbookId}/invite/${inviteId}`);
    } catch (error) {
      handleAxiosError(error, 'Failed to delete workspace invite');
    }
  },

  updatePermission: async (
    workbookId: WorkbookId,
    permissionId: WorkspacePermissionId,
    dto: UpdateWorkspacePermissionDto,
  ): Promise<WorkspacePermission> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.patch<WorkspacePermission>(`/workbook/${workbookId}/permission/${permissionId}`, dto);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to update workspace permission');
    }
  },

  exportWorkbookJson: async (workbookId: WorkbookId): Promise<unknown> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get(`/dev-tools/workbooks/${workbookId}/export`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to export workspace');
      throw error;
    }
  },

  importWorkbookJson: async (json: unknown): Promise<{ workbookId: string }> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<{ workbookId: string }>('/dev-tools/workbooks/import', json);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to import workspace');
      throw error;
    }
  },

  /**
   * @deprecated Legacy/manual helper.
   *
   * Normal sync create/update/delete flows already initialize the workbook config repo and
   * push the current sync definitions automatically on the server.
   */
  pushSyncsToGit: async (workbookId: WorkbookId): Promise<{ count: number }> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.post(`/cli/v1/workbooks/${workbookId}/config/init`);
      const res = await axios.post<{ count: number }>(`/cli/v1/workbooks/${workbookId}/config/push-syncs`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to push syncs to git');
      throw error;
    }
  },

  getConnectionGitUrl: async (connectorAccountId: string): Promise<{ gitUrl: string; gitCloneCommand: string }> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<{ gitUrl: string; gitCloneCommand: string }>(
        `/dev-tools/connections/${connectorAccountId}/git-url`,
      );
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to get connection git URL');
      throw error;
    }
  },

  moveRepo: async (
    connectorAccountId: string,
    newRepoPath: string,
  ): Promise<{ success: boolean; oldRepoPath: string; newRepoPath: string }> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<{ success: boolean; oldRepoPath: string; newRepoPath: string }>(
        `/dev-tools/connections/${connectorAccountId}/move-repo`,
        { newRepoPath },
      );
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to move repo');
      throw error;
    }
  },
  gitServiceProxy: async (
    workbookId: WorkbookId,
    connectionId: string,
    path: string,
    method: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const normalizedPath = path.startsWith('/') ? path.substring(1) : path;
      const res = await axios({
        method,
        url: `/scratch-git/${workbookId}/git-service/${connectionId}/${normalizedPath}`,
        data: body,
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, `Git service proxy error: ${path}`);
      throw error;
    }
  },
};
