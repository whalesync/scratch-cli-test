import type { PrismaClient } from '@prisma/client';
import { type ConnectorPullOptions, DataFolderId, JobType, Service, type WorkbookId } from '@spinner/shared-types';
import type { ConnectorsService } from '../../../remote-service/connectors/connectors.service';
import type { ConnectorFile } from '../../../remote-service/connectors/types';
import type { JsonSafeObject } from '../../../utils/objects';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';
// Non type imports
import { AssetExtractorService } from 'src/asset/asset-extractor.service';
import { AssetIndexService } from 'src/asset/asset-index.service';
import type { PostHogService } from 'src/posthog/posthog.service';
import { FileIndexService } from 'src/publish-plan/file-index.service';
import { FileReferenceService } from 'src/publish-plan/file-reference.service';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { exceptionForConnectorError } from 'src/remote-service/connectors/error';
import { ScratchGitNotFoundError } from 'src/scratch-git/scratch-git.client';
import { MAIN_BRANCH, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { WSLogger } from '../../../logger';
import { WorkbookEventService } from '../../../workbook/workbook-event.service';
import { buildGitFilesFromConnectorFiles } from './connector-file-utils';

/** Maximum number of file paths to track per category in progress */
const MAX_PROGRESS_PATHS = 100;

export type PullLinkedFolderFilesPublicProgress = {
  totalFiles: number;
  folderCount: number;
  connectionName: string;
  folderId: string;
  folderName: string;
  connector: string;
  filter: string | null;
  status: 'pending' | 'active' | 'completed' | 'failed';
  createdPaths: string[];
  updatedPaths: string[];
  deletedPaths: string[];
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
    checkpoint: (
      progress: Omit<
        Progress<
          PullLinkedFolderFilesJobDefinition['publicProgress'],
          PullLinkedFolderFilesJobDefinition['initialJobProgress']
        >,
        'timestamp'
      >,
    ) => Promise<void>;
  }) {
    const { jobId, data, checkpoint, progress } = params;
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

    const totalFilesAccumulator = { count: 0 };
    const pullStats = { created: 0, updated: 0, deleted: 0, failed: false };
    const completedFolderIds = [...(progress.jobProgress?.completedFolderIds ?? [])];
    let lastPublicProgress = progress.publicProgress;
    for (const dataFolderId of data.dataFolderIds) {
      // Skip folders that were already completed before a stall/restart
      if (completedFolderIds.includes(dataFolderId)) {
        WSLogger.info({
          source: 'PullLinkedFolderFilesJob',
          message: 'Skipping already-completed folder on resume',
          dataFolderId,
          workbookId: data.workbookId,
        });
        continue;
      }

      lastPublicProgress = await this.pullFolder({
        jobId,
        dataFolderId,
        folderCount,
        connectionName,
        repoId,
        totalFilesAccumulator,
        pullStats,
        data,
        checkpoint,
        progress,
        completedFolderIds,
      });

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
        source: 'PullLinkedFolderFilesJob',
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
        totalFilesPulled: totalFilesAccumulator.count,
        filesCreated: pullStats.created,
        filesUpdated: pullStats.updated,
        filesDeleted: pullStats.deleted,
        foldersProcessed: folderCount,
      });
    } catch (err) {
      WSLogger.warn({
        source: 'PullLinkedFolderFilesJob',
        message: 'Failed to track pull completed event',
        error: err,
      });
    }
  }

  private async pullFolder(params: {
    jobId: string;
    dataFolderId: DataFolderId;
    folderCount: number;
    connectionName: string;
    repoId: string;
    totalFilesAccumulator: { count: number };
    pullStats: { created: number; updated: number; deleted: number; failed: boolean };
    data: PullLinkedFolderFilesJobDefinition['data'];
    progress: Progress<
      PullLinkedFolderFilesJobDefinition['publicProgress'],
      PullLinkedFolderFilesJobDefinition['initialJobProgress']
    >;
    checkpoint: (
      progress: Omit<
        Progress<
          PullLinkedFolderFilesJobDefinition['publicProgress'],
          PullLinkedFolderFilesJobDefinition['initialJobProgress']
        >,
        'timestamp'
      >,
    ) => Promise<void>;
    completedFolderIds: string[];
  }): Promise<PullLinkedFolderFilesPublicProgress> {
    const {
      jobId,
      dataFolderId,
      folderCount,
      connectionName,
      repoId,
      totalFilesAccumulator,
      pullStats,
      data,
      checkpoint,
      progress,
      completedFolderIds,
    } = params;

    // Detect whether this folder is being resumed after a stall.
    // On resume, connectorProgress contains the pagination cursor from the last checkpoint.
    const isResuming = Object.keys(progress.connectorProgress ?? {}).length > 0;

    const dataFolder = await this.prisma.dataFolder.findUnique({
      where: { id: dataFolderId },
      include: {
        connectorAccount: true,
      },
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

    // Restore publicProgress from the last checkpoint when resuming the same folder,
    // so file counts and tracked paths aren't reset to zero.
    const savedPublicProgress = progress.publicProgress;
    const canRestoreProgress = isResuming && savedPublicProgress?.folderId === dataFolder.id;

    const publicProgress: PullLinkedFolderFilesPublicProgress = canRestoreProgress
      ? { ...savedPublicProgress, status: 'active' }
      : {
          totalFiles: totalFilesAccumulator.count,
          folderCount,
          connectionName,
          folderId: dataFolder.id,
          folderName: dataFolder.name,
          connector: dataFolder.connectorService,
          filter: pullOptions.filter ?? null,
          status: 'active',
          createdPaths: [],
          updatedPaths: [],
          deletedPaths: [],
        };

    // Sync the accumulator with restored progress so subsequent folders get the right count
    if (canRestoreProgress) {
      totalFilesAccumulator.count = publicProgress.totalFiles;
    }

    this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
      type: 'job-started',
      data: {
        source: 'job',
        entityId: dataFolder.id,
        message: 'Pulling files for data folder',
        jobId: jobId,
      },
    });

    // Checkpoint initial status
    await checkpoint({
      publicProgress,
      jobProgress: { completedFolderIds },
      connectorProgress: {},
    });

    WSLogger.debug({
      source: 'PullLinkedFolderFilesJob',
      message: 'Pulling files for data folder',
      workbookId: dataFolder.workbookId,
      dataFolderId: dataFolder.id,
    });

    // Get connector for this folder
    const service = dataFolder.connectorService;

    let decryptedConnectorAccount: Awaited<ReturnType<typeof this.connectorAccountService.findOneById>> | null = null;
    if (dataFolder.connectorAccountId) {
      decryptedConnectorAccount = await this.connectorAccountService.findOneById(dataFolder.connectorAccountId, {
        userId: data.userId,
        organizationId: data.organizationId,
      });
      if (!decryptedConnectorAccount) {
        throw new Error(`Connector account ${dataFolder.connectorAccountId} not found`);
      }
    }

    const connector = await this.connectorService.getConnector({
      service: service,
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
    if (typeof nameOverride === 'string') {
      tableSpec.titleColumnRemoteId = [nameOverride];
    }

    // Write refreshed schema to git
    if (dataFolder.path) {
      await this.scratchGitService.writeSchemaToGit(repoId, dataFolder.path, tableSpec);
    }

    let gitFiles: { path: string; content: string }[] = [];
    const usedFileNames = new Set<string>();
    const callback = async (callbackParams: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => {
      const { files, connectorProgress } = callbackParams;

      WSLogger.debug({
        source: 'PullLinkedFolderFilesJob',
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
        dataFolder.path?.replace(/^\//, '') ?? '', // Match how folderPath is saved in upsertBatch
        recordIds,
      );

      // TODO: Validate files against the table schema before publishing.
      // Build git file payloads from connector files
      const suggestedFileNames = connector.getSuggestedRecordFileNames(files, tableSpec);
      const builtFiles = buildGitFilesFromConnectorFiles(
        dataFolder.path ?? '',
        files,
        tableSpec,
        usedFileNames,
        existingFileNames,
        suggestedFileNames,
      );

      // Sync to Git (Commit to main + Rebase dirty)
      if (builtFiles.length > 0) {
        const batchGitFiles = builtFiles.map((f) => ({
          path: f.path.startsWith('/') ? f.path.slice(1) : f.path,
          content: f.content,
        }));

        // Accumulate for deletion tracking
        gitFiles = gitFiles.concat(batchGitFiles);

        const commitResult = await this.scratchGitService.commitFilesToBranch(
          repoId,
          'main',
          batchGitFiles,
          `Sync batch of ${builtFiles.length} files in ${dataFolder.path ?? dataFolder.name}`,
        );

        // Update File Index & References (Best effort, after commit)
        try {
          // Update File Index
          await this.fileIndexService.upsertBatch(
            builtFiles
              .map((f) => {
                const content = JSON.parse(f.content) as Record<string, unknown>;
                // eslint-disable-next-line @typescript-eslint/no-base-to-string
                const recordId = String(content[tableSpec.idColumnRemoteId] || '');

                // f.path is full path e.g. /folder/file.json
                // We want folderPath without leading slash, and filename
                const parts = f.path.split('/');
                const filename = parts.pop()!;
                const folderPath = parts.join('/').replace(/^\//, '');

                if (!recordId) return null;

                return {
                  workbookId: dataFolder.workbookId,
                  folderPath,
                  filename,
                  recordId,
                };
              })
              .filter((x): x is NonNullable<typeof x> => x !== null),
          );

          // Update File References
          await this.fileReferenceService.updateRefsForFiles(
            dataFolder.workbookId,
            MAIN_BRANCH, // Pulled files go to main
            builtFiles.map((f) => ({
              path: f.path.startsWith('/') ? f.path.slice(1) : f.path,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              content: JSON.parse(f.content),
            })),
            tableSpec.schema, // Schema for Pass 2 (resolved ID refs)
          );

          // Update Asset Index
          try {
            const assetEntries = builtFiles.flatMap((f) => {
              const normalizedPath = f.path.startsWith('/') ? f.path.slice(1) : f.path;
              const content = JSON.parse(f.content) as Record<string, unknown>;
              // eslint-disable-next-line @typescript-eslint/no-base-to-string
              const recordRemoteId = String(content[tableSpec.idColumnRemoteId] || '') || undefined;
              return this.assetExtractorService.extractAssets(connector, {
                workbookId: dataFolder.workbookId,
                service: dataFolder.connectorService as Service,
                dataFolderId: dataFolder.id,
                recordFilePath: normalizedPath,
                recordRemoteId,
                recordContent: content,
                schema: tableSpec.schema as Record<string, unknown>,
              });
            });
            if (assetEntries.length > 0) {
              await this.assetIndexService.upsertBatch(assetEntries);
              WSLogger.info({
                source: 'PullLinkedFolderFilesJob',
                message: `Asset index updated: extracted assets from records`,
                service: dataFolder.connectorService,
                workbookId: dataFolder.workbookId,
                assetCount: assetEntries.length,
                recordCount: builtFiles.length,
              });
            }
          } catch (assetErr) {
            WSLogger.error({
              source: 'PullLinkedFolderFilesJob',
              message: 'Failed to update asset index',
              workbookId: dataFolder.workbookId,
              error: assetErr,
            });
          }
        } catch (err) {
          WSLogger.error({
            source: 'PullLinkedFolderFilesJob',
            message: 'Failed to update indices',
            workbookId: dataFolder.workbookId,
            error: err,
          });
          // Don't fail the job if indexing fails, but log it.
        }

        // Track file paths using actual commit stats (created vs updated vs unchanged)
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
      totalFilesAccumulator.count = publicProgress.totalFiles;

      this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
        type: 'folder-contents-changed',
        data: {
          entityId: dataFolder.id,
          source: 'job',
          message: 'Updated data folder progress',
          jobId: jobId,
        },
      });

      await checkpoint({
        publicProgress,
        jobProgress: { completedFolderIds },
        connectorProgress: connectorProgress ?? {},
      });
    };

    try {
      // Only pass connector progress when resuming the SAME folder — a stale cursor
      // from a different folder (e.g. a charge ID used as a customer pagination cursor)
      // will cause API errors.
      const resumeProgress = canRestoreProgress ? (progress.connectorProgress ?? {}) : {};
      await connector.pullRecordFiles(tableSpec, callback, resumeProgress, pullOptions);

      // After download, remove files from main that no longer exist in remote.
      // Skip deletion on resumed runs because gitFiles only contains files from
      // the resumed portion — deleting based on incomplete data would incorrectly
      // remove files committed before the stall. Deletion will happen on the next
      // full (non-resumed) pull.
      const folderPath = (dataFolder.path ?? dataFolder.name).replace(/^\//, '');
      if (isResuming) {
        WSLogger.info({
          source: 'PullLinkedFolderFilesJob',
          message: 'Skipping deletion check on resumed run',
          workbookId: dataFolder.workbookId,
          dataFolderId: dataFolder.id,
        });
      } else {
        try {
          const mainFiles = await this.scratchGitService.listRepoFiles(repoId, MAIN_BRANCH, folderPath);
          const downloadedFilePaths = gitFiles.map((f) => f.path);
          const filesToDelete = mainFiles
            .filter((f) => !f.name.startsWith('.')) // Exclude dotfiles (e.g. .schema.json) from deletion
            .filter((f) => !downloadedFilePaths.includes(f.path))
            .map((f) => f.path);

          if (filesToDelete.length > 0) {
            // Track deleted file paths
            for (const path of filesToDelete) {
              if (publicProgress.deletedPaths.length < MAX_PROGRESS_PATHS) {
                publicProgress.deletedPaths.push(path);
              }
            }

            WSLogger.debug({
              source: 'DownloadLinkedFolderFilesJob',
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
              source: 'DownloadLinkedFolderFilesJob',
              message: 'Failed to clean up deleted files from main',
              workbookId: dataFolder.workbookId,
              error: err,
            });
          }
          // Don't fail the job for cleanup errors
        }
      }

      // Checkpoint before rebase to keep BullMQ lock alive after potentially slow delete operation
      await checkpoint({
        publicProgress,
        jobProgress: { completedFolderIds },
        connectorProgress: {},
      });

      // Rebase dirty once at the end of the job (not after every batch)
      await this.scratchGitService.rebaseDirty(repoId);

      // Mark as completed
      publicProgress.status = 'completed';
      pullStats.created += publicProgress.createdPaths.length;
      pullStats.updated += publicProgress.updatedPaths.length;
      pullStats.deleted += publicProgress.deletedPaths.length;

      // Checkpoint final status
      await checkpoint({
        publicProgress,
        jobProgress: { completedFolderIds },
        connectorProgress: {},
      });

      // Set lock=null on success
      await this.prisma.dataFolder.update({
        where: { id: dataFolder.id },
        data: {
          lock: null,
        },
      });

      WSLogger.debug({
        source: 'PullLinkedFolderFilesJob',
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
          jobId: jobId,
        },
      });

      this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
        type: 'job-completed',
        data: {
          entityId: dataFolder.id,
          source: 'job',
          message: 'Pull completed for data folder',
          jobId: jobId,
        },
      });

      try {
        await this.scratchGitService.runGitGc(repoId);
      } catch (err) {
        WSLogger.warn({
          source: 'PullLinkedFolderFilesJob',
          message: 'Failed to run Git GC',
          workbookId: dataFolder.workbookId,
          error: err,
        });
      }

      return publicProgress;
    } catch (error) {
      // Mark as failed
      publicProgress.status = 'failed';
      pullStats.failed = true;

      // Checkpoint failed status
      await checkpoint({
        publicProgress,
        jobProgress: { completedFolderIds },
        connectorProgress: {},
      });

      // Set lock=null on failure
      await this.prisma.dataFolder.update({
        where: { id: dataFolder.id },
        data: { lock: null },
      });

      WSLogger.error({
        source: 'PullLinkedFolderFilesJob',
        message: 'Failed to pull files for data folder',
        workbookId: dataFolder.workbookId,
        dataFolderId: dataFolder.id,
        errorDetails: connector.extractConnectorErrorDetails(error),
      });

      this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
        type: 'folder-updated',
        data: {
          entityId: dataFolder.id,
          source: 'job',
          message: 'Updated status of folder',
          jobId: jobId,
        },
      });

      this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
        type: 'job-failed',
        data: {
          entityId: dataFolder.id,
          source: 'job',
          message: 'Pull failed for data folder',
          jobId: jobId,
        },
      });

      throw exceptionForConnectorError(error, connector);
    }
  }
}
