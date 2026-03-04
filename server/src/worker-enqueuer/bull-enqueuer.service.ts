import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createPlainId, DataFolderId, SyncId, WorkbookId } from '@spinner/shared-types';
import { Job, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { JobService } from 'src/job/job.service';
import { Actor } from 'src/users/types';
import { JobData } from 'src/worker/jobs/union-types';
import { PublishDataFolderJobDefinition } from '../worker/jobs/job-definitions/publish-data-folder.job';
import { PublishJobDefinition } from '../worker/jobs/job-definitions/publish.job';
import { PullFilesJobDefinition } from '../worker/jobs/job-definitions/pull-files.job';
import { PullLinkedFolderFilesJobDefinition } from '../worker/jobs/job-definitions/pull-linked-folder-files.job';
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
    initialPublicProgress?: PullLinkedFolderFilesJobDefinition['publicProgress'],
  ): Promise<Job> {
    const id = `pull-linked-folder-files-${actor.userId}-${workbookId}-${createPlainId()}`;
    const data: PullLinkedFolderFilesJobDefinition['data'] = {
      workbookId,
      userId: actor.userId,
      organizationId: actor.organizationId,
      dataFolderIds,
      type: 'pull-linked-folder-files',
      initialPublicProgress,
    };
    await this.jobService.createJob({
      userId: actor.userId,
      type: data.type,
      data,
      bullJobId: id,
      workbookId,
    });
    return await this.enqueueJobWithId(data, id);
  }

  async enqueuePublishDataFolderJob(
    workbookId: WorkbookId,
    actor: Actor,
    dataFolderIds: DataFolderId[],
    initialPublicProgress?: PublishDataFolderJobDefinition['publicProgress'],
  ): Promise<Job> {
    const id = `publish-data-folder-${actor.userId}-${workbookId}-${createPlainId()}`;
    const data: PublishDataFolderJobDefinition['data'] = {
      workbookId,
      userId: actor.userId,
      organizationId: actor.organizationId,
      dataFolderIds,
      type: 'publish-data-folder',
      initialPublicProgress,
    };
    await this.jobService.createJob({
      userId: actor.userId,
      type: data.type,
      data,
      bullJobId: id,
      workbookId,
    });
    return await this.enqueueJobWithId(data, id);
  }

  async enqueueSyncDataFoldersJob(
    workbookId: WorkbookId,
    syncId: SyncId,
    actor: Actor,
    initialPublicProgress?: SyncDataFoldersJobDefinition['publicProgress'],
  ): Promise<Job> {
    const id = `sync-data-folders-${actor.userId}-${workbookId}-${createPlainId()}`;
    const data: SyncDataFoldersJobDefinition['data'] = {
      workbookId,
      syncId,
      userId: actor.userId,
      organizationId: actor.organizationId,
      type: 'sync-data-folders',
      initialPublicProgress,
    };
    await this.jobService.createJob({
      userId: actor.userId,
      type: data.type,
      data,
      bullJobId: id,
      workbookId,
    });
    return await this.enqueueJobWithId(data, id);
  }

  async enqueuePlanPipelineJob(
    workbookId: WorkbookId,
    actor: Actor,
    pipelineId: string,
    connectorAccountId?: string,
    runAfterPlan?: boolean,
    folderPath?: string,
    filePath?: string,
    initialProgress?: import('src/types/progress').Progress,
  ): Promise<Job> {
    const id = `publish-${actor.userId}-${workbookId}-${createPlainId()}`;
    const data: PublishJobDefinition['data'] = {
      workbookId,
      userId: actor.userId,
      pipelineId,
      type: 'publish',
      ...(connectorAccountId && { connectorAccountId }),
      ...(runAfterPlan && { runAfterPlan }),
      ...(folderPath && { folderPath }),
      ...(filePath && { filePath }),
    };
    await this.jobService.createJob({
      userId: actor.userId,
      type: data.type,
      data,
      bullJobId: id,
      workbookId,
      progress: initialProgress,
    });
    return await this.enqueueJobWithId(data, id);
  }

  async enqueueRunPipelineJob(
    workbookId: WorkbookId,
    actor: Actor,
    pipelineId: string,
    executeSinglePhase?: boolean,
    initialProgress?: import('src/types/progress').Progress,
  ): Promise<Job> {
    const id = `publish-${actor.userId}-${workbookId}-${createPlainId()}`;
    const data: PublishJobDefinition['data'] = {
      pipelineId,
      workbookId,
      userId: actor.userId,
      type: 'publish',
      // We are enqueuing a run explicitly
      runAfterPlan: true,
      ...(executeSinglePhase && { executeSinglePhase }),
    };
    await this.jobService.createJob({
      userId: actor.userId,
      type: data.type,
      data,
      bullJobId: id,
      workbookId,
      progress: initialProgress,
    });
    return await this.enqueueJobWithId(data, id);
  }

  async enqueuePullFilesJob(
    workbookId: WorkbookId,
    actor: Actor,
    dataFolderId: DataFolderId,
    filePaths: string[],
    initialPublicProgress?: PullFilesJobDefinition['publicProgress'],
  ): Promise<Job> {
    const id = `refresh-records-${actor.userId}-${workbookId}-${createPlainId()}`;
    const data: PullFilesJobDefinition['data'] = {
      workbookId,
      userId: actor.userId,
      organizationId: actor.organizationId,
      dataFolderId,
      filePaths,
      type: 'refresh-records',
      initialPublicProgress,
    };
    await this.jobService.createJob({
      userId: actor.userId,
      type: data.type,
      data,
      bullJobId: id,
      workbookId,
      dataFolderId,
    });
    return await this.enqueueJobWithId(data, id);
  }

  private getQueue(): Queue {
    if (!this.queue) {
      throw new Error('Expected queue to not be undefined');
    }
    return this.queue;
  }
}
