import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { DataFolderId, WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { ScratchGitNotFoundError } from 'src/scratch-git/scratch-git.client';
import { MAIN_BRANCH, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { WorkbookEventService } from 'src/workbook/workbook-event.service';

const LOG_SOURCE = 'RecordCountService';

// Bound how many DataFolder row updates run concurrently per workbook.
const UPDATE_CHUNK_SIZE = 25;

export interface RecordCountDeps {
  prisma: PrismaClient;
  scratchGit: ScratchGitService;
  events: WorkbookEventService;
}

export interface RecomputeRecordCountsOptions {
  // When set, only recompute folders belonging to this connector account (one repo walk).
  connectorAccountId?: string | null;
  // Emit a `folder-updated` workbook event when counts change (default true).
  emitEvent?: boolean;
  // Source attributed to the emitted event (default 'job').
  eventSource?: 'job' | 'cron';
}

/**
 * Recompute the denormalized {@link DataFolder.recordCount} for a workbook's folders from
 * git (the source of truth), updating only rows whose count changed.
 *
 * Idempotent and safe to re-run: it derives every count from the current git tree, so two
 * runs with no git changes between them update nothing. A missing/uninitialized repo is
 * treated as 0 for its folders rather than failing the whole workbook. Implemented as a
 * standalone function (over an injected client) so it can be called both from the pull job
 * handler — which holds a raw {@link PrismaClient} — and from the Nest cron service.
 */
export async function recomputeRecordCountsForWorkbook(
  deps: RecordCountDeps,
  workbookId: WorkbookId,
  options: RecomputeRecordCountsOptions = {},
): Promise<{ changedFolderIds: DataFolderId[] }> {
  const { prisma, scratchGit, events } = deps;
  const emitEvent = options.emitEvent ?? true;
  const eventSource = options.eventSource ?? 'job';

  const folders = await prisma.dataFolder.findMany({
    where: {
      workbookId,
      ...(options.connectorAccountId ? { connectorAccountId: options.connectorAccountId } : {}),
    },
    select: { id: true, path: true, connectorAccountId: true, recordCount: true },
  });
  type FolderRow = (typeof folders)[number];

  // Group folders by their connector account so each repo is walked exactly once. Connector-less
  // (scratch) folders share the per-workbook scratch repo and are counted together below (DEV-10424).
  const foldersByConnectorAccountId = new Map<string, FolderRow[]>();
  const scratchFolders: FolderRow[] = [];
  const desiredCountByFolderId = new Map<string, number>();
  for (const folder of folders) {
    if (!folder.connectorAccountId) {
      scratchFolders.push(folder);
      continue;
    }
    const group = foldersByConnectorAccountId.get(folder.connectorAccountId) ?? [];
    group.push(folder);
    foldersByConnectorAccountId.set(folder.connectorAccountId, group);
  }

  for (const [connectorAccountId, accountFolders] of foldersByConnectorAccountId) {
    let countByGitFolderPath = new Map<string, number>();
    try {
      const repoId = await scratchGit.resolveConnectionRepoPath(connectorAccountId);
      countByGitFolderPath = await scratchGit.countRecordFilesByFolder(repoId, MAIN_BRANCH);
    } catch (error) {
      // A repo that doesn't exist yet (never pulled/initialized) means "no records": count
      // its folders as 0 and keep going. Only log unexpected (non-404) failures.
      if (!(error instanceof ScratchGitNotFoundError)) {
        WSLogger.warn({
          source: LOG_SOURCE,
          message: 'Failed to count record files for connector account; treating its folders as 0',
          workbookId,
          connectorAccountId,
          error,
        });
      }
    }
    for (const folder of accountFolders) {
      // DataFolder.path is POSIX with a leading slash (e.g. "/Airtable/Table"); git folder
      // keys have none. Strip exactly one. A null path has no git location → 0.
      const gitFolderPath = folder.path == null ? null : folder.path.replace(/^\//, '');
      const count = gitFolderPath == null ? 0 : (countByGitFolderPath.get(gitFolderPath) ?? 0);
      desiredCountByFolderId.set(folder.id, count);
    }
  }

  // Count scratch (connector-less) folders from the per-workbook scratch repo (main branch).
  if (scratchFolders.length > 0) {
    let countByGitFolderPath = new Map<string, number>();
    try {
      const repoId = await scratchGit.resolveRepoPathForFolder(null, workbookId);
      countByGitFolderPath = await scratchGit.countRecordFilesByFolder(repoId, MAIN_BRANCH);
    } catch (error) {
      // No scratch repo yet (never initialized) → count its folders as 0. Log unexpected failures.
      if (!(error instanceof ScratchGitNotFoundError)) {
        WSLogger.warn({
          source: LOG_SOURCE,
          message: 'Failed to count record files for scratch repo; treating its folders as 0',
          workbookId,
          error,
        });
      }
    }
    for (const folder of scratchFolders) {
      const gitFolderPath = folder.path == null ? null : folder.path.replace(/^\//, '');
      const count = gitFolderPath == null ? 0 : (countByGitFolderPath.get(gitFolderPath) ?? 0);
      desiredCountByFolderId.set(folder.id, count);
    }
  }

  // Update only rows whose count actually changed: keeps updatedAt stable and avoids churn.
  const foldersToUpdate = folders.filter(
    (folder) => (desiredCountByFolderId.get(folder.id) ?? 0) !== folder.recordCount,
  );
  const now = new Date();
  for (let start = 0; start < foldersToUpdate.length; start += UPDATE_CHUNK_SIZE) {
    const chunk = foldersToUpdate.slice(start, start + UPDATE_CHUNK_SIZE);
    await Promise.all(
      chunk.map((folder) =>
        prisma.dataFolder.update({
          where: { id: folder.id },
          data: { recordCount: desiredCountByFolderId.get(folder.id) ?? 0, recordCountUpdatedAt: now },
        }),
      ),
    );
  }

  const changedFolderIds = foldersToUpdate.map((folder) => folder.id as DataFolderId);
  if (emitEvent && changedFolderIds.length > 0) {
    events.sendWorkbookEvent(workbookId, {
      type: 'folder-updated',
      data: {
        source: eventSource,
        entityId: workbookId,
        message: 'Record counts refreshed',
        changedFolderIds,
      },
    });
  }

  return { changedFolderIds };
}

/**
 * Nest wrapper around {@link recomputeRecordCountsForWorkbook}, plus a single-folder variant.
 * Injected by the hourly cron and any service that wants to refresh counts on demand.
 */
@Injectable()
export class RecordCountService {
  constructor(
    private readonly db: DbService,
    private readonly scratchGit: ScratchGitService,
    private readonly events: WorkbookEventService,
  ) {}

  recomputeRecordCountsForWorkbook(
    workbookId: WorkbookId,
    options: RecomputeRecordCountsOptions = {},
  ): Promise<{ changedFolderIds: DataFolderId[] }> {
    return recomputeRecordCountsForWorkbook(
      { prisma: this.db.client, scratchGit: this.scratchGit, events: this.events },
      workbookId,
      options,
    );
  }

  /**
   * Recompute a single folder's recordCount (cheap, single-folder git count). Updates the
   * row and emits a `folder-updated` event only when the count changed. A missing repo
   * counts as 0; an unexpected git error leaves the stored count unchanged.
   */
  async recomputeRecordCountForFolder(folderId: DataFolderId): Promise<void> {
    const folder = await this.db.client.dataFolder.findUnique({
      where: { id: folderId },
      select: { id: true, workbookId: true, path: true, connectorAccountId: true, recordCount: true },
    });
    if (!folder || folder.path == null) {
      return;
    }

    let count = 0;
    try {
      // Folder-aware: connector folders resolve to the connector repo, scratch folders to the
      // per-workbook scratch repo (DEV-10424). Both count on main.
      const repoId = await this.scratchGit.resolveRepoPathForFolder(
        folder.connectorAccountId,
        folder.workbookId as WorkbookId,
      );
      count = await this.scratchGit.countRecordFilesInFolder(repoId, folder.path.replace(/^\//, ''), MAIN_BRANCH);
    } catch (error) {
      if (!(error instanceof ScratchGitNotFoundError)) {
        WSLogger.warn({
          source: LOG_SOURCE,
          message: 'Failed to count record files for folder; leaving recordCount unchanged',
          folderId,
          error,
        });
        return;
      }
      // Missing repo → 0 records.
    }

    if (count === folder.recordCount) {
      return;
    }
    await this.db.client.dataFolder.update({
      where: { id: folder.id },
      data: { recordCount: count, recordCountUpdatedAt: new Date() },
    });
    this.events.sendWorkbookEvent(folder.workbookId as WorkbookId, {
      type: 'folder-updated',
      data: { source: 'job', entityId: folder.id, message: 'Record count refreshed' },
    });
  }
}
