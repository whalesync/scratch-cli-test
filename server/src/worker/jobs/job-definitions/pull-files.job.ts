import type { PrismaClient } from '@prisma/client';
import { type DataFolderId, type JobTrigger, JobType, Service, type WorkbookId } from '@spinner/shared-types';
import type { ConnectorsService } from '../../../remote-service/connectors/connectors.service';
import {
  type BaseJsonTableSpec,
  type ConnectorFile,
  readRecordIdAsString,
} from '../../../remote-service/connectors/types';
import type { JsonSafeObject } from '../../../utils/objects';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';
// Non type imports
import { AssetExtractorService } from 'src/asset/asset-extractor.service';
import { AssetIndexService } from 'src/asset/asset-index.service';
import type { PostHogService } from 'src/posthog/posthog.service';
import { FileIndexService } from 'src/publish-plan/file-index.service';
import { FileReferenceService } from 'src/publish-plan/file-reference.service';
import { recomputeRecordCountsForWorkbook } from 'src/record-count/record-count.service';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { exceptionForConnectorError } from 'src/remote-service/connectors/error';
import { MAIN_BRANCH, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { WSLogger } from '../../../logger';
import { WorkbookEventService } from '../../../workbook/workbook-event.service';
import { buildGitFilesFromConnectorFiles } from './connector-file-utils';

/** Maximum number of file paths to track in progress */
const MAX_PROGRESS_PATHS = 100;

export type PullFilesPublicProgress = {
  status: 'pending' | 'active' | 'completed' | 'failed';
  folderId: string;
  folderName: string;
  connector: string;
  totalRequested: number;
  createdPaths: string[];
  updatedPaths: string[];
};

export type PullFilesJobDefinition = JobDefinitionBuilder<
  typeof JobType.RefreshRecords,
  {
    workbookId: WorkbookId;
    dataFolderId: DataFolderId;
    userId: string;
    organizationId: string;
    filePaths: string[];
    trigger?: JobTrigger;
    progress?: JsonSafeObject;
    initialPublicProgress?: PullFilesPublicProgress;
  },
  PullFilesPublicProgress,
  Record<string, never>,
  void
>;

/**
 * This job pulls specific files by ID from their remote source.
 * It resolves file paths to record IDs via the FileIndex, then pulls
 * those records using the connector's pullRecordFilesByIds method.
 */
export class PullFilesJobHandler implements JobHandlerBuilder<PullFilesJobDefinition> {
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
    data: PullFilesJobDefinition['data'];
    progress: Progress<PullFilesJobDefinition['publicProgress'], PullFilesJobDefinition['initialJobProgress']>;
    abortSignal: AbortSignal;
    checkpoint: (
      progress: Omit<
        Progress<PullFilesJobDefinition['publicProgress'], PullFilesJobDefinition['initialJobProgress']>,
        'timestamp'
      >,
    ) => Promise<void>;
  }) {
    const { jobId, data, checkpoint } = params;

    const dataFolder = await this.prisma.dataFolder.findUnique({
      where: { id: data.dataFolderId },
      include: { connectorAccount: true },
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

    // Resolve the repo path for this connection (used for both reading schema and writing files)
    const repoId = await this.scratchGitService.resolveConnectionRepoPath(dataFolder.connectorAccountId);

    // Read schema from git
    let tableSpec: BaseJsonTableSpec | null = null;
    if (dataFolder.path) {
      try {
        tableSpec = await this.scratchGitService.readSchemaFromGit(repoId, dataFolder.path);
      } catch {
        // schema will remain null
      }
    }

    if (!tableSpec) {
      throw new Error(`Schema not found for DataFolder ${data.dataFolderId}`);
    }

    const publicProgress: PullFilesPublicProgress = {
      status: 'active',
      folderId: dataFolder.id,
      folderName: dataFolder.name,
      connector: dataFolder.connectorService,
      totalRequested: data.filePaths.length,
      createdPaths: [],
      updatedPaths: [],
    };

    this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
      type: 'job-started',
      data: {
        source: 'job',
        entityId: dataFolder.id,
        message: 'Pulling files from source',
        jobId,
      },
    });

    await checkpoint({
      publicProgress,
      jobProgress: {},
      connectorProgress: {},
    });

    WSLogger.debug({
      source: 'PullFilesJob',
      message: 'Pulling files for data folder',
      workbookId: dataFolder.workbookId,
      dataFolderId: dataFolder.id,
      filePathCount: data.filePaths.length,
    });

    // Resolve filePaths → recordIds via FileIndex, scoped to this folder's
    // connection so a folder name shared with another connection can't return
    // the wrong connection's record (DEV-10880).
    const lookups = data.filePaths.map((fp) => {
      const normalized = fp.startsWith('/') ? fp.slice(1) : fp;
      const lastSlash = normalized.lastIndexOf('/');
      return {
        folderPath: lastSlash === -1 ? '' : normalized.substring(0, lastSlash),
        filename: lastSlash === -1 ? normalized : normalized.substring(lastSlash + 1),
        connectorAccountId: dataFolder.connectorAccountId ?? null,
      };
    });

    const recordIdMap = await this.fileIndexService.getRecordIds(dataFolder.workbookId, lookups);
    const recordIds = [...new Set(recordIdMap.values())];

    if (recordIds.length === 0) {
      WSLogger.warn({
        source: 'PullFilesJob',
        message: 'No record IDs found for the given file paths — nothing to pull',
        workbookId: dataFolder.workbookId,
        dataFolderId: dataFolder.id,
        filePaths: data.filePaths,
      });

      publicProgress.status = 'completed';
      await checkpoint({ publicProgress, jobProgress: {}, connectorProgress: {} });

      await this.prisma.dataFolder.update({
        where: { id: dataFolder.id },
        data: { lock: null },
      });

      this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
        type: 'job-completed',
        data: { entityId: dataFolder.id, source: 'job', message: 'No files to pull', jobId },
      });

      return;
    }

    // Get connector
    const service = dataFolder.connectorService;

    let decryptedConnectorAccount: Awaited<ReturnType<typeof this.connectorAccountService.findOneByIdUnscoped>> | null =
      null;
    if (dataFolder.connectorAccountId) {
      decryptedConnectorAccount = await this.connectorAccountService.findOneByIdUnscoped(
        dataFolder.connectorAccountId,
        {
          userId: data.userId,
          organizationId: data.organizationId,
        },
      );
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

    // Seed the dedup conflict set with every filename already indexed for this
    // folder. Without this, a new record whose suggested filename matches an
    // existing record's prior filename can silently clobber it: the new record
    // claims the bare name (its existing twin isn't in the per-batch
    // existingFileNames lookup unless it happens to be in the same batch), and
    // both end up writing to the same path. See pull-linked-folder-files.job.ts
    // for the longer-term Phase-2-defer-naming alternative.
    const folderPathForIndex = dataFolder.path?.replace(/^\//, '') ?? '';
    const usedFileNames = new Set<string>(
      await this.fileIndexService.listFilenamesForFolder(dataFolder.workbookId, folderPathForIndex),
    );

    // Names minted during THIS run, so a record re-delivered by the connector
    // (e.g. Notion's 10k-continuation boundary minute) resolves to the file it
    // already got instead of an id-suffixed duplicate. Lives for the whole run,
    // alongside `usedFileNames`.
    const fileNamesAssignedByRecordIdInThisRun = new Map<string, string>();

    const callback = async (callbackParams: { files: ConnectorFile[] }) => {
      const { files } = callbackParams;

      WSLogger.debug({
        source: 'PullFilesJob',
        message: 'Received files from connector',
        workbookId: dataFolder.workbookId,
        dataFolderId: dataFolder.id,
        fileCount: files.length,
      });

      const batchRecordIds = files.map((f) => readRecordIdAsString(f, tableSpec.idPath) ?? '');
      const existingFileNames = await this.fileIndexService.getFilenamesByRecordIds(
        dataFolder.workbookId,
        dataFolder.path?.replace(/^\//, '') ?? '',
        batchRecordIds,
      );

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
        const batchGitFiles = builtFiles.map((f) => ({
          path: f.path.startsWith('/') ? f.path.slice(1) : f.path,
          content: f.content,
        }));

        const commitResult = await this.scratchGitService.commitFilesToBranch(
          repoId,
          'main',
          batchGitFiles,
          `Pull ${builtFiles.length} file(s)`,
        );

        // Update File Index & References (best effort)
        try {
          await this.fileIndexService.upsertBatch(
            builtFiles
              .map((f) => {
                const parts = f.path.split('/');
                const filename = parts.pop();
                const folderPath = parts.join('/').replace(/^\//, '');

                if (!f.recordId || filename === undefined) return null;

                return {
                  workbookId: dataFolder.workbookId,
                  folderPath,
                  filename,
                  recordId: f.recordId,
                  // Discriminator so a workspace-absolute pseudo-ref resolves to
                  // this connection even when another shares the folder name.
                  connectorAccountId: dataFolder.connectorAccountId ?? null,
                };
              })
              .filter((x): x is NonNullable<typeof x> => x !== null),
          );

          await this.fileReferenceService.updateRefsForFiles(
            dataFolder.workbookId,
            MAIN_BRANCH,
            builtFiles.map((f) => ({
              path: f.path.startsWith('/') ? f.path.slice(1) : f.path,
              content: f.parsedRecord,
            })),
            tableSpec.schema,
          );

          // Update Asset Index
          try {
            const assetEntries = builtFiles.flatMap((f) => {
              const normalizedPath = f.path.startsWith('/') ? f.path.slice(1) : f.path;
              const recordContent = f.parsedRecord as Record<string, unknown>;
              const recordRemoteId = readRecordIdAsString(recordContent, tableSpec.idPath) ?? undefined;
              return this.assetExtractorService.extractAssets(connector, {
                workbookId: dataFolder.workbookId,
                service: dataFolder.connectorService as Service,
                dataFolderId: dataFolder.id,
                recordFilePath: normalizedPath,
                recordRemoteId,
                recordContent,
                schema: tableSpec.schema as Record<string, unknown>,
              });
            });
            if (assetEntries.length > 0) {
              await this.assetIndexService.upsertBatch(assetEntries);
              WSLogger.info({
                source: 'PullFilesJob',
                message: 'Asset index updated: extracted assets from pulled files',
                service: dataFolder.connectorService,
                workbookId: dataFolder.workbookId,
                assetCount: assetEntries.length,
                recordCount: builtFiles.length,
              });
            }
          } catch (assetErr) {
            WSLogger.error({
              source: 'PullFilesJob',
              message: 'Failed to update asset index',
              workbookId: dataFolder.workbookId,
              error: assetErr,
            });
          }
        } catch (err) {
          WSLogger.error({
            source: 'PullFilesJob',
            message: 'Failed to update indices',
            workbookId: dataFolder.workbookId,
            error: err,
          });
        }

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

      this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
        type: 'folder-contents-changed',
        data: {
          entityId: dataFolder.id,
          source: 'job',
          message: 'Pulled files',
          jobId,
        },
      });

      await checkpoint({
        publicProgress,
        jobProgress: {},
        connectorProgress: {},
      });
    };

    try {
      await connector.pullRecordFilesByIds(tableSpec, recordIds, callback);

      // Rebase dirty once at the end of the job (not after every batch)
      await this.scratchGitService.rebaseDirty(repoId);

      publicProgress.status = 'completed';

      await checkpoint({
        publicProgress,
        jobProgress: {},
        connectorProgress: {},
      });

      await this.prisma.dataFolder.update({
        where: { id: dataFolder.id },
        data: { lock: null },
      });

      // Refresh this folder's denormalized record count from git (a single-record refresh
      // can create/delete a file). Scoped to this connection (one tree walk); emitEvent is
      // off because the folder-updated event emitted just below already prompts a refetch.
      // Non-fatal — a failure here must not fail the pull.
      try {
        await recomputeRecordCountsForWorkbook(
          { prisma: this.prisma, scratchGit: this.scratchGitService, events: this.workbookEventService },
          dataFolder.workbookId as WorkbookId,
          { connectorAccountId: dataFolder.connectorAccountId, emitEvent: false },
        );
      } catch (err) {
        WSLogger.warn({
          source: 'PullFilesJob',
          message: 'Failed to refresh record counts after single-file pull',
          workbookId: dataFolder.workbookId,
          error: err,
        });
      }

      WSLogger.debug({
        source: 'PullFilesJob',
        message: 'Pull completed for data folder',
        workbookId: dataFolder.workbookId,
        dataFolderId: dataFolder.id,
      });

      this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
        type: 'folder-updated',
        data: { entityId: dataFolder.id, source: 'job', message: 'Updated status of folder', jobId },
      });

      this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
        type: 'job-completed',
        data: { entityId: dataFolder.id, source: 'job', message: 'Pull completed for data folder', jobId },
      });

      try {
        this.postHogService.trackPullCompleted(data.userId, {
          workbookId: data.workbookId,
          trigger: data.trigger,
          result: 'success',
          totalFilesPulled: publicProgress.createdPaths.length + publicProgress.updatedPaths.length,
          filesCreated: publicProgress.createdPaths.length,
          filesUpdated: publicProgress.updatedPaths.length,
          filesDeleted: 0,
          foldersProcessed: 1,
        });
      } catch (err) {
        WSLogger.warn({
          source: 'PullFilesJob',
          message: 'Failed to track pull completed event',
          error: err,
        });
      }
    } catch (error) {
      publicProgress.status = 'failed';

      await checkpoint({
        publicProgress,
        jobProgress: {},
        connectorProgress: {},
      });

      await this.prisma.dataFolder.update({
        where: { id: dataFolder.id },
        data: { lock: null },
      });

      WSLogger.error({
        source: 'PullFilesJob',
        message: 'Failed to pull files for data folder',
        workbookId: dataFolder.workbookId,
        dataFolderId: dataFolder.id,
        errorDetails: connector.extractConnectorErrorDetails(error),
      });

      this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
        type: 'folder-updated',
        data: { entityId: dataFolder.id, source: 'job', message: 'Updated status of folder', jobId },
      });

      this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
        type: 'job-failed',
        data: { entityId: dataFolder.id, source: 'job', message: 'Pull failed for data folder', jobId },
      });

      try {
        this.postHogService.trackPullCompleted(data.userId, {
          workbookId: data.workbookId,
          trigger: data.trigger,
          result: 'failure',
          totalFilesPulled: 0,
          filesCreated: 0,
          filesUpdated: 0,
          filesDeleted: 0,
          foldersProcessed: 1,
        });
      } catch {
        // PostHog tracking should never break the error flow
      }

      throw exceptionForConnectorError(error, connector);
    }
  }
}
