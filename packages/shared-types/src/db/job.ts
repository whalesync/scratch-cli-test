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
    | 'active'
    | 'completed'
    | 'failed'
    | 'delayed'
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
