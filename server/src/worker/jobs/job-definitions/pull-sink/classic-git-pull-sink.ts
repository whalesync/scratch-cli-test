import type { PrismaClient } from '@prisma/client';
import type { TableView, WorkbookId } from '@spinner/shared-types';
import type { AssetExtractorService } from '../../../../asset/asset-extractor.service';
import type { AssetIndexService } from '../../../../asset/asset-index.service';
import { WSLogger } from '../../../../logger';
import type { FileIndexService } from '../../../../publish-plan/file-index.service';
import type { FileReferenceService } from '../../../../publish-plan/file-reference.service';
import { recomputeRecordCountsForWorkbook } from '../../../../record-count/record-count.service';
import {
  type BaseJsonTableSpec,
  type ConnectorFile,
  readRecordIdAsString,
} from '../../../../remote-service/connectors/types';
import { ScratchGitConflictError, ScratchGitNotFoundError } from '../../../../scratch-git/scratch-git.client';
import { MAIN_BRANCH, type ScratchGitService } from '../../../../scratch-git/scratch-git.service';
import type { JsonSafeObject } from '../../../../utils/objects';
import type { DataFolderTableSpecStoreService } from '../../../../workbook/table-spec-store/data-folder-table-spec-store.service';
import type { TableSpecLocation } from '../../../../workbook/table-spec-store/table-spec-store';
import type { WorkbookEventService } from '../../../../workbook/workbook-event.service';
import { JobCanceledError } from '../../../job-errors';
import { buildGitFilesFromConnectorFiles, type BuiltFile } from '../connector-file-utils';
import type { FinishFolderOptions, PullSink, PullSinkFolder, PullSinkFolderChangeSummary } from './pull-sink';

// Kept identical to the job's log source: this code was the job's Phase 2 and its log lines must not change.
const LOG_SOURCE = 'PullLinkedFolderFilesJob';

/**
 * Per-folder naming state, alive only while the folder's pages are being written — from
 * `prepareFolderForIncomingRecordPages` to `releaseRecordPageWritingStateForFolder`. Three whole-folder
 * maps on a large folder, so it is dropped as soon as the fetch ends rather than carried through Phase 2
 * (the pull worker's memory history: DEV-11192/11193/11194).
 */
type ClassicFolderFileNamingState = {
  /** Start-of-fetch FileIndex snapshot: record id → the filename that record already has in this folder. */
  indexedFilenameByRecordIdInFolder: Map<string, string>;
  /** Dedup conflict set, seeded from the snapshot and grown with every name minted during this run. */
  usedFileNames: Set<string>;
  /** Names minted during THIS run, keyed by record id (see `prepareFolderForIncomingRecordPages`). */
  fileNamesAssignedByRecordIdInThisRun: Map<string, string>;
};

/**
 * The classic storage behind the pull job: stage each page on scratch-git's disk, then per folder read
 * the staged files back, index them into FileIndex / FileReference / Asset, commit them to `main` in
 * batches, and delete files the upstream no longer has; after the run, rebase `dirty`, GC, rebuild
 * the repo index, and refresh record counts.
 *
 * This is the job's former Phase-2 code (plus the staging half of Phase 1), moved without behavioural
 * change: same scratch-git calls in the same order, same Prisma queries, same log lines.
 */
export class ClassicGitPullSink implements PullSink {
  private readonly fileNamingStateByDataFolderId = new Map<string, ClassicFolderFileNamingState>();
  /**
   * Every repo-relative path staged by this attempt, per folder — the "still exists upstream" set for
   * stale-file deletion. Kept from the folder's fetch until its Phase-2 finish.
   */
  private readonly pulledPathsByDataFolderId = new Map<string, Set<string>>();

  constructor(
    private readonly services: {
      prisma: PrismaClient;
      scratchGitService: ScratchGitService;
      /** Each folder's stored table spec and default view (DEV-12616: Postgres, mirrored to git). */
      dataFolderTableSpecStore: DataFolderTableSpecStoreService;
      fileIndexService: FileIndexService;
      fileReferenceService: FileReferenceService;
      assetExtractorService: AssetExtractorService;
      assetIndexService: AssetIndexService;
      workbookEventService: WorkbookEventService;
    },
    private readonly pullRunContext: {
      /** Job id — also the staging-area key on scratch-git. */
      jobId: string;
      workbookId: WorkbookId;
      connectorAccountId: string;
      abortSignal: AbortSignal;
    },
  ) {}

