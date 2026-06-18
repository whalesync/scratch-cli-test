import { RoutineRunId } from '../ids';

/** What initiated a job. `'routine'` marks the top-level jobs a routine step starts directly. */
export type JobTrigger = 'web' | 'scheduler' | 'cli' | 'job' | 'routine';

/**
 * Per-job run metadata: links jobs belonging to the same run and records what initiated them.
 * Stored on `DbJob.runContext` and surfaced by the `/jobs` endpoints.
 */
export interface RunContext {
  runId: string;
  trigger: JobTrigger;
  parentJobId?: string; // The DbJob id of the job that triggered this job
  routineRunId?: RoutineRunId; // Set when this job is part of a routine run (top-level step or nested child)
}
