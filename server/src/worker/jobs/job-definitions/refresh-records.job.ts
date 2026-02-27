import type { PrismaClient } from '@prisma/client';
import { type DataFolderId, Service, type WorkbookId } from '@spinner/shared-types';
import type { ConnectorsService } from '../../../remote-service/connectors/connectors.service';
import type { BaseJsonTableSpec, ConnectorFile } from '../../../remote-service/connectors/types';
import type { JsonSafeObject } from '../../../utils/objects';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';
// Non type imports
import { FileIndexService } from 'src/publish-plan/file-index.service';
import { FileReferenceService } from 'src/publish-plan/file-reference.service';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { exceptionForConnectorError } from 'src/remote-service/connectors/error';
import { MAIN_BRANCH, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { WSLogger } from '../../../logger';
import { WorkbookEventService } from '../../../workbook/workbook-event.service';
import { buildGitFilesFromConnectorFiles } from './connector-file-utils';

/** Maximum number of file paths to track in progress */
const MAX_PROGRESS_PATHS = 1000;

export type RefreshRecordsPublicProgress = {
  status: 'pending' | 'active' | 'completed' | 'failed';
  folderId: string;
  folderName: string;
  connector: string;
  totalRequested: number;
  updatedPaths: string[];
};

export type RefreshRecordsJobDefinition = JobDefinitionBuilder<
  'refresh-records',
  {
    workbookId: WorkbookId;
    dataFolderId: DataFolderId;
    userId: string;
    organizationId: string;
    filePaths: string[];
    progress?: JsonSafeObject;
    initialPublicProgress?: RefreshRecordsPublicProgress;
  },
  RefreshRecordsPublicProgress,
  Record<string, never>,
  void
>;

/**
 * This job refreshes specific records by ID from their remote source.
 * It resolves file paths to record IDs via the FileIndex, then pulls
 * those records using the connector's pullRecordFilesByIds method.
 */
export class RefreshRecordsJobHandler implements JobHandlerBuilder<RefreshRecordsJobDefinition> {
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
    data: RefreshRecordsJobDefinition['data'];
    progress: Progress<
      RefreshRecordsJobDefinition['publicProgress'],
      RefreshRecordsJobDefinition['initialJobProgress']
    >;
    abortSignal: AbortSignal;
    checkpoint: (
      progress: Omit<
        Progress<RefreshRecordsJobDefinition['publicProgress'], RefreshRecordsJobDefinition['initialJobProgress']>,
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

    const tableSpec = dataFolder.schema as BaseJsonTableSpec;

    const publicProgress: RefreshRecordsPublicProgress = {
      status: 'active',
      folderId: dataFolder.id,
      folderName: dataFolder.name,
      connector: dataFolder.connectorService,
      totalRequested: data.filePaths.length,
      updatedPaths: [],
    };

    this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
      type: 'job-started',
      data: {
        source: 'job',
        entityId: dataFolder.id,
        message: 'Refreshing records from source',
        jobId,
      },
    });

    await checkpoint({
      publicProgress,
      jobProgress: {},
      connectorProgress: {},
    });

    WSLogger.debug({
      source: 'RefreshRecordsJob',
      message: 'Refreshing records for data folder',
      workbookId: dataFolder.workbookId,
      dataFolderId: dataFolder.id,
      filePathCount: data.filePaths.length,
    });

    // Resolve filePaths → recordIds via FileIndex
    const lookups = data.filePaths.map((fp) => {
      const normalized = fp.startsWith('/') ? fp.slice(1) : fp;
      const lastSlash = normalized.lastIndexOf('/');
      return {
        folderPath: lastSlash === -1 ? '' : normalized.substring(0, lastSlash),
        filename: lastSlash === -1 ? normalized : normalized.substring(lastSlash + 1),
      };
    });

    const recordIdMap = await this.fileIndexService.getRecordIds(dataFolder.workbookId, lookups);
    const recordIds = [...new Set(recordIdMap.values())];

    if (recordIds.length === 0) {
      WSLogger.warn({
        source: 'RefreshRecordsJob',
        message: 'No record IDs found for the given file paths',
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
        data: { entityId: dataFolder.id, source: 'job', message: 'No records to refresh', jobId },
      });

      return;
    }

    // Get connector
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

    const usedFileNames = new Set<string>();

    const callback = async (callbackParams: { files: ConnectorFile[] }) => {
      const { files } = callbackParams;

      WSLogger.debug({
        source: 'RefreshRecordsJob',
        message: 'Received files from connector',
        workbookId: dataFolder.workbookId,
        dataFolderId: dataFolder.id,
        fileCount: files.length,
      });

      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const batchRecordIds = files.map((f) => String((f as Record<string, unknown>)[tableSpec.idColumnRemoteId] || ''));
      const existingFileNames = await this.fileIndexService.getFilenamesByRecordIds(
        dataFolder.workbookId,
        dataFolder.path?.replace(/^\//, '') ?? '',
        batchRecordIds,
      );

      const builtFiles = buildGitFilesFromConnectorFiles(
        dataFolder.path ?? '',
        files,
        tableSpec,
        usedFileNames,
        existingFileNames,
      );

      if (builtFiles.length > 0) {
        const batchGitFiles = builtFiles.map((f) => ({
          path: f.path.startsWith('/') ? f.path.slice(1) : f.path,
          content: f.content,
        }));

        await this.scratchGitService.commitFilesToBranch(
          dataFolder.workbookId as WorkbookId,
          'main',
          batchGitFiles,
          `Refresh ${builtFiles.length} record(s)`,
        );

        await this.scratchGitService.rebaseDirty(dataFolder.workbookId as WorkbookId);

        // Update File Index & References (best effort)
        try {
          await this.fileIndexService.upsertBatch(
            builtFiles
              .map((f) => {
                const content = JSON.parse(f.content) as Record<string, unknown>;
                // eslint-disable-next-line @typescript-eslint/no-base-to-string
                const recordId = String(content[tableSpec.idColumnRemoteId] || '');

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

          await this.fileReferenceService.updateRefsForFiles(
            dataFolder.workbookId,
            MAIN_BRANCH,
            builtFiles.map((f) => ({
              path: f.path.startsWith('/') ? f.path.slice(1) : f.path,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              content: JSON.parse(f.content),
            })),
            tableSpec.schema,
          );
        } catch (err) {
          WSLogger.error({
            source: 'RefreshRecordsJob',
            message: 'Failed to update indices',
            workbookId: dataFolder.workbookId,
            error: err,
          });
        }
      }

      for (const file of builtFiles) {
        const normalizedPath = file.path.startsWith('/') ? file.path.slice(1) : file.path;
        if (publicProgress.updatedPaths.length < MAX_PROGRESS_PATHS) {
          publicProgress.updatedPaths.push(normalizedPath);
        }
      }

      this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
        type: 'folder-contents-changed',
        data: {
          entityId: dataFolder.id,
          source: 'job',
          message: 'Refreshed records',
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

      WSLogger.debug({
        source: 'RefreshRecordsJob',
        message: 'Refresh completed for data folder',
        workbookId: dataFolder.workbookId,
        dataFolderId: dataFolder.id,
      });

      this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
        type: 'folder-updated',
        data: { entityId: dataFolder.id, source: 'job', message: 'Updated status of folder', jobId },
      });

      this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
        type: 'job-completed',
        data: { entityId: dataFolder.id, source: 'job', message: 'Refresh completed for data folder', jobId },
      });
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
        source: 'RefreshRecordsJob',
        message: 'Failed to refresh records for data folder',
        workbookId: dataFolder.workbookId,
        dataFolderId: dataFolder.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
        type: 'folder-updated',
        data: { entityId: dataFolder.id, source: 'job', message: 'Updated status of folder', jobId },
      });

      this.workbookEventService.sendWorkbookEvent(dataFolder.workbookId as WorkbookId, {
        type: 'job-failed',
        data: { entityId: dataFolder.id, source: 'job', message: 'Refresh failed for data folder', jobId },
      });

      throw exceptionForConnectorError(error, connector);
    }
  }
}
