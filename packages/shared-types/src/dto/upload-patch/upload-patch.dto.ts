import { IsBoolean, IsOptional, IsString } from 'class-validator';

// ── /cli/v1/workbooks/:id/upload-patch/init ───────────────────────────────

export class UploadPatchInitDto {
  @IsString()
  @IsOptional()
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
  uploadId?: string;

  @IsString()
  @IsOptional()
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
}

export type ValidatedUploadPatchCommitDto = Required<Pick<UploadPatchCommitDto, 'uploadId' | 'connectorAccountId'>> & {
  baseHead?: string;
  refuseIfStale?: boolean;
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
  }>;
}
