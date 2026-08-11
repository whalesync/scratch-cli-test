import { RoutineRun as PrismaRoutineRun, RoutineRunStep as PrismaRoutineRunStep } from '@prisma/client';
import {
  deriveRoutineRunCurrentStepSummary,
  findRoutineRunStepInFlight,
  isActiveRoutineRunStatus,
  Job,
  RoutineRun,
  RoutineRunId,
  RoutineRunStatus,
  RoutineRunStep,
  RoutineRunStepId,
  RoutineRunStepResult,
  RoutineRunStepStatus,
  RoutineRunSummary,
  RoutineRunTrigger,
  RoutineStepOptions,
  WorkbookId,
} from '@spinner/shared-types';

/** Options for {@link RoutineRunEntity.from} — what side-loaded data to fold into the wire run. */
export interface RoutineRunEntityOptions {
  /** Resolved step jobs keyed by BullMQ job id. Provided only when the request asked to include jobs. */
  jobsByBullJobId?: Map<string, Job>;
  /**
   * What the run is doing right now (see {@link RoutineRun.currentStepSummary}). Computed by the
   * caller, which owns the queries needed to resolve the in-flight step's live job — the entity itself
   * stays a pure row→wire mapper. Null/omitted for a terminal run.
   */
  currentStepSummary?: string | null;
}

/** Builds the shared RoutineRun / RoutineRunStep wire types from Prisma rows. */
export const RoutineRunEntity = {
  /**
   * Map a run row to the wire type. Includes `steps` only when they were loaded (run detail).
   * When `options.jobsByBullJobId` is provided (the request asked to include jobs), each step also
   * carries its resolved `job` — see {@link RoutineRunEntity.stepFrom}.
   */
  from(run: PrismaRoutineRun & { steps?: PrismaRoutineRunStep[] }, options: RoutineRunEntityOptions = {}): RoutineRun {
    const { jobsByBullJobId, currentStepSummary } = options;
    return {
      id: run.id as RoutineRunId,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      workbookId: run.workbookId as WorkbookId,
      routineFilePath: run.routineFilePath,
      routineName: run.routineName,
      status: run.status as RoutineRunStatus,
      trigger: run.trigger as RoutineRunTrigger,
      triggeredByUserId: run.triggeredByUserId,
      startedAt: run.startedAt ? run.startedAt.toISOString() : null,
      finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
      error: run.error,
      resultSummary: run.resultSummary,
      currentStepSummary: currentStepSummary ?? null,
      resultWarning: run.resultWarning,
      currentStepIndex: run.currentStepIndex,
      ...(run.steps ? { steps: run.steps.map((step) => RoutineRunEntity.stepFrom(step, jobsByBullJobId)) } : {}),
    };
  },

  /**
   * Map a step row to the wire type. When `jobsByBullJobId` is provided, the step's `job` is set from
   * its `jobId` (the BullMQ job id) — `null` if the step has no job yet or its job is not in the map
   * (e.g. aged out of retention). When the map is omitted the `job` field is left off entirely, so
   * `includeJobs=false` responses are unchanged.
   */
  stepFrom(step: PrismaRoutineRunStep, jobsByBullJobId?: Map<string, Job>): RoutineRunStep {
    return {
      id: step.id as RoutineRunStepId,
      createdAt: step.createdAt.toISOString(),
      updatedAt: step.updatedAt.toISOString(),
      runId: step.runId as RoutineRunId,
      stepIndex: step.stepIndex,
      action: step.action,
      displayName: step.name,
      folder: step.folder,
      folders: step.folders,
      connection: step.connection,
      sync: step.sync,
      timeoutSeconds: step.timeoutSeconds,
      options: (step.options as RoutineStepOptions | null) ?? null,
      status: step.status as RoutineRunStepStatus,
      startedAt: step.startedAt ? step.startedAt.toISOString() : null,
      finishedAt: step.finishedAt ? step.finishedAt.toISOString() : null,
      error: step.error,
      jobId: step.jobId,
      pipelineId: step.pipelineId,
      result: (step.result as RoutineRunStepResult | null) ?? null,
      ...(jobsByBullJobId ? { job: step.jobId ? (jobsByBullJobId.get(step.jobId) ?? null) : null } : {}),
    };
  },

  /**
   * What a run is doing RIGHT NOW ({@link RoutineRun.currentStepSummary}), derived from its step ROWS
   * plus whatever step jobs the caller loaded. Null for a terminal run, and for an active run whose
   * steps weren't loaded. When the in-flight step's job is absent from the map (not loaded, not
   * enqueued yet, or aged out of retention) this still describes the CURRENT step — by its label —
   * rather than falling back to the last step that finished.
   */
  currentStepSummaryFrom(
    run: PrismaRoutineRun,
    steps: PrismaRoutineRunStep[] | undefined,
    jobsByBullJobId: Map<string, Job>,
  ): string | null {
    return deriveRoutineRunCurrentStepSummary(
      { status: run.status as RoutineRunStatus, currentStepIndex: run.currentStepIndex },
      (steps ?? []).map((step) => RoutineRunEntity.stepFrom(step, jobsByBullJobId)),
    );
  },

  /**
   * The step ROW a run is executing right now, or undefined when it has none (terminal run, or every
   * step already finished). Lets a caller load just that step's job instead of every step's.
   */
  inFlightStepRowFrom(run: PrismaRoutineRun, steps: PrismaRoutineRunStep[]): PrismaRoutineRunStep | undefined {
    if (!isActiveRoutineRunStatus(run.status)) {
      return undefined;
    }
    return findRoutineRunStepInFlight(run.currentStepIndex, steps);
  },

  /** Compact summary for the routine-list `latestRun` field. */
  summaryFrom(run: PrismaRoutineRun): RoutineRunSummary {
    return {
      id: run.id as RoutineRunId,
      status: run.status as RoutineRunStatus,
      trigger: run.trigger as RoutineRunTrigger,
      startedAt: run.startedAt ? run.startedAt.toISOString() : null,
      finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
      createdAt: run.createdAt.toISOString(),
      completedWithWarning: run.status === 'completed' && run.resultWarning != null,
    };
  },
};
