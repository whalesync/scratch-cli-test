import type { DataFolderId, SyncId, WorkbookId } from '@spinner/shared-types';
import { type JobTrigger, JobType } from '@spinner/shared-types';
import { WSLogger } from '../../../logger';
import type { SyncService } from '../../../sync/sync.service';
import { JobCanceledError } from '../../job-errors';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';
import type { JobData, JobDefinition, JobHandler } from '../union-types';
import type { PullLinkedFolderFilesJobDefinition } from './pull-linked-folder-files.job';
import type { SyncDataFoldersJobDefinition } from './sync-data-folders.job';

const LOG_SOURCE = 'TemporarySyncWithPullJob';

/**
 * THROWAWAY JOB — delete once the real job-dependency system lands.
 *
 * The product "Run now" button only ran the sync between two data folders; it
 * assumed both sides were already pulled. This job wraps that gap: it first
 * pulls (incremental where the connector supports it) every data folder that
 * participates in the sync, then runs the normal sync job. Both steps reuse the
 * existing job handlers verbatim by invoking them in-process, sequentially —
 * deliberately avoiding any new queue/flow infrastructure (no BullMQ
 * FlowProducer, no child jobs) since this is temporary scaffolding.
 */
export type TemporarySyncWithPullPublicProgress = {
  phase: 'pulling' | 'syncing' | 'completed';
  /** Number of distinct connections whose folders we pull (one child pull run each). */
  totalConnectionsToPull: number;
  connectionsPulled: number;
  message: string;
};

export type TemporarySyncWithPullJobDefinition = JobDefinitionBuilder<
  typeof JobType.TemporarySyncWithPull,
  {
    workbookId: WorkbookId;
    syncId: SyncId;
    organizationId: string;
    userId: string;
    trigger?: JobTrigger;
  },
  TemporarySyncWithPullPublicProgress,
  Record<string, never>,
  void
>;

/**
 * Minimal surface of `JobHandlerService` this job needs. Declared as an
 * interface (rather than importing the concrete class) to avoid a module import
 * cycle: `JobHandlerService` already imports this job's handler.
 */
export interface ChildJobHandlerFactory {
  getHandler(data: JobData): JobHandler<JobDefinition>;
}

export class TemporarySyncWithPullJobHandler implements JobHandlerBuilder<TemporarySyncWithPullJobDefinition> {
  constructor(
    private readonly syncService: SyncService,
    private readonly childJobHandlerFactory: ChildJobHandlerFactory,
  ) {}

