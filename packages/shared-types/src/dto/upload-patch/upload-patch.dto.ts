import { IsOptional, IsString } from 'class-validator';

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
   * If provided and the server's `main` has moved past it, the response will
   * include a soft `stalenessWarning` — patches are still applied.
   */
  @IsString()
  @IsOptional()
  baseHead?: string;
}

export type ValidatedUploadPatchCommitDto = Required<Pick<UploadPatchCommitDto, 'uploadId' | 'connectorAccountId'>> & {
  baseHead?: string;
};

export interface UploadPatchCommitResponseDto {
  jobId: string | null;
  stalenessWarning?: { newHead: string };
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
