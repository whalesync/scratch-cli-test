import type { PrismaClient } from '@prisma/client';
import { Service, type DataFolderId, type WorkbookId } from '@spinner/shared-types';
import type { ConnectorsService } from '../../../remote-service/connectors/connectors.service';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';
import { createRunContext } from '../base-types';
// Non type imports
import { RunId } from '@spinner/shared-types';
import type { PostHogService } from 'src/posthog/posthog.service';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { exceptionForConnectorError } from 'src/remote-service/connectors/error';
import { BaseJsonTableSpec } from 'src/remote-service/connectors/types';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { WSLogger } from '../../../logger';
import { DataFolderPublishingService } from '../../../workbook/data-folder-publishing.service';
import { WorkbookEventService } from '../../../workbook/workbook-event.service';

export type FolderPublishStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** Maximum number of file paths to track per category in progress */
const MAX_PROGRESS_PATHS = 1000;

export type FolderPublishProgress = {
  id: string;
  name: string;
  connector: string;
  creates: number;
  updates: number;
  deletes: number;
  expectedCreates: number;
  expectedUpdates: number;
  expectedDeletes: number;
  createdPaths: string[];
  updatedPaths: string[];
  deletedPaths: string[];
  status: FolderPublishStatus;
};

export type PublishDataFolderPublicProgress = {
  totalFilesPublished: number;
  folders: FolderPublishProgress[];
};

export type PublishDataFolderJobDefinition = JobDefinitionBuilder<
  'publish-data-folder',
  {
    workbookId: WorkbookId;
    dataFolderIds: DataFolderId[];
    userId: string;
    organizationId: string;
    trigger?: 'web' | 'scheduler' | 'cli' | 'job';
    initialPublicProgress?: PublishDataFolderPublicProgress;
  },
  PublishDataFolderPublicProgress,
  { folderIndex: number },
  void
>;

/**
 * This job publishes files from one or more DataFolders to external services.
 * It processes folders sequentially and tracks progress for all folders.
 */
