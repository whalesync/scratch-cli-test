import { Inject, Injectable, OnApplicationShutdown, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';
import {
  CustomMetric,
  JOB_CANCELED_METRIC,
  JOB_COMPLETED_METRIC,
  JOB_FAILED_METRIC,
  JOB_STALLED_METRIC,
} from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { RunCountService } from 'src/run-count/run-count.service';
import { JobService } from '../job/job.service';
import { JobCanceledError } from './job-errors';
import { JobHandlerService } from './job-handler.service';
import { JobResult, Progress, RunContext } from './jobs/base-types';
import { JobData, JobProgress } from './jobs/union-types';
import { WORKER_QUEUE_NAME, WORKER_QUEUE_STREAM_OPTIONS } from './worker-queue.constants';

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown {
  private redis: IORedis | null = null;
  private pubSubRedis: IORedis | null = null;
  private worker: Worker | null = null;
  private queue: Queue | null = null;
  private activeJobToAbortCtrl: Map<string, AbortController> = new Map();

  constructor(
    private readonly jobHandlerService: JobHandlerService,
    private readonly jobService: JobService,
    private readonly configService: ScratchConfigService,
    @Inject(CustomMetricsService) private readonly metricsService: CustomMetricsService,
    private readonly runCountService: RunCountService,
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
    // Create a queue instance for job lookups (e.g. stalled events)
    this.queue = new Queue(WORKER_QUEUE_NAME, { connection: this.getRedis(), streams: WORKER_QUEUE_STREAM_OPTIONS });

    // Create the worker to process jobs
    // maxStalledCount is high because Cloud Run instances are ephemeral and
    // non-graceful shutdowns can cause false stall detections.
    this.worker = new Worker(WORKER_QUEUE_NAME, async (job: Job) => this.processJob(job), {
      connection: this.getRedis(),
      concurrency: this.configService.getWorkerConcurrency(),
      lockDuration: this.configService.getWorkerLockTimeout(),
      maxStalledCount: 20,
    });

    // Set up event listeners
    this.worker.on('completed', (job: Job, result: JobResult) => {
      const jobType = (job.data as JobData)?.type;
      WSLogger.info({
        source: 'QueueService',
        message: 'Job completed successfully',
        jobId: job.id?.toString(),
        jobType,
        executionTime: result?.executionTime,
      });
      if (jobType && jobType in JOB_COMPLETED_METRIC) {
        this.metricsService.logValue(JOB_COMPLETED_METRIC[jobType], 1);
      }
      // Count this as a per-org monthly run execution (Pull/Publish/Sync). Fired here in the
      // once-per-final-completion event listener (not in processJob, which re-runs on stall
      // re-dispatch) so a stalled-then-resumed job is counted exactly once. Self-filters to counted
      // job types; non-fatal (never throws).
      if (jobType) {
        const data = job.data as { workbookId?: string; organizationId?: string };
        void this.runCountService.recordJobRun({
          jobType,
          workbookId: data.workbookId,
          organizationId: data.organizationId,
        });
      }
      // Clean up the abort controller when job completes
      if (job.id) {
        this.activeJobToAbortCtrl.delete(job.id.toString());
      }
    });

    this.worker.on('failed', (job: Job | undefined, err: Error) => {
      const jobType = job ? (job.data as JobData)?.type : undefined;
      WSLogger.error({
        source: 'QueueService',
        message: 'Job failed',
        jobId: job?.id?.toString(),
        jobType,
        error: err.message,
        stack: err.stack,
      });
      if (jobType && jobType in JOB_FAILED_METRIC) {
        if (err instanceof JobCanceledError) {
          this.metricsService.logValue(JOB_CANCELED_METRIC[jobType], 1);
        } else {
          this.metricsService.logValue(JOB_FAILED_METRIC[jobType], 1);
        }
      }
      // Count failed runs toward the per-org monthly run execution totals, but NOT user
      // cancellations (a cancelled run is not a billable execution). Non-fatal.
      if (job && jobType && !(err instanceof JobCanceledError)) {
        const data = job.data as { workbookId?: string; organizationId?: string };
        void this.runCountService.recordJobRun({
          jobType,
          workbookId: data.workbookId,
          organizationId: data.organizationId,
        });
      }
      // Clean up the abort controller when job fails
      if (job?.id) {
        this.activeJobToAbortCtrl.delete(job.id.toString());
      }

      // Belt-and-suspenders crash recovery: when BullMQ fails a job OUTSIDE a handler run (stall
      // exhaustion, or a job whose instance died), processJob's catch never ran, so the DbJob is
      // still 'active'/'created'. Reconcile it to 'failed' (guarded — a no-op if the handler already
      // wrote a terminal status) and release any folder lock it held, so recovery doesn't wait a full
      // StaleJobReaper cron tick. User cancellations are already handled by processJob's catch.
      if (job?.id && !(err instanceof JobCanceledError)) {
        const bullJobId = job.id.toString();
        void (async () => {
          try {
            const dbJob = await this.jobService.getJobByBullJobId(bullJobId);
            if (dbJob && (await this.jobService.reconcileOrphanedJob(dbJob, 'failed', err.message))) {
              this.metricsService.logValue(CustomMetric.JOB_RECONCILED_ON_FAILED_EVENT, 1);
              WSLogger.warn({
                source: 'QueueService',
                message: 'Reconciled orphaned DbJob after BullMQ-declared failure',
                jobId: bullJobId,
                jobType,
              });
            }
          } catch (reconcileError) {
            WSLogger.warn({
              source: 'QueueService',
              message: 'Failed to reconcile orphaned DbJob after job failure',
              jobId: bullJobId,
              error: reconcileError,
            });
          }
        })();
      }
    });

    this.worker.on('error', (err: Error) => {
      WSLogger.error({
        source: 'QueueService',
        message: 'Worker error',
        error: err.message,
        stack: err.stack,
      });
      this.metricsService.logValue(CustomMetric.JOB_WORKER_ERROR, 1);
    });

    this.worker.on('stalled', (jobId: string) => {
      WSLogger.warn({
        source: 'QueueService',
        message: 'Job stalled',
        jobId,
      });

      const queue = this.queue;

      if (!queue) {
        WSLogger.error({
          source: 'QueueService',
          message: 'Queue is not initialized',
          jobId,
        });
        return;
      }
      // Fetch the job to determine its type for the metric
      void Job.fromId(queue, jobId)
        .then((job) => {
          const jobType = job ? (job.data as JobData)?.type : undefined;
          if (jobType && jobType in JOB_STALLED_METRIC) {
            this.metricsService.logValue(JOB_STALLED_METRIC[jobType], 1);
          }
        })
        .catch((err) => {
          WSLogger.error({
            source: 'QueueService',
            message: 'Failed to fetch stalled job for metrics',
            jobId,
            error: err instanceof Error ? err.message : 'Unknown error',
          });
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
        await this.persistProgressToBullJobHashWithoutEmittingEvent(jobId, JSON.stringify(newProgress));
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
      const runContext = dbJob.runContext as RunContext | null;
      const result = await handler.run({
        jobId: dbJob.id,
        runId: dbJob.runId ?? undefined,
        routineRunId: runContext?.routineRunId,
        data: jobData,
        checkpoint,
        progress: job.progress as JobProgress,
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

  /**
   * Persist checkpoint progress to the BullMQ job hash (`bull:worker-queue:<jobId>` field
   * `progress`) WITHOUT emitting a `progress` event. `job.updateProgress()` would additionally
   * XADD the entire progress JSON to the shared events stream, which is trimmed by entry count,
   * not size — large per-page pull progress payloads filled the whole 1 GB production Redis that
   * way on 2026-07-10. Nothing consumes `progress` events (the only stream consumer is
   * `job.waitUntilFinished`, which needs `completed`/`failed`), while the hash copy IS load-bearing:
   * it is the resume state handed to handlers as `job.progress` and what the job-inspection
   * endpoints read. Mirrors BullMQ's updateProgress-3.lua minus the XADD, including its
   * exists-guard so a job removed mid-flight is not resurrected as a stray progress-only hash.
   */
  private async persistProgressToBullJobHashWithoutEmittingEvent(
    bullJobId: string,
    progressJson: string,
  ): Promise<void> {
    const queue = this.queue;
    if (!queue) {
      throw new Error('Queue is not initialized');
    }
    const scriptResult = await this.getRedis().eval(
      'if redis.call("EXISTS", KEYS[1]) == 1 then redis.call("HSET", KEYS[1], "progress", ARGV[1]) return 0 else return -1 end',
      1,
      queue.toKey(bullJobId),
      progressJson,
    );
    if (scriptResult === -1) {
      // Parity with job.updateProgress(), which throws when the job hash is gone (BullMQ's
      // "Missing key for job" error): a job removed mid-run must fail fast at its next
      // checkpoint, not keep doing side-effect work against a deleted job.
      throw new Error(`Cannot persist progress: BullMQ job ${bullJobId} no longer exists in Redis`);
    }
  }

  private handleCancellationMessage(channel: string, message: string) {
    try {
      const data = JSON.parse(message) as { action?: string; jobId?: string };
      if (data.action === 'cancel' && data.jobId) {
        const jobId = data.jobId;
        const abortController = this.activeJobToAbortCtrl.get(jobId);

        if (abortController) {
          WSLogger.info({ source: 'QueueService', message: `Cancelling job ${jobId}` });
          abortController.abort();
        } else {
          WSLogger.info({
            source: 'QueueService',
            message: `Job ${jobId} not found in active jobs or already completed`,
          });
        }
      }
    } catch (error) {
      WSLogger.error({ source: 'QueueService', message: 'Error handling cancellation message', error });
    }
  }

  async onModuleDestroy() {
    // Phase 1 of graceful shutdown (DEV-11184), mirroring the sibling bottlenose convention
    // (onModuleDestroy -> pause, onApplicationShutdown -> close). NestJS only reaches these hooks
    // because main.ts calls enableShutdownHooks(). Pausing here — the instant SIGTERM lands — stops
    // the worker pulling NEW jobs and drains the in-flight one(s), while leaving Redis connected so
    // the enqueuer/HTTP layer can keep working. We disconnect later, in onApplicationShutdown, once
    // the HTTP server has drained. The drain is bounded so a long-running job can't hang the shutdown
    // sequence past Cloud Run's ~10s grace or starve the later onApplicationShutdown hooks.
    await this.drainWorkerWithinShutdownBudget();
  }

  async onApplicationShutdown() {
    // Phase 2 of graceful shutdown (DEV-11184): disconnect as late as possible, after HTTP
    // connections have terminated. Force-close the worker (its jobs already drained in
    // onModuleDestroy, or the budget was exceeded and we must not wait again), then best-effort close
    // the Queue and Redis clients this service owns.
    await this.disconnectWorker();
    await this.quitOwnedConnectionsBestEffort();
  }

  /**
   * Race the BullMQ worker's pause (which stops new-job intake and waits for the in-flight handler(s)
   * to finish, with no internal timeout) against the configured shutdown budget. On timeout we
   * proceed rather than block: onApplicationShutdown force-closes the worker, and the in-flight job is
   * left for the next instance, which re-runs it idempotently via stall-recovery / the DEV-11146
   * reaper.
   */
  private async drainWorkerWithinShutdownBudget(): Promise<void> {
    const worker = this.worker;
    if (!worker) {
      return;
    }
    const shutdownBudgetMs = this.configService.getWorkerShutdownTimeoutMs();
    // Swallow a late rejection (e.g. the worker being force-closed in onApplicationShutdown while this
    // pause is still pending) so it can't surface as an unhandledRejection after we've moved on.
    const drainedOrRejected = worker
      .pause()
      .then(() => 'drained' as const)
      .catch(() => 'drained' as const);
    let shutdownBudgetTimeoutHandle: NodeJS.Timeout | undefined;
    const budgetExceeded = new Promise<'timed_out'>((resolve) => {
      shutdownBudgetTimeoutHandle = setTimeout(() => resolve('timed_out'), shutdownBudgetMs);
    });
    const outcome = await Promise.race([drainedOrRejected, budgetExceeded]);
    if (shutdownBudgetTimeoutHandle) {
      clearTimeout(shutdownBudgetTimeoutHandle);
    }
    if (outcome === 'timed_out') {
      WSLogger.warn({
        source: 'QueueService',
        message: `Worker did not finish draining within the ${shutdownBudgetMs}ms shutdown budget; proceeding so the remaining shutdown hooks run before SIGKILL. In-flight job(s) will be re-processed idempotently on the next instance.`,
      });
      this.metricsService.logValue(CustomMetric.WORKER_SHUTDOWN_TIMED_OUT, 1);
    } else {
      WSLogger.info({
        source: 'QueueService',
        message: 'Worker drained in-flight jobs and paused on shutdown',
      });
      this.metricsService.logValue(CustomMetric.WORKER_SHUTDOWN_DRAINED, 1);
    }
  }

  /**
   * Force-close the worker to disconnect its dedicated blocking Redis client. `close(true)` skips
   * waiting for in-flight jobs: they either already drained during the onModuleDestroy pause, or the
   * drain budget was exceeded and we must not re-wait here (BullMQ's graceful close has no internal
   * timeout and would block until SIGKILL, starving the shutdown hooks ordered after this one).
   */
  private async disconnectWorker(): Promise<void> {
    const worker = this.worker;
    if (!worker) {
      return;
    }
    try {
      await worker.close(true);
    } catch (error) {
      this.logShutdownCloseFailure('worker', error);
    }
  }

  /**
   * Best-effort teardown of the connections QueueService owns. BullMQ never closes the shared command
   * connection (`this.redis`) itself, so we must. Each close is guarded so one failure can't abort the
   * NestJS shutdown chain, and always runs so the process can still exit cleanly on a local Ctrl+C.
   */
  private async quitOwnedConnectionsBestEffort(): Promise<void> {
    const { queue, redis, pubSubRedis } = this;
    if (queue) {
      try {
        await queue.close();
      } catch (error) {
        this.logShutdownCloseFailure('queue', error);
      }
    }
    if (redis) {
      try {
        await redis.quit();
      } catch (error) {
        this.logShutdownCloseFailure('redis', error);
      }
    }
    if (pubSubRedis) {
      try {
        await pubSubRedis.quit();
      } catch (error) {
        this.logShutdownCloseFailure('pubSubRedis', error);
      }
    }
  }

  private logShutdownCloseFailure(resource: string, error: unknown): void {
    WSLogger.warn({
      source: 'QueueService',
      message: `Failed to close ${resource} during shutdown`,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export { JobCanceledError };
