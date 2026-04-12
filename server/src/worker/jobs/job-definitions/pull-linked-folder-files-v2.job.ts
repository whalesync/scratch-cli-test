import type { PrismaClient } from '@prisma/client';
import { type ConnectorPullOptions, DataFolderId, type WorkbookId } from '@spinner/shared-types';
import type { ConnectorsService } from '../../../remote-service/connectors/connectors.service';
import type { BaseJsonTableSpec, ConnectorFile } from '../../../remote-service/connectors/types';
import type { JsonSafeObject } from '../../../utils/objects';
import type { JobHandlerBuilder, Progress } from '../base-types';
// Non type imports
import { AssetExtractorService } from 'src/asset/asset-extractor.service';
import { AssetIndexService } from 'src/asset/asset-index.service';
import type { PostHogService } from 'src/posthog/posthog.service';
import { FileIndexService } from 'src/publish-plan/file-index.service';
import { FileReferenceService } from 'src/publish-plan/file-reference.service';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import type { Connector } from 'src/remote-service/connectors/connector';
import { connectorRegistry } from 'src/remote-service/connectors/connector-registry';
import { exceptionForConnectorError } from 'src/remote-service/connectors/error';
import { ScratchGitNotFoundError } from 'src/scratch-git/scratch-git.client';
import { MAIN_BRANCH, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { WSLogger } from '../../../logger';
import { WorkbookEventService } from '../../../workbook/workbook-event.service';
import { type BuiltFile, buildGitFilesFromConnectorFiles } from './connector-file-utils';
import type {
  PullLinkedFolderFilesJobDefinition,
  PullLinkedFolderFilesPublicProgress,
} from './pull-linked-folder-files.job';

/** Maximum number of file paths to track per category in progress (for UI display). */
const MAX_PROGRESS_PATHS = 100;

const LOG_SOURCE = 'PullLinkedFolderFilesV2Job';

/** Default max parallel folder fetches when no rate limiter spec is defined. */
const DEFAULT_CONCURRENCY = 3;

type PullLinkedFolderFilesV2JobProgress = {
  completedFolderIds?: string[];
  phase?: 'fetch' | 'process';
  folderFetchStatus?: Record<string, 'pending' | 'fetching' | 'fetched' | 'failed'>;
  folderCursors?: Record<string, JsonSafeObject>;
};

type CheckpointFn = (
  progress: Omit<
    Progress<PullLinkedFolderFilesJobDefinition['publicProgress'], PullLinkedFolderFilesV2JobProgress>,
    'timestamp'
  >,
) => Promise<void>;

/** Context shared across all phases of pulling a single folder. */
type FolderContext = {
  jobId: string;
  dataFolder: {
    id: DataFolderId;
    workbookId: string;
    name: string;
    path: string | null;
    connectorService: string;
    connectorAccountId: string;
  };
  repoId: string;
  connector: Connector;
  tableSpec: BaseJsonTableSpec;
  pullOptions: ConnectorPullOptions;
};

/** Result from Phase 1 fetch for a single folder. */
type FolderFetchResult = {
  folderId: DataFolderId;
  pulledPaths: Set<string>;
  fileCount: number;
  isResuming: boolean;
};

/**
 * V2 pull job handler with two-phase architecture:
 *
 * Phase 1 (FETCH): All folders fetch from their connector API in parallel.
 *   Each batch is written to a staging area on scratch-git-2's disk.
 *   No git commits or DB index updates during this phase.
 *
 * Phase 2 (PROCESS): For each folder sequentially, read staged files back,
 *   run DB index updates (parallel), commit to git, delete stale files, finalize.
 */
export class PullLinkedFolderFilesV2JobHandler implements JobHandlerBuilder<PullLinkedFolderFilesJobDefinition> {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly connectorService: ConnectorsService,
    private readonly connectorAccountService: ConnectorAccountService,
    private readonly workbookEventService: WorkbookEventService,
    private readonly scratchGitService: ScratchGitService,
    private readonly fileIndexService: FileIndexService,
    private readonly fileReferenceService: FileReferenceService,
    private readonly assetExtractorService: AssetExtractorService,
    private readonly assetIndexService: AssetIndexService,
    private readonly postHogService: PostHogService,
  ) {}

  async run(params: {
    jobId: string;
    data: PullLinkedFolderFilesJobDefinition['data'];
    progress: Progress<PullLinkedFolderFilesJobDefinition['publicProgress'], PullLinkedFolderFilesV2JobProgress>;
    abortSignal: AbortSignal;
    checkpoint: CheckpointFn;
  }) {
    const { jobId, data, checkpoint, progress, abortSignal } = params;
    if (!data?.dataFolderIds?.length) {
      throw new Error(`Invalid job data: dataFolderIds is ${JSON.stringify(data?.dataFolderIds)}`);
    }
    const folderCount = data.dataFolderIds.length;

    // Fetch all folders upfront to validate they share the same connection
    const folders = await this.prisma.dataFolder.findMany({
      where: { id: { in: data.dataFolderIds } },
      include: { connectorAccount: true },
    });

    const connectorAccountIds = new Set(folders.map((f) => f.connectorAccountId));
    if (connectorAccountIds.size > 1) {
      throw new Error(
        `All folders in a pull job must belong to the same connection, got: ${[...connectorAccountIds].join(', ')}`,
      );
    }

    const connectionName = folders[0]?.connectorAccount?.displayName ?? 'Unknown connection';
    const connectorAccountId = folders[0]?.connectorAccountId ?? null;

    if (!connectorAccountId) {
      throw new Error(`All folders in pull job must belong to a connection`);
    }

    const repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);
    await this.scratchGitService.initRepo(repoId);

    // Load all folder contexts upfront
    const folderContexts: FolderContext[] = [];
    for (const dataFolderId of data.dataFolderIds) {
      const folderCtx = await this.loadFolderAndConnector({ dataFolderId, repoId, data, jobId });
      folderContexts.push(folderCtx);
    }

    // Determine max concurrency from connector's rate limiter spec
    const connectorService = folderContexts[0].dataFolder.connectorService;
    const maxConcurrency = getMaxConcurrency(connectorService, folderCount);

    WSLogger.info({
      source: LOG_SOURCE,
      message: `Starting V2 pull: ${folderCount} folders, concurrency ${maxConcurrency}`,
      workbookId: data.workbookId,
      folderCount,
      maxConcurrency,
    });

    const jobProgress: PullLinkedFolderFilesV2JobProgress = {
      completedFolderIds: [...(progress.jobProgress?.completedFolderIds ?? [])],
      phase: 'fetch',
      folderFetchStatus: progress.jobProgress?.folderFetchStatus ?? {},
      folderCursors: progress.jobProgress?.folderCursors ?? {},
    };

    const publicProgress: PullLinkedFolderFilesPublicProgress = {
      totalFiles: 0,
      folderCount,
      connectionName,
      folderId: folderContexts[0].dataFolder.id,
      folderName: folderContexts[0].dataFolder.name,
      connector: connectorService,
      filter: null,
      status: 'active',
      createdPaths: [],
      updatedPaths: [],
      deletedPaths: [],
      createdCount: 0,
      updatedCount: 0,
      deletedCount: 0,
    };

    const pullStats = { created: 0, updated: 0, deleted: 0, failed: false };

    try {
      // =====================================================================
      // PHASE 1 — FETCH (parallel)
      // =====================================================================
      jobProgress.phase = 'fetch';
      await checkpoint({ publicProgress, jobProgress, connectorProgress: {} });

      const fetchResults = await this.runPhase1Fetch({
        folderContexts,
        maxConcurrency,
        jobId,
        publicProgress,
        jobProgress,
        pullStats,
        checkpoint,
        abortSignal,
      });

      // =====================================================================
      // PHASE 2 — PROCESS (sequential)
      // =====================================================================
      jobProgress.phase = 'process';
      await checkpoint({ publicProgress, jobProgress, connectorProgress: {} });

      for (const folderCtx of folderContexts) {
        if (abortSignal.aborted) break;

        const fetchResult = fetchResults.get(folderCtx.dataFolder.id);
        if (!fetchResult || jobProgress.folderFetchStatus?.[folderCtx.dataFolder.id] === 'failed') {
          continue;
        }

        if (jobProgress.completedFolderIds?.includes(folderCtx.dataFolder.id)) {
          continue;
        }

        try {
          const result = await this.processFolder({
            folderCtx,
            fetchResult,
            jobId,
            publicProgress,
            jobProgress,
            checkpoint,
          });

          pullStats.created += result.created;
          pullStats.updated += result.updated;
          pullStats.deleted += result.deleted;

          jobProgress.completedFolderIds = jobProgress.completedFolderIds ?? [];
          jobProgress.completedFolderIds.push(folderCtx.dataFolder.id);
        } catch (error) {
          pullStats.failed = true;

          WSLogger.error({
            source: LOG_SOURCE,
            message: 'Failed to process folder in Phase 2',
            workbookId: folderCtx.dataFolder.workbookId,
            dataFolderId: folderCtx.dataFolder.id,
            errorDetails: folderCtx.connector.extractConnectorErrorDetails(error),
          });

          await this.prisma.dataFolder.update({
            where: { id: folderCtx.dataFolder.id },
            data: { lock: null },
          });

          this.workbookEventService.sendWorkbookEvent(folderCtx.dataFolder.workbookId as WorkbookId, {
            type: 'job-failed',
            data: {
              entityId: folderCtx.dataFolder.id,
              source: 'job',
              message: 'Pull failed for data folder',
              jobId,
            },
          });

          throw exceptionForConnectorError(error, folderCtx.connector);
        }
      }
    } finally {
      // Defensive backstop: clear locks on any folder that still has lock='pull'.
      // The per-error-path cleanup should have handled this, but this catches any
      // future code path that forgets to clear a lock.
      for (const folderCtx of folderContexts) {
        const folderId = folderCtx.dataFolder.id;
        const wasCompleted = jobProgress.completedFolderIds?.includes(folderId);
        const wasFailed = jobProgress.folderFetchStatus?.[folderId] === 'failed';
        if (!wasCompleted && !wasFailed) {
          try {
            await this.prisma.dataFolder.update({
              where: { id: folderId },
              data: { lock: null },
            });
          } catch (err) {
            WSLogger.warn({
              source: LOG_SOURCE,
              message: 'Failed to clear lock in finally backstop',
              dataFolderId: folderId,
              error: err,
            });
          }
        }
      }

      // Always clean up staging, even on failure
      try {
        await this.scratchGitService.cleanupStaging(jobId);
      } catch (err) {
        WSLogger.warn({
          source: LOG_SOURCE,
          message: 'Failed to clean up staging files',
          jobId,
          error: err,
        });
      }
    }

    // Checkpoint before finalization
    await checkpoint({ publicProgress, jobProgress, connectorProgress: {} });

    // Rebase and GC once after all folders are processed (not per-folder)
    await this.scratchGitService.rebaseDirty(repoId);

    try {
      await this.scratchGitService.runGitGc(repoId);
    } catch (err) {
      WSLogger.warn({
        source: LOG_SOURCE,
        message: 'Failed to run Git GC',
        workbookId: data.workbookId,
        error: err,
      });
    }

    // Rebuild the index once after all folders are done
    await this.scratchGitService.buildIndex(repoId).catch((err) => {
      WSLogger.warn({
        source: LOG_SOURCE,
        message: 'Failed to rebuild index after pull',
        workbookId: data.workbookId,
        error: err,
      });
    });

    try {
      this.postHogService.trackPullCompleted(data.userId, {
        workbookId: data.workbookId,
        trigger: data.trigger,
        result: pullStats.failed ? 'failure' : 'success',
        totalFilesPulled: publicProgress.totalFiles,
        filesCreated: pullStats.created,
        filesUpdated: pullStats.updated,
        filesDeleted: pullStats.deleted,
        foldersProcessed: folderCount,
      });
    } catch (err) {
      WSLogger.warn({
        source: LOG_SOURCE,
        message: 'Failed to track pull completed event',
        error: err,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 1: Load folder from DB, set up connector and fetch fresh schema
  // ---------------------------------------------------------------------------

  private async loadFolderAndConnector(params: {
    dataFolderId: DataFolderId;
    repoId: string;
    data: PullLinkedFolderFilesJobDefinition['data'];
    jobId: string;
  }): Promise<FolderContext> {
    const { dataFolderId, repoId, data, jobId } = params;

    const dataFolder = await this.prisma.dataFolder.findUnique({
      where: { id: dataFolderId },
      include: { connectorAccount: true },
    });

    if (!dataFolder) {
      throw new Error(`DataFolder with id ${dataFolderId} not found`);
    }
    if (!dataFolder.connectorAccountId) {
      throw new Error(`DataFolder ${dataFolderId} does not have an associated connector account`);
    }
    if (!dataFolder.connectorService) {
      throw new Error(`DataFolder ${dataFolderId} does not have a connector service`);
    }

    const pullOptions: ConnectorPullOptions = (dataFolder.options as ConnectorPullOptions) ?? {};

    const decryptedConnectorAccount = await this.connectorAccountService.findOneById(dataFolder.connectorAccountId, {
      userId: data.userId,
      organizationId: data.organizationId,
    });
    if (!decryptedConnectorAccount) {
      throw new Error(`Connector account ${dataFolder.connectorAccountId} not found`);
    }

    const connector = await this.connectorService.getConnector({
      service: dataFolder.connectorService,
      connectorAccount: decryptedConnectorAccount,
      decryptedCredentials: decryptedConnectorAccount,
      userId: data.userId,
    });

    const tableSpec = await connector.fetchJsonTableSpec({
      wsId: dataFolder.tableId[0],
      remoteId: dataFolder.tableId,
    });

    // Re-apply user field overrides from options
    const options =
      dataFolder.options && typeof dataFolder.options === 'object' && !Array.isArray(dataFolder.options)
        ? dataFolder.options
        : {};
    const idOverride = 'idFieldOverride' in options ? (options as Record<string, unknown>).idFieldOverride : undefined;
    const nameOverride =
      'nameFieldOverride' in options ? (options as Record<string, unknown>).nameFieldOverride : undefined;
    if (typeof idOverride === 'string') {
      tableSpec.idColumnRemoteId = idOverride;
    }
    if (typeof nameOverride === 'string') {
      tableSpec.titleColumnRemoteId = [nameOverride];
    }

    // Write refreshed schema to git
    if (dataFolder.path) {
      await this.scratchGitService.writeSchemaToGit(repoId, dataFolder.path, tableSpec);
    }

    return {
      jobId,
      dataFolder: {
        id: dataFolder.id as DataFolderId,
        workbookId: dataFolder.workbookId,
        name: dataFolder.name,
        path: dataFolder.path,
        connectorService: dataFolder.connectorService,
        connectorAccountId: dataFolder.connectorAccountId,
      },
      repoId,
      connector,
      tableSpec,
      pullOptions,
    };
  }

  // ---------------------------------------------------------------------------
  // Phase 1: Parallel fetch — stage files to scratch-git-2 disk
  // ---------------------------------------------------------------------------

  private async runPhase1Fetch(params: {
    folderContexts: FolderContext[];
    maxConcurrency: number;
    jobId: string;
    publicProgress: PullLinkedFolderFilesPublicProgress;
    jobProgress: PullLinkedFolderFilesV2JobProgress;
    pullStats: { created: number; updated: number; deleted: number; failed: boolean };
    checkpoint: CheckpointFn;
    abortSignal: AbortSignal;
  }): Promise<Map<DataFolderId, FolderFetchResult>> {
    const { folderContexts, maxConcurrency, jobId, publicProgress, jobProgress, pullStats, checkpoint, abortSignal } =
      params;

    const results = new Map<DataFolderId, FolderFetchResult>();

    await runWithConcurrency(folderContexts, maxConcurrency, async (folderCtx) => {
      if (abortSignal.aborted) return;

      const folderId = folderCtx.dataFolder.id;
      const fetchStatus = jobProgress.folderFetchStatus?.[folderId];

      // Skip already-fetched folders on resume
      if (fetchStatus === 'fetched') {
        WSLogger.info({
          source: LOG_SOURCE,
          message: 'Skipping already-fetched folder on resume',
          dataFolderId: folderId,
        });
        // We don't have pulledPaths from the previous run — mark as resuming
        results.set(folderId, { folderId, pulledPaths: new Set(), fileCount: 0, isResuming: true });
        return;
      }

      jobProgress.folderFetchStatus = jobProgress.folderFetchStatus ?? {};
      jobProgress.folderFetchStatus[folderId] = 'fetching';

      try {
        const result = await this.fetchFolder({
          folderCtx,
          jobId,
          publicProgress,
          jobProgress,
          checkpoint,
          abortSignal,
        });
        results.set(folderId, result);
        jobProgress.folderFetchStatus[folderId] = 'fetched';
      } catch (error) {
        jobProgress.folderFetchStatus[folderId] = 'failed';
        pullStats.failed = true;

        WSLogger.error({
          source: LOG_SOURCE,
          message: 'Phase 1 fetch failed for folder',
          workbookId: folderCtx.dataFolder.workbookId,
          dataFolderId: folderId,
          errorDetails: folderCtx.connector.extractConnectorErrorDetails(error),
        });

        // Clear the lock so the folder can be re-pulled
        await this.prisma.dataFolder.update({
          where: { id: folderId },
          data: { lock: null },
        });

        // Notify workbook clients about the per-folder failure
        this.workbookEventService.sendWorkbookEvent(folderCtx.dataFolder.workbookId as WorkbookId, {
          type: 'job-failed',
          data: {
            entityId: folderId,
            source: 'job',
            message: 'Pull failed for data folder',
            jobId,
          },
        });
      }

      await checkpoint({ publicProgress, jobProgress, connectorProgress: {} });
    });

    return results;
  }

  private async fetchFolder(params: {
    folderCtx: FolderContext;
    jobId: string;
    publicProgress: PullLinkedFolderFilesPublicProgress;
    jobProgress: PullLinkedFolderFilesV2JobProgress;
    checkpoint: CheckpointFn;
    abortSignal: AbortSignal;
  }): Promise<FolderFetchResult> {
    const { folderCtx, jobId, publicProgress, jobProgress, checkpoint, abortSignal } = params;
    const { dataFolder, connector, tableSpec, pullOptions } = folderCtx;
    const folderId = dataFolder.id;

    const pulledPaths = new Set<string>();
    const usedFileNames = new Set<string>();
    let fileCount = 0;

    // Resume from per-folder cursor if available
    const resumeProgress = jobProgress.folderCursors?.[folderId] ?? {};
    const isResuming = Object.keys(resumeProgress).length > 0;

    const stagingFolder = (dataFolder.path ?? dataFolder.name).replace(/^\//, '');

    const onBatch = async (callbackParams: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => {
      if (abortSignal.aborted) return;

      const { files, connectorProgress } = callbackParams;

      // Resolve filenames (DB query) — needed for proper file naming
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const recordIds = files.map((f) => String((f as Record<string, unknown>)[tableSpec.idColumnRemoteId] || ''));
      const existingFileNames = await this.fileIndexService.getFilenamesByRecordIds(
        dataFolder.workbookId,
        dataFolder.path?.replace(/^\//, '') ?? '',
        recordIds,
      );

      const suggestedFileNames = connector.getSuggestedRecordFileNames(files, tableSpec);
      const builtFiles = buildGitFilesFromConnectorFiles(
        dataFolder.path ?? '',
        files,
        tableSpec,
        usedFileNames,
        existingFileNames,
        suggestedFileNames,
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
        await this.scratchGitService.stageFiles(jobId, stagingFolder, stagingFiles);

        // Track pulled paths for stale file detection
        for (const f of builtFiles) {
          const normalizedPath = f.path.startsWith('/') ? f.path.slice(1) : f.path;
          pulledPaths.add(normalizedPath);
        }
      }

      fileCount += files.length;
      publicProgress.totalFiles += files.length;

      // Save per-folder cursor for resume
      if (connectorProgress) {
        jobProgress.folderCursors = jobProgress.folderCursors ?? {};
        jobProgress.folderCursors[folderId] = connectorProgress;
      }

      await checkpoint({ publicProgress, jobProgress, connectorProgress: {} });
    };

    this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
      type: 'job-started',
      data: {
        source: 'job',
        entityId: dataFolder.id,
        message: 'Pulling files for data folder',
        jobId,
      },
    });

    await connector.pullRecordFiles(tableSpec, onBatch, resumeProgress, pullOptions);

    return { folderId, pulledPaths, fileCount, isResuming };
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Process staged files — index, commit, delete stale, finalize
  // ---------------------------------------------------------------------------

  private async processFolder(params: {
    folderCtx: FolderContext;
    fetchResult: FolderFetchResult;
    jobId: string;
    publicProgress: PullLinkedFolderFilesPublicProgress;
    jobProgress: PullLinkedFolderFilesV2JobProgress;
    checkpoint: CheckpointFn;
  }): Promise<{ created: number; updated: number; deleted: number }> {
    const { folderCtx, fetchResult, jobId, publicProgress, jobProgress, checkpoint } = params;
    const { dataFolder, tableSpec, repoId } = folderCtx;
    const stagingFolder = (dataFolder.path ?? dataFolder.name).replace(/^\//, '');
    let created = 0;
    let updated = 0;
    let deleted = 0;

    // Update publicProgress to show current folder
    publicProgress.folderId = dataFolder.id;
    publicProgress.folderName = dataFolder.name;

    // --- Read staged files and update DB indexes ---
    let offset = 0;
    const batchSize = 100;
    while (true) {
      const batch = await this.scratchGitService.readStagedFiles(jobId, stagingFolder, offset, batchSize);
      if (batch.files.length === 0) break;

      // Re-hydrate BuiltFile-like objects from staged content.
      // Staged file paths are relative to the folder (e.g., "file.json"),
      // but index methods expect full paths (e.g., "Products/file.json").
      const builtFiles: BuiltFile[] = batch.files.map((f) => {
        const parsedRecord = JSON.parse(f.content) as Record<string, unknown>;
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        const recordId = String(parsedRecord[tableSpec.idColumnRemoteId] || '');
        return {
          path: `${stagingFolder}/${f.path}`,
          content: f.content,
          recordId,
          parsedRecord: parsedRecord as JsonSafeObject,
        };
      });

      // Run index updates in parallel — they write to different tables with no data dependency
      await Promise.all([
        this.updateFileIndex(folderCtx, builtFiles),
        this.updateFileReferences(folderCtx, builtFiles),
        this.updateAssetIndex(folderCtx, builtFiles),
      ]);

      offset += batch.files.length;
    }

    // --- Commit staged files to git (scratch-git reads from its own disk) ---
    const commitResult = await this.scratchGitService.commitStagedFiles(
      jobId,
      repoId,
      MAIN_BRANCH,
      stagingFolder,
      `Sync ${stagingFolder} (${offset} files)`,
    );

    created = commitResult.created.length;
    updated = commitResult.updated.length;

    publicProgress.createdCount += created;
    publicProgress.updatedCount += updated;
    for (const path of commitResult.created) {
      if (publicProgress.createdPaths.length < MAX_PROGRESS_PATHS) {
        publicProgress.createdPaths.push(path);
      }
    }
    for (const path of commitResult.updated) {
      if (publicProgress.updatedPaths.length < MAX_PROGRESS_PATHS) {
        publicProgress.updatedPaths.push(path);
      }
    }

    // --- Delete stale files ---
    deleted = await this.deleteStaleFiles({
      folderCtx,
      publicProgress,
      pulledPaths: fetchResult.pulledPaths,
      isResuming: fetchResult.isResuming,
    });

    // --- Finalize (rebase, GC, events) ---
    await this.finalizeFolder({ folderCtx, jobId, publicProgress, checkpoint, jobProgress });

    this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
      type: 'folder-contents-changed',
      data: {
        entityId: dataFolder.id,
        source: 'job',
        message: 'Updated data folder progress',
        jobId,
      },
    });

    return { created, updated, deleted };
  }

  // ---------------------------------------------------------------------------
  // Shared operations (same logic as V1)
  // ---------------------------------------------------------------------------

  private async deleteStaleFiles(params: {
    folderCtx: FolderContext;
    publicProgress: PullLinkedFolderFilesPublicProgress;
    pulledPaths: Set<string>;
    isResuming: boolean;
  }): Promise<number> {
    const { folderCtx, publicProgress, pulledPaths, isResuming } = params;
    const { dataFolder, repoId } = folderCtx;
    const folderPath = (dataFolder.path ?? dataFolder.name).replace(/^\//, '');

    if (isResuming) {
      WSLogger.info({
        source: LOG_SOURCE,
        message: 'Skipping deletion check on resumed run',
        workbookId: dataFolder.workbookId,
        dataFolderId: dataFolder.id,
      });
      return 0;
    }

    try {
      const mainFiles = await this.scratchGitService.listRepoFiles(repoId, MAIN_BRANCH, folderPath);
      const filesToDelete = mainFiles
        .filter((f) => !f.name.startsWith('.'))
        .filter((f) => !pulledPaths.has(f.path))
        .map((f) => f.path);

      if (filesToDelete.length > 0) {
        publicProgress.deletedCount += filesToDelete.length;
        for (const path of filesToDelete) {
          if (publicProgress.deletedPaths.length < MAX_PROGRESS_PATHS) {
            publicProgress.deletedPaths.push(path);
          }
        }

        await this.scratchGitService.deleteFilesFromBranch(
          repoId,
          MAIN_BRANCH,
          filesToDelete,
          `Remove ${filesToDelete.length} deleted files from ${folderPath}`,
        );

        return filesToDelete.length;
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

    return 0;
  }

  private async finalizeFolder(params: {
    folderCtx: FolderContext;
    jobId: string;
    publicProgress: PullLinkedFolderFilesPublicProgress;
    checkpoint: CheckpointFn;
    jobProgress: PullLinkedFolderFilesV2JobProgress;
  }): Promise<void> {
    const { folderCtx, jobId, publicProgress, checkpoint, jobProgress } = params;
    const { dataFolder } = folderCtx;

    publicProgress.status = 'completed';

    await checkpoint({ publicProgress, jobProgress, connectorProgress: {} });

    await this.prisma.dataFolder.update({
      where: { id: dataFolder.id },
      data: { lock: null },
    });

    WSLogger.debug({
      source: LOG_SOURCE,
      message: 'Pull completed for data folder',
      workbookId: dataFolder.workbookId,
      dataFolderId: dataFolder.id,
    });

    this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
      type: 'folder-updated',
      data: {
        entityId: dataFolder.id,
        source: 'job',
        message: 'Updated status of folder',
        jobId,
      },
    });

    this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
      type: 'job-completed',
      data: {
        entityId: dataFolder.id,
        source: 'job',
        message: 'Pull completed for data folder',
        jobId,
      },
    });
  }

  private async updateFileIndex(folderCtx: FolderContext, builtFiles: BuiltFile[]): Promise<void> {
    try {
      await this.fileIndexService.upsertBatch(
        builtFiles
          .map((f) => {
            const parts = f.path.split('/');
            const filename = parts.pop()!;
            const folderPath = parts.join('/').replace(/^\//, '');

            if (!f.recordId) return null;

            return {
              workbookId: folderCtx.dataFolder.workbookId,
              folderPath,
              filename,
              recordId: f.recordId,
            };
          })
          .filter((x): x is NonNullable<typeof x> => x !== null),
      );
    } catch (err) {
      WSLogger.error({
        source: LOG_SOURCE,
        message: 'Failed to update file index',
        workbookId: folderCtx.dataFolder.workbookId,
        error: err,
      });
    }
  }

  private async updateFileReferences(folderCtx: FolderContext, builtFiles: BuiltFile[]): Promise<void> {
    try {
      await this.fileReferenceService.updateRefsForFiles(
        folderCtx.dataFolder.workbookId,
        MAIN_BRANCH,
        builtFiles.map((f) => ({
          path: f.path.startsWith('/') ? f.path.slice(1) : f.path,
          content: f.parsedRecord,
        })),
        folderCtx.tableSpec.schema,
      );
    } catch (err) {
      WSLogger.error({
        source: LOG_SOURCE,
        message: 'Failed to update file references',
        workbookId: folderCtx.dataFolder.workbookId,
        error: err,
      });
    }
  }

  private async updateAssetIndex(folderCtx: FolderContext, builtFiles: BuiltFile[]): Promise<void> {
    try {
      const assetEntries = builtFiles.flatMap((f) => {
        const normalizedPath = f.path.startsWith('/') ? f.path.slice(1) : f.path;
        const recordContent = f.parsedRecord as Record<string, unknown>;
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        const recordRemoteId = String(recordContent[folderCtx.tableSpec.idColumnRemoteId] || '') || undefined;
        return this.assetExtractorService.extractAssets(folderCtx.connector, {
          workbookId: folderCtx.dataFolder.workbookId,
          service: folderCtx.dataFolder.connectorService,
          dataFolderId: folderCtx.dataFolder.id,
          recordFilePath: normalizedPath,
          recordRemoteId,
          recordContent,
          schema: folderCtx.tableSpec.schema as Record<string, unknown>,
        });
      });

      if (assetEntries.length > 0) {
        await this.assetIndexService.upsertBatch(assetEntries);
      }
    } catch (err) {
      WSLogger.error({
        source: LOG_SOURCE,
        message: 'Failed to update asset index',
        workbookId: folderCtx.dataFolder.workbookId,
        error: err,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive max parallel folder fetches from the connector's rate limiter spec.
 * Each parallel folder has roughly 1 in-flight API call at a time,
 * so we cap at the rate limit's requests-per-second.
 */
export function getMaxConcurrency(service: string, folderCount: number): number {
  const registration = connectorRegistry.get(service);
  const spec = registration?.rateLimiterSpec;
  if (!spec) return Math.min(folderCount, DEFAULT_CONCURRENCY);
  const maxFromRate = Math.ceil(spec.points / spec.duration);
  return Math.min(folderCount, maxFromRate);
}

/**
 * Run async functions over items with a concurrency limit.
 */
export async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const executing = new Set<Promise<void>>();
  for (const item of items) {
    const p = fn(item).then(
      () => {
        executing.delete(p);
      },
      () => {
        executing.delete(p);
      },
    );
    executing.add(p);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}
