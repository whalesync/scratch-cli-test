import type { DataFolder, DataFolderGroup } from '../../db';
import type { CreateDataFolderDto } from '../../dto/data-folder/create-data-folder.dto';
import type { MoveDataFolderDto } from '../../dto/data-folder/move-data-folder.dto';
import type { RenameDataFolderDto } from '../../dto/data-folder/rename-data-folder.dto';
import type { UpdateDataFolderDto } from '../../dto/data-folder/update-data-folder.dto';
import type { DirtyFile } from '../../file-types';
import type { TransformerConfig } from '../../sync-mapping';
import type { Http } from '../http';

/**
 * Data-folder operations: create / read / mutate the folders that index a connection's records,
 * plus a couple of working-tree reads. Reached as `client.dataFolders.*`.
 *
 * WEB vs DESKTOP reconciliation (web `data-folder.ts` `dataFolderApi`, desktop
 * `data-folders-api.ts` `dataFoldersApi`):
 *  - `create`, `delete`, `getSchema` — SAME route/body/return on both, one shared method each.
 *  - `update` — same route (`PATCH /data-folder/:id`) and same body (`UpdateDataFolderDto`), but the
 *    RETURN DIVERGES: web returns the updated `DataFolder`; desktop ignored the body and typed it as
 *    `void`. Canonical here returns `DataFolder` (the richer shape); desktop callers may discard it.
 *  - `list`, `getDirtyFiles` — DESKTOP-ONLY (web has no equivalent in its module).
 *  - `findOne`, `rename`, `move`, `pullFiles`, `refreshSchema`, `deleteAllRecords` — WEB-ONLY.
 *
 * Note on `create`'s DTO: the web module passes the full `CreateDataFolderDto`; the desktop module
 * declared an inline body (`tableId`/`connectorAccountId` required, plus `name`, `workbookId`,
 * `filter?`, `idFieldOverride?`, `nameFieldOverride?`, `options?`, `triggerPull?`). That inline shape
 * is a subset of `CreateDataFolderDto`, which is therefore used as the canonical parameter type.
 */
