/** Response for `POST .../publish-v2/plan-job`. */
export interface PlanJobResponse {
  jobId: string | number | null;
  pipelineId: string | null;
}

/** Response for `POST .../publish-v2/run-job`. */
export interface RunJobResponse {
  jobId: string | number | null;
}

/** Response for `GET /scratch-git/:id/file`. */
export interface RepoFileResponse {
  content: string;
}

/**
 * One record the destination connector rejected during a publish run-job (a
 * publish-plan operation that ended `failed-batch`). `error` carries the
 * connector's own user-facing message (e.g. Pipedrive's "'person_id' is a
 * read-only field…") so the desktop/CLI can show *why* a record didn't publish,
 * not just that something failed.
 *
 * Surfaced (bounded) on a publish run-job's terminal
 * `publicProgress.failedOperations`, alongside `failedCount` (the authoritative
 * total — the list may be capped server-side).
 *
 * Declared as a `type` (not `interface`) so it carries an implicit index
 * signature and stays assignable to the job's JSON-safe `publicProgress`
 * payload on the server. The Rust CLI mirrors this shape as `JobFailedOperation`
 * (scratch-git-2/src/cli/api/mod.rs) — keep them in sync.
 */
export type PublishFailedOperation = {
  filePath: string;
  phase: string;
  error: string | null;
  /**
   * Per-field connector rejection messages, keyed by RFC 6902 JSON Pointer
   * (e.g. `"/Organization"`). Populated when the connector attributes the
   * rejection to specific fields; `null`/absent when only a record-level
   * `error` is available. Drives the per-field "this field failed to publish"
   * warning in the desktop/web grid (the value is moved into the matching
   * `failed-patches.json` entry's `fieldErrors`). Publish is per-record atomic,
   * so a single bad field fails the whole record — `fieldErrors` is attribution,
   * not partial success.
   */
  fieldErrors?: Record<string, string> | null;
};

/**
 * Paginated response for `GET /cli/v1/workbooks/:id/publish-v2/:planId/failed-operations`
 * (DEV-10756). Unlike the run-job's terminal `publicProgress.failedOperations` — a bounded
 * display sample capped at `PUBLISH_FAILED_OPERATIONS_SUMMARY_CAP` — this route returns the
 * **complete** set of the plan's connector-rejected records (`failed-batch` operations),
 * collapsed to one entry per file path. The desktop/CLI post-publish reconcile fetches it so
 * that *every* failure (not just the first 20) is routed to `failed-patches.json`. `total` is
 * the distinct failed-record count (equal to the run's authoritative `failedCount`).
 */
export interface PublishFailedOperationsResponse {
  data: PublishFailedOperation[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * One record whose publish operation(s) the server marked `success` during a
 * run-job. This is the connector-agnostic proof that a record's approved delta
 * shipped — the post-publish reconcile drops the matching `accepted-patches.json`
 * entry on success membership rather than byte-matching the approved value
 * against a connector-normalized `main` (DEV-10741). Publish is per-record
 * atomic, so this is record-granular: `filePath` only, no per-field detail.
 *
 * Declared as an object (not a bare `string`) for symmetry with
 * `PublishFailedOperation` and to leave room for future fields.
 */
export interface PublishSucceededOperation {
  filePath: string;
}

/**
 * Paginated response for `GET /cli/v1/workbooks/:id/publish-v2/:planId/succeeded-operations`
 * (DEV-10741). The **complete** set of a plan's successfully-published records
 * (`success` operations), collapsed to one entry per file path. The desktop/CLI
 * post-publish reconcile fetches it so it can drop every shipped record's
 * accepted patch regardless of connector value normalization. `total` is the
 * distinct succeeded-record count. Mirrors `PublishFailedOperationsResponse`.
 */
export interface PublishSucceededOperationsResponse {
  data: PublishSucceededOperation[];
  total: number;
  page: number;
  pageSize: number;
}