export class PublishDataFolderJobHandler implements JobHandlerBuilder<PublishDataFolderJobDefinition> {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly connectorService: ConnectorsService,
    private readonly connectorAccountService: ConnectorAccountService,
    private readonly workbookEventService: WorkbookEventService,
    private readonly dataFolderPublishingService: DataFolderPublishingService,
    private readonly bullEnqueuerService: BullEnqueuerService,
    private readonly scratchGitService: ScratchGitService,
    private readonly postHogService: PostHogService,
  ) {}

  async run(params: {
    jobId: string;
    runId?: string;
    data: PublishDataFolderJobDefinition['data'];
    progress: Progress<
      PublishDataFolderJobDefinition['publicProgress'],
      PublishDataFolderJobDefinition['initialJobProgress']
    >;
    abortSignal: AbortSignal;
    checkpoint: (
      progress: Omit<
        Progress<
          PublishDataFolderJobDefinition['publicProgress'],
          PublishDataFolderJobDefinition['initialJobProgress']
        >,
        'timestamp'
      >,
    ) => Promise<void>;
  }) {
    const { jobId, runId, data, checkpoint, progress } = params;

    // Fetch all DataFolders with their connector accounts
    const dataFolders = await this.prisma.dataFolder.findMany({
      where: { id: { in: data.dataFolderIds } },
      include: {
        connectorAccount: true,
      },
    });

    if (dataFolders.length === 0) {
      throw new Error(`No DataFolders found with the provided IDs`);
    }

    // Verify workbook exists
    const workbook = await this.prisma.workbook.findUnique({
      where: { id: data.workbookId },
    });

    if (!workbook) {
      throw new Error(`Workbook with id ${data.workbookId} not found`);
    }

    // Create a map for quick lookup of initial progress
    const initialProgressMap = new Map(data.initialPublicProgress?.folders.map((f) => [f.id, f]) || []);

    // Build folders progress array
    const foldersProgress: FolderPublishProgress[] = dataFolders.map((dataFolder) => {
      const initialFolderProgress = initialProgressMap.get(dataFolder.id);

      return {
        id: dataFolder.id,
        name: dataFolder.name,
        connector: dataFolder.connectorService ?? '',
        creates: 0,
        updates: 0,
        deletes: 0,
        expectedCreates: initialFolderProgress?.expectedCreates ?? 0,
        expectedUpdates: initialFolderProgress?.expectedUpdates ?? 0,
        expectedDeletes: initialFolderProgress?.expectedDeletes ?? 0,
        createdPaths: [] as string[],
        updatedPaths: [] as string[],
        deletedPaths: [] as string[],
        status: 'pending' as FolderPublishStatus,
      };
    });

    let totalFilesPublished = 0;

    // Determine starting index from progress (for resumability)
    const startIndex = progress?.jobProgress?.folderIndex ?? 0;

    // Checkpoint initial status
    await checkpoint({
      publicProgress: {
        totalFilesPublished,
        folders: foldersProgress,
      },
      jobProgress: { folderIndex: startIndex },
      connectorProgress: {},
    });

    this.workbookEventService.sendWorkbookEvent(data.workbookId, {
      type: 'job-started',
      data: {
        source: 'job',
        entityId: jobId,
        message: 'Publish data folder job started',
      },
    });

    WSLogger.debug({
      source: 'PublishDataFolderJob',
      message: 'Starting publish job for data folders',
      workbookId: data.workbookId,
      folderCount: dataFolders.length,
      startIndex,
    });

    // Process each data folder sequentially
    for (let i = startIndex; i < dataFolders.length; i++) {
      const dataFolder = dataFolders[i];
      const currentFolder = foldersProgress[i];

      if (!dataFolder.connectorAccountId) {
        WSLogger.warn({
          source: 'PublishDataFolderJob',
          message: 'Skipping folder - no connector account',
          dataFolderId: dataFolder.id,
        });
        currentFolder.status = 'failed';
        continue;
      }

      if (!dataFolder.connectorService) {
        WSLogger.warn({
          source: 'PublishDataFolderJob',
          message: 'Skipping folder - no connector service',
          dataFolderId: dataFolder.id,
        });
        currentFolder.status = 'failed';
        continue;
      }

      // Read schema from git
      let tableSpec: BaseJsonTableSpec | null = null;
      if (dataFolder.path && dataFolder.connectorAccountId) {
        try {
          const schemaRepoId = await this.scratchGitService.resolveRepoId(
            data.workbookId,
            dataFolder.connectorAccountId,
          );
          tableSpec = await this.scratchGitService.readSchemaFromGit(schemaRepoId, dataFolder.path);
        } catch {
          // schema will remain null
        }
      }

      if (!tableSpec) {
        WSLogger.warn({
          source: 'PublishDataFolderJob',
          message: 'Skipping folder - schema not found in git',
          dataFolderId: dataFolder.id,
        });
        currentFolder.status = 'failed';
        continue;
      }

      // Mark folder as in_progress
      currentFolder.status = 'in_progress';

      // Checkpoint status for this folder
      await checkpoint({
        publicProgress: {
          totalFilesPublished,
          folders: foldersProgress,
        },
        jobProgress: { folderIndex: i },
        connectorProgress: {},
      });

      // Enqueue pull job to sync from Webflow and update main branch
      // This ensures future deletes can be detected (they need to exist in main)
      await this.bullEnqueuerService.enqueuePullLinkedFolderFilesJob(
        data.workbookId,
        { userId: data.userId, organizationId: data.organizationId },
        [dataFolder.id as DataFolderId],
        undefined,
        createRunContext('job', { runId: runId as RunId, parentJobId: jobId }),
      );

      WSLogger.debug({
        source: 'PublishDataFolderJob',
        message: 'Enqueued pull job to sync main branch after publish',
        workbookId: data.workbookId,
        dataFolderId: dataFolder.id,
        folderIndex: i,
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

      try {
        const folderPath = (dataFolder.path ?? dataFolder.name).replace(/^\//, '');

        // Resolve the correct repo ID (V1: plain workbookId, V2: composite ID per connection)
        const repoId = await this.scratchGitService.resolveRepoId(
          data.workbookId,
          dataFolder.connectorAccountId ?? undefined,
        );

        WSLogger.debug({
          source: 'PublishDataFolderJob',
          message: 'Publishing data folder using scratch-git',
          workbookId: data.workbookId,
          repoId,
          dataFolderId: dataFolder.id,
          folderPath,
        });

        // Use the DataFolderPublishingService which reads from scratch-git
        const publishResult = await this.dataFolderPublishingService.publishAll(
          repoId,
          folderPath,
          connector,
          tableSpec,
          async (phase: 'creates' | 'updates' | 'deletes', count: number) => {
            if (phase === 'creates') {
              currentFolder.creates += count;
            } else if (phase === 'updates') {
              currentFolder.updates += count;
            } else if (phase === 'deletes') {
              currentFolder.deletes += count;
            }
            totalFilesPublished += count;

            this.workbookEventService.sendWorkbookEvent(data.workbookId, {
              type: 'workbook-updated',
              data: {
                entityId: dataFolder.id,
                source: 'user',
                message: `Updating publishing counts for ${phase}`,
              },
            });

            await checkpoint({
              publicProgress: {
                totalFilesPublished,
                folders: foldersProgress,
              },
              jobProgress: { folderIndex: i },
              connectorProgress: {},
            });
          },
        );

        // Populate file paths from publish result
        currentFolder.createdPaths = publishResult.createdPaths.slice(0, MAX_PROGRESS_PATHS);
        currentFolder.updatedPaths = publishResult.updatedPaths.slice(0, MAX_PROGRESS_PATHS);
        currentFolder.deletedPaths = publishResult.deletedPaths.slice(0, MAX_PROGRESS_PATHS);

        // Mark folder as completed
        currentFolder.status = 'completed';

        WSLogger.info({
          source: 'PublishDataFolderJob',
          message: 'Folder publish completed',
          workbookId: data.workbookId,
          dataFolderId: dataFolder.id,
          creates: currentFolder.creates,
          updates: currentFolder.updates,
          deletes: currentFolder.deletes,
        });

        // Enqueue pull job to sync from remote and update main branch
        await this.bullEnqueuerService.enqueuePullLinkedFolderFilesJob(
          data.workbookId,
          { userId: data.userId, organizationId: data.organizationId },
          [dataFolder.id as DataFolderId],
          undefined,
          createRunContext('job', { runId: runId as RunId, parentJobId: jobId }),
        );

        WSLogger.debug({
          source: 'PublishDataFolderJob',
          message: 'Enqueued download job to sync main branch after publish',
          workbookId: data.workbookId,
          dataFolderId: dataFolder.id,
        });

        // Update folder in database
        await this.prisma.dataFolder.update({
          where: { id: dataFolder.id },
          data: {
            lock: null,
            lastSyncTime: new Date(),
          },
        });

        this.workbookEventService.sendWorkbookEvent(data.workbookId, {
          type: 'workbook-updated',
          data: {
            source: 'user',
            entityId: dataFolder.id,
            message: 'Folder publish completed',
          },
        });
      } catch (error) {
        // Mark folder as failed but continue with other folders
        currentFolder.status = 'failed';

        // Clear lock on failure
        await this.prisma.dataFolder.update({
          where: { id: dataFolder.id },
          data: { lock: null },
        });

        this.workbookEventService.sendWorkbookEvent(data.workbookId, {
          type: 'job-failed',
          data: {
            source: 'user',
            entityId: dataFolder.id,
            message: 'Folder publish failed',
          },
        });

        WSLogger.error({
          source: 'PublishDataFolderJob',
          message: 'Failed to publish files for folder',
          workbookId: data.workbookId,
          dataFolderId: dataFolder.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        // Re-throw if this is the only folder, otherwise continue
        if (dataFolders.length === 1) {
          throw exceptionForConnectorError(error, connector);
        }
      }

      // Checkpoint after each folder completes
      await checkpoint({
        publicProgress: {
          totalFilesPublished,
          folders: foldersProgress,
        },
        jobProgress: { folderIndex: i + 1 },
        connectorProgress: {},
      });
    }

    WSLogger.debug({
      source: 'PublishDataFolderJob',
      message: 'Publish job completed for all folders',
      workbookId: data.workbookId,
      totalFilesPublished,
      folderCount: dataFolders.length,
    });

    try {
      const totalCreates = foldersProgress.reduce((sum, f) => sum + f.creates, 0);
      const totalUpdates = foldersProgress.reduce((sum, f) => sum + f.updates, 0);
      const totalDeletes = foldersProgress.reduce((sum, f) => sum + f.deletes, 0);
      const anyFailed = foldersProgress.some((f) => f.status === 'failed');

      this.postHogService.trackPublishCompleted(data.userId, {
        workbookId: data.workbookId,
        trigger: data.trigger,
        result: anyFailed ? 'failure' : 'success',
        totalRecordsPushed: totalCreates + totalUpdates + totalDeletes,
        creates: totalCreates,
        edits: totalUpdates,
        deletes: totalDeletes,
      });
    } catch (err) {
      WSLogger.warn({
        source: 'PublishDataFolderJob',
        message: 'Failed to track publish completed event',
        error: err,
      });
    }
  }
}