  /** The classic store is the baseline an incremental pull extends: watermarks describe what git holds. */
  readonly persistsIncrementalPullBaseline = true;

  /** Git holds the previous pull, so every fetched record is classified as new, updated or unchanged. */
  readonly reportsRecordChangeCounts = true;

  /**
   * The connection repo every folder of this job lives in (single-connection invariant), resolved
   * and initialized by `prepareStorageBeforeLoadingFolders`.
   */
  private connectionRepoIdIfPrepared: string | undefined;

  private get repoId(): string {
    if (this.connectionRepoIdIfPrepared === undefined) {
      throw new Error('ClassicGitPullSink: used before prepareStorageBeforeLoadingFolders');
    }
    return this.connectionRepoIdIfPrepared;
  }

  async prepareStorageBeforeLoadingFolders(): Promise<void> {
    const repoId = await this.services.scratchGitService.resolveConnectionRepoPath(
      this.pullRunContext.connectorAccountId,
    );
    await this.services.scratchGitService.initRepo(repoId);
    this.connectionRepoIdIfPrepared = repoId;
  }

  /**
   * Stores the refreshed schema (Postgres, then the awaited git mirror the CLI and the index build at the end of
   * this pull read). A database error fails the folder: Postgres is the source of truth.
   */
  async storeFolderTableSpec(location: TableSpecLocation, tableSpec: BaseJsonTableSpec): Promise<void> {
    await this.services.dataFolderTableSpecStore.writeTableSpec(
      { ...location, connectorAccountId: this.pullRunContext.connectorAccountId },
      tableSpec,
      'pull',
    );
  }

  /** Stores the default view (Postgres, then the awaited git mirror). */
  async storeFolderDefaultView(location: TableSpecLocation, defaultView: TableView): Promise<void> {
    await this.services.dataFolderTableSpecStore.writeDefaultView(
      { ...location, connectorAccountId: this.pullRunContext.connectorAccountId },
      defaultView,
      'pull',
    );
  }

