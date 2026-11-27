import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DbJob, Prisma, RoutineRun as PrismaRoutineRun, RoutineRunStep as PrismaRoutineRunStep } from '@prisma/client';
import {
  createRoutineRunId,
  createRoutineRunStepId,
  DataFolderId,
  deriveJobResult,
  JobType,
  RoutineAction,
  RoutineRun,
  RoutineRunId,
  RoutineRunStepResult,
  RoutineRunTrigger,
  RoutineStep,
  RoutineStepOptions,
  SyncId,
  WorkbookId,
} from '@spinner/shared-types';
import { Job } from 'bullmq';
import { AuditLogService } from 'src/audit/audit-log.service';
import { DbService } from 'src/db/db.service';
import { JobService } from 'src/job/job.service';
import { LiveExportAccessService, ScheduleTiming } from 'src/live-export-access/live-export-access.service';
import { LiveExportRunLifecycleService } from 'src/live-export-run-store/live-export-run-lifecycle.service';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { RunCountService } from 'src/run-count/run-count.service';
import { Actor } from 'src/users/types';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { createRunContext, RunContext } from 'src/worker/jobs/base-types';
import { DiscardPendingChangesPublicProgress } from 'src/worker/jobs/job-definitions/discard-pending-changes.job';
import { PublishPublicProgress } from 'src/worker/jobs/job-definitions/publish.job';
import { PullLinkedFolderFilesPublicProgress } from 'src/worker/jobs/job-definitions/pull-linked-folder-files.job';
import { SyncDataFoldersPublicProgress } from 'src/worker/jobs/job-definitions/sync-data-folders.job';
import { RoutineRunEntity } from './entities/routine-run.entity';
import { RoutineDefinitionStoreService } from './routine-definition-store.service';
import { assertValidRoutineFilePath } from './routine-file-path';
import { RoutineParserService } from './routine-parser.service';
import {
  resolveConnectionInContext,
  resolveFoldersInContext,
  resolveSyncInContext,
  RoutineReferenceValidatorService,
} from './routine-reference-validator.service';
import {
  buildCancelReasonForTimedOutRoutineStepJob,
  computeRoutineStepDeadline,
  isJobCanceledBecauseRoutineStepTimedOut,
  resolveRoutineStepTimeoutMs,
} from './routine-step-deadline';
import { RoutineValidationContext, TERMINAL_ROUTINE_RUN_STATUSES } from './routine.types';
import { WhalesyncRunNotifierService } from './whalesync-run-notifier.service';

/** Terminal DbJob statuses — once a step's job reaches one of these the step is done. */
const TERMINAL_JOB_STATUSES = ['completed', 'failed', 'canceled'];

/** Terminal RoutineRun statuses — the loop stops re-entering once a run reaches one. */

/** The outcome of running one step, used by the loop to decide whether to advance, fail, or stop. */
type RoutineStepOutcome =
  // `summary` is the concise, user-facing result of this step, persisted to RoutineRun.resultSummary.
  // `result` is the normalized headline (summary + stat counters) persisted to RoutineRunStep.result.
  | {
      kind: 'completed';
      pipelineId: string | null;
      warning: string | null;
      summary: string;
      result: RoutineRunStepResult;
    }
  | { kind: 'failed'; error: string }
  | { kind: 'canceled' }
  // Stop driving and leave the run to RoutineRunReaperService. Either another driver already owns this step (it
  // won the per-step claim) but hasn't recorded a job id yet — the reaper resumes the run if that driver dies — or
  // this driver's wait on the step's job ended before the timeout with the job unfinished, and the reaper resumes
  // the run once that job is terminal or the step has outlived its timeout (DEV-11274).
  | { kind: 'yield' };

/** Per-trigger overrides applied to the run's step snapshot (see {@link RoutineExecutorService.triggerRun}). */
export interface TriggerRunOptions {
  /**
   * Force every pull step of this run to a full pull, whatever its YAML `options.fullPull` says.
   * The wire-level meaning is documented on `triggerRoutineSchema.forceFullPull` (shared-types).
   */
  forceFullPull?: boolean;
  /**
   * The schedule that started a `schedule` run. The Live Export speed check reads its cron and timezone to tell whether
   * the schedule already fits the team's fastest speed (DEV-12983).
   */
  schedule?: ScheduleTiming;
}

/**
 * The `options` to snapshot onto a run step: the step's own YAML options, with `fullPull: true`
 * written over a PULL step's when the run was triggered with `forceFullPull`. Non-pull steps are
 * never touched (`fullPull` is meaningless there, and the parser rejects it on them). Returns
 * `null` when the step ends up with no options at all.
 */
function resolveStepOptionsForRun(step: RoutineStep, forceFullPull: boolean): RoutineStepOptions | null {
  if (!forceFullPull || step.action !== RoutineAction.PULL) {
    return step.options;
  }
  return { ...(step.options ?? {}), fullPull: true };
}

/**
 * Runs a routine end-to-end (DEV-10436, slice 2). This is the "Option A" durable orchestrator from
 * docs/routines-step-execution.md: each step is enqueued as its own DbJob via the existing enqueuers,
 * and the loop awaits each job's terminal state via BullMQ `QueueEvents` (the fast path) while a
 * persisted `currentStepIndex` cursor + an atomic run claim + the RoutineRunReaperService make a
 * process restart recoverable.
 *
 * Lives in its own module (RoutineExecutionModule) with NO dependency on ScheduleModule, so the
 * scheduler, the controller, and the cron reaper can all drive routines without a circular module
 * dependency.
 */
@Injectable()
export class RoutineExecutorService {
  constructor(
    private readonly db: DbService,
    private readonly bullEnqueuer: BullEnqueuerService,
    private readonly jobService: JobService,
    private readonly routineDefinitionStore: RoutineDefinitionStoreService,
    private readonly parser: RoutineParserService,
    private readonly referenceValidator: RoutineReferenceValidatorService,
    private readonly auditLogService: AuditLogService,
    private readonly runCountService: RunCountService,
    private readonly liveExportRunLifecycle: LiveExportRunLifecycleService,
    private readonly whalesyncRunNotifier: WhalesyncRunNotifierService,
    @Inject(CustomMetricsService) private readonly metricsService: CustomMetricsService,
    private readonly liveExportAccessService: LiveExportAccessService,
  ) {}

