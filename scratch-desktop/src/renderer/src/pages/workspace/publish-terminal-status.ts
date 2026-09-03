// DEV-10598: pure helpers for deciding how a finished publish is presented.
//
// A connection whose run-job rejected some records is stored with
// `status: 'failed'` (so the post-publish reconcile still routes those
// rejections into failed-patches.json AND clears the rows that DID publish —
// every `status === 'failed'` check depends on that). But when the same run
// also published some records, presenting the whole thing as a flat red
// "Publish failed" hides the successes. "Partial success" is therefore a
// DISPLAY-only concept derived from the per-record success/fail counts, never a
// stored status. These helpers live in a sibling `.ts` (not the `.tsx`) so they
// can be unit-tested and to satisfy `react-refresh/only-export-components`.

/**
 * Per-connection publish status as stored on `ConnectionPublishState`.
 *  - `plan-no-diff` — server's dirty matched main; nothing to publish.
 *  - `completed` — run-job terminal with no record-level failures.
 *  - `failed` — plan/run-job failed, OR the run-job reported record rejections
 *    (which may coexist with successes — the partial-success case).
 */
export type ConnectionPublishStatus = 'pending' | 'planning' | 'plan-no-diff' | 'running' | 'completed' | 'failed';

/**
 * The subset of a run's public progress that reports SUCCESSFUL record
 * operations. The wire type `PublishPublicProgress` (@spinner/shared-types) has
 * no `successCount` field — successes are the per-phase `*Executed` tallies.
 */
export interface PublishProgressExecutedCounts {
  editsExecuted?: number;
  createsExecuted?: number;
  deletesExecuted?: number;
}

/**
 * Count the records a run published successfully by summing the record-level
 * `*Executed` phases (edits + creates + deletes). This is the correct source of
 * "records published" — the desktop must NOT read a `successCount` field, which
 * the server never sends.
 */
export function publishedRecordCountFromProgress(progress: PublishProgressExecutedCounts | undefined): number {
  return (progress?.editsExecuted ?? 0) + (progress?.createsExecuted ?? 0) + (progress?.deletesExecuted ?? 0);
}

/** The subset of `ConnectionPublishState` these decisions read. */
export interface PublishTerminalConnection {
  status: ConnectionPublishStatus;
  /** Records the run-job published successfully (from the run-job progress). */
  successCount?: number;
  /** Records the run-job's connector rejected (from the run-job progress). */
  failedCount?: number;
}

export type PublishTerminalMode = 'complete' | 'partial' | 'error';

/**
 * True when a connection is stored as `failed` but actually published at least
 * one record — i.e. a partial success rather than a total failure.
 */
export function isPartialConnectionSuccess(connection: PublishTerminalConnection): boolean {
  return connection.status === 'failed' && (connection.successCount ?? 0) > 0;
}

/**
 * Decide the modal's terminal mode from every connection's outcome:
 *  - `complete` — no connection failed.
 *  - `partial` — at least one connection failed, but at least one record was
 *    still published somewhere.
 *  - `error` — at least one connection failed and NO records published at all.
 *
 * The published test is `successCount > 0`, not `status === 'completed'`: a
 * connection can fail wholesale (plan/transport/crash) with no run progress and
 * therefore zero counts, and a `completed` connection whose run was a no-op
 * publishes nothing — neither should be counted as "records published", or a
 * run where nothing went live would be mislabelled a partial success.
 */
export function decidePublishTerminalMode(connections: PublishTerminalConnection[]): PublishTerminalMode {
  const anyConnectionFailed = connections.some((connection) => connection.status === 'failed');
  if (!anyConnectionFailed) {
    return 'complete';
  }
  const anyRecordsPublished = connections.some((connection) => (connection.successCount ?? 0) > 0);
  return anyRecordsPublished ? 'partial' : 'error';
}

export interface PublishedRecordCounts {
  publishedRecordCount: number;
  failedRecordCount: number;
  totalRecordCount: number;
}

/** Aggregate the per-record success/fail counts across every connection. */
export function summarizePublishedRecordCounts(connections: PublishTerminalConnection[]): PublishedRecordCounts {
  const publishedRecordCount = connections.reduce((sum, connection) => sum + (connection.successCount ?? 0), 0);
  const failedRecordCount = connections.reduce((sum, connection) => sum + (connection.failedCount ?? 0), 0);
  return {
    publishedRecordCount,
    failedRecordCount,
    totalRecordCount: publishedRecordCount + failedRecordCount,
  };
}
