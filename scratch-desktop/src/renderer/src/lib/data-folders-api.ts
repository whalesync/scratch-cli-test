import { DataFolder, DataFolderGroup, DirtyFile } from '@spinner/shared-types';
import { API_CONFIG } from './api';

export const dataFoldersApi = {
  list: async (workbookId: string): Promise<DataFolderGroup[]> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.get<DataFolderGroup[]>(`/workbook/${workbookId}/data-folders/list`);
    return res.data;
  },

  create: async (dto: {
    tableId: string[];
    workbookId: string;
    name: string;
    connectorAccountId: string;
    filter?: string;
    idFieldOverride?: string;
    nameFieldOverride?: string[];
    options?: Record<string, unknown>;
    triggerPull?: boolean;
  }): Promise<DataFolder> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.post<DataFolder>('/data-folder/create', dto);
    return res.data;
  },

  getSchema: async (folderId: string): Promise<Record<string, unknown>> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.get<Record<string, unknown>>(`/data-folder/${folderId}/schema`);
    return res.data;
  },

  update: async (
    folderId: string,
    dto: { filter?: string | null; options?: Record<string, unknown> },
  ): Promise<void> => {
    const axios = API_CONFIG.getAxiosInstance();
    await axios.patch(`/data-folder/${folderId}`, dto);
  },

  delete: async (folderId: string): Promise<void> => {
    const axios = API_CONFIG.getAxiosInstance();
    await axios.delete(`/data-folder/${folderId}`);
  },

  getDirtyFiles: async (workbookId: string): Promise<DirtyFile[]> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.get<DirtyFile[]>(`/scratch-git/${workbookId}/git-status`);
    return res.data;
  },
};