  /**
   * Creates a run from the routine's CURRENT YAML (snapshotted into the run, per design Open-Q #5)
   * and kicks the executor fire-and-forget. Enforces "one active run per routine file" via the
   * partial unique index — a concurrent trigger surfaces as a P2002, mapped to 409. Returns the
   * pending run immediately so the caller can navigate to it.
   *
   * `options.forceFullPull` rewrites every pull step's snapshotted `options.fullPull` to `true` for
   * THIS run only — the routine file is untouched, and the executor reads pull mode from the step
   * snapshot (never the YAML), so the override needs no executor change and the run's own step rows
   * record that a full pull was requested. This is the "full sync" of a Live Export whose
   * destination pull is otherwise incremental (DEV-11407).
   *
   * A Live Export run is refused (403) while Whalesync has paused the team's Live Exports, and a scheduled one is
   * skipped when it comes too soon for the team's fastest speed. See
   * `LiveExportAccessService.assertLiveExportRunAllowedOrThrow`.
   */
  async triggerRun(
    workbookId: WorkbookId,
    routineFilePath: string,
    trigger: RoutineRunTrigger,
    actor?: Actor,
    options: TriggerRunOptions = {},
  ): Promise<RoutineRun> {
    assertValidRoutineFilePath(routineFilePath);

    const definition = await this.routineDefinitionStore.getDefinition(workbookId, routineFilePath);
    if (definition === null) {
      throw new NotFoundException(`Routine file ${routineFilePath} not found`);
    }

    const parseResult = this.parser.parse(definition.content);
    if ('error' in parseResult) {
      throw new BadRequestException(parseResult.error);
    }
    const routine = parseResult.routine;

    const referenceErrors = await this.referenceValidator.validateRoutine(workbookId, routine);
    if (referenceErrors.length > 0) {
      throw new BadRequestException(referenceErrors.join('; '));
    }

    // A Live Export runs only while the team's Live Export access allows it (DEV-12983). Checked before the run row
    // exists, so a refused run leaves nothing behind and a skipped scheduled run isn't counted as the last one.
    await this.liveExportAccessService.assertLiveExportRunAllowedOrThrow({
      workbookId,
      routineFilePath,
      trigger,
      schedule: options.schedule,
      now: new Date(),
    });

    const forceFullPull = options.forceFullPull === true;

    let run: PrismaRoutineRun & { steps: PrismaRoutineRunStep[] };
    try {
      run = await this.db.client.routineRun.create({
        // Return the snapshotted steps so the response can say what the run is about to start on
        // (`currentStepSummary`) — no step has a job yet, so it reads as the first step's label.
        include: { steps: { orderBy: { stepIndex: 'asc' } } },
        data: {
          id: createRoutineRunId(),
          workbookId,
          routineFilePath,
          routineName: routine.name,
          status: 'pending',
          trigger,
          triggeredByUserId: actor?.userId ?? null,
          currentStepIndex: 0,
          steps: {
            create: routine.steps.map((step, index) => {
              const stepOptions = resolveStepOptionsForRun(step, forceFullPull);
              return {
                id: createRoutineRunStepId(),
                stepIndex: index,
                action: step.action,
                name: step.name,
                folder: step.folder,
                // Scalar-list column: an absent `folders:` snapshots as an empty array (the executor
                // treats empty as "all linked folders", matching an omitted target).
                folders: step.folders ?? [],
                connection: step.connection,
                sync: step.sync,
                timeoutSeconds: step.timeout,
                // Json column rejects a bare `null`; use Prisma.DbNull for "no options".
                options: stepOptions === null ? Prisma.DbNull : (stepOptions as Prisma.InputJsonValue),
                status: 'pending',
              };
            }),
          },
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(`Routine ${routineFilePath} already has an active run`);
      }
      throw error;
    }

    if (actor) {
      await this.auditLogService.logEvent({
        actor,
        eventType: 'create',
        message: `Triggered routine "${routine.name}" (${routineFilePath})${forceFullPull ? ' with a forced full pull' : ''}`,
        entityId: workbookId,
        organizationId: actor.organizationId,
      });
    }

    // Fire-and-forget: the caller gets the pending run back; the loop drives it on this instance,
    // and the reaper recovers it if this instance dies mid-run.
    void this.execute(run.id as RoutineRunId).catch((error) =>
      WSLogger.error({
        source: 'RoutineExecutorService.triggerRun',
        message: `Routine executor crashed for run ${run.id}`,
        error,
      }),
    );

    return RoutineRunEntity.from(run, {
      currentStepSummary: RoutineRunEntity.currentStepSummaryFrom(run, run.steps, new Map()),
    });
  }

  /**
   * Marks a run `cancelled` and stops its in-flight step's worker job (so e.g. a publish does not
   * keep shipping to the external service after the user cancels). The loop observes the status
   * change and skips the remaining steps. Idempotent for an already-terminal run.
   */
  async cancelRun(workbookId: WorkbookId, runId: string, actor: Actor): Promise<RoutineRun> {
    const run = await this.db.client.routineRun.findFirst({
      where: { id: runId, workbookId },
      include: { steps: { orderBy: { stepIndex: 'asc' } } },
    });
    if (!run) {
      throw new NotFoundException(`Routine run ${runId} not found`);
    }

    if (TERMINAL_ROUTINE_RUN_STATUSES.includes(run.status)) {
      return RoutineRunEntity.from(run);
    }

    await this.db.client.routineRun.updateMany({
      where: { id: runId, status: { in: ['pending', 'running'] } },
      data: { status: 'cancelled', finishedAt: new Date(), updatedAt: new Date() },
    });

    // Stop the worker for the step currently in flight, if any.
    const inFlightStep = run.steps.find((step) => step.status === 'running' && step.jobId);
    if (inFlightStep?.jobId) {
      const dbJob = await this.jobService.getJobByBullJobId(inFlightStep.jobId);
      if (dbJob && !TERMINAL_JOB_STATUSES.includes(dbJob.status)) {
        await this.jobService.cancelJob(inFlightStep.jobId, actor);
      }
    }
    this.liveExportRunLifecycle.releaseRunStoreOfFinishedRun(runId);

    await this.auditLogService.logEvent({
      actor,
      eventType: 'update',
      message: `Cancelled routine run ${runId} (${run.routineFilePath})`,
      entityId: workbookId,
      organizationId: actor.organizationId,
    });

    const updated = await this.db.client.routineRun.findFirstOrThrow({
      where: { id: runId },
      include: { steps: { orderBy: { stepIndex: 'asc' } } },
    });
    return RoutineRunEntity.from(updated);
  }

  /**
   * Drives a run from `currentStepIndex` to completion. Safe to call repeatedly and from multiple
   * instances: the run claim plus the per-step transactional claim guarantee each step is enqueued
   * at most once and only one driver advances the run. Returns when the run reaches a terminal state
   * or yields to another driver.
   */
  async execute(runId: RoutineRunId): Promise<void> {
    const claimedRun = await this.claimRun(runId);
    if (!claimedRun) {
      // Run is terminal, missing, or owned by another driver — nothing to do.
      return;
    }

    const workbookId = claimedRun.workbookId as WorkbookId;
    const actor = await this.buildActorForRun(claimedRun);
    const context = await this.referenceValidator.loadContext(workbookId);
    // One RunContext (and RunId) for every step job of this run so they group together for debugging.
    // `trigger: 'routine'` marks these top-level step jobs; `routineRunId` links them (and any child
    // jobs they spawn) back to this run.
    const runContext = createRunContext('routine', { routineRunId: runId });

    const steps = await this.db.client.routineRunStep.findMany({
      where: { runId },
      orderBy: { stepIndex: 'asc' },
    });

    // Classic (git + Postgres) unless this is a Live Export run on the run-store engine — decided on the
    // run's first drive and kept for its whole life (see LiveExportRunLifecycleService).
    const liveExportRunStoreKey = await this.liveExportRunLifecycle.resolveRunStoreKeyForRun(
      claimedRun,
      steps.map((step) => ({
        action: step.action,
        options: step.options,
        syncId: step.sync ? (resolveSyncInContext(step.sync, context)?.id ?? null) : null,
        pullDataFolderIds:
          step.action === String(RoutineAction.PULL) ? this.resolvePullFolderIds(step, context) : undefined,
      })),
    );

    for (let index = claimedRun.currentStepIndex; index < steps.length; index++) {
      const current = await this.db.client.routineRun.findUnique({ where: { id: runId } });
      if (!current || TERMINAL_ROUTINE_RUN_STATUSES.includes(current.status)) {
        // Cancelled (or otherwise finalized) between steps — skip whatever is left and stop.
        if (current?.status === 'cancelled') {
          await this.skipStepsFrom(runId, index);
          this.liveExportRunLifecycle.releaseRunStoreOfFinishedRun(runId);
        }
        return;
      }

      const step = steps[index];
      const outcome = await this.runStep(claimedRun, step, actor, context, runContext, liveExportRunStoreKey);

      if (outcome.kind === 'yield') {
        return;
      }
      if (outcome.kind === 'failed') {
        await this.failStep(step.id, outcome.error);
        // `error` keeps the prefixed message (deprecated); `resultSummary` gets the clean step error.
        const failed = await this.failRun(
          runId,
          `Step ${index} (${step.action}) failed: ${outcome.error}`,
          outcome.error,
        );
        // A failed routine counts as one Routine run (per product decision: include failures,
        // exclude cancellations). Guarded on the transition so a reaper-resumed re-drive can't
        // double-count. Non-fatal — never breaks the run.
        if (failed) {
          await this.runCountService.recordRoutineRun({ workbookId });
          // Queue a failure email for Whalesync when this is a Live Export run (DEV-12330). Fire-and-forget: it
          // never throws, only writes an outbox row, and skips every run that isn't a Whalesync Live Export.
          void this.whalesyncRunNotifier.enqueueForRun(runId);
        }
        await this.skipStepsFrom(runId, index + 1);
        this.liveExportRunLifecycle.releaseRunStoreOfFinishedRun(runId);
        return;
      }
      if (outcome.kind === 'canceled') {
        await this.markRunCancelled(runId);
        await this.skipStepsFrom(runId, index);
        this.liveExportRunLifecycle.releaseRunStoreOfFinishedRun(runId);
        return;
      }

      await this.completeStep(step.id, outcome.pipelineId, outcome.warning, outcome.result);
      // Advance the cursor AND bump updatedAt — this is the driver's liveness signal for the reaper.
      // Overwrite resultSummary with this step's summary so a finished run reflects the LAST step run.
      await this.db.client.routineRun.updateMany({
        where: { id: runId, status: 'running' },
        data: { currentStepIndex: index + 1, resultSummary: outcome.summary, updatedAt: new Date() },
      });
    }

    const completed = await this.markRunCompleted(runId);
    this.liveExportRunLifecycle.releaseRunStoreOfFinishedRun(runId);
    // A completed routine counts as one Routine run. Guarded on the transition so a reaper-resumed
    // re-drive can't double-count. Non-fatal — never breaks the run.
    if (completed) {
      await this.runCountService.recordRoutineRun({ workbookId });
    }
  }

  // ── step execution ─────────────────────────────────────────────────────────────

  /**
   * Runs a single step: claim it (so only one driver enqueues it), enqueue its action as a DbJob,
   * await the job's terminal state (timing out per the step's resolved timeout), then classify the
   * outcome. On reaper-resume a step that already has a `jobId` is re-attached rather than re-enqueued,
   * and only waits for what is left of the step's timeout, counted from when the step was claimed.
   */
  private async runStep(
    run: PrismaRoutineRun,
    step: PrismaRoutineRunStep,
    actor: Actor,
    context: RoutineValidationContext,
    runContext: RunContext,
    liveExportRunStoreKey: string | undefined,
  ): Promise<RoutineStepOutcome> {
    let bullJobId = step.jobId;
    // When the step was claimed, which is where its timeout starts. Read from the persisted step rather than this
    // driver's memory, so a driver that re-attaches after the first one died keeps the same deadline (DEV-11274).
    let stepStartedAt = step.startedAt;
    const timeoutMs = resolveRoutineStepTimeoutMs(step);
    const timeoutSeconds = Math.round(timeoutMs / 1000);

    if (!bullJobId) {
      // Per-step claim, gated on the run still being on THIS step: serializes a rare double-drive so
      // a step is enqueued at most once and a step the run has moved past is never (re)started.
      // `step` was loaded before the claim, so keep the claim time this driver writes rather than re-reading it.
      const stepClaimedAt = new Date();
      const claimed = await this.db.client.$transaction(async (tx) => {
        const liveRun = await tx.routineRun.findUnique({ where: { id: run.id } });
        if (!liveRun || liveRun.status !== 'running' || liveRun.currentStepIndex !== step.stepIndex) {
          return false;
        }
        const res = await tx.routineRunStep.updateMany({
          where: { id: step.id, status: 'pending' },
          data: { status: 'running', startedAt: stepClaimedAt },
        });
        return res.count === 1;
      });

      if (!claimed) {
        const latest = await this.db.client.routineRunStep.findUnique({ where: { id: step.id } });
        bullJobId = latest?.jobId ?? null;
        stepStartedAt = latest?.startedAt ?? null;
        if (!bullJobId) {
          if (
            latest?.status === 'running' &&
            latest.startedAt &&
            computeRoutineStepDeadline(latest.startedAt, step).getTime() <= Date.now()
          ) {
            // The step was claimed but its job id was never recorded, and its timeout has run out: the driver that
            // claimed it died mid-enqueue. No driver is still enqueueing it, and no job id is left to cancel, so fail
            // the step. Yielding would leave the run holding its routine's active-run slot forever.
            WSLogger.warn({
              source: 'RoutineExecutorService.runStep',
              message: `Routine step ${step.stepIndex} timed out after ${timeoutSeconds}s without a recorded job; failing run ${run.id}`,
              runId: run.id,
              workbookId: run.workbookId,
              stepIndex: step.stepIndex,
              action: step.action,
              stepStartedAt: latest.startedAt.toISOString(),
              timeoutSeconds,
            });
            this.metricsService.logValue(CustomMetric.ROUTINE_STEP_TIMED_OUT, 1);
            return { kind: 'failed', error: `Step timed out after ${timeoutSeconds}s` };
          }
          return { kind: 'yield' };
        }
      } else {
        stepStartedAt = stepClaimedAt;
        let job: Job;
        try {
          job = await this.enqueueForStep(run, step, actor, context, runContext, liveExportRunStoreKey);
        } catch (error) {
          return { kind: 'failed', error: error instanceof Error ? error.message : 'Failed to enqueue step job' };
        }
        if (!job.id) {
          return { kind: 'failed', error: 'Step job was enqueued without an id' };
        }
        bullJobId = job.id;
        await this.db.client.routineRunStep.update({ where: { id: step.id }, data: { jobId: bullJobId } });
      }
    }

    // What is left of the step's timeout. A step re-attached to after its driver died gets only the rest, and one
    // already past its deadline gets none. The wall clock is read once, here, and capped at the full timeout so clock
    // skew between instances can never extend it. A step with a job always has `startedAt` (the claim writes it
    // first), so the full-timeout fallback is defensive only.
    const stepDeadline = stepStartedAt ? computeRoutineStepDeadline(stepStartedAt, step) : null;
    const remainingTimeoutMs = stepDeadline ? Math.min(stepDeadline.getTime() - Date.now(), timeoutMs) : timeoutMs;
    // Monotonic, so a wall-clock adjustment can't make a wait that ended early pass for a timeout.
    const waitForStepJobStartedAtMs = performance.now();
    // BullMQ treats a ttl of 0 as "wait forever", so a spent timeout must skip the wait rather than pass it on.
    if (remainingTimeoutMs > 0) {
      try {
        const job = await this.bullEnqueuer.getJob(bullJobId);
        if (job) {
          await job.waitUntilFinished(this.bullEnqueuer.getQueueEvents(), remainingTimeoutMs);
        }
      } catch {
        // waitUntilFinished rejects on job failure, on its ttl, OR on a Redis error. Disambiguate via the DbJob
        // below — the DbJob row (durable in Postgres) is the source of truth, not the evictable BullMQ object.
      }
    }

    const dbJob = await this.jobService.getJobByBullJobId(bullJobId);
    if (!dbJob) {
      // The enqueuer writes the DbJob before the BullMQ job, so a missing row was deleted (job cleanup ages out
      // terminal jobs). Nothing is left to wait for or cancel, so fail the step rather than wait on it forever.
      return { kind: 'failed', error: `Step job ${bullJobId} no longer exists` };
    }
    if (isJobCanceledBecauseRoutineStepTimedOut(dbJob)) {
      // Another driver already timed this step out and cancelled its job, but didn't get to fail the run (it died, or
      // is still on its way). That is a timeout, not a user's cancel, so fail the run rather than mark it cancelled.
      return { kind: 'failed', error: `Step timed out after ${timeoutSeconds}s` };
    }
    if (TERMINAL_JOB_STATUSES.includes(dbJob.status)) {
      return this.classifyOutcome(step, dbJob);
    }

    const waitForStepJobElapsedMs = performance.now() - waitForStepJobStartedAtMs;
    if (waitForStepJobElapsedMs < remainingTimeoutMs) {
      // The wait ended before the timeout with the job unfinished: a Redis error, a BullMQ job that can't be read,
      // or BullMQ failing a stalled job the worker never recorded. That is not a timeout, so never cancel a job
      // that may still be healthy. Stop driving instead; the reaper resumes the run once the job is terminal, or
      // once the step outlives its timeout.
      WSLogger.warn({
        source: 'RoutineExecutorService.runStep',
        message: `Lost track of routine step ${step.stepIndex}'s job before its timeout; leaving run ${run.id} to the reaper`,
        runId: run.id,
        workbookId: run.workbookId,
        stepIndex: step.stepIndex,
        action: step.action,
        bullJobId,
        dbJobStatus: dbJob.status,
        waitForStepJobElapsedMs: Math.round(waitForStepJobElapsedMs),
        remainingTimeoutMs,
      });
      this.metricsService.logValue(CustomMetric.ROUTINE_STEP_JOB_WAIT_ENDED_BEFORE_TIMEOUT, 1);
      return { kind: 'yield' };
    }

    // Timed out. ALWAYS cancel before failing the run so a long publish stops shipping rather than running on
    // past the run's failure.
    await this.cancelJobOfTimedOutStep(run, step, dbJob, timeoutSeconds, stepDeadline);
    return { kind: 'failed', error: `Step timed out after ${timeoutSeconds}s` };
  }

  /**
   * Cancels the job of a step that outlived its timeout. Cancels as the system: the run's actor carries no
   * workspace permissions, so the access-checked {@link JobService.cancelJob} would always refuse it (DEV-12713).
   * Never throws — the caller fails the run either way, and a run left `running` would sit there until its job
   * finished on its own. `systemCancelJob` writes the DbJob's cancel flag before it touches Redis, so even a Redis
   * failure after that still stops the worker at its next checkpoint. The cancel reason marks the job as timed out, so
   * a driver that re-attaches after this one dies fails the run instead of reading the cancel as the user's.
   */
  private async cancelJobOfTimedOutStep(
    run: PrismaRoutineRun,
    step: PrismaRoutineRunStep,
    dbJob: DbJob,
    timeoutSeconds: number,
    stepDeadline: Date | null,
  ): Promise<void> {
    const timedOutStepLogFields = {
      runId: run.id,
      workbookId: run.workbookId,
      stepIndex: step.stepIndex,
      action: step.action,
      bullJobId: dbJob.bullJobId,
      timeoutSeconds,
      stepDeadline: stepDeadline?.toISOString() ?? null,
    };
    WSLogger.warn({
      source: 'RoutineExecutorService.cancelJobOfTimedOutStep',
      message: `Routine step ${step.stepIndex} timed out after ${timeoutSeconds}s; cancelling its job and failing run ${run.id}`,
      ...timedOutStepLogFields,
    });
    this.metricsService.logValue(CustomMetric.ROUTINE_STEP_TIMED_OUT, 1);

    try {
      await this.jobService.systemCancelJob(dbJob, buildCancelReasonForTimedOutRoutineStepJob(timeoutSeconds));
    } catch (error) {
      WSLogger.error({
        source: 'RoutineExecutorService.cancelJobOfTimedOutStep',
        message: `Failed to cancel the job of timed-out routine step ${step.stepIndex}; failing run ${run.id} anyway`,
        error,
        ...timedOutStepLogFields,
      });
    }
  }

  /** Maps a step's action to the right enqueuer, resolving its folder/connection/sync against the context. */
  private async enqueueForStep(
    run: PrismaRoutineRun,
    step: PrismaRoutineRunStep,
    actor: Actor,
    context: RoutineValidationContext,
    runContext: RunContext,
    liveExportRunStoreKey: string | undefined,
  ): Promise<Job> {
    const workbookId = run.workbookId as WorkbookId;
    const action = step.action as RoutineAction;

    switch (action) {
      case RoutineAction.DISCARD_PENDING_CHANGES: {
        // Pre-flight cleanup is always workbook-wide (no folder/connection target) — it clears every
        // connection's leftover working-set edits before the run pulls anything.
        return this.bullEnqueuer.enqueueDiscardPendingChangesJob(workbookId, actor, runContext, liveExportRunStoreKey);
      }
      case RoutineAction.PULL: {
        const dataFolderIds = this.resolvePullFolderIds(step, context);
        if (dataFolderIds.length === 0) {
          throw new Error(
            `pull step has no linked folders to pull (folders=${
              step.folders.length > 0 ? step.folders.join(', ') : 'all'
            }, connection=${step.connection ?? 'all'})`,
          );
        }
        // Routine pulls default to INCREMENTAL (cheaper; the pull job auto-demotes to full on the
        // first run or when the connector lacks incremental support). A step can force a full
        // re-fetch via the YAML `options.fullPull: true` flag, snapshotted onto the run step.
        const stepOptions = step.options as RoutineStepOptions | null;
        const pullMode: 'full' | 'incremental' = stepOptions?.fullPull ? 'full' : 'incremental';
        return this.bullEnqueuer.enqueuePullLinkedFolderFilesJob(
          workbookId,
          actor,
          dataFolderIds,
          undefined,
          runContext,
          pullMode,
          liveExportRunStoreKey,
        );
      }
      case RoutineAction.PUBLISH_PLAN:
      case RoutineAction.PUBLISH: {
        const { connectorAccountId, folderPath } = this.resolvePublishTarget(step, context);
        return this.bullEnqueuer.enqueueSelfPlanningPublishJob(
          workbookId,
          actor,
          connectorAccountId,
          action === RoutineAction.PUBLISH,
          folderPath,
          runContext,
          liveExportRunStoreKey,
        );
      }
      case RoutineAction.SYNC: {
        const sync = step.sync ? resolveSyncInContext(step.sync, context) : null;
        if (!sync) {
          throw new Error(`sync step references sync "${step.sync}" which no longer exists in this workbook`);
        }
        return this.bullEnqueuer.enqueueSyncDataFoldersJob(
          workbookId,
          sync.id as SyncId,
          actor,
          undefined,
          runContext,
          liveExportRunStoreKey,
          await this.collectRecordsThisRunsPullsCouldOnlyPartlyRead(run.id),
        );
      }
      default:
        throw new Error(`Unsupported routine action "${step.action}"`);
    }
  }

  /**
   * Per source DataFolderId, the remote ids of the records this run's pulls could only partly read — every pull
   * step the run already completed lists them on its job's folders (`PullFolderProgress.warnings`, a complete list).
   * The sync step leaves each one out, so a partial copy never overwrites (or creates) its destination record. Read
   * from the persisted steps so it stays right when the run resumed on another driver. Undefined when there are none.
   */
  private async collectRecordsThisRunsPullsCouldOnlyPartlyRead(
    runId: string,
  ): Promise<Record<string, string[]> | undefined> {
    const completedPullSteps = await this.db.client.routineRunStep.findMany({
      where: { runId, action: RoutineAction.PULL, status: 'completed' },
      orderBy: { stepIndex: 'asc' },
    });
    const remoteIdsBySourceDataFolderId: Record<string, string[]> = {};
    for (const completedPullStep of completedPullSteps) {
      const pullJob = completedPullStep.jobId ? await this.jobService.getJobByBullJobId(completedPullStep.jobId) : null;
      const pullProgress = this.readPullProgress(pullJob?.progress);
      // A pull step completes with a warning exactly when it degraded records. If its job can't be read back, the
      // records can't be named — fail rather than let the sync overwrite destination records from partial copies.
      if (completedPullStep.error !== null && !pullProgress) {
        throw new Error(
          `Could not read which records pull step "${completedPullStep.name ?? completedPullStep.stepIndex}" could ` +
            'only partly read, so the sync cannot leave them out',
        );
      }
      for (const pulledFolder of pullProgress?.folders ?? []) {
        const remoteIdsOfPartlyReadRecords = (pulledFolder.warnings ?? []).map((warning) => warning.remoteId);
        if (remoteIdsOfPartlyReadRecords.length > 0) {
          remoteIdsBySourceDataFolderId[pulledFolder.id] = [
            ...(remoteIdsBySourceDataFolderId[pulledFolder.id] ?? []),
            ...remoteIdsOfPartlyReadRecords,
          ];
        }
      }
    }
    return Object.keys(remoteIdsBySourceDataFolderId).length > 0 ? remoteIdsBySourceDataFolderId : undefined;
  }

  /**
   * Resolves a pull step to the linked DataFolderIds to pull. A non-empty `folders` list resolves
   * each entry and unions the results (two entries — or a path matching several folders — can
   * overlap, so the ids are de-duplicated). An empty `folders` means "all linked folders", optionally
   * scoped by `connection`.
   */
  private resolvePullFolderIds(step: PrismaRoutineRunStep, context: RoutineValidationContext): DataFolderId[] {
    const resolvedConnection = step.connection ? resolveConnectionInContext(step.connection, context) : null;
    if (step.connection && !resolvedConnection) {
      return [];
    }

    const folders =
      step.folders.length > 0
        ? step.folders.flatMap((folderEntry) => resolveFoldersInContext(folderEntry, resolvedConnection, context))
        : [...context.foldersById.values()].filter(
            (folder) => !resolvedConnection || folder.connectorAccountId === resolvedConnection.id,
          );

    // Only folders linked to a connection are pullable; unlinked (scratch) folders are skipped.
    // De-duplicate because overlapping `folders` entries can resolve to the same DataFolder.
    const linkedFolderIds = folders
      .filter((folder) => folder.connectorAccountId !== null)
      .map((folder) => folder.id as DataFolderId);
    return [...new Set(linkedFolderIds)];
  }

  /**
   * Resolves a publish step to exactly one (connectorAccountId, folderPath) target. Publishing "all
   * connections" in one step is unsupported (it would fan out to many jobs, breaking one-step-one-job),
   * so a step with neither a folder nor a connection is rejected.
   */
  private resolvePublishTarget(
    step: PrismaRoutineRunStep,
    context: RoutineValidationContext,
  ): { connectorAccountId: string; folderPath: string | undefined } {
    const resolvedConnection = step.connection ? resolveConnectionInContext(step.connection, context) : null;
    if (step.connection && !resolvedConnection) {
      throw new Error(`publish step references connection "${step.connection}" which no longer exists`);
    }

    if (step.folder) {
      const folders = resolveFoldersInContext(step.folder, resolvedConnection, context);
      if (folders.length === 0) {
        throw new Error(`publish step references folder "${step.folder}" which no longer exists in this workbook`);
      }
      if (folders.length > 1) {
        throw new Error(`publish step folder "${step.folder}" is ambiguous across connections — add a connection`);
      }
      const folder = folders[0];
      if (!folder.connectorAccountId) {
        throw new Error(`publish step folder "${step.folder}" is not linked to a connection (not publishable)`);
      }
      // The publish job expects a leading-slash path (the validator stores paths without one).
      return { connectorAccountId: folder.connectorAccountId, folderPath: folder.path ? `/${folder.path}` : undefined };
    }

    if (!resolvedConnection) {
      throw new Error('publish step must target a folder or a connection (publishing all connections is unsupported)');
    }
    return { connectorAccountId: resolvedConnection.id, folderPath: undefined };
  }

  /** Reads a finished DbJob into a step outcome. A publish with rejected records completes WITH a warning. */
  private classifyOutcome(
    step: PrismaRoutineRunStep,
    dbJob: { status: string; error: string | null; progress: unknown },
  ): RoutineStepOutcome {
    if (dbJob.status === 'canceled') {
      return { kind: 'canceled' };
    }
    if (dbJob.status === 'failed') {
      return { kind: 'failed', error: dbJob.error ?? 'Step job failed' };
    }

    const action = step.action as RoutineAction;
    if (action === RoutineAction.PUBLISH || action === RoutineAction.PUBLISH_PLAN) {
      const publicProgress = this.readPublishProgress(dbJob.progress);
      const pipelineId = publicProgress?.pipelineId ?? null;
      const failedCount = publicProgress?.failedCount ?? 0;
      // Decision: a publish with per-record rejections COMPLETES with a warning rather than failing
      // the run — the connector accepted the rest, the run continues, and the warning + pipelineId
      // let the user inspect what was rejected.
      const warning = failedCount > 0 ? `Completed with ${failedCount} record(s) rejected by the connector` : null;
      const result = this.deriveStepResult(action, publicProgress);
      return { kind: 'completed', pipelineId, warning, summary: result.summary, result };
    }

    if (action === RoutineAction.SYNC) {
      // A sync job ends `DbJob=completed` even when a table failed — the per-table failure lives only
      // in `publicProgress.tables[].status` (the job never throws). Unlike a publish's per-record
      // rejection (complete-with-warning), a failed table is a hard failure: the destination is now
      // stale and a downstream publish would ship wrong state, so we fail the step and stop the run.
      const publicProgress = this.readSyncProgress(dbJob.progress);
      const tables = publicProgress?.tables ?? [];
      const failedTables = tables.filter((table) => table.status === 'failed');
      if (failedTables.length > 0) {
        return { kind: 'failed', error: this.summarizeSyncFailure(failedTables) };
      }
      // No table failed, but a table can still have degraded a record: a dangling foreign key whose
      // link was left empty (DEV-11222), a value written uncoerced, an invalid date nulled out. Those
      // are warn-and-skip by design — the sync is right to continue — but they must not read as a
      // clean run, so they complete WITH a warning exactly as a publish's per-record rejections do.
      const result = this.deriveStepResult(action, publicProgress);
      const warning = this.summarizeSyncWarnings(tables);
      return { kind: 'completed', pipelineId: null, warning, summary: result.summary, result };
    }

    if (action === RoutineAction.PULL) {
      // A pull job ends `DbJob=completed` even when some folders failed — the pull handler catches
      // per-folder fetch/process errors, records them in `publicProgress.folders[].status` +
      // `folderErrors`, and returns normally (it only throws when EVERY folder fails to load). This
      // mirrors sync's per-table failures exactly, so we treat it the same way: a failed folder is a
      // hard failure that stops the run. A downstream sync reads the source folder straight off disk;
      // if this pull left it stale (a failed folder keeps its old records) — or, on a full pull that
      // partially failed, in an inconsistent state — a sync's unmatched-destination `delete` policy
      // can wrongly archive/delete destination records and a publish would ship that live. Failing
      // the step here upholds the precondition the delete policy relies on: never sync/publish on a
      // pull that did not fully succeed.
      const publicProgress = this.readPullProgress(dbJob.progress);
      const failedFolders = (publicProgress?.folders ?? []).filter((folder) => folder.status === 'failed');
      if (failedFolders.length > 0) {
        return { kind: 'failed', error: this.summarizePullFailure(failedFolders) };
      }
      // No folder failed, but the connector may have kept some records in a degraded form rather than failing
      // their folder (e.g. an Intercom conversation it was refused the message history of, pulled as listed).
      // The run continues — the sync step leaves those records out (collectRecordsThisRunsPullsCouldOnlyPartlyRead),
      // so their destination records are untouched — but it completes WITH a warning, like sync's.
      const result = this.deriveStepResult(action, publicProgress);
      const warning = this.summarizePullWarnings(publicProgress?.folders ?? []);
      return { kind: 'completed', pipelineId: null, warning, summary: result.summary, result };
    }

    if (action === RoutineAction.DISCARD_PENDING_CHANGES) {
      const publicProgress = this.readDiscardProgress(dbJob.progress);
      const result = this.deriveStepResult(action, publicProgress);
      return { kind: 'completed', pipelineId: null, warning: null, summary: result.summary, result };
    }

    return {
      kind: 'completed',
      pipelineId: null,
      warning: null,
      summary: 'Step completed',
      result: { summary: 'Step completed', stats: [] },
    };
  }

  /** Maps a routine action to the job-type string the shared {@link deriveJobResult} categorizes on. */
  private jobTypeForAction(action: RoutineAction): string {
    switch (action) {
      case RoutineAction.DISCARD_PENDING_CHANGES:
        return JobType.DiscardPendingChanges;
      case RoutineAction.PULL:
        return JobType.PullLinkedFolderFiles;
      case RoutineAction.SYNC:
        return JobType.SyncDataFolders;
      case RoutineAction.PUBLISH:
      case RoutineAction.PUBLISH_PLAN:
        return JobType.Publish;
      default:
        return action;
    }
  }

  /**
   * Builds the normalized, persisted headline ({@link RoutineRunStepResult}) for a completed step from
   * its job's `publicProgress`, via the shared {@link deriveJobResult}. The same helper drives the
   * frontends' rendering, so the persisted `summary` matches what the live job detail shows. A
   * publish-plan reports planned counts; a publish reports executed counts (see `publishMode`).
   */
  private deriveStepResult(action: RoutineAction, publicProgress: unknown): RoutineRunStepResult {
    const jobResult = deriveJobResult({
      type: this.jobTypeForAction(action),
      publicProgress,
      publishMode: action === RoutineAction.PUBLISH_PLAN ? 'plan' : 'run',
    });
    return { summary: jobResult.summary, stats: jobResult.stats };
  }

  /** Safely reads `progress.publicProgress` (a JSON column) as a PublishPublicProgress, without `as any`. */
  private readPublishProgress(progress: unknown): PublishPublicProgress | undefined {
    if (progress && typeof progress === 'object' && 'publicProgress' in progress) {
      return (progress as { publicProgress?: PublishPublicProgress }).publicProgress;
    }
    return undefined;
  }

  /** Safely reads `progress.publicProgress` (a JSON column) as a SyncDataFoldersPublicProgress, without `as any`. */
  private readSyncProgress(progress: unknown): SyncDataFoldersPublicProgress | undefined {
    if (progress && typeof progress === 'object' && 'publicProgress' in progress) {
      return (progress as { publicProgress?: SyncDataFoldersPublicProgress }).publicProgress;
    }
    return undefined;
  }

  /** Safely reads `progress.publicProgress` (a JSON column) as a PullLinkedFolderFilesPublicProgress, without `as any`. */
  private readPullProgress(progress: unknown): PullLinkedFolderFilesPublicProgress | undefined {
    if (progress && typeof progress === 'object' && 'publicProgress' in progress) {
      return (progress as { publicProgress?: PullLinkedFolderFilesPublicProgress }).publicProgress;
    }
    return undefined;
  }

  /** Safely reads `progress.publicProgress` (a JSON column) as a DiscardPendingChangesPublicProgress, without `as any`. */
  private readDiscardProgress(progress: unknown): DiscardPendingChangesPublicProgress | undefined {
    if (progress && typeof progress === 'object' && 'publicProgress' in progress) {
      return (progress as { publicProgress?: DiscardPendingChangesPublicProgress }).publicProgress;
    }
    return undefined;
  }

  /** A concise, bounded summary naming the failed table(s) and their first error for the run page. */
  private summarizeSyncFailure(failedTables: SyncDataFoldersPublicProgress['tables']): string {
    const MAX_NAMED_TABLES = 3;
    const namedFailures = failedTables
      .slice(0, MAX_NAMED_TABLES)
      .map((table) => `${table.name}: ${table.errors[0]?.error ?? 'unknown error'}`);
    const overflow = failedTables.length > MAX_NAMED_TABLES ? ` (+${failedTables.length - MAX_NAMED_TABLES} more)` : '';
    return `Sync failed for ${failedTables.length} table(s) — ${namedFailures.join('; ')}${overflow}`;
  }

  /**
   * The run-page warning for a sync that completed but degraded some records — the count across every
   * table plus the first warning as an example. Null when the sync was clean, which is the signal
   * `RoutineRun.resultWarning` uses to distinguish "completed" from "completed with warnings".
   */
  private summarizeSyncWarnings(tables: SyncDataFoldersPublicProgress['tables']): string | null {
    const totalWarningCount = tables.reduce(
      (total, table) => total + (table.warningCount ?? table.warnings?.length ?? 0),
      0,
    );
    // Every table caps the warning samples it keeps, so a table with warnings can have no example to
    // show; take the first one that does rather than assuming the first warned table carries it.
    const firstWarning = tables.flatMap((table) => table.warnings ?? [])[0]?.warning;
    return this.describeCompletedWithWarnings(totalWarningCount, firstWarning);
  }

  /**
   * The run-page warning for a pull that completed but kept some records in a degraded form — the count across
   * every folder plus the first warning as an example. Null when no record was degraded.
   */
  private summarizePullWarnings(folders: PullLinkedFolderFilesPublicProgress['folders']): string | null {
    const totalWarningCount = folders.reduce(
      (total, folder) => total + (folder.warningCount ?? folder.warnings?.length ?? 0),
      0,
    );
    const firstWarning = folders.flatMap((folder) => folder.warnings ?? [])[0]?.warning;
    return this.describeCompletedWithWarnings(totalWarningCount, firstWarning);
  }

  /** "Completed with N warning(s) — e.g. <first>", or null when there were none: the step's warning text. */
  private describeCompletedWithWarnings(
    totalWarningCount: number,
    firstWarningExample: string | undefined,
  ): string | null {
    if (totalWarningCount === 0) {
      return null;
    }
    return firstWarningExample
      ? `Completed with ${totalWarningCount} warning(s) — e.g. ${firstWarningExample}`
      : `Completed with ${totalWarningCount} warning(s)`;
  }

  /** A concise, bounded summary naming the failed folder(s) and their error for the run page. */
  private summarizePullFailure(failedFolders: PullLinkedFolderFilesPublicProgress['folders']): string {
    const MAX_NAMED_FOLDERS = 3;
    const namedFailures = failedFolders
      .slice(0, MAX_NAMED_FOLDERS)
      .map((folder) => `${folder.name}: ${folder.error?.message ?? 'unknown error'}`);
    const overflow =
      failedFolders.length > MAX_NAMED_FOLDERS ? ` (+${failedFolders.length - MAX_NAMED_FOLDERS} more)` : '';
    return `Pull failed for ${failedFolders.length} folder(s) — ${namedFailures.join('; ')}${overflow}`;
  }

  // ── run/step state transitions ───────────────────────────────────────────────

  /**
   * Atomically transitions a run into `running` (from `pending` on first run, or `running` on a
   * reaper resume). Returns the claimed run, or null if it is terminal/missing/already owned.
   */
  private async claimRun(runId: string): Promise<PrismaRoutineRun | null> {
    const res = await this.db.client.routineRun.updateMany({
      where: { id: runId, status: { in: ['pending', 'running'] } },
      data: { status: 'running', updatedAt: new Date() },
    });
    if (res.count !== 1) {
      return null;
    }
    const run = await this.db.client.routineRun.findUnique({ where: { id: runId } });
    if (run && !run.startedAt) {
      return this.db.client.routineRun.update({ where: { id: runId }, data: { startedAt: new Date() } });
    }
    return run;
  }

  private async failStep(stepId: string, error: string): Promise<void> {
    await this.db.client.routineRunStep.update({
      where: { id: stepId },
      data: { status: 'failed', error, finishedAt: new Date() },
    });
  }

  private async completeStep(
    stepId: string,
    pipelineId: string | null,
    warning: string | null,
    result: RoutineRunStepResult,
  ): Promise<void> {
    await this.db.client.routineRunStep.update({
      where: { id: stepId },
      // A completed step with a non-null `error` is the "completed with warnings" signal for the UI.
      data: {
        status: 'completed',
        pipelineId,
        error: warning,
        // RoutineRunStepResult is a plain JSON-safe object but lacks an index signature, so TS won't
        // narrow it directly to Prisma's InputJsonValue — round-trip through `unknown`.
        result: result as unknown as Prisma.InputJsonValue,
        finishedAt: new Date(),
      },
    });
  }

  /** Marks every still-pending/running step from `fromIndex` onward as skipped (run failed or cancelled). */
  private async skipStepsFrom(runId: string, fromIndex: number): Promise<void> {
    await this.db.client.routineRunStep.updateMany({
      where: { runId, stepIndex: { gte: fromIndex }, status: { in: ['pending', 'running'] } },
      data: { status: 'skipped', finishedAt: new Date() },
    });
  }

  /** Returns true iff THIS call transitioned the run into `failed` (so a run is counted at most once). */
  private async failRun(runId: string, error: string, resultSummary: string): Promise<boolean> {
    const res = await this.db.client.routineRun.updateMany({
      where: { id: runId, status: 'running' },
      data: { status: 'failed', error, resultSummary, finishedAt: new Date(), updatedAt: new Date() },
    });
    return res.count === 1;
  }

  private async markRunCancelled(runId: string): Promise<void> {
    await this.db.client.routineRun.updateMany({
      where: { id: runId, status: { in: ['pending', 'running'] } },
      data: { status: 'cancelled', finishedAt: new Date(), updatedAt: new Date() },
    });
  }

  /** Returns true iff THIS call transitioned the run into `completed` (so a run is counted at most once). */
  private async markRunCompleted(runId: string): Promise<boolean> {
    // Surface the first step that finished "completed with a warning" (a completed step whose `error`
    // holds a warning, e.g. a publish with connector-rejected records) at the run level, so a consumer
    // can tell a clean completion from one with warnings without walking the steps. We read the
    // persisted steps rather than accumulating in-memory so this stays correct when the run resumed
    // across drivers (the loop only sees steps from `currentStepIndex` onward). `error` is left alone —
    // it stays reserved for an actual run failure.
    const firstStepCompletedWithWarning = await this.db.client.routineRunStep.findFirst({
      where: { runId, status: 'completed', error: { not: null } },
      orderBy: { stepIndex: 'asc' },
    });
    const res = await this.db.client.routineRun.updateMany({
      where: { id: runId, status: 'running' },
      data: {
        status: 'completed',
        resultWarning: firstStepCompletedWithWarning?.error ?? null,
        finishedAt: new Date(),
        updatedAt: new Date(),
      },
    });
    return res.count === 1;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /**
   * Builds the Actor the step jobs run as: the triggering user when known, else the org owner
   * (schedule-triggered runs have no user) — mirrors SchedulerService.buildActor.
   */
  private async buildActorForRun(run: PrismaRoutineRun): Promise<Actor> {
    const workbook = await this.db.client.workbook.findFirst({
      where: { id: run.workbookId },
      select: { organizationId: true },
    });
    if (!workbook) {
      throw new Error(`Cannot build actor for run ${run.id}: workbook ${run.workbookId} not found`);
    }
    const organizationId = workbook.organizationId;

    if (run.triggeredByUserId) {
      return { userId: run.triggeredByUserId, organizationId };
    }

    const orgUser = await this.db.client.user.findFirst({
      where: { organizationId },
      select: { id: true },
    });
    if (!orgUser) {
      throw new Error(`Cannot build actor for run ${run.id}: no users in organization ${organizationId}`);
    }
    return { userId: orgUser.id, organizationId };
  }
}
