import { JobType, type WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { FileIndexService, folderPathOwns } from 'src/publish-plan/file-index.service';
import { FileReferenceService } from 'src/publish-plan/file-reference.service';
import { WSLogger } from '../../../logger';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';

export type CleanupConnectionIndexRowsPublicProgress = {
  status: 'pending' | 'active' | 'completed' | 'failed';
};

/**
 * Background cleanup after a connection is DELETED (DEV-10885). FileIndex and
 * FileReference have no FK to DataFolder/ConnectorAccount, so deleting the
 * connection's DataFolders leaves their rows orphaned against the surviving
 * workbook. This job removes them out of band so the delete request returns fast.
 *
 * - `connectorAccountId` scopes the FileIndex delete (covers nested sub-paths for
 *   free); the ConnectorAccount row is already gone, but the column value persists
 *   on the FileIndex rows (no FK), so the scoped delete still matches. A reconnect
 *   gets a NEW connectorAccountId, so this can never touch a future connection's
 *   rows — no run-time guard needed.
 * - `connectionFolderPaths` are the connection's DataFolder paths captured before
 *   deletion (with leading slash). FileReference has no connectorAccountId column,
 *   so its rows are prefix-deleted per folder path. Because folder paths carry no
 *   connection prefix, a reconnect of the same service can recreate a DataFolder at
 *   one of these paths and re-pull into it before this (possibly delayed/retried)
 *   job drains. To avoid wiping that new connection's refs, we re-check liveness at
 *   RUN time: skip any path a live DataFolder owns at-or-above it, and exclude any
 *   live DataFolder recreated strictly under it (mirrors the single-folder
 *   `deleteForFolderExcludingLiveChildren` path).
 */
export type CleanupConnectionIndexRowsJobDefinition = JobDefinitionBuilder<
  typeof JobType.CleanupConnectionIndexRows,
  {
    workbookId: WorkbookId;
    // Carried on every job payload (the worker logs it and uses it as the DbJob
    // fallback owner); the cleanup work itself is system-level and doesn't use it.
    userId: string;
    connectorAccountId: string;
    connectionFolderPaths: string[];
  },
  CleanupConnectionIndexRowsPublicProgress,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  {},
  void
>;

export class CleanupConnectionIndexRowsJobHandler
  implements JobHandlerBuilder<CleanupConnectionIndexRowsJobDefinition>
{
  constructor(
    private readonly fileIndexService: FileIndexService,
    private readonly fileReferenceService: FileReferenceService,
    private readonly db: DbService,
  ) {}

  async run(params: {
    jobId: string;
    data: CleanupConnectionIndexRowsJobDefinition['data'];
    progress: Progress<
      CleanupConnectionIndexRowsJobDefinition['publicProgress'],
      CleanupConnectionIndexRowsJobDefinition['initialJobProgress']
    >;
    abortSignal: AbortSignal;
    checkpoint: (
      progress: Omit<
        Progress<
          CleanupConnectionIndexRowsJobDefinition['publicProgress'],
          CleanupConnectionIndexRowsJobDefinition['initialJobProgress']
        >,
        'timestamp'
      >,
    ) => Promise<void>;
  }) {
    const { jobId, data, checkpoint } = params;
    const { workbookId, connectorAccountId, connectionFolderPaths } = data;

    await checkpoint({
      publicProgress: { status: 'active' },
      jobProgress: {},
      connectorProgress: {},
    });

    WSLogger.info({
      source: 'CleanupConnectionIndexRowsJobHandler',
      message: 'Cleaning up orphaned FileIndex/FileReference rows for deleted connection',
      workbookId,
      connectorAccountId,
      folderPathCount: connectionFolderPaths.length,
      jobId,
    });

    try {
      // FileIndex: single scoped delete covers all of the connection's rows,
      // including any stored under a folderPath deeper than the DataFolder path.
      // Scoped by the now-dead connectorAccountId, so it can't touch a future
      // connection's rows even if this job runs long after a reconnect.
      await this.fileIndexService.deleteForConnection(workbookId, connectorAccountId);

      // FileReference: no connectorAccountId column, so prefix-delete per folder path.
      // Re-check liveness at RUN time so a reconnect of the same service (which reuses
      // the freed folder paths) plus a re-pull before this job drains can't have its
      // fresh refs wiped. Two reclaim shapes, mirroring the single-folder delete path:
      //   - ancestor-or-self: a live folder sits at or above the path (the common
      //     reconnect) → leave the whole subtree to that owner (skip).
      //   - descendant: a live folder was recreated strictly UNDER the path but its
      //     parent wasn't re-pulled (e.g. a Webflow locale child without its parent
      //     collection) → exclude those subtrees so the prefix delete can't reach them.
      const liveDataFolders = await this.db.client.dataFolder.findMany({
        where: { workbookId, path: { not: null } },
        select: { path: true },
      });
      const liveFolderPathsNoSlash = liveDataFolders
        .map((folder) => folder.path?.replace(/^\//, ''))
        .filter((path): path is string => !!path);

      // Paths arrive with a leading slash; FileReference.sourceFilePath is stored
      // without one, so strip it to match.
      for (const folderPath of connectionFolderPaths) {
        const folderPathNoSlash = folderPath.replace(/^\//, '');
        if (!folderPathNoSlash) continue;
        const reclaimedByLiveOwner = liveFolderPathsNoSlash.some((livePath) =>
          folderPathOwns(livePath, folderPathNoSlash),
        );
        if (reclaimedByLiveOwner) continue;
        const liveChildFolderPathsNoSlash = liveFolderPathsNoSlash.filter((livePath) =>
          livePath.startsWith(`${folderPathNoSlash}/`),
        );
        await this.fileReferenceService.deleteForFolderExcludingLiveChildren(
          workbookId,
          folderPathNoSlash,
          liveChildFolderPathsNoSlash,
        );
      }

      await checkpoint({
        publicProgress: { status: 'completed' },
        jobProgress: {},
        connectorProgress: {},
      });

      WSLogger.info({
        source: 'CleanupConnectionIndexRowsJobHandler',
        message: 'Connection index cleanup complete',
        workbookId,
        connectorAccountId,
        jobId,
      });
    } catch (err) {
      await checkpoint({
        publicProgress: { status: 'failed' },
        jobProgress: {},
        connectorProgress: {},
      });
      throw err;
    }
  }
}
