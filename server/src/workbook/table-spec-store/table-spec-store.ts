import { WSLogger } from 'src/logger';
import type { BaseJsonTableSpec } from 'src/remote-service/connectors/types';

/**
 * Where a folder's table spec (the connector-derived JSON schema + id/title paths) is stored.
 *
 * Sync and publish read a folder's spec through this port, so a Live Export run can read the spec its own pull
 * wrote into the run store instead of the stored copy — see
 * docs/plans/2026-09-25-live-export-git-free-run-store/2026-09-25-live-export-git-free-run-store.md
 * ("The rule: no git or Postgres file state for these workbooks"). The folder ROW (which connection, which path)
 * is configuration and is still looked up in Postgres by the caller; only the spec's storage is behind the port.
 * The pull writes specs through its own storage port (`PullSink`).
 *
 * The classic implementation is `DataFolderTableSpecStoreService` (DEV-12616): the folder's `DataFolderTableSpec`
 * row in Postgres, mirrored to `.scratch/{folder}/schema.json` in the connection's git repo. The Live Export
 * implementation is `RunStoreTableSpecStore`.
 */
export interface TableSpecLocation {
  /** The folder. The Postgres store keys on it; the Live Export run store ignores it (it keys on connection + path). */
  dataFolderId: string;
  /** The connection whose storage holds the folder; null for a folder with no connection. */
  connectorAccountId: string | null;
  /** The folder's path as stored on its DataFolder row (leading slash or not); implementations normalize it. */
  folderPath: string;
}

export interface TableSpecStore {
  /** The stored spec, or null when none is stored. Throws when the storage can't be read. */
  readTableSpec(location: TableSpecLocation): Promise<BaseJsonTableSpec | null>;
}

/**
 * Reads a folder's table spec, returning null — and logging the error — when it can't be read, and null
 * for a folder with no path. Callers treat a missing spec as "no schema" (sync then falls back to an `id`
 * idPath), which is the long-standing classic behaviour.
 */
export async function readTableSpecOrNullLoggingFailure(
  tableSpecStore: TableSpecStore,
  location: { dataFolderId: string; connectorAccountId: string | null; folderPath: string | null },
  logContext: { source: string; workbookId: string },
): Promise<BaseJsonTableSpec | null> {
  const { dataFolderId, connectorAccountId, folderPath } = location;
  if (folderPath) {
    try {
      const tableSpec = await tableSpecStore.readTableSpec({ dataFolderId, connectorAccountId, folderPath });
      if (tableSpec) return tableSpec;
    } catch (error) {
      WSLogger.error({
        source: logContext.source,
        message: 'Failed to read table spec',
        error,
        workbookId: logContext.workbookId,
        dataFolderId,
        folderPath,
      });
    }
  }
  return null;
}
