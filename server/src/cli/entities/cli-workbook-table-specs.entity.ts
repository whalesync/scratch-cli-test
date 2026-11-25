import { CLI_WORKBOOK_TABLE_SPECS_FORMAT_VERSION, type CliWorkbookTableSpecsResponse } from '@spinner/shared-types';
import type { StoredTableSpecsForCliCacheRefreshConnection } from 'src/workbook/table-spec-store/data-folder-table-spec-store.service';

/** Builds the `GET /cli/v1/workbooks/:id/table-specs` response from the store's read (DEV-13025). */
export const CliWorkbookTableSpecsEntity = {
  from(
    workbookId: string,
    connectionsForCliCacheRefresh: StoredTableSpecsForCliCacheRefreshConnection[],
  ): CliWorkbookTableSpecsResponse {
    return {
      formatVersion: CLI_WORKBOOK_TABLE_SPECS_FORMAT_VERSION,
      workbookId,
      connectorAccounts: connectionsForCliCacheRefresh.map(({ connectorAccountId, dataFolders }) => ({
        connectorAccountId,
        dataFolders: dataFolders.map(({ dataFolderId, folderPath, storedRowUpdatedAt, tableSpec, defaultView }) => ({
          dataFolderId,
          path: folderPath,
          storedRowUpdatedAt: storedRowUpdatedAt?.toISOString() ?? null,
          tableSpec,
          defaultView,
        })),
      })),
    };
  },
};