  async run(params: {
    jobId: string;
    runId?: string;
    data: TemporarySyncWithPullJobDefinition['data'];
    progress: Progress<
      TemporarySyncWithPullJobDefinition['publicProgress'],
      TemporarySyncWithPullJobDefinition['initialJobProgress']
    >;
    abortSignal: AbortSignal;
    checkpoint: (
      progress: Omit<
        Progress<
          TemporarySyncWithPullJobDefinition['publicProgress'],
          TemporarySyncWithPullJobDefinition['initialJobProgress']
        >,
        'timestamp'
      >,
    ) => Promise<void>;
  }) {
    const { jobId, runId, data, checkpoint, abortSignal } = params;

    WSLogger.info({
      source: LOG_SOURCE,
      message: 'Starting temporary pull-then-sync job',
      syncId: data.syncId,
      workbookId: data.workbookId,
      userId: data.userId,
    });

    // Resolve the sync's data folders through the same choke point the sync job
    // uses. Each table pair contributes a source and a destination folder.
    const sync = await this.syncService.getSyncForExecution(data.syncId);
    if (!sync) {
      throw new Error(`Sync with id ${data.syncId} not found`);
    }

    // Dedupe the folders (a folder can appear in multiple pairs) and group them
    // by connection: the pull job requires every folder in one run to share a
    // single connectorAccount, so we issue one child pull run per connection.
    const uniqueDataFoldersById = new Map<DataFolderId, { id: DataFolderId; connectorAccountId: string | null }>();
    for (const tablePair of sync.syncTablePairs) {
      for (const dataFolder of [tablePair.sourceDataFolder, tablePair.destinationDataFolder]) {
        uniqueDataFoldersById.set(dataFolder.id as DataFolderId, {
          id: dataFolder.id as DataFolderId,
          connectorAccountId: dataFolder.connectorAccountId,
        });
      }
    }

    const dataFolderIdsByConnectorAccountId = new Map<string, DataFolderId[]>();
    for (const dataFolder of uniqueDataFoldersById.values()) {
      if (!dataFolder.connectorAccountId) {
        // A folder with no connection can't be pulled; the sync step will surface
        // any real problem with it. Skip rather than fail the whole run.
        WSLogger.warn({
          source: LOG_SOURCE,
          message: 'Skipping pull for data folder without a connection',
          dataFolderId: dataFolder.id,
          syncId: data.syncId,
        });
        continue;
      }
      const existing = dataFolderIdsByConnectorAccountId.get(dataFolder.connectorAccountId) ?? [];
      existing.push(dataFolder.id);
      dataFolderIdsByConnectorAccountId.set(dataFolder.connectorAccountId, existing);
    }

    const publicProgress: TemporarySyncWithPullPublicProgress = {
      phase: 'pulling',
      totalConnectionsToPull: dataFolderIdsByConnectorAccountId.size,
      connectionsPulled: 0,
      message: 'Pulling data folders before sync',
    };
    await checkpoint({ publicProgress, jobProgress: {}, connectorProgress: {} });

    // ---- Phase 1: pull every participating folder, one run per connection ----
    for (const [connectorAccountId, dataFolderIds] of dataFolderIdsByConnectorAccountId) {
      if (abortSignal.aborted) throw new JobCanceledError(jobId);

      WSLogger.info({
        source: LOG_SOURCE,
        message: 'Pulling folders for connection before sync',
        connectorAccountId,
        dataFolderCount: dataFolderIds.length,
        syncId: data.syncId,
      });

      const pullJobData: PullLinkedFolderFilesJobDefinition['data'] = {
        type: JobType.PullLinkedFolderFiles,
        workbookId: data.workbookId,
        userId: data.userId,
        organizationId: data.organizationId,
        dataFolderIds,
        // Incremental where supported; the pull handler demotes to full per-folder
        // when the connector lacks incremental support or has no prior watermark.
        pullMode: 'incremental',
        trigger: 'job',
      };

      await this.runChildHandlerInProcess(pullJobData, { jobId, runId, abortSignal });

      publicProgress.connectionsPulled += 1;
      await checkpoint({ publicProgress: { ...publicProgress }, jobProgress: {}, connectorProgress: {} });
    }

    // ---- Phase 2: run the normal sync job, in-process ----
    if (abortSignal.aborted) throw new JobCanceledError(jobId);

    publicProgress.phase = 'syncing';
    publicProgress.message = 'Running sync';
    await checkpoint({ publicProgress: { ...publicProgress }, jobProgress: {}, connectorProgress: {} });

    const syncJobData: SyncDataFoldersJobDefinition['data'] = {
      type: JobType.SyncDataFolders,
      workbookId: data.workbookId,
      syncId: data.syncId,
      userId: data.userId,
      organizationId: data.organizationId,
      trigger: data.trigger ?? 'job',
    };

    await this.runChildHandlerInProcess(syncJobData, { jobId, runId, abortSignal });

    publicProgress.phase = 'completed';
    publicProgress.message = 'Pull and sync completed';
    await checkpoint({ publicProgress: { ...publicProgress }, jobProgress: {}, connectorProgress: {} });

    WSLogger.info({
      source: LOG_SOURCE,
      message: 'Completed temporary pull-then-sync job',
      syncId: data.syncId,
      workbookId: data.workbookId,
    });
  }

  /**
   * Run an existing job handler in-process (NOT via the queue). We build the
   * concrete handler with the same dependency wiring `JobHandlerService` uses,
   * then call its `run` directly.
   *
   * The child handlers only read `progress.jobProgress` to resume a crashed run
   * and rebuild `publicProgress` from scratch, so a fresh/empty progress is the
   * correct "start from the beginning" input. Cancellation still propagates to
   * the child through the shared `abortSignal`, so the child checkpoint is a
   * no-op here.
   */
  private async runChildHandlerInProcess(
    childJobData: JobData,
    context: { jobId: string; runId?: string; abortSignal: AbortSignal },
  ): Promise<void> {
    const childHandler = this.childJobHandlerFactory.getHandler(childJobData);

    const freshProgress: Progress = { publicProgress: {}, jobProgress: {}, connectorProgress: {}, timestamp: 0 };

    await childHandler.run({
      jobId: context.jobId,
      runId: context.runId,
      data: childJobData,
      checkpoint: async () => {},
      // The handler-union's progress type is narrower than the default `Progress`;
      // the value is only used for jobProgress resume state, which we intentionally
      // leave empty. Cast to the parameter's exact type without `any`.
      progress: freshProgress as Parameters<typeof childHandler.run>[0]['progress'],
      abortSignal: context.abortSignal,
    });
  }
}