export function createDataFoldersApi(http: Http) {
  return {
    /** GET `/workbook/:id/data-folders/list` — grouped data folders for a workbook. (desktop-only) */
    list: async (workbookId: string): Promise<DataFolderGroup[]> => {
      const res = await http.get<DataFolderGroup[]>(`/workbook/${workbookId}/data-folders/list`, {
        fallbackMessage: 'Failed to list data folders',
      });
      return res.data;
    },

    /** POST `/data-folder/create` — create a data folder. (web + desktop) */
    create: async (dto: CreateDataFolderDto): Promise<DataFolder> => {
      const res = await http.post<DataFolder>('/data-folder/create', dto, {
        fallbackMessage: 'Failed to create data folder',
      });
      return res.data;
    },

    /** GET `/data-folder/:id` — fetch a single data folder. (web-only) */
    findOne: async (id: string): Promise<DataFolder> => {
      const res = await http.get<DataFolder>(`/data-folder/${id}`, {
        fallbackMessage: 'Failed to fetch data folder',
      });
      return res.data;
    },

    /** DELETE `/data-folder/:id` — delete a data folder. (web + desktop) */
    delete: async (id: string): Promise<void> => {
      await http.delete(`/data-folder/${id}`, { fallbackMessage: 'Failed to delete data folder' });
    },

    /** PATCH `/data-folder/:id/rename` — rename a data folder. (web-only) */
    rename: async (id: string, dto: RenameDataFolderDto): Promise<DataFolder> => {
      const res = await http.patch<DataFolder>(`/data-folder/${id}/rename`, dto, {
        fallbackMessage: 'Failed to rename data folder',
      });
      return res.data;
    },

    /**
     * PATCH `/data-folder/:id` — update a data folder's `filter` / `options`. (web + desktop)
     * Returns the updated `DataFolder` (web). The desktop module typed this as `void` and ignored
     * the body; that is a strict subset of returning `DataFolder`, so callers may discard the result.
     */
    update: async (id: string, dto: UpdateDataFolderDto): Promise<DataFolder> => {
      const res = await http.patch<DataFolder>(`/data-folder/${id}`, dto, {
        fallbackMessage: 'Failed to update data folder',
      });
      return res.data;
    },

    /** PATCH `/data-folder/:id/move` — move a data folder. (web-only) */
    move: async (id: string, dto: MoveDataFolderDto): Promise<DataFolder> => {
      const res = await http.patch<DataFolder>(`/data-folder/${id}/move`, dto, {
        fallbackMessage: 'Failed to move data folder',
      });
      return res.data;
    },

    /** POST `/data-folder/:id/pull-files` — pull specific files into a folder. (web-only) */
    pullFiles: async (dataFolderId: string, workbookId: string, filePaths: string[]): Promise<{ jobId: string }> => {
      const res = await http.post<{ jobId: string }>(
        `/data-folder/${dataFolderId}/pull-files`,
        { workbookId, filePaths },
        { fallbackMessage: 'Failed to pull files' },
      );
      return res.data;
    },

    /** GET `/data-folder/:id/schema` — read a data folder's JSON schema. (web + desktop) */
    getSchema: async (dataFolderId: string): Promise<Record<string, unknown>> => {
      const res = await http.get<Record<string, unknown>>(`/data-folder/${dataFolderId}/schema`, {
        fallbackMessage: 'Failed to get schema for data folder: ' + dataFolderId,
      });
      return res.data;
    },

    /** POST `/data-folder/:id/refresh-schema` — re-derive a data folder's schema from the service. (web-only) */
    refreshSchema: async (dataFolderId: string): Promise<Record<string, unknown>> => {
      const res = await http.post<Record<string, unknown>>(`/data-folder/${dataFolderId}/refresh-schema`, undefined, {
        fallbackMessage: 'Failed to refresh schema for data folder: ' + dataFolderId,
      });
      return res.data;
    },

    /** DELETE `/scratch-git/:id/data-folder/files?path=` — delete all records under a folder path. (web-only) */
    deleteAllRecords: async (workbookId: string, folderPath: string): Promise<void> => {
      await http.delete(`/scratch-git/${workbookId}/data-folder/files`, {
        params: { path: folderPath },
        fallbackMessage: 'Failed to delete all records in: ' + folderPath,
      });
    },

    /** GET `/scratch-git/:id/git-status` — dirty (uncommitted) files in the workbook. (desktop-only) */
    getDirtyFiles: async (workbookId: string): Promise<DirtyFile[]> => {
      const res = await http.get<DirtyFile[]>(`/scratch-git/${workbookId}/git-status`, {
        fallbackMessage: 'Failed to get dirty files',
      });
      return res.data;
    },

    /** POST `/data-folder/:folderId/files` — create a record file in a folder. */
    createDataFolderFile: async (
      folderId: string,
      name: string,
      useTemplate: boolean,
      workbookId: string,
    ): Promise<unknown> => {
      const res = await http.post(
        `/data-folder/${folderId}/files`,
        { name, useTemplate, workbookId },
        { fallbackMessage: 'Failed to create file in data folder' },
      );
      return res.data;
    },

    /** GET `/data-folder/:folderId/schema-paths` — flattened schema paths + suggested transformers. */
    getSchemaPaths: async (
      folderId: string,
    ): Promise<{ path: string; type: string; displayLabel?: string; suggestedTransformer?: TransformerConfig }[]> => {
      const res = await http.get<
        { path: string; type: string; displayLabel?: string; suggestedTransformer?: TransformerConfig }[]
      >(`/data-folder/${folderId}/schema-paths`, { fallbackMessage: 'Failed to fetch schema paths' });
      return res.data;
    },
  };
}

export type DataFoldersApi = ReturnType<typeof createDataFoldersApi>;
