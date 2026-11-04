import { RoutineRunStep as PrismaRoutineRunStep } from '@prisma/client';
import { RoutineAction } from '@spinner/shared-types';
import { ROUTINE_STEP_TIMEOUT_MAX_SECONDS } from './routine.types';

/** Fallback per-action timeout ceiling (seconds) for an unrecognized action — defensive only. */
const FALLBACK_STEP_TIMEOUT_SECONDS = 30 * 60;

/**
 * The start of the reason `JobService.systemCancelJob` writes to `DbJob.error` when it cancels the job of a timed-out
 * routine step. It is what tells a timeout cancel apart from a user's cancel once only the DbJob row is left.
 */
const TIMED_OUT_ROUTINE_STEP_JOB_CANCEL_REASON_PREFIX = 'Canceled: routine step timed out';

/** The step's timeout in ms: the snapshotted value (or the per-action default), capped at the per-action max. */
export function resolveRoutineStepTimeoutMs(step: Pick<PrismaRoutineRunStep, 'action' | 'timeoutSeconds'>): number {
  const maxSeconds = ROUTINE_STEP_TIMEOUT_MAX_SECONDS[step.action as RoutineAction] ?? FALLBACK_STEP_TIMEOUT_SECONDS;
  const seconds = step.timeoutSeconds ?? maxSeconds;
  return Math.min(seconds, maxSeconds) * 1000;
}

/**
 * When the step's timeout runs out, counted from when the step was claimed. Both inputs are persisted on the step, so
 * the deadline outlives the executor driver that started the step: the driver that re-attaches after it died, and
 * RoutineRunReaperService, both see the same deadline (DEV-11274).
 */
export function computeRoutineStepDeadline(
  stepStartedAt: Date,
  step: Pick<PrismaRoutineRunStep, 'action' | 'timeoutSeconds'>,
): Date {
  return new Date(stepStartedAt.getTime() + resolveRoutineStepTimeoutMs(step));
}

/** The reason recorded on the job of a routine step that timed out, when the executor cancels it. */
export function buildCancelReasonForTimedOutRoutineStepJob(timeoutSeconds: number): string {
  return `${TIMED_OUT_ROUTINE_STEP_JOB_CANCEL_REASON_PREFIX} after ${timeoutSeconds}s`;
}

/**
 * True when the job was canceled because its routine step timed out, rather than by a user. `updateJobStatus` never
 * overwrites a `canceled` row, so the reason `systemCancelJob` wrote survives the worker finishing afterwards.
 */
export function isJobCanceledBecauseRoutineStepTimedOut(dbJob: { status: string; error: string | null }): boolean {
  return (
    dbJob.status === 'canceled' && (dbJob.error?.startsWith(TIMED_OUT_ROUTINE_STEP_JOB_CANCEL_REASON_PREFIX) ?? false)
  );
}