  async prepareFolderForIncomingRecordPages(folder: PullSinkFolder): Promise<void> {
    const { dataFolder } = folder;

    // Seed the dedup conflict set with every filename already indexed for this
    // folder. Without this, a new record whose suggested filename matches an
    // existing record's prior filename can silently clobber it: the new record
    // claims the bare name (its existing twin isn't in the per-batch
    // existingFileNames lookup unless it happens to be in the same batch), and
    // both end up staging to the same path — last write wins, one record vanishes.
    //
    // The conceptually cleaner fix is to defer all naming to Phase 2. Phase 1
    // would stage by recordId (collision-free by construction); Phase 2, which
    // already re-parses every staged file, would assign human-friendly names
    // with full visibility into every recordId in the pull and rename before
    // commit. That's a larger refactor — this seed patches the symptom while
    // keeping Phase 1's naming responsibility intact.
    //
    // The same single read also answers every page's "what is this record's current filename"
    // question: the index isn't written for this folder until the Phase-2 index loop, after the
    // fetch, so a start-of-fetch snapshot is exactly what a per-page lookup would have seen —
    // without one query per connector page (hundreds per folder on a large pull).
    const folderPathForIndex = dataFolder.path?.replace(/^\//, '') ?? '';
    const indexedFilenameByRecordIdInFolder = await this.services.fileIndexService.readRecordIdToFilenameMapForFolder(
      dataFolder.workbookId,
      folderPathForIndex,
    );
    const usedFileNames = new Set<string>(indexedFilenameByRecordIdInFolder.values());

    // Names minted during THIS run, so a record re-delivered by the connector
    // (e.g. Notion's 10k-continuation boundary minute) resolves to the file it
    // already got instead of an id-suffixed duplicate. Lives for the whole run,
    // alongside `usedFileNames`.
    const fileNamesAssignedByRecordIdInThisRun = new Map<string, string>();

    this.fileNamingStateByDataFolderId.set(dataFolder.id, {
      indexedFilenameByRecordIdInFolder,
      usedFileNames,
      fileNamesAssignedByRecordIdInThisRun,
    });
    this.pulledPathsByDataFolderId.set(dataFolder.id, new Set<string>());
  }

  releaseRecordPageWritingStateForFolder(folder: PullSinkFolder): void {
    this.fileNamingStateByDataFolderId.delete(folder.dataFolder.id);
  }

  async writeConnectorRecordPage(folder: PullSinkFolder, connectorRecordsInPage: ConnectorFile[]): Promise<void> {
    const { dataFolder, connector, tableSpec } = folder;
    const { jobId } = this.pullRunContext;
    const folderState = this.fileNamingStateByDataFolderId.get(dataFolder.id);
    const pulledPaths = this.pulledPathsByDataFolderId.get(dataFolder.id);
    if (!folderState || !pulledPaths) {
      throw new Error(
        `ClassicGitPullSink: writeConnectorRecordPage called for folder ${dataFolder.id} before prepareFolderForIncomingRecordPages`,
      );
    }
    const { indexedFilenameByRecordIdInFolder, usedFileNames, fileNamesAssignedByRecordIdInThisRun } = folderState;
    const files = connectorRecordsInPage;

    const stagingFolder = (dataFolder.path ?? dataFolder.name).replace(/^\//, '');

    // Resolve this page's existing filenames from the folder snapshot — needed for proper file naming
    const existingFileNames = new Map<string, string>();
    for (const file of files) {
      const recordId = readRecordIdAsString(file, tableSpec.idPath) ?? '';
      const indexedFilename = indexedFilenameByRecordIdInFolder.get(recordId);
      if (indexedFilename !== undefined) existingFileNames.set(recordId, indexedFilename);
    }

    const suggestedFileNames = connector.getSuggestedRecordFileNames(files, tableSpec);
    const builtFiles = buildGitFilesFromConnectorFiles(
      dataFolder.path ?? '',
      files,
      tableSpec,
      usedFileNames,
      existingFileNames,
      suggestedFileNames,
      fileNamesAssignedByRecordIdInThisRun,
    );

    if (builtFiles.length > 0) {
      // Stage files to scratch-git-2 disk (no git commit yet)
      // Strip the folder prefix from paths since the staging folder already provides that namespace.
      // builtFiles have paths like "Products/file.json" but staging writes to {stagingFolder}/file.json.
      const folderPrefix = stagingFolder + '/';
      const stagingFiles = builtFiles.map((f) => {
        const normalized = f.path.startsWith('/') ? f.path.slice(1) : f.path;
        const stripped = normalized.startsWith(folderPrefix) ? normalized.slice(folderPrefix.length) : normalized;
        return { path: stripped, content: f.content };
      });
      await this.services.scratchGitService.stageFiles(jobId, stagingFolder, stagingFiles);

      // Track pulled paths for stale file detection
      for (const f of builtFiles) {
        const normalizedPath = f.path.startsWith('/') ? f.path.slice(1) : f.path;
        pulledPaths.add(normalizedPath);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Process staged files — index, commit, delete stale
  //
  // Two symmetric loops, both backed by SQLite state on scratch-git:
  //
  // 1. INDEX LOOP: Read unprocessed files → update Postgres indexes (file index,
  //    file references, asset index) → mark processed in SQLite. Repeats until
  //    all files are processed.
  //
  // 2. COMMIT LOOP: Commit unprocessed files to git in batches → mark committed
  //    in SQLite. Repeats until all files are committed.
  //
  // Both loops are:
  //   - Bounded: each HTTP call handles at most `batchSize` files
  //   - Resumable: SQLite state persists across crashes
  //   - Cancellable: abortSignal checked each iteration via event loop yield
  //   - Progress-tracked: BullMQ checkpoint after each batch
  // ---------------------------------------------------------------------------

  async finishFolderAfterAllRecordPagesWritten(
    folder: PullSinkFolder,
    options: FinishFolderOptions,
  ): Promise<PullSinkFolderChangeSummary> {
    const { dataFolder, tableSpec } = folder;
    const { jobId, abortSignal } = this.pullRunContext;
    const repoId = this.repoId;
    const { isResumingFromEarlierAttempt, mayRemoveRecordsAbsentFromThisPull, reportDurableProgress } = options;
    const stagingFolder = (dataFolder.path ?? dataFolder.name).replace(/^\//, '');

    // --- Index loop: read unprocessed staged files and update Postgres indexes ---
    // Each iteration reads up to `batchSize` files that haven't been processed yet,
    // updates three Postgres tables in parallel, then marks those files as processed
    // in SQLite so they won't be returned again (including on crash-restart).
    const batchSize = 100;
    let processedCount = 0;
    while (true) {
      if (abortSignal.aborted) throw new JobCanceledError(jobId);

      const batch = await this.services.scratchGitService.readStagedFiles(jobId, stagingFolder, batchSize);
      if (batch.files.length === 0) break;

      // Re-hydrate BuiltFile-like objects from staged content.
      // Staged file paths are relative to the folder (e.g., "file.json"),
      // but index methods expect full paths (e.g., "Products/file.json").
      // Skip files with invalid JSON — this can happen if Phase 1 was
      // interrupted mid-write (e.g. ECONNRESET) leaving truncated content.
      const builtFiles: BuiltFile[] = [];
      for (const f of batch.files) {
        let parsedRecord: Record<string, unknown>;
        try {
          parsedRecord = JSON.parse(f.content) as Record<string, unknown>;
        } catch {
          WSLogger.warn({
            source: LOG_SOURCE,
            message: `Skipping staged file with invalid JSON: ${stagingFolder}/${f.path}`,
            workbookId: dataFolder.workbookId,
          });
          continue;
        }
        const recordId = readRecordIdAsString(parsedRecord, tableSpec.idPath) ?? '';
        builtFiles.push({
          path: `${stagingFolder}/${f.path}`,
          content: f.content,
          recordId,
          parsedRecord: parsedRecord as JsonSafeObject,
        });
      }

      // Run index updates in parallel — they write to different tables with no data dependency
      await Promise.all([
        this.updateFileIndex(folder, builtFiles),
        this.updateFileReferences(folder, builtFiles),
        this.updateAssetIndex(folder, builtFiles),
      ]);

      await this.services.scratchGitService.markStagedFilesProcessed(
        jobId,
        stagingFolder,
        batch.files.map((f) => f.path),
      );

      processedCount += batch.files.length;
      await reportDurableProgress();
    }

    // --- Commit loop: write staged files to git in batches of 1000 ---
    // Each iteration makes one HTTP call that creates one git commit for up to
    // 1000 files. scratch-git marks each file as committed in SQLite so the
    // next iteration picks up the next batch. Loop exits when committed === 0.
    const allCreated: string[] = [];
    const allUpdated: string[] = [];
    const commitMessage = `Sync ${stagingFolder} (${processedCount} files)`;
    while (true) {
      if (abortSignal.aborted) throw new JobCanceledError(jobId);

      const result = await this.services.scratchGitService.commitStagedFiles(
        jobId,
        repoId,
        MAIN_BRANCH,
        stagingFolder,
        commitMessage,
        1000,
      );
      if (result.committed === 0) break;

      allCreated.push(...result.created);
      allUpdated.push(...result.updated);
      await reportDurableProgress();
    }

    const created = allCreated.length;
    const updated = allUpdated.length;

    // --- Delete stale files ---
    // Incremental pulls don't delete: the connector only returned records
    // matching `IS_AFTER(...)`, so files absent from `pulledPaths` may be
    // unchanged rather than deleted. Deletion is the responsibility of full
    // pulls.
    //
    // A folder fully fetched by an earlier attempt was never prepared in this one, so it has no
    // state here; its empty `pulledPaths` is never used, because such a folder is always resuming.
    const pulledPaths = this.pulledPathsByDataFolderId.get(dataFolder.id) ?? new Set<string>();
    this.pulledPathsByDataFolderId.delete(dataFolder.id);
    const deleteResult = mayRemoveRecordsAbsentFromThisPull
      ? await this.deleteStaleFiles({
          folder,
          pulledPaths,
          isResuming: isResumingFromEarlierAttempt,
        })
      : { deleted: 0, deletedPaths: [] };

    return {
      created,
      updated,
      deleted: deleteResult.deleted,
      createdPaths: allCreated,
      updatedPaths: allUpdated,
      deletedPaths: deleteResult.deletedPaths,
    };
  }

  async cleanUpTemporaryStorageAfterPullAttempt(): Promise<void> {
    const { jobId } = this.pullRunContext;
    // Always clean up staging, even on failure
    try {
      await this.services.scratchGitService.cleanupStaging(jobId);
    } catch (err) {
      WSLogger.warn({
        source: LOG_SOURCE,
        message: 'Failed to clean up staging files',
        jobId,
        error: err,
      });
    }
  }

  async finalizeStorageAfterAllFoldersFinished(): Promise<void> {
    const { workbookId, connectorAccountId } = this.pullRunContext;
    const repoId = this.repoId;

    // Rebase and GC once after all folders are processed (not per-folder)
    try {
      await this.services.scratchGitService.rebaseDirty(repoId);
    } catch (err) {
      WSLogger.warn({
        source: LOG_SOURCE,
        message: 'Failed to rebase dirty branch',
        workbookId,
        error: err,
      });
    }

    try {
      await this.services.scratchGitService.runGitGc(repoId);
    } catch (err) {
      if (err instanceof ScratchGitConflictError) {
        // A GC from a prior run of this job (e.g. one that stalled and was retried by BullMQ) is still
        // in progress on scratch-git. GC is idempotent maintenance, so skipping this run is harmless —
        // the next pull will GC again. See https://linear.app/whalesync/issue/DEV-9980.
        WSLogger.debug({
          source: LOG_SOURCE,
          message: 'Git GC already in progress, skipping',
          workbookId,
        });
      } else {
        WSLogger.warn({
          source: LOG_SOURCE,
          message: 'Failed to run Git GC',
          workbookId,
          error: err,
        });
      }
    }

    // Rebuild the index once after all folders are done
    try {
      await this.services.scratchGitService.buildIndex(repoId);
    } catch (err) {
      WSLogger.warn({
        source: LOG_SOURCE,
        message: 'Failed to rebuild index after pull',
        workbookId,
        error: err,
      });
    }

    // Refresh denormalized per-folder record counts from git now that `main` is up to date.
    // Scoped to this pull's connector account, so it's a single tree walk. Non-fatal — a
    // failure here must not fail the pull, same as the rebase/GC/index steps above.
    try {
      await recomputeRecordCountsForWorkbook(
        {
          prisma: this.services.prisma,
          scratchGit: this.services.scratchGitService,
          events: this.services.workbookEventService,
        },
        workbookId,
        { connectorAccountId, emitEvent: true, eventSource: 'job' },
      );
    } catch (err) {
      WSLogger.warn({
        source: LOG_SOURCE,
        message: 'Failed to refresh record counts after pull',
        workbookId,
        error: err,
      });
    }
  }

  private async deleteStaleFiles(params: {
    folder: PullSinkFolder;
    pulledPaths: Set<string>;
    isResuming: boolean;
  }): Promise<{ deleted: number; deletedPaths: string[] }> {
    const { folder, pulledPaths, isResuming } = params;
    const { dataFolder } = folder;
    const repoId = this.repoId;
    const folderPath = (dataFolder.path ?? dataFolder.name).replace(/^\//, '');

    if (isResuming) {
      WSLogger.info({
        source: LOG_SOURCE,
        message: 'Skipping deletion check on resumed run',
        workbookId: dataFolder.workbookId,
        dataFolderId: dataFolder.id,
      });
      return { deleted: 0, deletedPaths: [] };
    }

    try {
      const mainFiles = await this.services.scratchGitService.listRepoFiles(repoId, MAIN_BRANCH, folderPath);

      // Defense in depth (DEV-11015): only ever delete leaf FILES. A directory entry
      // that isn't in `pulledPaths` means records were mis-staged into a nested path
      // (e.g. an unsanitized record-id filename containing '/'); deleting that
      // directory recursively wipes every file under it while the server reports a
      // single deletion ("Remove 1 deleted files" that removed 248). Skip directories
      // and warn loudly rather than silently mass-deleting a table.
      const staleDirectories = mainFiles.filter(
        (f) => f.type === 'directory' && !f.name.startsWith('.') && !pulledPaths.has(f.path),
      );
      if (staleDirectories.length > 0) {
        WSLogger.warn({
          source: LOG_SOURCE,
          message: 'Skipping unexpected directory entries during stale-file cleanup (possible mis-staged record paths)',
          workbookId: dataFolder.workbookId,
          dataFolderId: dataFolder.id,
          directoryPaths: staleDirectories.map((f) => f.path),
        });
      }

      const filesToDelete = mainFiles
        .filter((f) => f.type === 'file')
        .filter((f) => !f.name.startsWith('.'))
        .filter((f) => !pulledPaths.has(f.path))
        .map((f) => f.path);

      if (filesToDelete.length > 0) {
        await this.services.scratchGitService.deleteFilesFromBranch(
          repoId,
          MAIN_BRANCH,
          filesToDelete,
          `Remove ${filesToDelete.length} deleted files from ${folderPath}`,
        );

        // Drop the deleted files' FileIndex rows too. The index seeds the
        // filename-collision set for every later pull and published create
        // (`listFilenamesForFolder`), so a row left behind here makes a record
        // that is deleted upstream and re-created with a new id come back as
        // `<name>-<id>.json` instead of `<name>.json` (DEV-11438). The git
        // deletion above already happened, so an index failure is logged and
        // the deletion is still reported rather than hidden.
        try {
          await this.services.fileIndexService.deleteRowsForDeletedFiles(
            dataFolder.workbookId,
            dataFolder.connectorAccountId,
            filesToDelete,
          );
        } catch (indexCleanupError) {
          WSLogger.error({
            source: LOG_SOURCE,
            message: 'Deleted stale files from main but failed to remove their FileIndex rows',
            workbookId: dataFolder.workbookId,
            dataFolderId: dataFolder.id,
            error: indexCleanupError,
          });
        }

        return { deleted: filesToDelete.length, deletedPaths: filesToDelete };
      }
    } catch (err) {
      if (!(err instanceof ScratchGitNotFoundError)) {
        WSLogger.error({
          source: LOG_SOURCE,
          message: 'Failed to clean up deleted files from main',
          workbookId: dataFolder.workbookId,
          error: err,
        });
      }
    }

    return { deleted: 0, deletedPaths: [] };
  }

  private async updateFileIndex(folder: PullSinkFolder, builtFiles: BuiltFile[]): Promise<void> {
    try {
      await this.services.fileIndexService.upsertBatch(
        builtFiles
          .map((f) => {
            const parts = f.path.split('/');
            const filename = parts.pop();
            const folderPath = parts.join('/').replace(/^\//, '');

            if (!f.recordId || filename === undefined) return null;

            return {
              workbookId: folder.dataFolder.workbookId,
              folderPath,
              filename,
              recordId: f.recordId,
              // Discriminator so a workspace-absolute pseudo-ref resolves to this
              // connection even when another shares the folder name.
              connectorAccountId: folder.dataFolder.connectorAccountId ?? null,
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null),
      );
    } catch (err) {
      WSLogger.error({
        source: LOG_SOURCE,
        message: 'Failed to update file index',
        workbookId: folder.dataFolder.workbookId,
        error: err,
      });
    }
  }

  private async updateFileReferences(folder: PullSinkFolder, builtFiles: BuiltFile[]): Promise<void> {
    try {
      await this.services.fileReferenceService.updateRefsForFiles(
        folder.dataFolder.workbookId,
        MAIN_BRANCH,
        builtFiles.map((f) => ({
          path: f.path.startsWith('/') ? f.path.slice(1) : f.path,
          content: f.parsedRecord,
        })),
        folder.tableSpec.schema,
      );
    } catch (err) {
      WSLogger.error({
        source: LOG_SOURCE,
        message: 'Failed to update file references',
        workbookId: folder.dataFolder.workbookId,
        error: err,
      });
    }
  }

  private async updateAssetIndex(folder: PullSinkFolder, builtFiles: BuiltFile[]): Promise<void> {
    try {
      const assetEntries = builtFiles.flatMap((f) => {
        const normalizedPath = f.path.startsWith('/') ? f.path.slice(1) : f.path;
        const recordContent = f.parsedRecord as Record<string, unknown>;
        const recordRemoteId = readRecordIdAsString(recordContent, folder.tableSpec.idPath) ?? undefined;
        return this.services.assetExtractorService.extractAssets(folder.connector, {
          workbookId: folder.dataFolder.workbookId,
          service: folder.dataFolder.connectorService,
          dataFolderId: folder.dataFolder.id,
          recordFilePath: normalizedPath,
          recordRemoteId,
          recordContent,
          schema: folder.tableSpec.schema as Record<string, unknown>,
        });
      });

      if (assetEntries.length > 0) {
        await this.services.assetIndexService.upsertBatch(assetEntries);
      }
    } catch (err) {
      WSLogger.error({
        source: LOG_SOURCE,
        message: 'Failed to update asset index',
        workbookId: folder.dataFolder.workbookId,
        error: err,
      });
    }
  }
}
