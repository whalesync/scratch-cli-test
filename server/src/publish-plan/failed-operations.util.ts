import type { PublishFailedOperation } from '@spinner/shared-types';

/** A `publishPlanOperation` row's failure-relevant columns. */
export type FailedOperationRow = { filePath: string; phase: string; error: string | null };

/**
 * Collapse the raw `failed-batch` operation rows of a publish plan to one
 * `PublishFailedOperation` per file path.
 *
 * A single record can fail in more than one phase — e.g. a connector push that
 * the service rejected *and* that pending file's rename — which is two
 * `failed-batch` rows for one record. We keep one entry per path and prefer the
 * primary (non-`rename-files`) phase, so the surfaced reason is the service's
 * actual rejection rather than a downstream rename error.
 *
 * The order of the returned list follows first-seen order of the input rows, so
 * callers that want deterministic output should pass rows ordered by `filePath`.
 *
 * Two consumers share this rule and must never diverge (DEV-10756):
 *   - the run-job's terminal `publicProgress.failedOperations` (a bounded
 *     *display* sample — the caller slices this result to the summary cap), and
 *   - the `GET .../failed-operations` reconcile route (the *complete* set — no
 *     slice), which the desktop/CLI post-publish reconcile trusts as the full
 *     list of connector rejections.
 */
export function collapseFailedOperationsByPath(rows: FailedOperationRow[]): PublishFailedOperation[] {
  const failedOperationByPath = new Map<string, PublishFailedOperation>();
  for (const row of rows) {
    const existing = failedOperationByPath.get(row.filePath);
    if (!existing || (existing.phase === 'rename-files' && row.phase !== 'rename-files')) {
      failedOperationByPath.set(row.filePath, { filePath: row.filePath, phase: row.phase, error: row.error });
    }
  }
  return Array.from(failedOperationByPath.values());
}
