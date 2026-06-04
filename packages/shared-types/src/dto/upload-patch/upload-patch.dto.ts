import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

// ── /cli/v1/workbooks/:id/upload-patch/init ───────────────────────────────

export class UploadPatchInitDto {
  @IsString()
  @IsOptional()
  @MaxLength(64)
  connectorAccountId?: string;
}

export type ValidatedUploadPatchInitDto = Required<Pick<UploadPatchInitDto, 'connectorAccountId'>>;

export interface UploadPatchInitResponseDto {
  uploadId: string;
  presignedUrl: string;
  /** Seconds until the presigned URL expires. */
  expiresInSeconds: number;
}

// ── /cli/v1/workbooks/:id/upload-patch/commit ─────────────────────────────

export class UploadPatchCommitDto {
  @IsString()
  @IsOptional()
  @MaxLength(128)
  uploadId?: string;

  @IsString()
  @IsOptional()
  @MaxLength(64)
  connectorAccountId?: string;

  /**
   * Optional client-known commit SHA at the time the user computed the diff.
   * If provided and the server's `main` has moved past it, behavior depends
   * on `refuseIfStale`:
   *   - `refuseIfStale === true`: server refuses with HTTP 409 + structured
   *     `{ status: 'blocked_stale', baseHead, currentRemoteHead, message }`
   *     body; the job is NOT enqueued and the audit log is NOT written.
   *   - `refuseIfStale` falsy: patches apply anyway, response carries a soft
   *     `stalenessWarning` so the caller can show a non-blocking banner.
   */
  @IsString()
  @IsOptional()
  @MaxLength(64)
  baseHead?: string;

  /**
   * Strict-mode flag. When `true`, the server compares `baseHead` against the
   * current `refs/heads/main` SHA for this connection's repo and refuses with
   * HTTP 409 if they diverge. Used by `scratchmd files upload` and the
   * desktop `PublishChangesModal` to gate publish on a fresh local state —
   * symmetric with pull's `blocked_unreviewed` UX. Default `false` keeps the
   * legacy soft-warning behavior for back-compat.
   */
  @IsBoolean()
  @IsOptional()
  refuseIfStale?: boolean;

  /**
   * Strict-mode flag for the DEV-10316 dirty gate. When `true` (and the
   * `desktop_dirty_gate_enabled` kill switch is on), the server refuses the
   * commit with HTTP 409 + structured `UploadPatchBlockedDirtyResponseDto` if
   * the connection's `dirty` branch already holds unpublished record changes
   * versus live `refs/heads/main`. This keeps the desktop/CLI from piling its
   * approved edits onto a staging area that isn't already clean (which is how
   * the automated web sync's staged changes got swept into a desktop publish).
   * The check runs BEFORE the staleness gate, the job enqueue, and the audit
   * log, so a refusal leaves zero side effects. Default `false` keeps the
   * legacy behavior — only updated desktop/CLI clients send it.
   */
  @IsBoolean()
  @IsOptional()
  refuseIfDirty?: boolean;

  /**
   * Two-pass probe flag. When `true`, the server runs the gates (including the
   * `refuseIfDirty` dirty check) and returns `{ jobId: null }` WITHOUT
   * enqueueing the ApplyPatches job or writing an audit log. The CLI's
   * `files upload` runs a `checkOnly` pass over every connection first and only
   * proceeds to the real apply pass if every connection is clean — so a single
   * dirty connection blocks the whole publish with nothing uploaded. Default
   * `false` performs the real apply.
   */
  @IsBoolean()
  @IsOptional()
  checkOnly?: boolean;
}

export type ValidatedUploadPatchCommitDto = Required<Pick<UploadPatchCommitDto, 'uploadId' | 'connectorAccountId'>> & {
  baseHead?: string;
  refuseIfStale?: boolean;
  refuseIfDirty?: boolean;
  checkOnly?: boolean;
};

export interface UploadPatchCommitResponseDto {
  jobId: string | null;
  stalenessWarning?: { newHead: string };
}

/**
 * Body shape of the HTTP 409 response from `/upload-patch/commit` when
 * `refuseIfStale === true` and `baseHead` doesn't match the server's current
 * `refs/heads/main`. Returned via a NestJS `ConflictException` whose body
 * NestJS serializes as `{ statusCode: 409, ...this }`.
 */
export interface UploadPatchBlockedStaleResponseDto {
  status: 'blocked_stale';
  /** The client-supplied baseHead. May be omitted when the client never sent one. */
  baseHead?: string;
  /** The server's current `refs/heads/main` SHA for the connection's repo. */
  currentRemoteHead: string;
  /** Human-readable message; NestJS sets this automatically from ConflictException. */
  message?: string;
}

/**
 * Body shape of the HTTP 409 response from `/upload-patch/commit` when
 * `refuseIfDirty === true` and the connection's `dirty` branch already holds
 * unpublished record changes versus live `refs/heads/main` (DEV-10316). This
 * is intentionally **count-only**: the desktop can't show the user the
 * server's staging area, so it surfaces a name + total and redirects to the
 * web review screen rather than listing records. Returned via a NestJS
 * `ConflictException` whose body serializes as `{ statusCode: 409, ...this }`.
 */
export interface UploadPatchBlockedDirtyResponseDto {
  status: 'blocked_dirty';
  /** The connection whose staging area is not clean. */
  connectorAccountId: string;
  /** Total pending (unpublished) record changes on the connection vs live `main`. Count-only UI. */
  dirtyCount: number;
  /** Human-readable message; NestJS sets this automatically from ConflictException. */
  message?: string;
}

/**
 * Body shape of the HTTP 503 response from `/upload-patch/commit` when the
 * dirty-gate check itself could not run (the git service is down or busy).
 * Fail-closed: the publish is held with a retryable error rather than risking
 * an unguarded upload. Distinct from `blocked_dirty` because the failure is
 * transient — the desktop/CLI offers a "Try again" affordance. Returned via a
 * NestJS `ServiceUnavailableException`.
 */
export interface UploadPatchCheckFailedResponseDto {
  status: 'check_failed';
  /** The connection whose state could not be verified. */
  connectorAccountId: string;
  /** Human-readable message; NestJS sets this automatically from ServiceUnavailableException. */
  message?: string;
}

// ── Wire format for the GCS PUT body ──────────────────────────────────────

/**
 * The JSON body uploaded to the presigned PUT URL between `/init` and `/commit`.
 * Defined in shared-types so the server (worker), the desktop, and any future
 * TypeScript client share a single source of truth for the on-the-wire shape.
 * The Rust CLI re-declares this in serde.
 */
export interface UploadPatchPayload {
  patches: Array<{
    /** Path relative to the connection root, e.g. `Companies/rec123.json`. */
    path: string;
    /**
     * RFC 7396 JSON Merge Patch:
     *   - `null`          → delete the file
     *   - full JSON value → applied on top of the current file (or an empty
     *                       object if the file does not exist), with nested
     *                       `null` values deleting keys per the spec
     */
    patch: unknown;
    /**
     * True when this patch was produced by `scratchmd files revert-plan`
     * reviving a previously-deleted record. The patch body carries a
     * `scratch_pending_recreate_<old_id>` sentinel in its PK field; the
     * publish job strips the sentinel before sending to the connector,
     * captures the new remote id after success, and writes the mapping to
     * `RecreatedIdMap` so sibling reverts that FK-reference the old id can
     * be rewritten to the new id at publish time.
     *
     * Optional (defaults false). Marked at upload time, persisted as
     * `PublishPlanOperation.isRecreate` once the publish plan is built.
     */
    revert?: boolean;
  }>;
}
