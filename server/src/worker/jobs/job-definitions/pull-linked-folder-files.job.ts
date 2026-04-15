import type { PrismaClient } from '@prisma/client';
import { type ConnectorPullOptions, DataFolderId, JobType, type WorkbookId } from '@spinner/shared-types';
import type { ConnectorsService } from '../../../remote-service/connectors/connectors.service';
import type { BaseJsonTableSpec, ConnectorFile } from '../../../remote-service/connectors/types';
import type { JsonSafeObject } from '../../../utils/objects';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';
// Non type imports
import { AssetExtractorService } from 'src/asset/asset-extractor.service';
import { AssetIndexService } from 'src/asset/asset-index.service';
import type { PostHogService } from 'src/posthog/posthog.service';
import { FileIndexService } from 'src/publish-plan/file-index.service';
import { FileReferenceService } from 'src/publish-plan/file-reference.service';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import type { Connector } from 'src/remote-service/connectors/connector';
import { exceptionForConnectorError } from 'src/remote-service/connectors/error';
import { ScratchGitNotFoundError } from 'src/scratch-git/scratch-git.client';
import { MAIN_BRANCH, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { WSLogger } from '../../../logger';
import { WorkbookEventService } from '../../../workbook/workbook-event.service';
import { type BuiltFile, buildGitFilesFromConnectorFiles } from './connector-file-utils';

/** Maximum number of file paths to track per category in progress (for UI display). */
const MAX_PROGRESS_PATHS = 100;

const LOG_SOURCE = 'PullLinkedFolderFilesJob';

export type PullLinkedFolderFilesPublicProgress = {
  totalFiles: number;
  folderCount: number;
  connectionName: string;
  folderId: string;
  folderName: string;
  connector: string;
  filter: string | null;
  status: 'pending' | 'active' | 'completed' | 'failed';
  /** All folder IDs being pulled (v2 multi-folder jobs). */
  dataFolderIds?: string[];
  createdPaths: string[];
  updatedPaths: string[];
  deletedPaths: string[];
  /** Actual counts (not capped like path arrays) for accurate analytics. */
  createdCount: number;
  updatedCount: number;
  deletedCount: number;
};

export type PullLinkedFolderFilesJobProgress = {
  completedFolderIds?: string[];
};

export type PullLinkedFolderFilesJobDefinition = JobDefinitionBuilder<
  typeof JobType.PullLinkedFolderFiles,
  {
    workbookId: WorkbookId;
    dataFolderIds: DataFolderId[];
    userId: string;
    organizationId: string;
    trigger?: 'web' | 'scheduler' | 'cli' | 'job';
    progress?: JsonSafeObject;
    initialPublicProgress?: PullLinkedFolderFilesPublicProgress;
  },
  PullLinkedFolderFilesPublicProgress,
  PullLinkedFolderFilesJobProgress,
  void
>;

type CheckpointFn = (
  progress: Omit<
    Progress<
      PullLinkedFolderFilesJobDefinition['publicProgress'],
      PullLinkedFolderFilesJobDefinition['initialJobProgress']
    >,
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
};

/**
 * This job pulls records as ConnectorFiles for all DataFolders belonging to a single
 * ConnectorAccount (connection), processing each folder sequentially.
 */
export class PullLinkedFolderFilesJobHandler implements JobHandlerBuilder<PullLinkedFolderFilesJobDefinition> {
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
    progress: Progress<
      PullLinkedFolderFilesJobDefinition['publicProgress'],
      PullLinkedFolderFilesJobDefinition['initialJobProgress']
    >;
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

    // Ensure the repo exists (e.g. new connection added after migration)
    await this.scratchGitService.initRepo(repoId);

    let totalFiles = 0;
    const pullStats = { created: 0, updated: 0, deleted: 0, failed: false };
    const completedFolderIds = [...(progress.jobProgress?.completedFolderIds ?? [])];
    let lastPublicProgress = progress.publicProgress;

    for (const dataFolderId of data.dataFolderIds) {
      if (abortSignal.aborted) break;

      // Skip folders that were already completed before a stall/restart
      if (completedFolderIds.includes(dataFolderId)) {
        WSLogger.info({
          source: LOG_SOURCE,
          message: 'Skipping already-completed folder on resume',
          dataFolderId,
          workbookId: data.workbookId,
        });
        continue;
      }

      const result = await this.pullFolder({
        jobId,
        dataFolderId,
        folderCount,
        connectionName,
        repoId,
        totalFiles,
        data,
        checkpoint,
        progress,
        completedFolderIds,
        abortSignal,
      });

      totalFiles = result.publicProgress.totalFiles;
      pullStats.created += result.publicProgress.createdCount;
      pullStats.updated += result.publicProgress.updatedCount;
      pullStats.deleted += result.publicProgress.deletedCount;
      if (result.publicProgress.status === 'failed') pullStats.failed = true;
      lastPublicProgress = result.publicProgress;

      // Track this folder as completed so it's skipped if the job restarts
      completedFolderIds.push(dataFolderId);
    }

    // Checkpoint before buildIndex to keep BullMQ lock alive after folder processing
    await checkpoint({
      publicProgress: lastPublicProgress,
      jobProgress: { completedFolderIds },
      connectorProgress: {},
    });

    // Rebuild the index once after all folders are done (not per-folder)
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
        totalFilesPulled: totalFiles,
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
  // pullFolder — orchestrates the five phases of pulling a single folder
  // ---------------------------------------------------------------------------

  private async pullFolder(params: {
    jobId: string;
    dataFolderId: DataFolderId;
    folderCount: number;
    connectionName: string;
    repoId: string;
    totalFiles: number;
    data: PullLinkedFolderFilesJobDefinition['data'];
    progress: Progress<
      PullLinkedFolderFilesJobDefinition['publicProgress'],
      PullLinkedFolderFilesJobDefinition['initialJobProgress']
    >;
    checkpoint: CheckpointFn;
    completedFolderIds: string[];
    abortSignal: AbortSignal;
  }): Promise<{ publicProgress: PullLinkedFolderFilesPublicProgress }> {
    const {
      jobId,
      dataFolderId,
      folderCount,
      connectionName,
      repoId,
      totalFiles,
      data,
      checkpoint,
      progress,
      completedFolderIds,
      abortSignal,
    } = params;

    // Detect whether this folder is being resumed after a stall.
    // On resume, connectorProgress contains the pagination cursor from the last checkpoint.
    const isResuming = Object.keys(progress.connectorProgress ?? {}).length > 0;

    // --- Phase 1: Load folder and set up connector ---
    const { folderCtx, pullOptions } = await this.loadFolderAndConnector({
      dataFolderId,
      repoId,
      data,
    });

    // Restore publicProgress from the last checkpoint when resuming the same folder,
    // so file counts and tracked paths aren't reset to zero.
    const savedPublicProgress = progress.publicProgress;
    const canRestoreProgress = isResuming && savedPublicProgress?.folderId === folderCtx.dataFolder.id;

    const publicProgress: PullLinkedFolderFilesPublicProgress = canRestoreProgress
      ? { ...savedPublicProgress, status: 'active' }
      : {
          totalFiles,
          folderCount,
          connectionName,
          folderId: folderCtx.dataFolder.id,
          folderName: folderCtx.dataFolder.name,
          connector: folderCtx.dataFolder.connectorService,
          filter: pullOptions.filter ?? null,
          status: 'active',
          createdPaths: [],
          updatedPaths: [],
          deletedPaths: [],
          createdCount: 0,
          updatedCount: 0,
          deletedCount: 0,
        };

    // Backfill counts for progress restored from before count fields existed
    if (canRestoreProgress && publicProgress.createdCount === undefined) {
      publicProgress.createdCount = publicProgress.createdPaths.length;
      publicProgress.updatedCount = publicProgress.updatedPaths.length;
      publicProgress.deletedCount = publicProgress.deletedPaths.length;
    }

    this.workbookEventService.sendWorkbookEvent(folderCtx.dataFolder.workbookId as WorkbookId, {
      type: 'job-started',
      data: {
        source: 'job',
        entityId: folderCtx.dataFolder.id,
        message: 'Pulling files for data folder',
        jobId,
      },
    });

    // Checkpoint initial status
    await checkpoint({
      publicProgress,
      jobProgress: { completedFolderIds },
      connectorProgress: {},
    });

    WSLogger.debug({
      source: LOG_SOURCE,
      message: 'Pulling files for data folder',
      workbookId: folderCtx.dataFolder.workbookId,
      dataFolderId: folderCtx.dataFolder.id,
    });

    try {
      // --- Phase 2: Pull records in batches and commit to git ---
      const pulledPaths = await this.pullAndCommitRecords({
        folderCtx,
        publicProgress,
        pullOptions,
        checkpoint,
        completedFolderIds,
        isResuming,
        canRestoreProgress,
        resumeProgress: canRestoreProgress ? (progress.connectorProgress ?? {}) : {},
        abortSignal,
      });

      // --- Phase 3: Delete stale files ---
      await this.deleteStaleFiles({
        folderCtx,
        publicProgress,
        pulledPaths,
        isResuming,
      });

      // --- Phase 4: Finalize (rebase, GC, events, checkpoint) ---
      await this.finalizeFolder({
        folderCtx,
        jobId,
        publicProgress,
        checkpoint,
        completedFolderIds,
      });

      return { publicProgress };
    } catch (error) {
      publicProgress.status = 'failed';

      await checkpoint({
        publicProgress,
        jobProgress: { completedFolderIds },
        connectorProgress: {},
      });

      await this.prisma.dataFolder.update({
        where: { id: folderCtx.dataFolder.id },
        data: { lock: null },
      });

      WSLogger.error({
        source: LOG_SOURCE,
        message: 'Failed to pull files for data folder',
        workbookId: folderCtx.dataFolder.workbookId,
        dataFolderId: folderCtx.dataFolder.id,
        errorDetails: folderCtx.connector.extractConnectorErrorDetails(error),
      });

      this.workbookEventService.sendWorkbookEvent(folderCtx.dataFolder.workbookId as WorkbookId, {
        type: 'folder-updated',
        data: {
          entityId: folderCtx.dataFolder.id,
          source: 'job',
          message: 'Updated status of folder',
          jobId,
        },
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

  // ---------------------------------------------------------------------------
  // Phase 1: Load folder from DB, set up connector and fetch fresh schema
  // ---------------------------------------------------------------------------

  private async loadFolderAndConnector(params: {
    dataFolderId: DataFolderId;
    repoId: string;
    data: PullLinkedFolderFilesJobDefinition['data'];
  }): Promise<{ folderCtx: FolderContext; pullOptions: ConnectorPullOptions }> {
    const { dataFolderId, repoId, data } = params;

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

    // Get decrypted connector account
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

    // Fetch fresh schema from the remote connector
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
    if (Array.isArray(nameOverride) && nameOverride.length > 0) {
      tableSpec.titleColumnRemoteId = nameOverride;
    }

    // Write refreshed schema to git
    if (dataFolder.path) {
      await this.scratchGitService.writeSchemaToGit(repoId, dataFolder.path, tableSpec);
    }

    const folderCtx: FolderContext = {
      jobId: '',
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
    };

    return { folderCtx, pullOptions };
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Pull records in batches, commit each batch, update indices
  // ---------------------------------------------------------------------------

  private async pullAndCommitRecords(params: {
    folderCtx: FolderContext;
    publicProgress: PullLinkedFolderFilesPublicProgress;
    pullOptions: ConnectorPullOptions;
    checkpoint: CheckpointFn;
    completedFolderIds: string[];
    isResuming: boolean;
    canRestoreProgress: boolean;
    resumeProgress: JsonSafeObject;
    abortSignal: AbortSignal;
  }): Promise<Set<string>> {
    const { folderCtx, publicProgress, pullOptions, checkpoint, completedFolderIds, resumeProgress, abortSignal } =
      params;
    const { dataFolder, connector, tableSpec } = folderCtx;

    const pulledPaths = new Set<string>();
    const usedFileNames = new Set<string>();

    const onBatch = async (callbackParams: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => {
      if (abortSignal.aborted) return;

      const { files, connectorProgress } = callbackParams;

      WSLogger.debug({
        source: LOG_SOURCE,
        message: 'Received files from connector',
        workbookId: dataFolder.workbookId,
        dataFolderId: dataFolder.id,
        fileCount: files.length,
        folderPath: dataFolder.path,
      });

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
        const commitResult = await this.commitBatch(folderCtx, builtFiles);

        // Track pulled paths for deletion comparison (paths only — no content held in memory)
        for (const f of builtFiles) {
          const normalizedPath = f.path.startsWith('/') ? f.path.slice(1) : f.path;
          pulledPaths.add(normalizedPath);
        }

        await this.updateFileIndex(folderCtx, builtFiles);
        await this.updateFileReferences(folderCtx, builtFiles);
        await this.updateAssetIndex(folderCtx, builtFiles);

        // Track progress: actual counts + capped path arrays for UI
        publicProgress.createdCount += commitResult.created.length;
        publicProgress.updatedCount += commitResult.updated.length;
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
      }

      publicProgress.totalFiles += files.length;

      this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
        type: 'folder-contents-changed',
        data: {
          entityId: dataFolder.id,
          source: 'job',
          message: 'Updated data folder progress',
          jobId: folderCtx.jobId,
        },
      });

      await checkpoint({
        publicProgress,
        jobProgress: { completedFolderIds },
        connectorProgress: connectorProgress ?? {},
      });
    };

    await connector.pullRecordFiles(tableSpec, onBatch, resumeProgress, pullOptions);

    return pulledPaths;
  }

  // ---------------------------------------------------------------------------
  // Phase 3: Delete files from git that no longer exist in the remote
  // ---------------------------------------------------------------------------

  private async deleteStaleFiles(params: {
    folderCtx: FolderContext;
    publicProgress: PullLinkedFolderFilesPublicProgress;
    pulledPaths: Set<string>;
    isResuming: boolean;
  }): Promise<void> {
    const { folderCtx, publicProgress, pulledPaths, isResuming } = params;
    const { dataFolder, repoId } = folderCtx;
    const folderPath = (dataFolder.path ?? dataFolder.name).replace(/^\//, '');

    // Skip deletion on resumed runs because pulledPaths only contains files from
    // the resumed portion — deleting based on incomplete data would incorrectly
    // remove files committed before the stall. Deletion will happen on the next
    // full (non-resumed) pull.
    if (isResuming) {
      WSLogger.info({
        source: LOG_SOURCE,
        message: 'Skipping deletion check on resumed run',
        workbookId: dataFolder.workbookId,
        dataFolderId: dataFolder.id,
      });
      return;
    }

    try {
      const mainFiles = await this.scratchGitService.listRepoFiles(repoId, MAIN_BRANCH, folderPath);
      const filesToDelete = mainFiles
        .filter((f) => !f.name.startsWith('.')) // Exclude dotfiles (e.g. .schema.json)
        .filter((f) => !pulledPaths.has(f.path))
        .map((f) => f.path);

      if (filesToDelete.length > 0) {
        publicProgress.deletedCount += filesToDelete.length;
        for (const path of filesToDelete) {
          if (publicProgress.deletedPaths.length < MAX_PROGRESS_PATHS) {
            publicProgress.deletedPaths.push(path);
          }
        }

        WSLogger.debug({
          source: LOG_SOURCE,
          message: 'Removing deleted files from main branch',
          workbookId: dataFolder.workbookId,
          dataFolderId: dataFolder.id,
          filesToDelete,
        });

        await this.scratchGitService.deleteFilesFromBranch(
          repoId,
          MAIN_BRANCH,
          filesToDelete,
          `Remove ${filesToDelete.length} deleted files from ${folderPath}`,
        );
      }
    } catch (err) {
      // On first pull, the main branch doesn't exist yet — nothing to clean up
      if (!(err instanceof ScratchGitNotFoundError)) {
        WSLogger.error({
          source: LOG_SOURCE,
          message: 'Failed to clean up deleted files from main',
          workbookId: dataFolder.workbookId,
          error: err,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 4: Rebase, GC, emit completion events, final checkpoint
  // ---------------------------------------------------------------------------

  private async finalizeFolder(params: {
    folderCtx: FolderContext;
    jobId: string;
    publicProgress: PullLinkedFolderFilesPublicProgress;
    checkpoint: CheckpointFn;
    completedFolderIds: string[];
  }): Promise<void> {
    const { folderCtx, jobId, publicProgress, checkpoint, completedFolderIds } = params;
    const { dataFolder, repoId } = folderCtx;

    // Checkpoint before rebase to keep BullMQ lock alive
    await checkpoint({
      publicProgress,
      jobProgress: { completedFolderIds },
      connectorProgress: {},
    });

    await this.scratchGitService.rebaseDirty(repoId);

    publicProgress.status = 'completed';

    await checkpoint({
      publicProgress,
      jobProgress: { completedFolderIds },
      connectorProgress: {},
    });

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

    try {
      await this.scratchGitService.runGitGc(repoId);
    } catch (err) {
      WSLogger.warn({
        source: LOG_SOURCE,
        message: 'Failed to run Git GC',
        workbookId: dataFolder.workbookId,
        error: err,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Batch operations: commit, file index, file references, asset index
  // ---------------------------------------------------------------------------

  private async commitBatch(
    folderCtx: FolderContext,
    builtFiles: BuiltFile[],
  ): Promise<{ created: string[]; updated: string[] }> {
    const batchGitFiles = builtFiles.map((f) => ({
      path: f.path.startsWith('/') ? f.path.slice(1) : f.path,
      content: f.content,
    }));

    return this.scratchGitService.commitFilesToBranch(
      folderCtx.repoId,
      'main',
      batchGitFiles,
      `Sync batch of ${builtFiles.length} files in ${folderCtx.dataFolder.path ?? folderCtx.dataFolder.name}`,
    );
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
        WSLogger.info({
          source: LOG_SOURCE,
          message: 'Asset index updated: extracted assets from records',
          service: folderCtx.dataFolder.connectorService,
          workbookId: folderCtx.dataFolder.workbookId,
          assetCount: assetEntries.length,
          recordCount: builtFiles.length,
        });
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
