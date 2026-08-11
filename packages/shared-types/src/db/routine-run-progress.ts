import { RoutineAction } from '../enums/enums';
import { isJobStillRunning } from './job';
import { deriveJobResult } from './job-result';
import { RoutineRunStatus, RoutineRunStep } from './routine-run';

///
/// What a routine run is doing RIGHT NOW.
///
/// A run's `resultSummary` describes the last step that FINISHED, which is the wrong thing to show
/// while the run is still going (mid-run it names the previous task). The derivation here answers the
/// other question — what the run is working on at this moment — from the step currently executing and
/// that step's live job progress. It lives in shared-types beside {@link deriveJobResult} so the
/// server (which exposes it as `RoutineRun.currentStepSummary`), the web client, and the desktop app
/// all phrase it identically.
///

/** Run statuses where a run still has a step in flight (or about to start). */
const ACTIVE_ROUTINE_RUN_STATUSES: RoutineRunStatus[] = ['pending', 'running'];

/** True for a run status where the run is still going, so it has (or is about to have) a step in flight. */
export function isActiveRoutineRunStatus(status: string): boolean {
  return ACTIVE_ROUTINE_RUN_STATUSES.includes(status as RoutineRunStatus);
}

/**
 * The step a run is executing right now: the step marked `running`, else the step the run's cursor
 * points at (a step that has been claimed but not yet flipped to `running`, or the next one up on a
 * pending run), else the first step still waiting to run.
 *
 * Structural in its step type so the server can run it over raw DB rows (to decide which step's job to
 * load) and the shared derivation below can run it over the wire steps — one rule, not two.
 */
export function findRoutineRunStepInFlight<TStep extends { stepIndex: number; status: string }>(
  currentStepIndex: number,
  steps: TStep[],
): TStep | undefined {
  return (
    steps.find((step) => step.status === 'running') ??
    steps.find((step) => step.stepIndex === currentStepIndex && step.status === 'pending') ??
    steps.find((step) => step.status === 'pending')
  );
}

/**
 * A routine step's `action` column is a plain string on the wire; this narrows it back to the enum (or
 * undefined for a value this build doesn't know, e.g. a step snapshotted by a newer server).
 */
export function parseRoutineAction(action: string): RoutineAction | undefined {
  return (Object.values(RoutineAction) as string[]).includes(action) ? (action as RoutineAction) : undefined;
}

/**
 * Which publish headline a step's job should get: a `publish-plan` step STAGES a plan, every other
 * action runs. Shared so the executor, the server's run summary, and the frontends agree.
 */
export function publishModeForRoutineAction(action: string): 'plan' | 'run' {
  return parseRoutineAction(action) === RoutineAction.PUBLISH_PLAN ? 'plan' : 'run';
}

/**
 * A present-tense label for a step whose job hasn't reported progress yet (it was just enqueued, or
 * its job has aged out of retention). Prefers the step's own name from the routine YAML — that's the
 * label the user wrote for this task — and falls back to the action's own verb.
 */
export function describeRoutineActionInProgress(action: string, displayName?: string | null): string {
  if (displayName) {
    return `${displayName}…`;
  }
  switch (parseRoutineAction(action)) {
    case RoutineAction.DISCARD_PENDING_CHANGES:
      return 'Clearing leftover changes…';
    case RoutineAction.PULL:
      return 'Pulling…';
    case RoutineAction.SYNC:
      return 'Syncing…';
    case RoutineAction.PUBLISH_PLAN:
      return 'Building the publish plan…';
    case RoutineAction.PUBLISH:
      return 'Publishing…';
    default:
      return `${action}…`;
  }
}

/**
 * What an ACTIVE routine run is doing right now, as one user-facing line — the in-flight step's live
 * job progress ("Pulling Companies — 1,200 records fetched"), or the step's label when its job hasn't
 * reported anything yet ("Pull Destination…").
 *
 * Returns null for a run in a terminal state (completed / failed / cancelled): a finished run is
 * described by its `resultSummary`, not by a step in progress. Also null when the run has no step left
 * to describe. `steps[].job` is only consulted when it was loaded — without it the label falls back to
 * the step, which is still about the CURRENT step rather than the last finished one.
 */
export function deriveRoutineRunCurrentStepSummary(
  run: { status: RoutineRunStatus; currentStepIndex: number },
  steps: RoutineRunStep[],
): string | null {
  if (!isActiveRoutineRunStatus(run.status)) {
    return null;
  }

  const stepInFlight = findRoutineRunStepInFlight(run.currentStepIndex, steps);
  if (!stepInFlight) {
    return null;
  }

  const job = stepInFlight.job;
  if (job) {
    const summary = deriveJobResult({
      type: job.type,
      publicProgress: job.publicProgress,
      publishMode: publishModeForRoutineAction(stepInFlight.action),
      isRunning: isJobStillRunning(job.state),
    }).summary;
    if (summary) {
      return summary;
    }
  }

  return describeRoutineActionInProgress(stepInFlight.action, stepInFlight.displayName);
}
