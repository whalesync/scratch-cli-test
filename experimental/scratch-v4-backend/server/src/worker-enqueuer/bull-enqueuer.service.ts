import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { JobService } from 'src/job/job.service';
import { WSLogger } from 'src/logger';
import { PollJobDefinition } from 'src/worker/jobs/job-definitions/poll.job';

@Injectable()
export class BullEnqueuerService implements OnModuleDestroy {
  private queue: Queue;

  constructor(
    private readonly configService: ScratchConfigService,
    private readonly jobService: JobService,
  ) {
    this.queue = new Queue('worker-queue', {
      connection: {
        host: this.configService.getRedisHost(),
        port: this.configService.getRedisPort(),
        password: this.configService.getRedisPassword(),
        maxRetriesPerRequest: null,
      },
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 100,
        attempts: 1,
      },
    });
  }

  async onModuleDestroy() {
    await this.queue.close();
  }

  async enqueuePollJob(params: {
    workbookId: string;
    connectorAccountId: string;
    userId: string;
  }): Promise<Job> {
    const id = `poll-${params.workbookId}-${params.connectorAccountId}-${Date.now()}`;
    const data: PollJobDefinition['data'] = {
      type: 'poll',
      workbookId: params.workbookId,
      connectorAccountId: params.connectorAccountId,
      userId: params.userId,
    };

    const dbJob = await this.jobService.createJob({
      userId: params.userId,
      type: data.type,
      data: data as Record<string, unknown>,
      bullJobId: id,
      workbookId: params.workbookId,
    });

    try {
      return await this.queue.add(data.type, data, { jobId: id });
    } catch (error) {
      WSLogger.error({
        source: 'BullEnqueuerService',
        message: `Failed to enqueue poll job ${id}`,
        error,
      });
      await this.jobService.updateJobStatus({
        id: dbJob.id,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
        finishedOn: new Date(),
      });
      throw error;
    }
  }
}
