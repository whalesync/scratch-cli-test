import type { PrismaClient } from '@prisma/client';
import { type ConnectorPullOptions, DataFolderId, Service, type WorkbookId } from '@spinner/shared-types';
import type { ConnectorsService } from '../../../remote-service/connectors/connectors.service';
import type { BaseJsonTableSpec, ConnectorFile } from '../../../remote-service/connectors/types';
import type { JsonSafeObject } from '../../../utils/objects';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';
// Non type imports
import { FileIndexService } from 'src/publish-plan/file-index.service';
import { FileReferenceService } from 'src/publish-plan/file-reference.service';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { exceptionForConnectorError } from 'src/remote-service/connectors/error';
import { getRepoId, MAIN_BRANCH, RepoFileRef, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { WSLogger } from '../../../logger';
import { WorkbookEventService } from '../../../workbook/workbook-event.service';
import { buildGitFilesFromConnectorFiles } from './connector-file-utils';

/** Maximum number of file paths to track per category in progress */
const MAX_PROGRESS_PATHS = 1000;

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

export type PullLinkedFolderFilesJobDefinition = JobDefinitionBuilder<
  'pull-linked-folder-files',
  {
    workbookId: WorkbookId;
    dataFolderIds: DataFolderId[];
    userId: string;
    organizationId: string;
    progress?: JsonSafeObject;
    initialPublicProgress?: PullLinkedFolderFilesPublicProgress;
  },
  PullLinkedFolderFilesPublicProgress,
  Record<string, never>,
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

    // Look up workbook version to determine which repo path to use
    const workbook = await this.prisma.workbook.findUnique({ where: { id: data.workbookId } });
    const workbookVersion = workbook?.version ?? 1;

    const repoId =
      workbookVersion >= 2 && connectorAccountId
        ? getRepoId(workbookVersion, data.workbookId, data.organizationId, connectorAccountId)
        : data.workbookId;

    // For V2 workbooks, ensure the repo exists (e.g. new connection added after migration)
    if (workbookVersion >= 2 && connectorAccountId) {
      await this.scratchGitService.initRepo(repoId as WorkbookId);
    }

    const totalFilesAccumulator = { count: 0 };
    for (const dataFolderId of data.dataFolderIds) {
      await this.pullFolder({
        jobId,
        dataFolderId,
        folderCount,
        connectionName,
        repoId,
        totalFilesAccumulator,
        data,
        checkpoint,
        progress,
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
  }) {
    const {
      jobId,
      dataFolderId,
      folderCount,
      connectionName,
      repoId,
      totalFilesAccumulator,
      data,
      checkpoint,
      progress,
    } = params;

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

    const tableSpec = dataFolder.schema as BaseJsonTableSpec;

    const pullOptions: ConnectorPullOptions = (dataFolder.options as ConnectorPullOptions) ?? {};

    const publicProgress: PullLinkedFolderFilesPublicProgress = {
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
      jobProgress: {},
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
      service: service as Service,
      connectorAccount: decryptedConnectorAccount,
      decryptedCredentials: decryptedConnectorAccount,
      userId: data.userId,
    });

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
      const builtFiles = buildGitFilesFromConnectorFiles(
        dataFolder.path ?? '',
        files,
        tableSpec,
        usedFileNames,
        existingFileNames,
      );

      // Sync to Git (Commit to main + Rebase dirty)
      if (builtFiles.length > 0) {
        const batchGitFiles = builtFiles.map((f) => ({
          path: f.path.startsWith('/') ? f.path.slice(1) : f.path,
          content: f.content,
        }));

        // Accumulate for deletion tracking
        gitFiles = gitFiles.concat(batchGitFiles);

        await this.scratchGitService.commitFilesToBranch(
          repoId as WorkbookId,
          'main',
          batchGitFiles,
          `Sync batch of ${builtFiles.length} files`,
        );

        await this.scratchGitService.rebaseDirty(repoId as WorkbookId);

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
        } catch (err) {
          WSLogger.error({
            source: 'PullLinkedFolderFilesJob',
            message: 'Failed to update indices',
            workbookId: dataFolder.workbookId,
            error: err,
          });
          // Don't fail the job if indexing fails, but log it.
        }
      }

      // Track file paths (all pulled records are "created" from the pull perspective)
      for (const file of builtFiles) {
        const normalizedPath = file.path.startsWith('/') ? file.path.slice(1) : file.path;
        if (publicProgress.createdPaths.length < MAX_PROGRESS_PATHS) {
          publicProgress.createdPaths.push(normalizedPath);
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
        jobProgress: {},
        connectorProgress: connectorProgress ?? {},
      });
    };

    try {
      await connector.pullRecordFiles(tableSpec, callback, progress, pullOptions);

      // After download, remove files from main that no longer exist in remote
      // This ensures deleted items don't keep showing up in future diffs
      const folderPath = (dataFolder.path ?? dataFolder.name).replace(/^\//, '');
      try {
        const mainFiles = (await this.scratchGitService.listRepoFiles(
          repoId as WorkbookId,
          MAIN_BRANCH,
          folderPath,
        )) as RepoFileRef[];
        const downloadedFilePaths = gitFiles.map((f) => f.path);
        const filesToDelete = mainFiles.filter((f) => !downloadedFilePaths.includes(f.path)).map((f) => f.path);

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
            repoId as WorkbookId,
            MAIN_BRANCH,
            filesToDelete,
            `Remove ${filesToDelete.length} deleted files from ${folderPath}`,
          );

          await this.scratchGitService.rebaseDirty(repoId as WorkbookId);
        }
      } catch (err) {
        WSLogger.error({
          source: 'DownloadLinkedFolderFilesJob',
          message: 'Failed to clean up deleted files from main',
          workbookId: dataFolder.workbookId,
          error: err,
        });
        // Don't fail the job for cleanup errors
      }

      // Mark as completed
      publicProgress.status = 'completed';

      // Checkpoint final status
      await checkpoint({
        publicProgress,
        jobProgress: {},
        connectorProgress: {},
      });

      // Set lock=null and update lastSyncTime on success
      await this.prisma.dataFolder.update({
        where: { id: dataFolder.id },
        data: {
          lock: null,
          lastSyncTime: new Date(),
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
        await this.scratchGitService.runGitGc(repoId as WorkbookId);
      } catch (err) {
        WSLogger.warn({
          source: 'PullLinkedFolderFilesJob',
          message: 'Failed to run Git GC',
          workbookId: dataFolder.workbookId,
          error: err,
        });
      }
    } catch (error) {
      // Mark as failed
      publicProgress.status = 'failed';

      // Checkpoint failed status
      await checkpoint({
        publicProgress,
        jobProgress: {},
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
        error: error instanceof Error ? error.message : 'Unknown error',
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
