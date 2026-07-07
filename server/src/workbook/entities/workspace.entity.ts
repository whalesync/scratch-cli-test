import { Schedule } from '@prisma/client';
import { IncrementalPullSupport, WorkbookId, WorkbookManager, Workspace } from '@spinner/shared-types';
import { WorkbookCluster } from '../../db/cluster-types';
import { largestConnectionSideRecordCount } from '../whalesync-eligible-record-count.util';
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
    const dataFolders = workbook.dataFolders?.map(
      (df) =>
        new DataFolderEntity(
          df,
          schedulesByEntityId?.get(df.id) ?? [],
          incrementalPullSupportByDataFolderId?.get(df.id) ?? IncrementalPullSupport.NOT_SUPPORTED,
        ),
    );
    return {
      id: workbook.id as WorkbookId,
      name: workbook.name ?? null,
      // ISO-8601 strings — matches how DataFolderEntity emits its timestamps and
      // how every client already reads them off the wire.
      createdAt: workbook.createdAt.toISOString(),
      updatedAt: workbook.updatedAt.toISOString(),
      version: workbook.version,
      isPendingDelete: workbook.isPendingDelete,
      managedBy: (workbook.managedBy as WorkbookManager | null) ?? null,
      // `settings` is a nullable JSON column; coalesce to an empty map so every client
      // always receives an object rather than null.
      settings: (workbook.settings as Record<string, string | number | boolean> | null) ?? {},
      userId: workbook.userId ?? null,
      organizationId: workbook.organizationId,
      dataFolders,
      // Workspace-level total, summed from the per-folder counts. Undefined when folders
      // aren't loaded — we don't fabricate a total without them.
      recordCount: dataFolders?.reduce((sum, folder) => sum + folder.recordCount, 0),
      // Whalesync-plan-eligible count: the larger of the two connection sides for a CRM-mirror
      // workspace (counting each synced record once), 0 for a non-CRM-mirror workspace. Same
      // load-dependent semantics as `recordCount` — undefined when folders aren't loaded.
      whalesyncEligibleRecordCount: !workbook.dataFolders
        ? undefined
        : workbook.managedBy === WorkbookManager.WS_EXPORT
          ? largestConnectionSideRecordCount(workbook.dataFolders)
          : 0,
    };
  },
};
