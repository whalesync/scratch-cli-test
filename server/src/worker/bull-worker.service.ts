import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';
import { JobService } from '../job/job.service';
import { JobCanceledError } from './job-errors';
import { JobHandlerService } from './job-handler.service';
import { JobResult, Progress } from './jobs/base-types';
import { JobData } from './jobs/union-types';

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private redis: IORedis | null = null;
  private pubSubRedis: IORedis | null = null;
  private worker: Worker | null = null;
  private activeJobToAbortCtrl: Map<string, AbortController> = new Map();

  constructor(
    // private readonly workerPool: WorkerPoolService,
    private readonly jobHandlerService: JobHandlerService,
    private readonly jobService: JobService,
    private readonly configService: ScratchConfigService,
  ) {}

  private getRedis(): IORedis {
    if (!this.redis) {
      this.redis = new IORedis({
        host: this.configService.getRedisHost(),
        port: this.configService.getRedisPort(),
        password: this.configService.getRedisPassword(),
        maxRetriesPerRequest: null,
      });
    }
    return this.redis;
  }

  private getPubSubRedis(): IORedis {
    if (!this.pubSubRedis) {
      this.pubSubRedis = new IORedis({
        host: this.configService.getRedisHost(),
        port: this.configService.getRedisPort(),
        password: this.configService.getRedisPassword(),
        maxRetriesPerRequest: null,
      });
    }
    return this.pubSubRedis;
  }

  onModuleInit() {
    // Create the worker to process jobs
    this.worker = new Worker('worker-queue', async (job: Job) => this.processJob(job), {
      connection: this.getRedis(),
      concurrency: this.configService.getWorkerConcurrency(),
      lockDuration: this.configService.getWorkerLockTimeout(),
    });

    // Set up event listeners
    this.worker.on('completed', (job: Job, result: JobResult) => {
      WSLogger.info({
        source: 'QueueService',
        message: 'Job completed successfully',
        jobId: job.id?.toString(),
        jobType: (job.data as JobData)?.type,
        executionTime: result?.executionTime,
      });
      // Clean up the abort controller when job completes
      if (job.id) {
        this.activeJobToAbortCtrl.delete(job.id.toString());
      }
    });

    this.worker.on('failed', (job: Job | undefined, err: Error) => {
      WSLogger.error({
        source: 'QueueService',
        message: 'Job failed',
        jobId: job?.id?.toString(),
        jobType: job ? (job.data as JobData)?.type : undefined,
        error: err.message,
        stack: err.stack,
      });
      // Clean up the abort controller when job fails
      if (job?.id) {
        this.activeJobToAbortCtrl.delete(job.id.toString());
      }
    });

    this.worker.on('error', (err: Error) => {
      WSLogger.error({
        source: 'QueueService',
        message: 'Worker error',
        error: err.message,
        stack: err.stack,
      });
    });

    // Subscribe to job cancellation messages using the separate pub/sub client
    void this.getPubSubRedis().psubscribe('job-cancel:*');
    this.getPubSubRedis().on('pmessage', (pattern, channel, message) => {
      if (pattern === 'job-cancel:*') {
        this.handleCancellationMessage(channel, message);
      }
    });
  }

  async processJob(job: Job) {
    const jobId = job.id;
    if (!jobId) {
      // Should ever happen. We need the check to make the compiler happy
      WSLogger.error({
        source: 'QueueService',
        message: 'Received an error without id. ',
      });
      throw new Error('Job ID is missing');
    }

    const jobData = job.data as JobData;
    const handler = this.jobHandlerService.getHandler(jobData);
    const abortController = new AbortController();

    WSLogger.info({
      source: 'QueueService',
      message: 'Starting job processing',
      jobId: job.id?.toString(),
      jobType: jobData.type,
      userId: jobData.userId,
    });

    // Look up the DbJob created by the enqueuer, or create one as fallback for test/legacy jobs
    let dbJob = await this.jobService.getJobByBullJobId(jobId);
    if (!dbJob) {
      dbJob = await this.jobService.createJob({
        userId: jobData.userId || 'unknown',
        type: jobData.type,
        data: jobData,
        bullJobId: job.id?.toString(),
        workbookId: (jobData as Record<string, unknown>).workbookId as string | undefined,
      });
    }

    await this.jobService.updateJobStatus({
      id: dbJob.id,
      status: 'active',
      processedOn: new Date(),
    });

    // const isLastAttempt = job.attemptsStarted < (job.opts.attempts ?? 1);

    this.activeJobToAbortCtrl.set(jobId, abortController);

    let latestProgress = job.progress as Progress;
    const checkpoint = async (progress: Omit<Progress, 'timestamp'>) => {
      if (progress) {
        const newProgress = { ...progress, timestamp: Date.now() };
        latestProgress = newProgress;
        await job.updateProgress(newProgress);
        // Write progress and check the DB cancellation flag in one round-trip
        const cancelRequested = await this.jobService.updateJobProgressAndCheckCancel(dbJob.id, newProgress);
        if (cancelRequested) {
          abortController.abort();
        }
        WSLogger.debug({
          source: 'QueueService.checkpoint',
          message: 'Progress persisted to DB',
          jobId,
          dbJobId: dbJob.id,
        });
      }
      // Check if job was cancelled (via pub/sub fast-path or DB flag above)
      if (abortController.signal.aborted) {
        throw new JobCanceledError(job.id?.toString() || 'unknown');
      }
    };

    try {
      const result = await handler.run({
        jobId: dbJob.id,
        runId: dbJob.runId ?? undefined,
        data: jobData,
        checkpoint,
        progress: job.progress as Progress<any>,
        abortSignal: abortController.signal,
      });

      await this.jobService.updateJobStatus({
        id: dbJob.id,
        status: 'completed',
        result: {},
        finishedOn: new Date(),
        progress: latestProgress,
      });

      return result;
    } catch (error) {
      // Update job status to FAILED or CANCELLED
      const status = error instanceof JobCanceledError ? 'canceled' : 'failed';
      await this.jobService.updateJobStatus({
        id: dbJob.id,
        status,
        error: error instanceof Error ? error.message : 'Unknown error',
        finishedOn: new Date(),
        progress: latestProgress,
      });

      if (error instanceof JobCanceledError) {
        WSLogger.warn({
          source: 'QueueService',
          message: 'Job was cancelled',
          jobId,
          error: error.message,
        });
        throw error;
      }
      WSLogger.error({
        source: 'QueueService',
        message: 'Job failed unexpectedly',
        jobId: job.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    } finally {
      this.activeJobToAbortCtrl.delete(jobId);
    }
  }

  private handleCancellationMessage(channel: string, message: string) {
    try {
      const data = JSON.parse(message) as { action?: string; jobId?: string };
      if (data.action === 'cancel' && data.jobId) {
        const jobId = data.jobId;
        const abortController = this.activeJobToAbortCtrl.get(jobId);

        if (abortController) {
          console.log(`Cancelling job ${jobId}`);
          abortController.abort();
        } else {
          console.log(`Job ${jobId} not found in active jobs or already completed`);
        }
      }
    } catch (error) {
      console.error('Error handling cancellation message:', error);
    }
  }

  async onModuleDestroy() {
    if (this.worker) {
      await this.worker.close();
    }
    if (this.redis) {
      await this.redis.quit();
    }
    if (this.pubSubRedis) {
      await this.pubSubRedis.quit();
    }
  }
}

export { JobCanceledError };
