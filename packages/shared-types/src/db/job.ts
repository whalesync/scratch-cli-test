import { RunContext } from './run-context';

/**
 * A job (pull / publish / sync / etc.) as returned by the `/jobs` endpoints.
 *
 * `state` is the superset of values the frontends observe; `processedOn` /
 * `finishedOn` are ISO-8601 strings on the wire (the server holds `Date`s that
 * serialize to strings). The server's `JobEntity` does not yet formally produce
 * this exact type — reconciling it is tracked follow-up.
 */
export interface Job<TPublicProgress = object> {
  bullJobId?: string | null;
  dbJobId?: string | null;
  runId?: string | null;
  workbookId?: string | null;
  dataFolderId?: string | null;
  state:
    | 'waiting'
    | 'waiting-children'
    | 'active'
    | 'completed'
    | 'failed'
    | 'delayed'
    | 'prioritized'
    | 'paused'
    | 'unknown'
    | 'canceled'
    | 'pending'
    | 'created';
  type: string;
  progressTimestamp?: number;
  publicProgress?: TPublicProgress;
  processedOn?: string | null;
  finishedOn?: string | null;
  failedReason?: string | null;
  runContext?: RunContext | null;
}

/** Job states where the job has stopped for good. Everything else is still on its way to one of these. */
const TERMINAL_JOB_STATES: Job['state'][] = ['completed', 'failed', 'canceled'];

/**
 * Whether a job has NOT finished yet — it is running, queued, delayed, or paused. The counterpart of a
 * terminal state, and what `deriveJobResult`'s `isRunning` input wants: a job that hasn't reached a
 * terminal state has no result yet, so its progress must be described in the present tense.
 */
export function isJobStillRunning(state: Job['state'] | undefined): boolean {
  return state != null && !TERMINAL_JOB_STATES.includes(state);
}
