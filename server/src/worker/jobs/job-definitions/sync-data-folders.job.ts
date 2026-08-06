import type { PrismaClient } from '@prisma/client';
import type {
  DataFolderId,
  RoutineRunId,
  SyncDataFoldersPublicProgress,
  SyncId,
  SyncTableProgress,
  WorkbookId,
} from '@spinner/shared-types';
import { type JobTrigger, JobType, RunId, TransformerTypes, transformV1ToV2 } from '@spinner/shared-types';
import { createHash } from 'crypto';
import { AuditLogService } from 'src/audit/audit-log.service';
import { UserCluster } from 'src/db/cluster-types';
import { CustomMetric } from 'src/metrics/custom-metrics';
import type { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import type { PostHogService } from 'src/posthog/posthog.service';
import { PublishPlanBuildService } from 'src/publish-plan/publish-plan-build.service';
import { WorkbookEventService } from 'src/workbook/workbook-event.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { WSLogger } from '../../../logger';
import { ScratchGitConflictError } from '../../../scratch-git/scratch-git.client';
import { ScratchGitService } from '../../../scratch-git/scratch-git.service';
import { findTransformerConfigsV2 } from '../../../sync/sync-execution';
import { SyncService } from '../../../sync/sync.service';
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

// `SyncDataFoldersPublicProgress` (and its per-table `SyncTableProgress`) now live in
// `@spinner/shared-types` so the web client, desktop app, and CLI render it without a shadow copy.
// Re-exported here so the existing `from '...sync-data-folders.job'` importers are unchanged.
export type { SyncDataFoldersPublicProgress, SyncTableProgress };

export type SyncDataFoldersJobDefinition = JobDefinitionBuilder<
  typeof JobType.SyncDataFolders,
  {
    workbookId: WorkbookId;
    syncId: SyncId;
    organizationId: string;
    userId: string;
    trigger?: JobTrigger;
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
    private readonly auditLogService: AuditLogService,
  ) {}

  async run(params: {
    jobId: string;
    runId?: string;
    routineRunId?: RoutineRunId;
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
    const { jobId, runId, routineRunId, data, checkpoint } = params;

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

    // Executor consumes v2 internally. Transform v1 mappings at the entry —
    // a transformed v1 has no unmatched-destination policy and every column
    // mapping defaults to `when: 'matched'`, so Pass 3 (the unmatched-destination
    // pass, when it lands with TODO(DEV-10008)) is a no-op for v1 syncs.
    const v2Mappings = sync.mappings.version === 1 ? transformV1ToV2(sync.mappings) : sync.mappings;
    const tableMappings = v2Mappings.tableMappings;

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

    // Errors seen per table, summed across the DATA and FK phases. A count rather
    // than a set of record ids: the service caps the error samples it returns, so
    // the ids of every errored record are no longer available (and holding one per
    // record is what these lists were changed to avoid).
    const errorCounts: number[] = tableMappings.map(() => 0);
    const warningCounts: number[] = tableMappings.map(() => 0);

    // Aggregate Pass 3 (unmatched-destination) counts across table mappings.
    // Surfaces in the per-run PostHog event, audit log entry, and metrics.
    const unmatchedDestinationTotals = { withMatchKey: 0, withoutMatchKey: 0, archived: 0, unarchived: 0, deleted: 0 };

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
          errorCount: result.errorCount,
        });

        // Update progress with results
        tableProgress.creates = result.recordsCreated;
        tableProgress.updates = result.recordsUpdated;
        tableProgress.skipped = result.recordsSkipped;
        tableProgress.createdPaths = result.createdPaths.slice(0, MAX_PROGRESS_PATHS);
        tableProgress.updatedPaths = result.updatedPaths.slice(0, MAX_PROGRESS_PATHS);
        errorCounts[i] += result.errorCount;
        tableProgress.errorCount = errorCounts[i];
        tableProgress.errors = result.errors.slice(0, MAX_PROGRESS_ERRORS);
        tableProgress.status = result.errorCount > 0 ? 'failed' : 'completed';
        totalFilesSynced += result.recordsCreated + result.recordsUpdated;
        unmatchedDestinationTotals.withMatchKey += result.unmatchedDestinationCounts.withMatchKey;
        unmatchedDestinationTotals.withoutMatchKey += result.unmatchedDestinationCounts.withoutMatchKey;
        unmatchedDestinationTotals.archived += result.unmatchedDestinationCounts.archived;
        unmatchedDestinationTotals.unarchived += result.unmatchedDestinationCounts.unarchived;
        unmatchedDestinationTotals.deleted += result.unmatchedDestinationCounts.deleted;

        // Store warnings in dedicated warnings array
        if (result.warningCount > 0) {
          warningCounts[i] += result.warningCount;
          tableProgress.warnings = [...tableProgress.warnings, ...result.warnings].slice(0, MAX_PROGRESS_WARNINGS);
          tableProgress.warningCount = warningCounts[i];
        }

        // Log any errors
        if (result.errorCount > 0) {
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
          findTransformerConfigsV2(m, TransformerTypes.SourceFkToDestFk).length > 0 ||
          findTransformerConfigsV2(m, TransformerTypes.SourceAssetToDestAsset).length > 0,
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
            errorCount: fkResult.errorCount,
          });

          // Store FK resolution warnings in dedicated warnings array
          if (fkResult.warningCount > 0) {
            warningCounts[i] += fkResult.warningCount;
            tablesProgress[i].warnings = [...tablesProgress[i].warnings, ...fkResult.warnings].slice(
              0,
              MAX_PROGRESS_WARNINGS,
            );
            tablesProgress[i].warningCount = warningCounts[i];
          }

          if (fkResult.errorCount > 0) {
            WSLogger.warn({
              source: 'SyncDataFoldersJob',
              message: 'FK resolution completed with errors',
              syncId: data.syncId,
              tableIndex: i,
              errors: fkResult.errors,
            });
            errorCounts[i] += fkResult.errorCount;
            tablesProgress[i].errorCount = errorCounts[i];
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
              // Child job: triggered by this job (trigger stays 'job'), but it inherits routineRunId so
              // a routine-driven publish-after-sync stays attributable to the run. Undefined otherwise.
              createRunContext('job', { runId: runId as RunId, parentJobId: jobId, routineRunId }),
            );

            if (job.id === undefined) {
              throw new Error(`Plan-pipeline job for pipeline ${pipelineId} was enqueued without an id`);
            }
            await this.publishPlanBuildService.setActiveJob(pipelineId, job.id.toString());

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

    // Compact the git repos the sync actually wrote to. Sync writes every record into its
    // destination folders, so those folders' repos are the ones worth GCing. In the V2
    // per-connection-repo architecture each connector-backed folder lives in its own
    // `org_/wkb_/coa_` repo (and a connector-less scratch folder lives in the per-workbook
    // scratch repo), so we resolve and dedupe the destination repos rather than GCing a bare
    // workbook id — `wkb_<id>.git` does not exist and used to ENOENT/500 on every sync (DEV-10671).
    const destinationRepoIdsWrittenBySync = new Set<string>();
    for (const syncTablePair of sync.syncTablePairs) {
      try {
        const destinationRepoId = await this.scratchGitService.resolveRepoPathForFolder(
          syncTablePair.destinationDataFolder.connectorAccountId,
          data.workbookId,
        );
        destinationRepoIdsWrittenBySync.add(destinationRepoId);
      } catch (err) {
        WSLogger.warn({
          source: 'SyncDataFoldersJob',
          message: 'Failed to resolve destination repo for Git GC',
          workbookId: data.workbookId,
          destinationDataFolderId: syncTablePair.destinationDataFolder.id,
          error: err,
        });
      }
    }

    for (const destinationRepoId of destinationRepoIdsWrittenBySync) {
      try {
        await this.scratchGitService.runGitGc(destinationRepoId);
      } catch (err) {
        if (err instanceof ScratchGitConflictError) {
          // A GC from a prior run of this job (e.g. one that stalled and was retried by BullMQ) is
          // still in progress on scratch-git. GC is idempotent maintenance, so skipping this run is
          // harmless — the next sync/pull will GC again. Mirrors pull-linked-folder-files.job.
          WSLogger.debug({
            source: 'SyncDataFoldersJob',
            message: 'Git GC already in progress, skipping',
            workbookId: data.workbookId,
            repoId: destinationRepoId,
          });
        } else {
          WSLogger.warn({
            source: 'SyncDataFoldersJob',
            message: 'Failed to run Git GC',
            workbookId: data.workbookId,
            repoId: destinationRepoId,
            error: err,
          });
        }
      }
    }

    WSLogger.info({
      source: 'SyncDataFoldersJob',
      message: 'Completed sync data folders job',
      syncId: data.syncId,
      workbookId: data.workbookId,
      totalFilesSynced,
      tablesProcessed: tableMappings.length,
      allTablesSucceeded,
      unmatchedDestinationTotals,
    });

    // Per-run metrics for Pass 3 activity. Emitted even when zero so dashboards
    // see a consistent stream of zeros for syncs that don't enable archive policy.
    this.metricsService.logValue(CustomMetric.SYNC_UNMATCHED_WITH_KEY_COUNT, unmatchedDestinationTotals.withMatchKey);
    this.metricsService.logValue(
      CustomMetric.SYNC_UNMATCHED_WITHOUT_KEY_COUNT,
      unmatchedDestinationTotals.withoutMatchKey,
    );
    this.metricsService.logValue(CustomMetric.SYNC_ARCHIVE_WRITES_TOTAL, unmatchedDestinationTotals.archived);

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
        unmatchedWithKeyCount: unmatchedDestinationTotals.withMatchKey,
        unmatchedWithoutKeyCount: unmatchedDestinationTotals.withoutMatchKey,
        archiveWritesCount: unmatchedDestinationTotals.archived,
        unarchiveWritesCount: unmatchedDestinationTotals.unarchived,
        deleteCount: unmatchedDestinationTotals.deleted,
      });
    } catch (err) {
      WSLogger.warn({
        source: 'SyncDataFoldersJob',
        message: 'Failed to track sync completed event',
        error: err,
      });
    }

    // Audit log: one entry per sync run when Pass 3 visited any unmatched
    // destination record. Narrowly scoped per D11 — broader "audit every sync
    // run" is tracked as a separate P2 follow-up.
    const visitedAny =
      unmatchedDestinationTotals.withMatchKey > 0 ||
      unmatchedDestinationTotals.withoutMatchKey > 0 ||
      unmatchedDestinationTotals.archived > 0 ||
      unmatchedDestinationTotals.unarchived > 0 ||
      unmatchedDestinationTotals.deleted > 0;
    if (visitedAny) {
      try {
        await this.auditLogService.logEvent({
          actor,
          eventType: 'update',
          message: `Sync "${sync.displayName ?? data.syncId}" applied unmatched-destination rules: ${unmatchedDestinationTotals.archived} archived, ${unmatchedDestinationTotals.unarchived} unarchived, ${unmatchedDestinationTotals.deleted} deleted`,
          entityId: data.syncId,
          context: {
            syncId: data.syncId,
            workbookId: data.workbookId,
            withMatchKey: unmatchedDestinationTotals.withMatchKey,
            withoutMatchKey: unmatchedDestinationTotals.withoutMatchKey,
            archived: unmatchedDestinationTotals.archived,
            unarchived: unmatchedDestinationTotals.unarchived,
            deleted: unmatchedDestinationTotals.deleted,
            mappingsSnapshotHash: hashV2Mappings(v2Mappings),
          },
        });
      } catch (err) {
        WSLogger.warn({
          source: 'SyncDataFoldersJob',
          message: 'Failed to write unmatched-destination audit log',
          error: err,
        });
      }
    }
  }
}

/**
 * Stable SHA-256 over the v2 mappings JSON. Persisted on the audit log entry
 * so ops can correlate "what config was active when this archive happened"
 * weeks later, even if the sync has been edited since.
 */
function hashV2Mappings(mappings: { tableMappings: unknown[] }): string {
  return createHash('sha256').update(JSON.stringify(mappings)).digest('hex');
}
