import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createPlainId, DataFolderId, RunId, SyncId, WorkbookId } from '@spinner/shared-types';
import { Job, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { JobService } from 'src/job/job.service';
import { WSLogger } from 'src/logger';
import { Actor } from 'src/users/types';
import { RunContext } from 'src/worker/jobs/base-types';
import { JobData } from 'src/worker/jobs/union-types';
import { PublishDataFolderJobDefinition } from '../worker/jobs/job-definitions/publish-data-folder.job';
import { PublishJobDefinition } from '../worker/jobs/job-definitions/publish.job';
import { PullFilesJobDefinition } from '../worker/jobs/job-definitions/pull-files.job';
import { PullLinkedFolderFilesJobDefinition } from '../worker/jobs/job-definitions/pull-linked-folder-files.job';
import { RehostAssetsJobDefinition } from '../worker/jobs/job-definitions/rehost-assets.job';
import { SyncDataFoldersJobDefinition } from '../worker/jobs/job-definitions/sync-data-folders.job';

@Injectable()
export class BullEnqueuerService implements OnModuleDestroy {
  private redis?: IORedis;
  private queue?: Queue;

  constructor(
    private readonly configService: ScratchConfigService,
    private readonly jobService: JobService,
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
  ): Promise<Job> {
    const id = `pull-linked-folder-files-${actor.userId}-${workbookId}-${createPlainId()}`;
    const data: PullLinkedFolderFilesJobDefinition['data'] = {
      workbookId,
      userId: actor.userId,
      organizationId: actor.organizationId,
      dataFolderIds,
      trigger: runContext.trigger,
      type: 'pull-linked-folder-files',
      initialPublicProgress,
    };
    return await this.createAndEnqueue(
      {
        userId: actor.userId,
        type: data.type,
        data,
        bullJobId: id,
        workbookId,
        runId: runContext.runId as RunId,
        runContext,
      },
      data,
      id,
    );
  }

  async enqueuePublishDataFolderJob(
    workbookId: WorkbookId,
    actor: Actor,
    dataFolderIds: DataFolderId[],
    initialPublicProgress: PublishDataFolderJobDefinition['publicProgress'] | undefined,
    runContext: RunContext,
  ): Promise<Job> {
    const id = `publish-data-folder-${actor.userId}-${workbookId}-${createPlainId()}`;
    const data: PublishDataFolderJobDefinition['data'] = {
      workbookId,
      userId: actor.userId,
      organizationId: actor.organizationId,
      dataFolderIds,
      trigger: runContext.trigger,
      type: 'publish-data-folder',
      initialPublicProgress,
    };
    return await this.createAndEnqueue(
      {
        userId: actor.userId,
        type: data.type,
        data,
        bullJobId: id,
        workbookId,
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
    const id = `sync-data-folders-${actor.userId}-${workbookId}-${createPlainId()}`;
    const data: SyncDataFoldersJobDefinition['data'] = {
      workbookId,
      syncId,
      userId: actor.userId,
      organizationId: actor.organizationId,
      trigger: runContext.trigger,
      type: 'sync-data-folders',
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
  ): Promise<Job> {
    const id = `publish-${actor.userId}-${workbookId}-${createPlainId()}`;
    const data: PublishJobDefinition['data'] = {
      workbookId,
      userId: actor.userId,
      pipelineId,
      type: 'publish',
      trigger: runContext.trigger,
      ...(connectorAccountId && { connectorAccountId }),
      ...(runAfterPlan && { runAfterPlan }),
      ...(folderPath && { folderPath }),
      ...(filePath && { filePath }),
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

  async enqueueRunPipelineJob(
    workbookId: WorkbookId,
    actor: Actor,
    pipelineId: string,
    executeSinglePhase: boolean | undefined,
    initialProgress: import('src/types/progress').Progress | undefined,
    runContext: RunContext,
  ): Promise<Job> {
    const id = `publish-${actor.userId}-${workbookId}-${createPlainId()}`;
    const data: PublishJobDefinition['data'] = {
      pipelineId,
      workbookId,
      userId: actor.userId,
      type: 'publish',
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
  ): Promise<Job> {
    const id = `rehost-assets-${actor.userId}-${workbookId}-${createPlainId()}`;
    const data: RehostAssetsJobDefinition['data'] = {
      workbookId,
      userId: actor.userId,
      organizationId: actor.organizationId,
      dataFolderId,
      type: 'rehost-assets',
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
    const id = `refresh-records-${actor.userId}-${workbookId}-${createPlainId()}`;
    const data: PullFilesJobDefinition['data'] = {
      workbookId,
      userId: actor.userId,
      organizationId: actor.organizationId,
      dataFolderId,
      filePaths,
      trigger: runContext.trigger,
      type: 'refresh-records',
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

  private async createAndEnqueue(
    params: Parameters<JobService['createJob']>[0],
    data: JobData,
    id: string,
  ): Promise<Job> {
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

  private getQueue(): Queue {
    if (!this.queue) {
      throw new Error('Expected queue to not be undefined');
    }
    return this.queue;
  }
}
