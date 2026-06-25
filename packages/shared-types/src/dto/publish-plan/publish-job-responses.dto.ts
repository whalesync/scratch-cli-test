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
