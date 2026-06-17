import { Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { createPlainId, DataFolderId, JobType, RunId, SyncId, WorkbookId } from '@spinner/shared-types';
import { Job, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';
import { JobService } from 'src/job/job.service';
import { WSLogger } from 'src/logger';
import { MigrationLockService } from 'src/migration-lock/migration-lock.service';
import { Actor } from 'src/users/types';
import { RunContext } from 'src/worker/jobs/base-types';
import { JobData } from 'src/worker/jobs/union-types';
import { ApplyPatchesJobDefinition } from '../worker/jobs/job-definitions/apply-patches.job';
import { DeleteWorkbookJobDefinition } from '../worker/jobs/job-definitions/delete-workbook.job';
import { PublishJobDefinition } from '../worker/jobs/job-definitions/publish.job';
import { PullFilesJobDefinition } from '../worker/jobs/job-definitions/pull-files.job';
import { PullLinkedFolderFilesJobDefinition } from '../worker/jobs/job-definitions/pull-linked-folder-files.job';
import { RehostAssetsJobDefinition } from '../worker/jobs/job-definitions/rehost-assets.job';
import { SyncDataFoldersJobDefinition } from '../worker/jobs/job-definitions/sync-data-folders.job';
import { TemporarySyncWithPullJobDefinition } from '../worker/jobs/job-definitions/temporary-sync-with-pull.job';

@Injectable()
export class BullEnqueuerService implements OnModuleDestroy {
  private redis?: IORedis;
  private queue?: Queue;

  constructor(
    private readonly configService: ScratchConfigService,
    private readonly jobService: JobService,
    private readonly dbService: DbService,
    private readonly migrationLockService: MigrationLockService,
  ) {
    if (configService.getUseJobs()) {
      this.redis = new IORedis({
        host: this.configService.getRedisHost(),
        port: this.configService.getRedisPort(),
        password: this.configService.getRedisPassword(),
        maxRetriesPerRequest: null,
      });

      this.queue = new Queue('worker-queue', {
        connection: this.redis,
        defaultJobOptions: {
          removeOnComplete: 100,
          removeOnFail: 100,
          attempts: 1,
        },
      });
    }
  }

  async onModuleDestroy() {
    await this.queue?.close();
    await this.redis?.quit();
  }

  async getJob(jobId: string): Promise<Job | undefined> {
    if (!this.queue) return undefined;
    return await this.queue.getJob(jobId);
  }

  private async enqueueJobWithId(data: JobData, id: string): Promise<Job> {
    return await this.getQueue().add(data.type, data, { jobId: id });
  }

  async enqueueJob(data: JobData): Promise<Job> {
    return await this.getQueue().add(data.type, data);
  }

  async enqueuePullLinkedFolderFilesJob(
    workbookId: WorkbookId,
    actor: Actor,
    dataFolderIds: DataFolderId[],
    initialPublicProgress: PullLinkedFolderFilesJobDefinition['publicProgress'] | undefined,
    runContext: RunContext,
    pullMode?: 'full' | 'incremental',
  ): Promise<Job> {
    const id = `pull-${workbookId}-${createPlainId()}`;
    const data: PullLinkedFolderFilesJobDefinition['data'] = {
      workbookId,
      userId: actor.userId,
      organizationId: actor.organizationId,
      dataFolderIds,
      trigger: runContext.trigger,
      type: JobType.PullLinkedFolderFiles,
      pullMode,
      initialPublicProgress,
    };
    return await this.createAndEnqueue(
      {
        userId: actor.userId,
        type: data.type,
        data,
        bullJobId: id,
        workbookId,
        dataFolderId: dataFolderIds.length === 1 ? dataFolderIds[0] : undefined,
        runId: runContext.runId as RunId,
        runContext,
      },
      data,
      id,
    );
  }

  async enqueueSyncDataFoldersJob(
    workbookId: WorkbookId,
    syncId: SyncId,
    actor: Actor,
    initialPublicProgress: SyncDataFoldersJobDefinition['publicProgress'] | undefined,
    runContext: RunContext,
  ): Promise<Job> {
    const id = `sync-${workbookId}-${syncId}-${createPlainId()}`;
    const data: SyncDataFoldersJobDefinition['data'] = {
      workbookId,
      syncId,
      userId: actor.userId,
      organizationId: actor.organizationId,
      trigger: runContext.trigger,
      type: JobType.SyncDataFolders,
      initialPublicProgress,
    };
    return await this.createAndEnqueue(
      {
        userId: actor.userId,
        type: data.type,
        data,
        bullJobId: id,
        workbookId,
        syncId,
        runId: runContext.runId as RunId,
        runContext,
      },
      data,
      id,
    );
  }

  /**
   * THROWAWAY (no Linear issue): enqueue a job that pulls every data folder in
   * the sync (incremental where supported) and then runs the normal sync job.
   * Mirrors {@link enqueueSyncDataFoldersJob}; remove once the real
   * job-dependency system lands.
   */
  async enqueueTemporarySyncWithPullJob(
    workbookId: WorkbookId,
    syncId: SyncId,
    actor: Actor,
    runContext: RunContext,
  ): Promise<Job> {
    const id = `temp-sync-with-pull-${workbookId}-${syncId}-${createPlainId()}`;
    const data: TemporarySyncWithPullJobDefinition['data'] = {
      type: JobType.TemporarySyncWithPull,
      workbookId,
      syncId,
      userId: actor.userId,
      organizationId: actor.organizationId,
      trigger: runContext.trigger,
    };
    return await this.createAndEnqueue(
      {
        userId: actor.userId,
        type: data.type,
        data,
        bullJobId: id,
        workbookId,
        syncId,
        runId: runContext.runId as RunId,
        runContext,
      },
      data,
      id,
    );
  }

  async enqueuePlanPipelineJob(
    workbookId: WorkbookId,
    actor: Actor,
    pipelineId: string,
    connectorAccountId: string | undefined,
    runAfterPlan: boolean | undefined,
    folderPath: string | undefined,
    filePath: string | undefined,
    initialProgress: import('src/types/progress').Progress | undefined,
    runContext: RunContext,
    expectedBaseDirtyHead?: string,
  ): Promise<Job> {
    const id = `publish-${workbookId}-${createPlainId()}`;
    const data: PublishJobDefinition['data'] = {
      workbookId,
      userId: actor.userId,
      pipelineId,
      type: JobType.Publish,
      trigger: runContext.trigger,
      ...(connectorAccountId && { connectorAccountId }),
      ...(runAfterPlan && { runAfterPlan }),
      ...(folderPath && { folderPath }),
      ...(filePath && { filePath }),
      // DEV-10316 TOCTOU token (desktop per-connection publish only).
      ...(expectedBaseDirtyHead && { expectedBaseDirtyHead }),
    };
    return await this.createAndEnqueue(
      {
        userId: actor.userId,
        type: data.type,
        data,
        bullJobId: id,
        workbookId,
        progress: initialProgress,
        runId: runContext.runId as RunId,
        runContext,
      },
      data,
      id,
    );
  }

  /**
   * Enqueue a "self-planning" publish job (DEV-10436, routines): a JobType.Publish job
   * with NO pre-created pipeline. The handler creates its own PublishPlan when it runs
   * (see PublishJobHandler), so the caller skips the createPipeline → enqueue →
   * setActiveJob 3-call shape. Use this when the caller doesn't need the pipelineId
   * synchronously — a routine step discovers it from the finished job's progress.
   */
  async enqueueSelfPlanningPublishJob(
    workbookId: WorkbookId,
    actor: Actor,
    connectorAccountId: string | undefined,
    runAfterPlan: boolean | undefined,
    folderPath: string | undefined,
    runContext: RunContext,
  ): Promise<Job> {
    const id = `publish-${workbookId}-${createPlainId()}`;
    const data: PublishJobDefinition['data'] = {
      workbookId,
      userId: actor.userId,
      type: JobType.Publish,
      trigger: runContext.trigger,
      ...(connectorAccountId && { connectorAccountId }),
      ...(runAfterPlan && { runAfterPlan }),
      ...(folderPath && { folderPath }),
    };
    return await this.createAndEnqueue(
      {
        userId: actor.userId,
        type: data.type,
        data,
        bullJobId: id,
        workbookId,
        progress: undefined,
        runId: runContext.runId as RunId,
        runContext,
      },
      data,
      id,
    );
  }

  async enqueueRunPipelineJob(
    workbookId: WorkbookId,
    actor: Actor,
    pipelineId: string,
    executeSinglePhase: boolean | undefined,
    initialProgress: import('src/types/progress').Progress | undefined,
    runContext: RunContext,
  ): Promise<Job> {
    const id = `publish-${workbookId}-${createPlainId()}`;
    const data: PublishJobDefinition['data'] = {
      pipelineId,
      workbookId,
      userId: actor.userId,
      type: JobType.Publish,
      trigger: runContext.trigger,
      // We are enqueuing a run explicitly
      runAfterPlan: true,
      ...(executeSinglePhase && { executeSinglePhase }),
    };
    return await this.createAndEnqueue(
      {
        userId: actor.userId,
        type: data.type,
        data,
        bullJobId: id,
        workbookId,
        progress: initialProgress,
        runId: runContext.runId as RunId,
        runContext,
      },
      data,
      id,
    );
  }

  async enqueueRehostAssetsJob(
    workbookId: WorkbookId,
    actor: Actor,
    dataFolderId: DataFolderId,
    initialPublicProgress: RehostAssetsJobDefinition['publicProgress'] | undefined,
    runContext: RunContext,
    options?: { rehost?: boolean },
  ): Promise<Job> {
    const id = `rehost-assets-${workbookId}-${createPlainId()}`;
    const data: RehostAssetsJobDefinition['data'] = {
      workbookId,
      userId: actor.userId,
      organizationId: actor.organizationId,
      dataFolderId,
      rehost: options?.rehost,
      type: JobType.RehostAssets,
      initialPublicProgress,
    };
    return await this.createAndEnqueue(
      {
        userId: actor.userId,
        type: data.type,
        data,
        bullJobId: id,
        workbookId,
        dataFolderId,
        runId: runContext.runId as RunId,
        runContext,
      },
      data,
      id,
    );
  }

  async enqueuePullFilesJob(
    workbookId: WorkbookId,
    actor: Actor,
    dataFolderId: DataFolderId,
    filePaths: string[],
    initialPublicProgress: PullFilesJobDefinition['publicProgress'] | undefined,
    runContext: RunContext,
  ): Promise<Job> {
    const id = `refresh-records-${workbookId}-${createPlainId()}`;
    const data: PullFilesJobDefinition['data'] = {
      workbookId,
      userId: actor.userId,
      organizationId: actor.organizationId,
      dataFolderId,
      filePaths,
      trigger: runContext.trigger,
      type: JobType.RefreshRecords,
      initialPublicProgress,
    };
    return await this.createAndEnqueue(
      {
        userId: actor.userId,
        type: data.type,
        data,
        bullJobId: id,
        workbookId,
        dataFolderId,
        runId: runContext.runId as RunId,
        runContext,
      },
      data,
      id,
    );
  }

  /**
   * Enqueue an asynchronous hard-delete for a workbook. Uses a deterministic Bull job id
   * (`delete-workbook-${workbookId}`) so retries do not stack duplicate work; the handler
   * is idempotent.
   */
  async enqueueDeleteWorkbookJob(workbookId: WorkbookId, actor: Actor): Promise<Job> {
    const id = `delete-workbook-${workbookId}-${createPlainId(5)}`;
    const data: DeleteWorkbookJobDefinition['data'] = {
      type: JobType.DeleteWorkbook,
      workbookId,
      userId: actor.userId,
      organizationId: actor.organizationId,
    };
    return await this.createAndEnqueue(
      {
        userId: actor.userId,
        type: data.type,
        data,
        bullJobId: id,
        workbookId,
      },
      data,
      id,
    );
  }

  async enqueueApplyPatchesJob(
    workbookId: WorkbookId,
    userId: string,
    connectorAccountId: string,
    uploadId: string,
    baseHead?: string,
  ): Promise<Job> {
    const id = `apply-patches-${workbookId}-${createPlainId()}`;
    const data: ApplyPatchesJobDefinition['data'] = {
      type: JobType.ApplyPatches,
      workbookId,
      userId,
      connectorAccountId,
      uploadId,
      ...(baseHead ? { baseHead } : {}),
    };
    return await this.createAndEnqueue(
      {
        userId,
        type: data.type,
        data,
        bullJobId: id,
        workbookId,
      },
      data,
      id,
    );
  }

  private async createAndEnqueue(
    params: Parameters<JobService['createJob']>[0],
    data: JobData,
    id: string,
  ): Promise<Job> {
    // Guard: do not enqueue user-initiated work for workbooks pending deletion. The
    // delete-workbook job itself bypasses this check (it's the worker draining the workbook).
    if (params.workbookId && data.type !== JobType.DeleteWorkbook) {
      await this.assertWorkbookNotPendingDelete(params.workbookId as WorkbookId);
    }

    // T4 (DEV-9698): do not enqueue work that touches a connection being migrated —
    // it would re-create activity the quiesce just drained, racing the folder move.
    // Fast-path no-op when nothing is locked (the common case). DeleteWorkbook is a
    // workbook-level drain and is exempt for the same reason as above.
    if (data.type !== JobType.DeleteWorkbook) {
      await this.migrationLockService.assertEnqueueAllowedForJob(data);
    }

    const dbJob = await this.jobService.createJob(params);
    try {
      return await this.enqueueJobWithId(data, id);
    } catch (error) {
      WSLogger.error({
        source: 'BullEnqueuerService',
        message: `Failed to enqueue BullMQ job ${id}, marking DbJob ${dbJob.id} as failed`,
        error,
      });
      await this.jobService.updateJobStatus({
        id: dbJob.id,
        status: 'failed',
        error: `Failed to enqueue to BullMQ: ${error instanceof Error ? error.message : 'Unknown error'}`,
        finishedOn: new Date(),
      });
      throw error;
    }
  }

  /**
   * Throws a NotFound (matching the controller-level visibility model) if the workbook is
   * already flagged for deletion. Avoids stacking long-running work on a workspace that's
   * about to be wiped.
   */
  private async assertWorkbookNotPendingDelete(workbookId: WorkbookId): Promise<void> {
    const workbook = await this.dbService.client.workbook.findUnique({
      where: { id: workbookId },
      select: { isPendingDelete: true },
    });
    if (workbook?.isPendingDelete) {
      throw new NotFoundException('Workbook not found');
    }
  }

  private getQueue(): Queue {
    if (!this.queue) {
      throw new Error('Expected queue to not be undefined');
    }
    return this.queue;
  }
}
