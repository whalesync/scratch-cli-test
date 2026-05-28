import type { PrismaClient } from '@prisma/client';
import type { DataFolderId, SyncId, WorkbookId } from '@spinner/shared-types';
import { JobType, RunId, TransformerTypes } from '@spinner/shared-types';
import { UserCluster } from 'src/db/cluster-types';
import type { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import type { PostHogService } from 'src/posthog/posthog.service';
import { PublishPlanBuildService } from 'src/publish-plan/publish-plan-build.service';
import { WorkbookEventService } from 'src/workbook/workbook-event.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { WSLogger } from '../../../logger';
import { ScratchGitService } from '../../../scratch-git/scratch-git.service';
import { SyncService } from '../../../sync/sync.service';
import { findTransformerConfigs } from '../../../sync/transformers';
import { Actor, userToActor } from '../../../users/types';
import type { JsonSafeObject } from '../../../utils/objects';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';
import { createRunContext } from '../base-types';

/** Maximum number of file paths to track per category in progress */
const MAX_PROGRESS_PATHS = 100;

/** Maximum number of errors to track per category in progress */
const MAX_PROGRESS_ERRORS = 100;

/** Maximum number of warnings to track per category in progress */
const MAX_PROGRESS_WARNINGS = 100;

export type SyncDataFoldersPublicProgress = {
  totalFilesSynced: number;
  tables: {
    id: string;
    name: string;
    connector: string;
    creates: number;
    updates: number;
    deletes: number;
    skipped: number;
    createdPaths: string[];
    updatedPaths: string[];
    deletedPaths: string[];
    errorCount: number;
    errors: Array<{ sourceRemoteId: string; error: string }>;
    warningCount: number;
    warnings: Array<{ sourceRemoteId: string; warning: string }>;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
  }[];
};

export type SyncDataFoldersJobDefinition = JobDefinitionBuilder<
  typeof JobType.SyncDataFolders,
  {
    workbookId: WorkbookId;
    syncId: SyncId;
    organizationId: string;
    userId: string;
    trigger?: 'web' | 'scheduler' | 'cli' | 'job';
    progress?: JsonSafeObject;
    initialPublicProgress?: SyncDataFoldersPublicProgress;
  },
  SyncDataFoldersPublicProgress,
  Record<string, never>, // jobProgress - empty for now
  void
>;

export class SyncDataFoldersJobHandler implements JobHandlerBuilder<SyncDataFoldersJobDefinition> {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly syncService: SyncService,
    private readonly workbookEventService: WorkbookEventService,
    private readonly scratchGitService: ScratchGitService,
    private readonly bullEnqueuerService: BullEnqueuerService,
    private readonly publishPlanBuildService: PublishPlanBuildService,
    private readonly postHogService: PostHogService,
    private readonly metricsService: CustomMetricsService,
  ) {}

  async run(params: {
    jobId: string;
    runId?: string;
    data: SyncDataFoldersJobDefinition['data'];
    progress: Progress<
      SyncDataFoldersJobDefinition['publicProgress'],
      SyncDataFoldersJobDefinition['initialJobProgress']
    >;
    abortSignal: AbortSignal;
    checkpoint: (
      progress: Omit<
        Progress<SyncDataFoldersJobDefinition['publicProgress'], SyncDataFoldersJobDefinition['initialJobProgress']>,
        'timestamp'
      >,
    ) => Promise<void>;
  }) {
    const { jobId, runId, data, checkpoint } = params;

    WSLogger.info({
      source: 'SyncDataFoldersJob',
      message: 'Starting sync data folders job',
      syncId: data.syncId,
      workbookId: data.workbookId,
      userId: data.userId,
    });

    this.workbookEventService.sendWorkbookEvent(data.workbookId, {
      type: 'job-started',
      data: {
        source: 'job',
        entityId: data.syncId,
        message: 'Syncing data folders',
        jobId: params.jobId,
      },
    });

    // Load the Sync record through the SyncService choke point so the v1/v2
    // shape is parsed correctly.
    const sync = await this.syncService.getSyncForExecution(data.syncId);

    if (!sync) {
      throw new Error(`Sync with id ${data.syncId} not found`);
    }

    // TODO(DEV-10008): when the executor adopts v2, replace this narrow
    // with `transformV1ToV2(sync.mappings)` at the executor entry.
    if (sync.mappings.version !== 1) {
      throw new Error(`Sync ${data.syncId}: executor does not yet support v2 mappings.`);
    }
    const tableMappings = sync.mappings.tableMappings;

    WSLogger.info({
      source: 'SyncDataFoldersJob',
      message: 'Loaded sync mapping',
      syncId: data.syncId,
      tableMappingCount: tableMappings.length,
    });

    // Reload the user to populate workspacePermissions on the actor — the queue
    // payload only carries userId/organizationId, but downstream calls into
    // dataFolderService.findOne hit assertReadableWorkbook, which requires the
    // permissions list.
    const user = await this.prisma.user.findUnique({
      where: { id: data.userId },
      include: UserCluster._validator.include,
    });
    if (!user) {
      throw new Error(`User ${data.userId} not found`);
    }
    const actor: Actor = userToActor(user);

    // Build mapping of data tables
    const dataTables = new Map(
      sync.syncTablePairs
        .flatMap((pair) => [pair.sourceDataFolder, pair.destinationDataFolder])
        .map((dt) => [dt.id as DataFolderId, dt]),
    );

    // Initialize progress tracking
    type TableProgress = SyncDataFoldersPublicProgress['tables'][number];
    const tablesProgress: TableProgress[] = tableMappings.map((tm, index) => {
      const dt = dataTables.get(tm.sourceDataFolderId);
      return {
        id: tm.sourceDataFolderId,
        name: dt?.name ?? `Unknown data source: ${index}`,
        connector: dt?.connectorService ?? '',
        creates: 0,
        updates: 0,
        deletes: 0,
        skipped: 0,
        createdPaths: [] as string[],
        updatedPaths: [] as string[],
        deletedPaths: [] as string[],
        errorCount: 0,
        errors: [] as Array<{ sourceRemoteId: string; error: string }>,
        warningCount: 0,
        warnings: [] as Array<{ sourceRemoteId: string; warning: string }>,
        status: 'pending' as const,
      };
    });

    let totalFilesSynced = 0;

    // Track unique source records that hit errors, per table
    const erroredRecordIds: Set<string>[] = tableMappings.map(() => new Set<string>());

    // Process each table mapping
    for (let i = 0; i < tableMappings.length; i++) {
      const tableMapping = tableMappings[i];
      const tableProgress = tablesProgress[i];

      WSLogger.info({
        source: 'SyncDataFoldersJob',
        message: 'Starting sync for table mapping',
        syncId: data.syncId,
        tableIndex: i,
        sourceDataFolderId: tableMapping.sourceDataFolderId,
        destinationDataFolderId: tableMapping.destinationDataFolderId,
        columnMappingCount: tableMapping.columnMappings.length,
      });

      // Mark table as in_progress
      tableProgress.status = 'in_progress';
      await checkpoint({
        publicProgress: { totalFilesSynced, tables: tablesProgress },
        jobProgress: {},
        connectorProgress: {},
      });

      try {
        // Run the sync for this table mapping
        const result = await this.syncService.syncTableMapping(data.syncId, tableMapping, data.workbookId, actor);

        WSLogger.info({
          source: 'SyncDataFoldersJob',
          message: 'Completed sync for table mapping',
          syncId: data.syncId,
          tableIndex: i,
          recordsCreated: result.recordsCreated,
          recordsUpdated: result.recordsUpdated,
          errorCount: result.errors.length,
        });

        // Update progress with results
        tableProgress.creates = result.recordsCreated;
        tableProgress.updates = result.recordsUpdated;
        tableProgress.skipped = result.recordsSkipped;
        tableProgress.createdPaths = result.createdPaths.slice(0, MAX_PROGRESS_PATHS);
        tableProgress.updatedPaths = result.updatedPaths.slice(0, MAX_PROGRESS_PATHS);
        for (const e of result.errors) erroredRecordIds[i].add(e.sourceRemoteId);
        tableProgress.errorCount = erroredRecordIds[i].size;
        tableProgress.errors = result.errors.slice(0, MAX_PROGRESS_ERRORS);
        tableProgress.status = result.errors.length > 0 ? 'failed' : 'completed';
        totalFilesSynced += result.recordsCreated + result.recordsUpdated;

        // Store warnings in dedicated warnings array
        if (result.warnings.length > 0) {
          tableProgress.warnings = [...tableProgress.warnings, ...result.warnings].slice(0, MAX_PROGRESS_WARNINGS);
          tableProgress.warningCount = tableProgress.warnings.length;
        }

        // Log any errors
        if (result.errors.length > 0) {
          WSLogger.warn({
            source: 'SyncDataFoldersJob',
            message: 'Sync completed with errors',
            syncId: data.syncId,
            tableIndex: i,
            errors: result.errors,
          });
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        WSLogger.error({
          source: 'SyncDataFoldersJob',
          message: 'Failed to sync table mapping',
          syncId: data.syncId,
          sourceDataFolderId: tableMapping.sourceDataFolderId,
          destinationDataFolderId: tableMapping.destinationDataFolderId,
          error: errorMessage,
        });

        tableProgress.errors = [{ sourceRemoteId: '', error: errorMessage }];
        tableProgress.status = 'failed';
      }

      // Checkpoint after each table
      await checkpoint({
        publicProgress: { totalFilesSynced, tables: tablesProgress },
        jobProgress: {},
        connectorProgress: {},
      });
    }

    // Phase 2: Resolve FK references by re-running table mappings with FOREIGN_KEY_MAPPING phase
    for (let i = 0; i < tableMappings.length; i++) {
      const tableMapping = tableMappings[i];
      const hasFkOrAssetColumns = tableMapping.columnMappings.some(
        (m) =>
          findTransformerConfigs(m, TransformerTypes.SourceFkToDestFk).length > 0 ||
          findTransformerConfigs(m, TransformerTypes.SourceAssetToDestAsset).length > 0,
      );
      if (hasFkOrAssetColumns) {
        try {
          const fkResult = await this.syncService.syncTableMapping(
            data.syncId,
            tableMapping,
            data.workbookId,
            actor,
            'FOREIGN_KEY_MAPPING',
          );

          WSLogger.info({
            source: 'SyncDataFoldersJob',
            message: 'Completed FK resolution for table mapping',
            syncId: data.syncId,
            tableIndex: i,
            recordsUpdated: fkResult.recordsUpdated,
            errorCount: fkResult.errors.length,
          });

          // Store FK resolution warnings in dedicated warnings array
          if (fkResult.warnings.length > 0) {
            tablesProgress[i].warnings = [...tablesProgress[i].warnings, ...fkResult.warnings].slice(
              0,
              MAX_PROGRESS_WARNINGS,
            );
            tablesProgress[i].warningCount = tablesProgress[i].warnings.length;
          }

          if (fkResult.errors.length > 0) {
            WSLogger.warn({
              source: 'SyncDataFoldersJob',
              message: 'FK resolution completed with errors',
              syncId: data.syncId,
              tableIndex: i,
              errors: fkResult.errors,
            });
            for (const e of fkResult.errors) erroredRecordIds[i].add(e.sourceRemoteId);
            tablesProgress[i].errorCount = erroredRecordIds[i].size;
            tablesProgress[i].errors = [...tablesProgress[i].errors, ...fkResult.errors].slice(0, MAX_PROGRESS_ERRORS);
            tablesProgress[i].status = 'failed';
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          WSLogger.error({
            source: 'SyncDataFoldersJob',
            message: 'Failed to resolve foreign keys for table mapping',
            syncId: data.syncId,
            tableIndex: i,
            error: errorMessage,
          });
          tablesProgress[i].errors = [
            ...tablesProgress[i].errors,
            { sourceRemoteId: '', error: `Foreign key resolution failed: ${errorMessage}` },
          ].slice(0, MAX_PROGRESS_ERRORS);
          tablesProgress[i].status = 'failed';
        }
      }
    }

    // Checkpoint after Phase 2
    await checkpoint({
      publicProgress: { totalFilesSynced, tables: tablesProgress },
      jobProgress: {},
      connectorProgress: {},
    });

    // Check if any tables failed
    const failedTables = tablesProgress.filter((t) => t.status === 'failed');
    const allTablesSucceeded = failedTables.length === 0;

    if (allTablesSucceeded) {
      // Update lastSyncTime on the Sync record
      await this.prisma.sync.update({
        where: { id: data.syncId },
        data: { lastSyncTime: new Date() },
      });

      // Trigger publish jobs for destination connectors if enabled
      if (sync.publishAfterSync && totalFilesSynced > 0) {
        WSLogger.info({
          source: 'SyncDataFoldersJob',
          message: 'Triggering publish-after-sync',
          syncId: data.syncId,
          workbookId: data.workbookId,
          totalFilesSynced,
        });

        const uniqueConnectorAccountIds = new Set<string>();
        for (const pair of sync.syncTablePairs) {
          const connectorAccountId = pair.destinationDataFolder.connectorAccountId;
          if (connectorAccountId) {
            uniqueConnectorAccountIds.add(connectorAccountId);
          }
        }

        for (const connectorAccountId of uniqueConnectorAccountIds) {
          try {
            const { pipelineId } = await this.publishPlanBuildService.createPipeline(
              data.workbookId,
              data.userId,
              connectorAccountId,
            );

            const job = await this.bullEnqueuerService.enqueuePlanPipelineJob(
              data.workbookId,
              actor,
              pipelineId,
              connectorAccountId,
              true, // runAfterPlan
              undefined,
              undefined,
              undefined,
              createRunContext('job', { runId: runId as RunId, parentJobId: jobId }),
            );

            await this.publishPlanBuildService.setActiveJob(pipelineId, job.id!.toString());

            WSLogger.info({
              source: 'SyncDataFoldersJob',
              message: 'Enqueued publish-after-sync job',
              syncId: data.syncId,
              connectorAccountId,
              pipelineId,
              jobId: job.id,
            });
          } catch (error) {
            WSLogger.error({
              source: 'SyncDataFoldersJob',
              message: 'Failed to enqueue publish-after-sync job',
              syncId: data.syncId,
              connectorAccountId,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
          }
        }
      }
    }

    this.workbookEventService.sendWorkbookEvent(data.workbookId, {
      type: 'job-completed',
      data: {
        source: 'job',
        entityId: data.syncId,
        message: allTablesSucceeded ? 'Sync completed' : 'Sync completed with errors',
        jobId: params.jobId,
      },
    });

    try {
      await this.scratchGitService.runGitGc(data.workbookId);
    } catch (err) {
      WSLogger.warn({
        source: 'SyncDataFoldersJob',
        message: 'Failed to run Git GC',
        workbookId: data.workbookId,
        error: err,
      });
    }

    WSLogger.info({
      source: 'SyncDataFoldersJob',
      message: 'Completed sync data folders job',
      syncId: data.syncId,
      workbookId: data.workbookId,
      totalFilesSynced,
      tablesProcessed: tableMappings.length,
      allTablesSucceeded,
    });

    try {
      this.postHogService.trackSyncCompleted(data.userId, {
        syncId: data.syncId,
        syncName: sync.displayName ?? data.syncId,
        trigger: data.trigger,
        result: allTablesSucceeded ? 'success' : 'failure',
        totalRecordsSynced: totalFilesSynced,
        recordsCreated: tablesProgress.reduce((sum, t) => sum + t.creates, 0),
        recordsUpdated: tablesProgress.reduce((sum, t) => sum + t.updates, 0),
        tablesProcessed: tableMappings.length,
        failedTableCount: failedTables.length,
      });
    } catch (err) {
      WSLogger.warn({
        source: 'SyncDataFoldersJob',
        message: 'Failed to track sync completed event',
        error: err,
      });
    }
  }
}
