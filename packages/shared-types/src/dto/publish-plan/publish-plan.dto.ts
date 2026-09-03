import { PublishPlanStatus } from '../../enums/enums';
import type { FileDiffStatus } from '../../file-types';

export { PublishPlanStatus };

// ── Request DTOs ──────────────────────────────────────────────────────────────

/**
 * Which surface initiated a publish. Decides where a record's *failed* edit goes
 * after the run (see the publish redesign, DEV-10048):
 *
 *   - `'web'`     — the web app has no local working tree; its only notion of
 *                   "pending" is the server `dirty` branch, so a failed edit is
 *                   **kept on `dirty`** (re-applied during the post-publish
 *                   reconcile) and re-surfaced as needs-approval there.
 *   - `'desktop'` — the desktop/CLI owns a local working tree + `accepted-patches.json`;
 *                   a failed edit is **stripped from server `dirty`** and travels
 *                   back to the client (via the run-job's `failedOperations`), which
 *                   moves it into `failed-patches.json` and re-applies it to the
 *                   working tree as a needs-approval edit.
 *
 * Absent ⇒ treated as `'web'` (keep failures on `dirty`) — the conservative legacy
 * default that matches the pre-redesign `rebaseDirty` behavior.
 */
export type PublishOrigin = 'web' | 'desktop';

export interface PublishPlanBuildDto {
  connectorAccountId?: string;
  runAfterPlan?: boolean;
  folderPath?: string;
  filePath?: string;
  /**
   * DEV-10316 TOCTOU token. The dirty-branch HEAD SHA the client captured right
   * after its upload-patch apply landed (surfaced by the apply job as
   * `publicProgress.dirtyHead`). When present, the publish-plan build re-checks,
   * BEFORE `rebaseDirty` force-moves the HEAD, that the connection's current
   * dirty HEAD still equals this value; if the server's `dirty` branch advanced
   * in the window between the user's upload and this publish (e.g. the automated
   * web sync staged new changes), the build aborts rather than ship the surprise.
   * Only the desktop publish modal sends it, per-connection; absent ⇒ no
   * re-check (legacy / CLI publish, which is protected by the upload-time gate).
   */
  expectedBaseDirtyHead?: string;
}

export interface PublishPlanRunDto {
  pipelineId: string;
  executeSinglePhase?: boolean;
  /**
   * Surface that initiated the publish; routes a record's *failed* edit during the
   * post-publish `dirty`/`main` reconcile. `'desktop'` strips failed paths from the
   * server `dirty` branch (they travel back to the client via the run-job's
   * `failedOperations`); `'web'` keeps them on `dirty`. Absent ⇒ `'web'`.
   *
   * Every client sends it explicitly: the desktop/CLI route (`viaCliRoute.runJob`)
   * sends `'desktop'`, and the web route (`viaWorkbookRoute.runJob`) sends `'web'`.
   * The `'web'` default exists for the web's `runAfterPlan` path (plan-job auto-runs
   * the pipeline with no separate run-job DTO) and for legacy callers. See {@link PublishOrigin}.
   */
  publishOrigin?: PublishOrigin;
}

// ── Response Entities ─────────────────────────────────────────────────────────

///
/// NOTE: Keep these in sync with server/prisma/schema.prisma
/// Begin "keep in sync" section
///

