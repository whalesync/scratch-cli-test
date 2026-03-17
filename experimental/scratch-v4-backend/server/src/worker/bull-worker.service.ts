import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { JobService } from 'src/job/job.service';
import { WSLogger } from 'src/logger';
import { PollJob } from 'src/poll/poll.job';
import { JobResult, Progress } from './jobs/base-types';
import { JobData } from './jobs/union-types';

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private worker: Worker | null = null;

  constructor(
    private readonly pollJob: PollJob,
    private readonly jobService: JobService,
    private readonly configService: ScratchConfigService,
  ) {}

  private getConnection() {
    return {
      host: this.configService.getRedisHost(),
      port: this.configService.getRedisPort(),
      password: this.configService.getRedisPassword(),
      maxRetriesPerRequest: null as null,
    };
  }

  onModuleInit() {
    this.worker = new Worker('worker-queue', async (job: Job) => this.processJob(job), {
      connection: this.getConnection(),
      concurrency: 5,
      lockDuration: 300_000,
    });

    this.worker.on('completed', (job: Job, result: JobResult) => {
      WSLogger.info({
        source: 'QueueService',
        message: 'Job completed',
        jobId: job.id?.toString(),
        jobType: (job.data as JobData)?.type,
        executionTime: result?.executionTime,
      });
    });

    this.worker.on('failed', (job: Job | undefined, err: Error) => {
      WSLogger.error({ source: 'QueueService', message: 'Job failed', jobId: job?.id?.toString(), error: err.message });
    });

    this.worker.on('error', (err: Error) => {
      WSLogger.error({ source: 'QueueService', message: 'Worker error', error: err.message });
    });
  }

  async processJob(job: Job) {
    const jobId = job.id;
    if (!jobId) throw new Error('Job ID is missing');

    const jobData = job.data as JobData;
    const abortController = new AbortController();

    let dbJob = await this.jobService.getJobByBullJobId(jobId);
    if (!dbJob) {
      dbJob = await this.jobService.createJob({
        userId: jobData.userId,
        type: jobData.type,
        data: jobData as Record<string, unknown>,
        bullJobId: jobId,
        workbookId: jobData.workbookId,
      });
    }

    await this.jobService.updateJobStatus({ id: dbJob.id, status: 'active', processedOn: new Date() });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let latestProgress = job.progress as any;
    const checkpoint = async (progress: Omit<Progress, 'timestamp'>) => {
      try {
        const newProgress = { ...progress, timestamp: Date.now() } as Progress;
        latestProgress = newProgress;
        const cancelRequested = await this.jobService.updateJobProgressAndCheckCancel(dbJob.id, newProgress);
        if (cancelRequested) abortController.abort();
        if (abortController.signal.aborted) throw new Error(`Job ${jobId} was canceled`);
      } catch (e) {
        WSLogger.warn({ source: 'QueueService', message: 'checkpoint error (non-fatal)', error: (e as Error)?.stack ?? String(e) });
      }
    };

    try {
      const handler = this.getHandler(jobData);
      const result = await handler.run({
        jobId: dbJob.id,
        data: jobData,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        checkpoint: checkpoint as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        progress: job.progress as any,
        abortSignal: abortController.signal,
      });

      await this.jobService.updateJobStatus({
        id: dbJob.id,
        status: 'completed',
        finishedOn: new Date(),
        progress: latestProgress,
      });

      return result;
    } catch (error) {
      await this.jobService.updateJobStatus({
        id: dbJob.id,
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
        finishedOn: new Date(),
        progress: latestProgress,
      });
      throw error;
    }
  }

  private getHandler(jobData: JobData) {
    if (jobData.type === 'poll') return this.pollJob;
    throw new Error(`Unknown job type: ${String((jobData as { type: unknown }).type)}`);
  }

  async onModuleDestroy() {
    if (this.worker) await this.worker.close();
  }
}
