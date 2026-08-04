import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DbJob } from '@prisma/client';
import { DbService } from 'src/db/db.service';
import { JobService } from 'src/job/job.service';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { minutes } from 'src/utils/duration';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';

const CREATED_JOB_STALE_THRESHOLD = minutes(5);

/**
 * A DbJob left `active` by a dead worker (BullMQ failed it outside a handler run, so
 * `worker.on('failed')` never wrote the row — see bull-worker.service.ts) is only a candidate once
 * it's older than this. The threshold is a churn-reducer, NOT the safety mechanism: a healthy
 * long-running job keeps its BullMQ lock auto-renewed and stays non-terminal, so the state check in
 * `reapOrphanedJob` skips it regardless of age. It must comfortably exceed the worst-case stall
 * bounce (`lockDuration 120s × maxStalledCount 20 ≈ 40 min`), hence 30+ min and explicitly not 5.
 */
const ACTIVE_JOB_STALE_THRESHOLD = minutes(30);

@Injectable()
export class StaleJobReaperService {
  constructor(
    private readonly dbService: DbService,
    private readonly jobService: JobService,
    private readonly bullEnqueuerService: BullEnqueuerService,
    @Inject(CustomMetricsService) private readonly metricsService: CustomMetricsService,
  ) {}

  /**
   * This exists because i've seen jobs that are stuck in "Created" for days with no BullMQ job, blocking other work.
   * It can be safely deleted if you don't see evidence of the logs below every having work.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async reapStaleCreatedJobs(): Promise<void> {
    const staleJobs = await this.dbService.client.dbJob.findMany({
      where: {
        status: 'created',
        createdAt: { lt: CREATED_JOB_STALE_THRESHOLD.inPast() },
      },
    });

    if (staleJobs.length === 0) return;

    WSLogger.info({
      source: 'StaleJobReaperService',
      message: `Found ${staleJobs.length} stale job(s) in 'created' status`,
    });

    for (const dbJob of staleJobs) {
      try {
        await this.reapOrphanedJob(dbJob, CustomMetric.JOB_REAPED_STALE_CREATED);
      } catch (error) {
        WSLogger.error({
          source: 'StaleJobReaperService',
          message: `Failed to reap stale created job ${dbJob.id}`,
          error,
        });
      }
    }
  }

  /**
   * Crash backstop for jobs left `active` by a dead worker. The worker sets `DbJob.status='active'`
   * on pickup and writes a terminal status only from inside its own handler; if the instance dies,
   * BullMQ eventually fails the job but `worker.on('failed')` doesn't touch the DbJob, so it stays
   * `active` forever — stranding the RoutineRun that waits on it (via `RoutineRunReaperService`) and
   * any `DataFolder.lock` it held. This reconciles those orphans back to a terminal state.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async reapStaleActiveJobs(): Promise<void> {
    const staleActiveJobs = await this.dbService.client.dbJob.findMany({
      where: {
        status: 'active',
        processedOn: { lt: ACTIVE_JOB_STALE_THRESHOLD.inPast() },
      },
    });

    if (staleActiveJobs.length === 0) return;

    WSLogger.info({
      source: 'StaleJobReaperService',
      message: `Found ${staleActiveJobs.length} stale job(s) in 'active' status`,
    });

    for (const dbJob of staleActiveJobs) {
      try {
        await this.reapOrphanedJob(dbJob, CustomMetric.JOB_REAPED_STALE_ACTIVE);
      } catch (error) {
        WSLogger.error({
          source: 'StaleJobReaperService',
          message: `Failed to reap stale active job ${dbJob.id}`,
          error,
        });
      }
    }
  }

  /**
   * Reconcile a single non-terminal DbJob whose BullMQ job is gone or terminal — i.e. no worker
   * will ever run it again — back to a terminal state, releasing any folder lock it held.
   * `reapedMetric` names the scenario for charting. Leaves the job alone (no-op) if its BullMQ job
   * is still `active`/`waiting`/`delayed`, since a live (or soon-to-be-redispatched) worker owns it.
   */
  private async reapOrphanedJob(dbJob: DbJob, reapedMetric: CustomMetric): Promise<void> {
    const bullJob = dbJob.bullJobId ? await this.bullEnqueuerService.getJob(dbJob.bullJobId) : undefined;

    let reconcileStatus: 'failed' | 'completed' = 'failed';
    if (bullJob) {
      const state = await bullJob.getState();
      if (!['completed', 'failed', 'unknown'].includes(state)) {
        // A live or soon-to-be-redispatched worker owns it — leave it alone.
        return;
      }
      if (state === 'completed') {
        // The handler finished but the instance died before writing the DbJob. Mirror completed so
        // the RoutineRun cascade doesn't fail a run whose work actually succeeded.
        reconcileStatus = 'completed';
      }
    }

    const flipped = await this.jobService.reconcileOrphanedJob(
      dbJob,
      reconcileStatus,
      reconcileStatus === 'failed' ? 'Reaped: DbJob orphaned with no live BullMQ job' : undefined,
    );

    if (flipped) {
      this.metricsService.logValue(reapedMetric, 1);
      WSLogger.info({
        source: 'StaleJobReaperService',
        message: `Reaped orphaned '${dbJob.status}' job → '${reconcileStatus}'`,
        jobId: dbJob.id,
        bullJobId: dbJob.bullJobId,
        type: dbJob.type,
        workbookId: dbJob.workbookId,
      });
    }
  }
}
