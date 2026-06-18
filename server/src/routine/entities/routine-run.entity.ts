import { RoutineRun as PrismaRoutineRun, RoutineRunStep as PrismaRoutineRunStep } from '@prisma/client';
import {
  RoutineRun,
  RoutineRunId,
  RoutineRunStatus,
  RoutineRunStep,
  RoutineRunStepId,
  RoutineRunStepStatus,
  RoutineRunSummary,
  RoutineRunTrigger,
  RoutineStepOptions,
  WorkbookId,
} from '@spinner/shared-types';

/** Builds the shared RoutineRun / RoutineRunStep wire types from Prisma rows. */
export const RoutineRunEntity = {
  /** Map a run row to the wire type. Includes `steps` only when they were loaded (run detail). */
  from(run: PrismaRoutineRun & { steps?: PrismaRoutineRunStep[] }): RoutineRun {
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
      currentStepIndex: run.currentStepIndex,
      ...(run.steps ? { steps: run.steps.map((step) => RoutineRunEntity.stepFrom(step)) } : {}),
    };
  },

  stepFrom(step: PrismaRoutineRunStep): RoutineRunStep {
    return {
      id: step.id as RoutineRunStepId,
      createdAt: step.createdAt.toISOString(),
      updatedAt: step.updatedAt.toISOString(),
      runId: step.runId as RoutineRunId,
      stepIndex: step.stepIndex,
      action: step.action,
      folder: step.folder,
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
    };
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
    };
  },
};
