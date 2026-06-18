import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RoutineRun as PrismaRoutineRun, RoutineRunStep as PrismaRoutineRunStep } from '@prisma/client';
import {
  createRoutineRunId,
  createRoutineRunStepId,
  DataFolderId,
  RoutineAction,
  RoutineRun,
  RoutineRunId,
  RoutineRunTrigger,
  SyncId,
  WorkbookId,
} from '@spinner/shared-types';
import { Job } from 'bullmq';
import { AuditLogService } from 'src/audit/audit-log.service';
import { DbService } from 'src/db/db.service';
import { JobService } from 'src/job/job.service';
import { WSLogger } from 'src/logger';
import { MAIN_BRANCH, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { Actor } from 'src/users/types';
import { getWorkbookRepoPath } from 'src/workbook/workbook-repo.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { createRunContext, RunContext } from 'src/worker/jobs/base-types';
import { PublishPublicProgress } from 'src/worker/jobs/job-definitions/publish.job';
import { RoutineRunEntity } from './entities/routine-run.entity';
import { assertValidRoutineFilePath } from './routine-file-path';
import { RoutineParserService } from './routine-parser.service';
import {
  resolveConnectionInContext,
  resolveFoldersInContext,
  resolveSyncInContext,
  RoutineReferenceValidatorService,
} from './routine-reference-validator.service';
import { ROUTINE_STEP_TIMEOUT_MAX_SECONDS, RoutineValidationContext } from './routine.types';

/** Terminal DbJob statuses — once a step's job reaches one of these the step is done. */
const TERMINAL_JOB_STATUSES = ['completed', 'failed', 'canceled'];

/** Terminal RoutineRun statuses — the loop stops re-entering once a run reaches one. */
const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled'];

/** Fallback per-action timeout ceiling (seconds) for an unrecognized action — defensive only. */
const FALLBACK_STEP_TIMEOUT_SECONDS = 30 * 60;

/** The outcome of running one step, used by the loop to decide whether to advance, fail, or stop. */
type RoutineStepOutcome =
  | { kind: 'completed'; pipelineId: string | null; warning: string | null }
  | { kind: 'failed'; error: string }
  | { kind: 'canceled' }
  // Another driver already owns this step (it won the per-step claim) but hasn't recorded a job id
  // yet — yield to it. The reaper resumes the run if that driver dies.
  | { kind: 'yield' };

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
    private readonly scratchGitService: ScratchGitService,
    private readonly parser: RoutineParserService,
    private readonly referenceValidator: RoutineReferenceValidatorService,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * Creates a run from the routine's CURRENT YAML (snapshotted into the run, per design Open-Q #5)
   * and kicks the executor fire-and-forget. Enforces "one active run per routine file" via the
   * partial unique index — a concurrent trigger surfaces as a P2002, mapped to 409. Returns the
   * pending run immediately so the caller can navigate to it.
   */
  async triggerRun(
    workbookId: WorkbookId,
    routineFilePath: string,
    trigger: RoutineRunTrigger,
    actor?: Actor,
  ): Promise<RoutineRun> {
    assertValidRoutineFilePath(routineFilePath);

    const repoId = await this.resolveConfigRepoId(workbookId);
    const file = await this.scratchGitService.getRepoFile(repoId, MAIN_BRANCH, routineFilePath);
    if (file === null) {
      throw new NotFoundException(`Routine file ${routineFilePath} not found`);
    }

    const parseResult = this.parser.parse(file.content);
    if ('error' in parseResult) {
      throw new BadRequestException(parseResult.error);
    }
    const routine = parseResult.routine;

    const referenceErrors = await this.referenceValidator.validateRoutine(workbookId, routine);
    if (referenceErrors.length > 0) {
      throw new BadRequestException(referenceErrors.join('; '));
    }

    let run: PrismaRoutineRun;
    try {
      run = await this.db.client.routineRun.create({
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
            create: routine.steps.map((step, index) => ({
              id: createRoutineRunStepId(),
              stepIndex: index,
              action: step.action,
              folder: step.folder,
              connection: step.connection,
              sync: step.sync,
              timeoutSeconds: step.timeout,
              status: 'pending',
            })),
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
        message: `Triggered routine "${routine.name}" (${routineFilePath})`,
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

    return RoutineRunEntity.from(run);
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

    if (TERMINAL_RUN_STATUSES.includes(run.status)) {
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
    const runContext = createRunContext('job', { parentJobId: runId });

    const steps = await this.db.client.routineRunStep.findMany({
      where: { runId },
      orderBy: { stepIndex: 'asc' },
    });

    for (let index = claimedRun.currentStepIndex; index < steps.length; index++) {
      const current = await this.db.client.routineRun.findUnique({ where: { id: runId } });
      if (!current || TERMINAL_RUN_STATUSES.includes(current.status)) {
        // Cancelled (or otherwise finalized) between steps — skip whatever is left and stop.
        if (current?.status === 'cancelled') {
          await this.skipStepsFrom(runId, index);
        }
        return;
      }

      const step = steps[index];
      const outcome = await this.runStep(claimedRun, step, actor, context, runContext);

      if (outcome.kind === 'yield') {
        return;
      }
      if (outcome.kind === 'failed') {
        await this.failStep(step.id, outcome.error);
        await this.failRun(runId, `Step ${index} (${step.action}) failed: ${outcome.error}`);
        await this.skipStepsFrom(runId, index + 1);
        return;
      }
      if (outcome.kind === 'canceled') {
        await this.markRunCancelled(runId);
        await this.skipStepsFrom(runId, index);
        return;
      }

      await this.completeStep(step.id, outcome.pipelineId, outcome.warning);
      // Advance the cursor AND bump updatedAt — this is the driver's liveness signal for the reaper.
      await this.db.client.routineRun.updateMany({
        where: { id: runId, status: 'running' },
        data: { currentStepIndex: index + 1, updatedAt: new Date() },
      });
    }

    await this.markRunCompleted(runId);
  }

  // ── step execution ─────────────────────────────────────────────────────────────

  /**
   * Runs a single step: claim it (so only one driver enqueues it), enqueue its action as a DbJob,
   * await the job's terminal state (timing out per the step's resolved timeout), then classify the
   * outcome. On reaper-resume a step that already has a `jobId` is re-attached rather than re-enqueued.
   */
  private async runStep(
    run: PrismaRoutineRun,
    step: PrismaRoutineRunStep,
    actor: Actor,
    context: RoutineValidationContext,
    runContext: RunContext,
  ): Promise<RoutineStepOutcome> {
    let bullJobId = step.jobId;

    if (!bullJobId) {
      // Per-step claim, gated on the run still being on THIS step: serializes a rare double-drive so
      // a step is enqueued at most once and a step the run has moved past is never (re)started.
      const claimed = await this.db.client.$transaction(async (tx) => {
        const liveRun = await tx.routineRun.findUnique({ where: { id: run.id } });
        if (!liveRun || liveRun.status !== 'running' || liveRun.currentStepIndex !== step.stepIndex) {
          return false;
        }
        const res = await tx.routineRunStep.updateMany({
          where: { id: step.id, status: 'pending' },
          data: { status: 'running', startedAt: new Date() },
        });
        return res.count === 1;
      });

      if (!claimed) {
        const latest = await this.db.client.routineRunStep.findUnique({ where: { id: step.id } });
        bullJobId = latest?.jobId ?? null;
        if (!bullJobId) {
          return { kind: 'yield' };
        }
      } else {
        let job: Job;
        try {
          job = await this.enqueueForStep(run, step, actor, context, runContext);
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

    const timeoutMs = this.resolveTimeoutMs(step);
    try {
      const job = await this.bullEnqueuer.getJob(bullJobId);
      if (job) {
        await job.waitUntilFinished(this.bullEnqueuer.getQueueEvents(), timeoutMs);
      }
    } catch {
      // waitUntilFinished rejects on job failure OR on its ttl. Disambiguate via the DbJob below —
      // the DbJob row (durable in Postgres) is the source of truth, not the evictable BullMQ object.
    }

    const dbJob = await this.jobService.getJobByBullJobId(bullJobId);
    if (!dbJob || !TERMINAL_JOB_STATUSES.includes(dbJob.status)) {
      // Not terminal after the wait returned/threw ⇒ timed out. ALWAYS cancel before failing the run
      // so a long publish stops shipping rather than running on past the run's failure.
      await this.jobService.cancelJob(bullJobId, actor);
      return { kind: 'failed', error: `Step timed out after ${Math.round(timeoutMs / 1000)}s` };
    }

    return this.classifyOutcome(step, dbJob);
  }

  /** Maps a step's action to the right enqueuer, resolving its folder/connection/sync against the context. */
  private async enqueueForStep(
    run: PrismaRoutineRun,
    step: PrismaRoutineRunStep,
    actor: Actor,
    context: RoutineValidationContext,
    runContext: RunContext,
  ): Promise<Job> {
    const workbookId = run.workbookId as WorkbookId;
    const action = step.action as RoutineAction;

    switch (action) {
      case RoutineAction.PULL: {
        const dataFolderIds = this.resolvePullFolderIds(step, context);
        if (dataFolderIds.length === 0) {
          throw new Error(
            `pull step has no linked folders to pull (folder=${step.folder ?? 'all'}, connection=${
              step.connection ?? 'all'
            })`,
          );
        }
        // Routines run as explicit batch operations where completeness matters more than latency,
        // so a routine pull is always a FULL pull (the safe superset).
        return this.bullEnqueuer.enqueuePullLinkedFolderFilesJob(
          workbookId,
          actor,
          dataFolderIds,
          undefined,
          runContext,
          'full',
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
        );
      }
      case RoutineAction.SYNC: {
        const sync = step.sync ? resolveSyncInContext(step.sync, context) : null;
        if (!sync) {
          throw new Error(`sync step references sync "${step.sync}" which no longer exists in this workbook`);
        }
        return this.bullEnqueuer.enqueueSyncDataFoldersJob(workbookId, sync.id as SyncId, actor, undefined, runContext);
      }
      default:
        throw new Error(`Unsupported routine action "${step.action}"`);
    }
  }

  /** Resolves a pull step to the linked DataFolderIds to pull (folder/connection omitted = all linked folders). */
  private resolvePullFolderIds(step: PrismaRoutineRunStep, context: RoutineValidationContext): DataFolderId[] {
    const resolvedConnection = step.connection ? resolveConnectionInContext(step.connection, context) : null;
    if (step.connection && !resolvedConnection) {
      return [];
    }

    const folders = step.folder
      ? resolveFoldersInContext(step.folder, resolvedConnection, context)
      : [...context.foldersById.values()].filter(
          (folder) => !resolvedConnection || folder.connectorAccountId === resolvedConnection.id,
        );

    // Only folders linked to a connection are pullable; unlinked (scratch) folders are skipped.
    return folders.filter((folder) => folder.connectorAccountId !== null).map((folder) => folder.id as DataFolderId);
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
      return { kind: 'completed', pipelineId, warning };
    }

    return { kind: 'completed', pipelineId: null, warning: null };
  }

  /** Safely reads `progress.publicProgress` (a JSON column) as a PublishPublicProgress, without `as any`. */
  private readPublishProgress(progress: unknown): PublishPublicProgress | undefined {
    if (progress && typeof progress === 'object' && 'publicProgress' in progress) {
      return (progress as { publicProgress?: PublishPublicProgress }).publicProgress;
    }
    return undefined;
  }

  /** The step's timeout in ms: the snapshotted value (or the per-action default), capped at the per-action max. */
  private resolveTimeoutMs(step: PrismaRoutineRunStep): number {
    const maxSeconds = ROUTINE_STEP_TIMEOUT_MAX_SECONDS[step.action as RoutineAction] ?? FALLBACK_STEP_TIMEOUT_SECONDS;
    const seconds = step.timeoutSeconds ?? maxSeconds;
    return Math.min(seconds, maxSeconds) * 1000;
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

  private async completeStep(stepId: string, pipelineId: string | null, warning: string | null): Promise<void> {
    await this.db.client.routineRunStep.update({
      where: { id: stepId },
      // A completed step with a non-null `error` is the "completed with warnings" signal for the UI.
      data: { status: 'completed', pipelineId, error: warning, finishedAt: new Date() },
    });
  }

  /** Marks every still-pending/running step from `fromIndex` onward as skipped (run failed or cancelled). */
  private async skipStepsFrom(runId: string, fromIndex: number): Promise<void> {
    await this.db.client.routineRunStep.updateMany({
      where: { runId, stepIndex: { gte: fromIndex }, status: { in: ['pending', 'running'] } },
      data: { status: 'skipped', finishedAt: new Date() },
    });
  }

  private async failRun(runId: string, error: string): Promise<void> {
    await this.db.client.routineRun.updateMany({
      where: { id: runId, status: 'running' },
      data: { status: 'failed', error, finishedAt: new Date(), updatedAt: new Date() },
    });
  }

  private async markRunCancelled(runId: string): Promise<void> {
    await this.db.client.routineRun.updateMany({
      where: { id: runId, status: { in: ['pending', 'running'] } },
      data: { status: 'cancelled', finishedAt: new Date(), updatedAt: new Date() },
    });
  }

  private async markRunCompleted(runId: string): Promise<void> {
    await this.db.client.routineRun.updateMany({
      where: { id: runId, status: 'running' },
      data: { status: 'completed', finishedAt: new Date(), updatedAt: new Date() },
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /** Resolves the workbook config repo id (`{orgId}/{workbookId}/{workbookId}`). */
  private async resolveConfigRepoId(workbookId: WorkbookId): Promise<string> {
    const workbook = await this.db.client.workbook.findFirst({
      where: { id: workbookId },
      select: { organizationId: true },
    });
    if (!workbook) {
      throw new NotFoundException(`Workbook ${workbookId} not found`);
    }
    return getWorkbookRepoPath(workbook.organizationId, workbookId);
  }

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
