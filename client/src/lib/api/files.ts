import {
  CreateFileDto,
  DataFolderId,
  FileDetailsResponseDto,
  FileRefEntity,
  ListFilesResponseDto,
  UpdateFileDto,
  WorkbookId,
} from '@spinner/shared-types';
import { API_CONFIG } from './config';
import { handleAxiosError } from './error';

/**
 * File API endpoints for file-based workbook operations
 */
export const filesApi = {
  /**
   * List files and folders at a given path (non-recursive, like `ls`).
   * GET /workbooks/:workbookId/files/list/by-folder?folderId=...
   */
  listFilesByFolder: async (
    workbookId: WorkbookId,
    folderId: DataFolderId,
    options?: { cursor?: string; limit?: number },
  ): Promise<ListFilesResponseDto> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const params: Record<string, string | number> = { folderId };
      if (options?.cursor) params.cursor = options.cursor;
      if (options?.limit) params.limit = options.limit;
      const res = await axios.get<ListFilesResponseDto>(`/workbooks/${workbookId}/files/list/by-folder`, {
        params,
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to list files by folder');
    }
  },

  /**
   * Create a new file
   * POST /workbooks/:workbookId/files
   */
  createFile: async (workbookId: WorkbookId, dto: CreateFileDto): Promise<FileRefEntity> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<FileRefEntity>(`/workbooks/${workbookId}/files`, dto);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to create file');
    }
  },

  /**
   * Get a single file by full path
   * GET /workbooks/:workbookId/files/by-path
   * @param path the full path to the file
   */
  getFileByPath: async (workbookId: WorkbookId, path: string): Promise<FileDetailsResponseDto> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<FileDetailsResponseDto>(`/workbooks/${workbookId}/files/by-path`, {
        params: { path },
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch file');
    }
  },

  /**
   * Update an existing file by file path
   * PATCH /workbooks/:workbookId/files/by-path
   */
  updateFileByPath: async (workbookId: WorkbookId, path: string, dto: UpdateFileDto): Promise<void> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.patch(`/workbooks/${workbookId}/files/by-path`, dto, { params: { path } });
    } catch (error) {
      handleAxiosError(error, 'Failed to update file');
    }
  },

  /**
   * Delete a file by file path
   * DELETE /workbooks/:workbookId/files/by-path
   */
  deleteFileByPath: async (workbookId: WorkbookId, path: string): Promise<void> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.delete(`/workbooks/${workbookId}/files/by-path`, { params: { path } });
    } catch (error) {
      handleAxiosError(error, 'Failed to delete file');
    }
  },

  /**
   * Resolve foreign key values in a file to their referenced file paths.
   * GET /workbooks/:workbookId/files/resolve-references?path=...&branch=main|dirty
   */
  resolveReferences: async (
    workbookId: WorkbookId,
    path: string,
    branch: 'main' | 'dirty',
  ): Promise<{ references: Record<string, Record<string, string>> }> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<{ references: Record<string, Record<string, string>> }>(
        `/workbooks/${workbookId}/files/resolve-references`,
        { params: { path, branch } },
      );
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to resolve references');
    }
  },

  /**
   * Download all files in a data folder as a ZIP archive.
   * GET /workbooks/:workbookId/files/download?folderId=...
   */
  downloadFolder: async (workbookId: WorkbookId, folderId: DataFolderId): Promise<void> => {
    try {
      const axiosInstance = API_CONFIG.getAxiosInstance();
      const res = await axiosInstance.get(`/workbooks/${workbookId}/files/download`, {
        params: { folderId },
        responseType: 'blob',
      });
      const contentDisposition = res.headers['content-disposition'] as string | undefined;
      const filename = contentDisposition?.match(/filename="(.+)"/)?.[1] ?? 'download.zip';
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      handleAxiosError(error, 'Failed to download folder');
    }
  },
};
