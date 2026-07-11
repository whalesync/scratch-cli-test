import { PublishPlanStatus } from '../../enums/enums';

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
