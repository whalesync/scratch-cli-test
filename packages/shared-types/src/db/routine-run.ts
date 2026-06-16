import { RoutineRunId, RoutineRunStepId, WorkbookId } from '../ids';

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
  folder: string | null;
  connection: string | null;
  status: RoutineRunStepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** The DbJob created for this step, if any. */
  jobId: string | null;
  /** For publish-plan / publish steps: the PublishPlan pipeline created for this step. */
  pipelineId: string | null;
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
  error: string | null;
  /** Index of the step currently executing (0-based). */
  currentStepIndex: number;
  /** Per-step records. Present on the run-detail endpoint; omitted from list responses. */
  steps?: RoutineRunStep[];
}

///
/// End "keep in sync" section
///
