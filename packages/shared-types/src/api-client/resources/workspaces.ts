import type { Workspace } from '../../db';
import type { CreateWorkbookDto } from '../../dto/workbook/create-workbook.dto';
import type { DeleteWorkbookResponseDto } from '../../dto/workbook/delete-workbook.dto';
import type { WorkbookListQuery } from '../../dto/workbook/list-workbooks-query.dto';
import type { UpdateWorkbookDto } from '../../dto/workbook/update-workbook.dto';
import type { Http } from '../http';

export type WorkbookSortBy = NonNullable<WorkbookListQuery['sortBy']>;
export type WorkbookSortOrder = NonNullable<WorkbookListQuery['sortOrder']>;

/** Return shape of `pull-files` — union of the web (`jobIds`) and desktop (`jobId`/`warning`) fields. */
export interface PullFilesResponse {
  jobId?: string;
  jobIds?: string[];
  warning?: string;
}

/**
 * Workspace CRUD + record pulls. (Server route is `/workbook`; the product term is "workspace".)
 */
export function createWorkspacesApi(http: Http) {
  return {
    list: async (
      connectorAccountId?: string,
      sortBy: WorkbookSortBy = 'createdAt',
      sortOrder: WorkbookSortOrder = 'desc',
    ): Promise<Workspace[]> => {
      const params: WorkbookListQuery = { connectorAccountId, sortBy, sortOrder };
      const res = await http.get<Workspace[]>('/workbook', { params, fallbackMessage: 'Failed to fetch workspaces' });
      return res.data;
    },

    detail: async (id: string): Promise<Workspace> => {
      const res = await http.get<Workspace>(`/workbook/${id}`, { fallbackMessage: 'Failed to fetch workspace' });
      return res.data;
    },

    create: async (dto: CreateWorkbookDto): Promise<Workspace> => {
      const res = await http.post<Workspace>('/workbook', dto, { fallbackMessage: 'Failed to create a workspace' });
      return res.data;
    },

    update: async (id: string, updateDto: UpdateWorkbookDto): Promise<Workspace> => {
      const res = await http.patch<Workspace>(`/workbook/${id}`, updateDto, {
        fallbackMessage: 'Failed to update workspace',
      });
      return res.data;
    },

    delete: async (id: string, options?: { force?: boolean }): Promise<DeleteWorkbookResponseDto> => {
      const res = await http.delete<DeleteWorkbookResponseDto>(`/workbook/${id}`, {
        params: options?.force ? { force: 'true' } : undefined,
        fallbackMessage: 'Failed to delete workspace',
      });
      return res.data;
    },

    pullFiles: async (
      id: string,
      dataFolderIds?: string[],
      mode?: 'full' | 'incremental',
    ): Promise<PullFilesResponse> => {
      const res = await http.post<PullFilesResponse>(
        `/workbook/${id}/pull-files`,
        { dataFolderIds, mode },
        { fallbackMessage: 'Failed to start files pull' },
      );
      return res.data;
    },

    pullAssets: async (
      id: string,
      dataFolderIds: string[],
      options?: { rehost?: boolean },
    ): Promise<{ jobIds?: string[] }> => {
      const res = await http.post<{ jobIds?: string[] }>(
        `/workbook/${id}/pull-assets`,
        { dataFolderIds, rehost: options?.rehost },
        { fallbackMessage: 'Failed to start asset pull' },
      );
      return res.data;
    },
  };
}

export type WorkspacesApi = ReturnType<typeof createWorkspacesApi>;
