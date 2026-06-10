import type { CreateFileDto, FileDetailsResponseDto, UpdateFileDto } from '../../dto/workbook/file-details.dto';
import type { ListFilesResponseDto } from '../../dto/workbook/list-files.dto';
import type { FileRefEntity } from '../../file-types';
import type { Http } from '../http';

/**
 * File-based workbook operations: list/create/read/update/delete files by path, resolve foreign-key
 * references, and download a data folder as a ZIP archive. Reached as `client.files.*`.
 */
export function createFilesApi(http: Http) {
  return {
    /**
     * List files and folders at a given path (non-recursive, like `ls`).
     * GET /workbooks/:workbookId/files/list/by-folder?folderId=...
     */
    listFilesByFolder: async (
      workbookId: string,
      folderId: string,
      options?: { cursor?: string; limit?: number },
    ): Promise<ListFilesResponseDto> => {
      const params: Record<string, string | number> = { folderId };
      if (options?.cursor) params.cursor = options.cursor;
      if (options?.limit) params.limit = options.limit;
      const res = await http.get<ListFilesResponseDto>(`/workbooks/${workbookId}/files/list/by-folder`, {
        params,
        fallbackMessage: 'Failed to list files by folder',
      });
      return res.data;
    },

    /**
     * Create a new file
     * POST /workbooks/:workbookId/files
     */
    createFile: async (workbookId: string, dto: CreateFileDto): Promise<FileRefEntity> => {
      const res = await http.post<FileRefEntity>(`/workbooks/${workbookId}/files`, dto, {
        fallbackMessage: 'Failed to create file',
      });
      return res.data;
    },

    /**
     * Get a single file by full path
     * GET /workbooks/:workbookId/files/by-path
     * @param path the full path to the file
     */
    getFileByPath: async (workbookId: string, path: string): Promise<FileDetailsResponseDto> => {
      const res = await http.get<FileDetailsResponseDto>(`/workbooks/${workbookId}/files/by-path`, {
        params: { path },
        fallbackMessage: 'Failed to fetch file',
      });
      return res.data;
    },

    /**
     * Update an existing file by file path
     * PATCH /workbooks/:workbookId/files/by-path
     */
    updateFileByPath: async (workbookId: string, path: string, dto: UpdateFileDto): Promise<void> => {
      await http.patch(`/workbooks/${workbookId}/files/by-path`, dto, {
        params: { path },
        fallbackMessage: 'Failed to update file',
      });
    },

    /** PATCH `/workbooks/:id/files/by-path?path=` with `{ name }` — rename a file in place. */
    renameFileByPath: async (workbookId: string, path: string, name: string): Promise<void> => {
      await http.patch(
        `/workbooks/${workbookId}/files/by-path`,
        { name },
        { params: { path }, fallbackMessage: 'Failed to rename file' },
      );
    },

    /**
     * Delete a file by file path
     * DELETE /workbooks/:workbookId/files/by-path
     */
    deleteFileByPath: async (workbookId: string, path: string): Promise<void> => {
      await http.delete(`/workbooks/${workbookId}/files/by-path`, {
        params: { path },
        fallbackMessage: 'Failed to delete file',
      });
    },

    /**
     * Resolve foreign key values in a file to their referenced file paths.
     * GET /workbooks/:workbookId/files/resolve-references?path=...&branch=main|dirty
     */
    resolveReferences: async (
      workbookId: string,
      path: string,
      branch: 'main' | 'dirty',
    ): Promise<{ references: Record<string, Record<string, string>> }> => {
      const res = await http.get<{ references: Record<string, Record<string, string>> }>(
        `/workbooks/${workbookId}/files/resolve-references`,
        { params: { path, branch }, fallbackMessage: 'Failed to resolve references' },
      );
      return res.data;
    },

    /**
     * Download all files in a data folder as a ZIP archive.
     * GET /workbooks/:workbookId/files/download?folderId=...
     *
     * Returns the raw ZIP blob; saving it to disk (filename, anchor click, object-URL cleanup)
     * is left to the platform-specific caller.
     */
    downloadFolder: async (workbookId: string, folderId: string): Promise<Blob> => {
      const res = await http.get<Blob>(`/workbooks/${workbookId}/files/download`, {
        params: { folderId },
        responseType: 'blob',
        fallbackMessage: 'Failed to download folder',
      });
      return res.data;
    },
  };
}

export type FilesApi = ReturnType<typeof createFilesApi>;
