import { RoutineRunId, RoutineRunStepId, WorkbookId } from '../ids';
import type { Job } from './job';
import type { RoutineRunStepResult } from './job-result';
import type { RoutineStepOptions } from './routine';

///
/// NOTE: Keep this in sync with server/prisma/schema.prisma RoutineRun + RoutineRunStep models
/// Begin "keep in sync" section
///

/** Lifecycle status of a routine run. */
export type RoutineRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Lifecycle status of a single step within a routine run. */
export type RoutineRunStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/** What started a routine run. */
export type RoutineRunTrigger = 'manual' | 'schedule';

/** A single step's execution record within a routine run. */
export interface RoutineRunStep {
  id: RoutineRunStepId;
  createdAt: string;
  updatedAt: string;
  runId: RoutineRunId;
  /** 0-based position in the routine's step list. */
  stepIndex: number;
  /** The action type: "pull" | "sync" | "publish-plan" | "publish". */
  action: string;
  /** The step's human-readable name from the routine YAML (snapshot of the step's `name:`). Null when the step has no name. */
  displayName: string | null;
  /** Single-folder target snapshot (publish / publish-plan). Null on pull steps. */
  folder: string | null;
  /** Multi-folder target snapshot for a `pull` step (each a POSIX path or `dfd_…`). Empty for other actions. */
  folders: string[];
  connection: string | null;
  /** For `sync` steps: the SyncId that ran. Null for non-sync actions. */
  sync: string | null;
  /** The step's timeout in seconds (snapshot from `timeout:`). Null = the per-action default. */
  timeoutSeconds: number | null;
  /** Action-specific config snapshot from the step's `options:` map (e.g. `{ fullPull: true }`). Null if none. */
  options: RoutineStepOptions | null;
  status: RoutineRunStepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** The DbJob created for this step, if any. */
  jobId: string | null;
  /** For publish-plan / publish steps: the PublishPlan pipeline created for this step. */
  pipelineId: string | null;
  /**
   * The step's normalized headline result — a concise `summary` ("Pulled 3 records across 2 folders")
   * plus flat `stats` counters ("3 created, 0 updated"), computed server-side from the job's
   * `publicProgress` when the step completes. Persisted so it survives the job aging out of retention;
   * the richer per-folder/file breakdown is derived on demand from {@link RoutineRunStep.job}. Null
   * until the step finishes, or for a step whose job produced no recognizable progress.
   */
  result: RoutineRunStepResult | null;
  /**
   * The step's job (pull / sync / publish) in the same `Job` wire shape the `/jobs` endpoints return
   * (`publicProgress`, `state`, timestamps). Server-derived, NOT a DB column — present only when the
   * request set `includeJobs=true`; `null` when the step has no job yet or the job has aged out of
   * retention. Resolved from {@link RoutineRunStep.jobId} (the BullMQ job id).
   */
  job?: Job | null;
}

/** Execution history for a single run of a routine. */
export interface RoutineRun {
  id: RoutineRunId;
  createdAt: string;
  updatedAt: string;
  workbookId: WorkbookId;
  /** The routine file path, e.g. "routines/daily-sync.yaml". */
  routineFilePath: string;
  /** The routine name snapshotted from the YAML at trigger time. */
  routineName: string;
  status: RoutineRunStatus;
  trigger: RoutineRunTrigger;
  triggeredByUserId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /**
   * @deprecated Prefer {@link RoutineRun.resultSummary}. Kept for backward-compat — still set to the
   * prefixed "Step N (action) failed: …" message when a run fails.
   */
  error: string | null;
  /**
   * User-facing summary of the LAST step that ran (a concise success summary, or — when a step failed
   * — that step's clean error). Overwritten as each step finishes. Null until the first step finishes.
   */
  resultSummary: string | null;
  /**
   * Set when the run COMPLETED but a step finished "completed with a warning" (e.g. a publish whose
   * connector rejected some records) — holds the first such step's message. Unlike {@link error}
   * (which means the run failed), this lets a consumer distinguish "completed clean" (null) from
   * "completed with warnings" (non-null) — e.g. to show a warning icon instead of a green check on an
   * otherwise-`completed` run. Null on a clean run.
   */
  resultWarning: string | null;
  /** Index of the step currently executing (0-based). */
  currentStepIndex: number;
  /** Per-step records. Present on the run-detail endpoint; omitted from list responses. */
  steps?: RoutineRunStep[];
}

///
/// End "keep in sync" section
///