export interface PublishPlanOperationEntity {
  id: string;
  planId: string;
  filePath: string;
  phase: string; // "create" | "edit" | "delete" | "backfill"
  content: unknown;
  changedFields?: unknown;
  remoteRecordId: string | null;
  remoteTableId: string | null;
  dataFolderId: string | null;
  status: string; // "pending" | "success" | "failed-batch"
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublishPlanJobEntity {
  id: string | number | null;
  name?: string;
  status: string; // normalized from bullJob.state or dbJob.status
  progress?: unknown;
  data?: unknown;
  state?: string;
  failedReason?: string;
  stacktrace?: string[];
  type?: string;
}

export interface PublishPlanEntity {
  id: string;
  createdAt: string;
  updatedAt: string;
  workbookId: string;
  userId: string;
  status: PublishPlanStatus;
  branchName: string;
  preDirtyCommitSha: string | null;
  preMainCommitSha: string | null;
  postMainCommitSha: string | null;
  result: unknown;
  activeJobId: string | null;
  connectorAccountId: string | null;
  connectorAccount?: { id: string; displayName: string; service: string } | null;
  authorId: string | null;
  author?: { id: string; name: string | null; email: string | null } | null;
  _count: { operations: number };
  dbJob: { status: string; type: string; progress: unknown } | null;
  bullJob: Record<string, unknown> | null;
  job: PublishPlanJobEntity | null;
}

export interface PublishPlanRecordRow {
  filePath: string;
  dataFolderId: string | null;
  phases: string[];
  hasError: boolean;
}

export interface PublishPlanRecordsResponse {
  data: PublishPlanRecordRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Total unique records (filePaths) across the entire plan, ignoring filters. */
  affectedRecords: number;
  /** Total operation rows across the entire plan, ignoring filters. */
  totalOperations: number;
  filters: {
    folders: { id: string; path: string; count: number }[];
    phases: { phase: string; count: number }[];
  };
}

///
/// End "keep in sync" section
///

/**
 * Paginated response for the publish-plans list (Publish History). Transport
 * wrapper around a page of `PublishPlanEntity` rows, newest first.
 */
export interface PublishPlanListResponse {
  data: PublishPlanEntity[];
  total: number;
  page: number;
  pageSize: number;
}

// ── Publish diffs (DEV-11427) ─────────────────────────────────────────────────
//
// "What did this publish change?" A publish run records three commits on the
// connection repo, and both diff endpoints compare any two of them, chosen by
// the `from` / `to` anchors:
//
//   pre-main   `main` before the run  (PublishPlan.preMainCommitSha,  tag main_pre_plan_<id>)
//   pre-dirty  `dirty` before the run (PublishPlan.preDirtyCommitSha, tag dirty_plan_<id>)
//              — the approved edits that were about to be published
//   post-main  `main` after the run   (PublishPlan.postMainCommitSha, tag main_plan_<id>)
//              — what actually landed
//
// Useful pairs:
//   pre-main  → post-main  (default)  what this publish changed live. Connector-rejected
//                                     records never reach `main`, so they never appear.
//   pre-main  → pre-dirty             what was staged for publish ("old vs edits"). Note
//                                     `dirty` is the connection's whole approved set, so a
//                                     scoped plan shows edits outside its scope here too.
//   pre-dirty → post-main             what the connector changed relative to what we sent
//                                     (normalisation, server-computed fields). A rejected
//                                     record shows the REVERSE of the user's edit here.
//
// Created records are renamed on publish (placeholder name on `dirty`, remote id on
// `main`), so a single `path` may only exist on one side of a pair that spans `dirty`;
// the caller picks the path per operation.

/** Named commit of a publish run to diff from / to. */
export type PublishDiffAnchor = 'pre-main' | 'pre-dirty' | 'post-main';

export const PUBLISH_DIFF_ANCHORS: readonly PublishDiffAnchor[] = ['pre-main', 'pre-dirty', 'post-main'];

/**
 * One file that differs between the two anchors.
 */
export interface PublishPlanChangedFile {
  /** Full workbook path of the record file, with a leading `/` (e.g. `/Companies/rec_123.json`). */
  path: string;
  /** `added` = absent at `from`, present at `to`; `modified` = differs; `deleted` = present at `from`, absent at `to`. */
  status: FileDiffStatus;
}

/**
 * Paginated list of the files that differ between two anchors of a publish, plus
 * per-status totals across the whole comparison (ignoring pagination and filters).
 */
export interface PublishPlanChangedFilesResponse {
  planId: string;
  connectorAccountId: string | null;
  /** The older side of the comparison. */
  from: PublishDiffAnchor;
  /** The newer side of the comparison. */
  to: PublishDiffAnchor;
  /** Commit at `from`. `null` only for `pre-main` on a run that recorded none (then every file is `added`). */
  baseCommitSha: string | null;
  /** Commit at `to`. */
  headCommitSha: string;
  data: PublishPlanChangedFile[];
  /** Number of files matching the filters (before pagination). */
  total: number;
  page: number;
  pageSize: number;
  /** Per-status counts across the entire comparison, ignoring filters and pagination. */
  counts: { added: number; modified: number; deleted: number };
}

/**
 * The content of one record file at two anchors of a publish.
 */
export interface PublishPlanFileDiff {
  planId: string;
  /** Full workbook path of the record file, with a leading `/`. */
  path: string;
  /** The older side of the comparison. */
  from: PublishDiffAnchor;
  /** The newer side of the comparison. */
  to: PublishDiffAnchor;
  /** How the file differs between the anchors; `unchanged` when byte-identical on both sides. */
  status: FileDiffStatus | 'unchanged';
  baseCommitSha: string | null;
  headCommitSha: string;
  /**
   * File content at `from`, for display; `null` when the file did not exist there.
   *
   * When the connection's connector declares field-value canonicalizers for the record's
   * table, each canonicalized field is shown in its canonical form (e.g. an omitted Airtable
   * empty field as `null`, a Postgres timestamp as epoch milliseconds) and the content is
   * re-serialised. That form is lossy and is NOT the file in git — use it only to show what
   * changed. Otherwise this is the raw file content.
   */
  before: string | null;
  /** File content at `to`, rendered like `before`; `null` when the file did not exist there. */
  after: string | null;
  /**
   * Sparse deep diff of the record, computed over the canonical forms in `before` / `after`:
   * only the field paths whose value changed, holding the value at `to` (same shape as a plan
   * operation's `changedFields`). `null` when either side is missing or is not a JSON object,
   * so callers can fall back to a text diff of `before` / `after`. An empty object with
   * `status: 'modified'` means the service only re-rendered or re-formatted the file.
   */
  changedFields: Record<string, unknown> | null;
}
