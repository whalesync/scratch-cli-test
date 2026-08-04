import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RoutineRun as PrismaRoutineRun } from '@prisma/client';
import { RoutineRunId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { JobService } from 'src/job/job.service';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { RoutineExecutorService } from 'src/routine/routine-executor.service';
import { minutes } from 'src/utils/duration';

/**
 * A RoutineRun stuck `running` whose driver hasn't advanced it within this window is a candidate for
 * reaping. Comfortably longer than the gap between steps (which is just a DB write), so a healthy
 * driver between steps is never mistaken for a dead one.
 */
const ROUTINE_RUN_STALE_THRESHOLD = minutes(5);

const TERMINAL_JOB_STATUSES = ['completed', 'failed', 'canceled'];

/**
 * Crash backstop for the routine executor (DEV-10436, slice 2). The executor is a fire-and-forget
 * loop on whichever instance triggered the run; if that instance dies mid-run, the step's job still
 * finishes but nothing advances the RoutineRun. This @Cron finds such stuck runs and resumes them.
 *
 * Liveness is judged STRUCTURALLY, not by a heartbeat (the driver is blocked in `waitUntilFinished`
 * and can't heartbeat): a run is only resumed when its current step's DbJob is already terminal but
 * the run hasn't moved on. If the step's job is still active, a worker is running it (covered by
 * BullMQ stalled-recovery) and the run is left alone.
 */
@Injectable()
export class RoutineRunReaperService {
  constructor(
    private readonly db: DbService,
    private readonly jobService: JobService,
    private readonly routineExecutorService: RoutineExecutorService,
    @Inject(CustomMetricsService) private readonly metricsService: CustomMetricsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reapStuckRoutineRuns(): Promise<void> {
    const staleCutoff = ROUTINE_RUN_STALE_THRESHOLD.inPast();
    // Both 'pending' (created but never claimed — the driver died between create and claimRun) and
    // 'running' runs occupy the partial unique index that blocks re-triggering, so both are reapable.
    const stuckRuns = await this.db.client.routineRun.findMany({
      where: { status: { in: ['pending', 'running'] }, updatedAt: { lt: staleCutoff } },
    });

    if (stuckRuns.length === 0) {
      return;
    }

    WSLogger.info({
      source: 'RoutineRunReaperService',
      message: `Found ${stuckRuns.length} possibly-stuck running routine run(s)`,
    });

    for (const run of stuckRuns) {
      try {
        if (!(await this.shouldResume(run, staleCutoff))) {
          continue;
        }

        // Atomic re-claim: only the reaper that flips updatedAt (count === 1) drives the resume. The
        // `updatedAt < staleCutoff` guard also loses to a driver that advanced in the meantime.
        const claimed = await this.db.client.routineRun.updateMany({
          where: { id: run.id, status: { in: ['pending', 'running'] }, updatedAt: { lt: staleCutoff } },
          data: { updatedAt: new Date() },
        });
        if (claimed.count !== 1) {
          continue;
        }

        this.metricsService.logValue(CustomMetric.ROUTINE_RUN_REAPED, 1);
        WSLogger.info({
          source: 'RoutineRunReaperService',
          message: `Resuming stuck '${run.status}' routine run ${run.id} from step ${run.currentStepIndex}`,
        });
        await this.routineExecutorService.execute(run.id as RoutineRunId);
      } catch (error) {
        WSLogger.error({
          source: 'RoutineRunReaperService',
          message: `Failed to reap routine run ${run.id}`,
          error,
        });
      }
    }
  }

  /**
   * A stale `running` run should be resumed only when there's no live worker on its current step:
   * the step has no job yet, its job vanished, or its job is already terminal (and didn't just
   * finish). An active/created job means a worker is on it — leave it to finish (or to stalled-recovery).
   */
  private async shouldResume(run: PrismaRoutineRun, staleCutoff: Date): Promise<boolean> {
    const step = await this.db.client.routineRunStep.findFirst({
      where: { runId: run.id, stepIndex: run.currentStepIndex },
    });
    if (!step) {
      // Cursor is past the last step — all steps ran but the run was never finalized. Resume; the
      // executor's loop falls through to markRunCompleted.
      return true;
    }
    if (!step.jobId) {
      // Driver died before it enqueued (and recorded) the step's job.
      return true;
    }

    const dbJob = await this.jobService.getJobByBullJobId(step.jobId);
    if (!dbJob) {
      // Job row gone — the executor's re-attach branch re-enqueues.
      return true;
    }
    if (!TERMINAL_JOB_STATUSES.includes(dbJob.status)) {
      // Genuinely in flight — a worker owns it (BullMQ stalled-recovery is the safety net here).
      return false;
    }
    if (dbJob.finishedOn && dbJob.finishedOn > staleCutoff) {
      // Just finished — a live driver is very likely about to advance. Give it until the next tick.
      return false;
    }
    return true;
  }
}
