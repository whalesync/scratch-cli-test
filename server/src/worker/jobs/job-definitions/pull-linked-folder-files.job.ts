import type { PrismaClient } from '@prisma/client';
import { DataFolderId, Service, type WorkbookId } from '@spinner/shared-types';
import type { ConnectorsService } from '../../../remote-service/connectors/connectors.service';
import type { BaseJsonTableSpec, ConnectorFile, ConnectorPullOptions } from '../../../remote-service/connectors/types';
import type { JsonSafeObject } from '../../../utils/objects';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';
// Non type imports
import _ from 'lodash';
import { FileIndexService } from 'src/publish-pipeline/file-index.service';
import { FileReferenceService } from 'src/publish-pipeline/file-reference.service';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { exceptionForConnectorError } from 'src/remote-service/connectors/error';
import { MAIN_BRANCH, RepoFileRef, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { formatJsonWithPrettier } from 'src/utils/json-formatter';
import { deduplicateFileName, resolveBaseFileName } from 'src/workbook/util';
import { WSLogger } from '../../../logger';
import { WorkbookEventService } from '../../../workbook/workbook-event.service';

/** Maximum number of file paths to track per category in progress */
const MAX_PROGRESS_PATHS = 1000;

export type PullLinkedFolderFilesPublicProgress = {
  totalFiles: number;
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
    dataFolderId: DataFolderId;
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
 * This job pulls records as ConnectorFiles for a single DataFolder (linked folder)
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

  /**
   * Constructs git file payloads from connector files, applying slug > title > id naming.
   * Deduplicates filenames across the entire pull (maintained in usedFileNames across batches).
   */
  private buildGitFilesFromConnectorFiles(
    parentPath: string,
    records: ConnectorFile[],
    tableSpec: BaseJsonTableSpec,
    usedFileNames: Set<string>,
  ): { path: string; content: string }[] {
    const prefix = parentPath === '/' ? '' : parentPath;
    const idColumnRemoteId = tableSpec.idColumnRemoteId;
    const processedFiles: { path: string; content: string }[] = [];

    for (const record of records) {
      const content = formatJsonWithPrettier(record as Record<string, unknown>);
      const recordId = String(record[idColumnRemoteId]);

      // Resolve filename: slug > title > id
      const slugValue = tableSpec.slugColumnRemoteId
        ? (_.get(record, tableSpec.slugColumnRemoteId) as string | undefined)
        : undefined;
      const titleValue = tableSpec.titleColumnRemoteId
        ? (_.get(record, tableSpec.titleColumnRemoteId[0]) as string | undefined)
        : undefined;

      const baseName = resolveBaseFileName({ slugValue, titleValue, idValue: recordId });
      const fileName = deduplicateFileName(baseName, '.json', usedFileNames, recordId);
      const fullPath = `${prefix}/${fileName}`;

      processedFiles.push({ path: fullPath, content });
    }

    return processedFiles;
  }

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

    const dataFolder = await this.prisma.dataFolder.findUnique({
      where: { id: data.dataFolderId },
      include: {
        connectorAccount: true,
      },
    });

    if (!dataFolder) {
      throw new Error(`DataFolder with id ${data.dataFolderId} not found`);
    }

    if (!dataFolder.connectorAccountId) {
      throw new Error(`DataFolder ${data.dataFolderId} does not have an associated connector account`);
    }

    if (!dataFolder.connectorService) {
      throw new Error(`DataFolder ${data.dataFolderId} does not have a connector service`);
    }

    const tableSpec = dataFolder.schema as BaseJsonTableSpec;

    const pullOptions: ConnectorPullOptions = (dataFolder.options as ConnectorPullOptions) ?? {};

    const publicProgress: PullLinkedFolderFilesPublicProgress = {
      totalFiles: 0,
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
    const callback = async (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => {
      const { files, connectorProgress } = params;

      WSLogger.debug({
        source: 'PullLinkedFolderFilesJob',
        message: 'Received files from connector',
        workbookId: dataFolder.workbookId,
        dataFolderId: dataFolder.id,
        fileCount: files.length,
        folderPath: dataFolder.path,
      });

      // TODO: Validate files against the table schema before publishing.
      // Build git file payloads from connector files
      const builtFiles = this.buildGitFilesFromConnectorFiles(dataFolder.path ?? '', files, tableSpec, usedFileNames);

      // Sync to Git (Commit to main + Rebase dirty)
      if (builtFiles.length > 0) {
        const batchGitFiles = builtFiles.map((f) => ({
          path: f.path.startsWith('/') ? f.path.slice(1) : f.path,
          content: f.content,
        }));

        // Accumulate for deletion tracking
        gitFiles = gitFiles.concat(batchGitFiles);

        await this.scratchGitService.commitFilesToBranch(
          dataFolder.workbookId as WorkbookId,
          'main',
          batchGitFiles,
          `Sync batch of ${builtFiles.length} files`,
        );

        await this.scratchGitService.rebaseDirty(dataFolder.workbookId as WorkbookId);

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
      const folderPath = dataFolder.name;
      try {
        const mainFiles = (await this.scratchGitService.listRepoFiles(
          dataFolder.workbookId as WorkbookId,
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
            dataFolder.workbookId as WorkbookId,
            MAIN_BRANCH,
            filesToDelete,
            `Remove ${filesToDelete.length} deleted files from ${folderPath}`,
          );

          await this.scratchGitService.rebaseDirty(dataFolder.workbookId as WorkbookId);
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
