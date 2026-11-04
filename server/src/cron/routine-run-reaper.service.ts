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
import { computeRoutineStepDeadline } from 'src/routine/routine-step-deadline';
import { minutes } from 'src/utils/duration';

/**
 * A RoutineRun stuck `running` whose driver hasn't advanced it within this window is a candidate for
 * reaping. Comfortably longer than the gap between steps (which is just a DB write), so a healthy
 * driver between steps is never mistaken for a dead one. It is also the grace a step gets past its
 * timeout before the reaper steps in, so a live driver times out its own step first.
 */
const ROUTINE_RUN_STALE_THRESHOLD = minutes(5);

const TERMINAL_JOB_STATUSES = ['completed', 'failed', 'canceled'];

/** Why a stale run is resumed — logged with every resume, so a reap can be traced to the state that caused it. */
type ReasonToResumeStuckRoutineRun =
  // The cursor is past the last step: every step ran, but the run was never finalized.
  | 'steps-finished-run-not-finalized'
  // The current step has no job recorded: its driver died before (or while) enqueueing it.
  | 'step-job-not-recorded'
  // The current step's job row is gone (aged out by job cleanup).
  | 'step-job-row-gone'
  // The current step's job finished, but no driver moved the run on.
  | 'step-job-terminal'
  // The current step's job is still running, past the step's timeout plus the stale threshold (DEV-11274).
  | 'step-job-past-deadline';

/**
 * Crash backstop for the routine executor (DEV-10436, slice 2). The executor is a fire-and-forget
 * loop on whichever instance triggered the run; if that instance dies mid-run, the step's job still
 * finishes but nothing advances the RoutineRun. This @Cron finds such stuck runs and resumes them.
 *
 * Liveness is judged STRUCTURALLY, not by a heartbeat (the driver is blocked in `waitUntilFinished`
 * and can't heartbeat): a run is resumed when its current step's DbJob is already terminal but the
 * run hasn't moved on. If the step's job is still active, a worker is running it (covered by BullMQ
 * stalled-recovery) and the run is left alone — until the step outlives its timeout. The timeout is
 * counted from the step's persisted `startedAt`, so it holds even when the driver that was waiting on
 * the step died (DEV-11274): the resumed executor cancels the job and fails the run.
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
        const reasonToResume = await this.findReasonToResume(run, staleCutoff);
        if (!reasonToResume) {
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
        if (reasonToResume === 'step-job-past-deadline') {
          // The executor's re-attach finds the timeout spent, cancels the job, and fails the run.
          this.metricsService.logValue(CustomMetric.ROUTINE_RUN_REAPED_PAST_STEP_DEADLINE, 1);
        }
        WSLogger.info({
          source: 'RoutineRunReaperService',
          message: `Resuming stuck '${run.status}' routine run ${run.id} from step ${run.currentStepIndex} (${reasonToResume})`,
          runId: run.id,
          reasonToResume,
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
   * Why a stale `running` run should be resumed, or null to leave it alone. It is resumed when there's
   * no live worker on its current step — the step has no job yet, its job vanished, or its job is
   * already terminal (and didn't just finish) — or when the step's job has outlived the step's timeout.
   * An active/created job within its timeout means a worker is on it — leave it to finish (or to
   * stalled-recovery).
   */
  private async findReasonToResume(
    run: PrismaRoutineRun,
    staleCutoff: Date,
  ): Promise<ReasonToResumeStuckRoutineRun | null> {
    const step = await this.db.client.routineRunStep.findFirst({
      where: { runId: run.id, stepIndex: run.currentStepIndex },
    });
    if (!step) {
      // Cursor is past the last step — all steps ran but the run was never finalized. Resume; the
      // executor's loop falls through to markRunCompleted.
      return 'steps-finished-run-not-finalized';
    }
    if (!step.jobId) {
      // Driver died before it enqueued (and recorded) the step's job. The executor re-enqueues it, or
      // fails it once its timeout has run out.
      return 'step-job-not-recorded';
    }

    const dbJob = await this.jobService.getJobByBullJobId(step.jobId);
    if (!dbJob) {
      // Job row gone (aged out by job cleanup) — the executor fails the step, since nothing is left to wait on.
      return 'step-job-row-gone';
    }
    if (!TERMINAL_JOB_STATUSES.includes(dbJob.status)) {
      // In flight — a worker owns it (BullMQ stalled-recovery is the safety net here), unless the step
      // is past its timeout by more than the stale threshold. A live driver would have timed it out and
      // failed the run by then, so the driver is gone and nothing else bounds the job (DEV-11274).
      const stepDeadline = step.startedAt ? computeRoutineStepDeadline(step.startedAt, step) : null;
      if (step.startedAt && stepDeadline && stepDeadline < staleCutoff) {
        WSLogger.warn({
          source: 'RoutineRunReaperService',
          message: `Routine run ${run.id} step ${step.stepIndex} outlived its timeout with no driver; resuming it to cancel the step's job`,
          runId: run.id,
          workbookId: run.workbookId,
          stepIndex: step.stepIndex,
          action: step.action,
          bullJobId: step.jobId,
          dbJobStatus: dbJob.status,
          stepStartedAt: step.startedAt.toISOString(),
          stepDeadline: stepDeadline.toISOString(),
        });
        return 'step-job-past-deadline';
      }
      return null;
    }
    if (dbJob.finishedOn && dbJob.finishedOn > staleCutoff) {
      // Just finished — a live driver is very likely about to advance. Give it until the next tick.
      return null;
    }
    return 'step-job-terminal';
  }
}
