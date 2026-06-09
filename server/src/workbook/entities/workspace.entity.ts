import { Schedule } from '@prisma/client';
import { IncrementalPullSupport, WorkbookId, Workspace } from '@spinner/shared-types';
import { WorkbookCluster } from '../../db/cluster-types';
import { DataFolderEntity } from './data-folder.entity';

/**
 * Factory for the shared {@link Workspace} data type. `Workspace` is the contract
 * every client consumes; this factory's only job is to build one from the DB
 * cluster row plus the side-loaded schedules / incremental-pull-support maps. It
 * returns the shared interface directly — there is no server-only `Workspace`
 * class, so nothing squats on the real word. (The DB model + route are still
 * "Workbook"; only the user-facing data type is "Workspace".)
 */
export const WorkspaceEntity = {
  from(
    workbook: WorkbookCluster.Workbook,
    schedulesByEntityId?: Map<string, Schedule[]>,
    incrementalPullSupportByDataFolderId?: Map<string, IncrementalPullSupport>,
  ): Workspace {
    return {
      id: workbook.id as WorkbookId,
      name: workbook.name ?? null,
      // ISO-8601 strings — matches how DataFolderEntity emits its timestamps and
      // how every client already reads them off the wire.
      createdAt: workbook.createdAt.toISOString(),
      updatedAt: workbook.updatedAt.toISOString(),
      version: workbook.version,
      isPendingDelete: workbook.isPendingDelete,
      userId: workbook.userId ?? null,
      organizationId: workbook.organizationId,
      dataFolders: workbook.dataFolders?.map(
        (df) =>
          new DataFolderEntity(
            df,
            schedulesByEntityId?.get(df.id) ?? [],
            incrementalPullSupportByDataFolderId?.get(df.id) ?? IncrementalPullSupport.NOT_SUPPORTED,
          ),
      ),
    };
  },
};
