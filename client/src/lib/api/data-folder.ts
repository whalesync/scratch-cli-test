import {
  CreateDataFolderDto,
  DataFolder,
  DataFolderId,
  MoveDataFolderDto,
  RenameDataFolderDto,
  UpdateDataFolderDto,
  WorkbookId,
} from '@spinner/shared-types';
import { API_CONFIG } from './config';
import { handleAxiosError } from './error';

export const dataFolderApi = {
  create: async (dto: CreateDataFolderDto): Promise<DataFolder> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<DataFolder>('/data-folder/create', dto);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to create data folder');
    }
  },

  findOne: async (id: DataFolderId): Promise<DataFolder> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<DataFolder>(`/data-folder/${id}`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch data folder');
    }
  },

  delete: async (id: DataFolderId): Promise<void> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.delete(`/data-folder/${id}`);
    } catch (error) {
      handleAxiosError(error, 'Failed to delete data folder');
    }
  },

  rename: async (id: DataFolderId, dto: RenameDataFolderDto): Promise<DataFolder> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.patch<DataFolder>(`/data-folder/${id}/rename`, dto);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to rename data folder');
    }
  },

  update: async (id: DataFolderId, dto: UpdateDataFolderDto): Promise<DataFolder> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.patch<DataFolder>(`/data-folder/${id}`, dto);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to update data folder');
    }
  },

  move: async (id: DataFolderId, dto: MoveDataFolderDto): Promise<DataFolder> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.patch<DataFolder>(`/data-folder/${id}/move`, dto);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to move data folder');
    }
  },

  refreshRecords: async (
    dataFolderId: DataFolderId,
    workbookId: WorkbookId,
    filePaths: string[],
  ): Promise<{ jobId: string }> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<{ jobId: string }>(`/data-folder/${dataFolderId}/refresh-records`, {
        workbookId,
        filePaths,
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to refresh records');
    }
  },

  getSchema: async (dataFolderId: DataFolderId): Promise<Record<string, unknown>> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<Record<string, unknown>>(`/data-folder/${dataFolderId}/schema`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to get schema for data folder: ' + dataFolderId);
    }
  },

  refreshSchema: async (dataFolderId: DataFolderId): Promise<Record<string, unknown>> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<Record<string, unknown>>(`/data-folder/${dataFolderId}/refresh-schema`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to refresh schema for data folder: ' + dataFolderId);
    }
  },

  deleteAllRecords: async (workbookId: WorkbookId, folderPath: string): Promise<void> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.delete(`/scratch-git/${workbookId}/data-folder/files`, {
        params: { path: folderPath },
      });
    } catch (error) {
      handleAxiosError(error, 'Failed to delete all records in: ' + folderPath);
    }
  },
};
