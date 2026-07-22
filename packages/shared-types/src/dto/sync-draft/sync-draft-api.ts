import { z } from 'zod';
import type { Sync } from '../../db/sync';
import type { SyncDraft } from '../../db/sync-draft';
import { draftTableMappingsSchema } from './sync-draft-content';

/**
 * Request/response contracts for the SyncDraft API. Request bodies are zod
 * (validated by the global ZodValidationPipe); responses are plain interfaces.
 */

// ── POST /workbooks/:workbookId/sync-drafts ───────────────────────────────────

export const createSyncDraftSchema = z.object({
  /**
   * When set, the draft is initialized from this existing sync (the edit flow):
   * its v2 mappings are converted to draft form with all `existing` refs and zero
   * placeholders, and `sourceSyncId` is recorded so apply diffs against it. Blank
   * (omitted) creates an empty draft for a brand-new sync.
   */
  fromSyncId: z.string().min(1).optional(),
});
export type CreateSyncDraftDto = z.infer<typeof createSyncDraftSchema>;

// ── PATCH /sync-drafts/:draftId ───────────────────────────────────────────────

/**
 * Replace-merge the draft's editable contents. `version` is the optimistic
 * concurrency token the client last saw; a mismatch is a 409 (the client should
 * refetch + reconcile rather than clobber). Every field is optional except
 * `version` — only provided keys are written.
 */
export const patchSyncDraftSchema = z.object({
  version: z.number().int().nonnegative(),
  displayName: z.string().min(1).optional(),
  /** Cron expression, or `null` to clear the schedule. */
  schedule: z.string().nullable().optional(),
  /** Whether the resulting sync should auto-publish after a successful sync. */
  publishAfterSync: z.boolean().optional(),
  tableMappings: draftTableMappingsSchema.optional(),
});
export type PatchSyncDraftDto = z.infer<typeof patchSyncDraftSchema>;

/**
 * 422 body when a PATCH would leave a foreignKey field pointing at a table that is
 * no longer in the draft — e.g. the user removed (unmapped) the table that another
 * table's foreignKey targets. The save is rejected so the reference can't dangle; the
 * client unmaps the listed field(s) — or restores the target table — and retries.
 *
 * Only foreignKeys whose target is resolved WITHIN the draft are checked: a sibling
 * `{ ref }` (must match a placeholder table in the draft) and a
 * `{ unresolvedLinkedTableId }` token (must match some mapping's source remote table
 * id — the same binding materialize uses). A concrete `{ existingRemoteTableId }`
 * always resolves (the remote table exists regardless of the draft) and is never flagged.
 */
export interface SyncDraftForeignKeyTargetMissingError {
  error: 'SYNC_DRAFT_FK_TARGET_MISSING';
  message: string;
  missingTargets: SyncDraftMissingForeignKeyTarget[];
}

/** One foreignKey field in the draft whose target table is no longer present. */
export interface SyncDraftMissingForeignKeyTarget {
  /** The `ref` of the table mapping that holds the foreignKey field. */
  tableMappingRef: string;
  /** The foreignKey field's name. */
  fieldName: string;
  /** What the field points at: a sibling create-spec ref, or a source linked-table id. */
  target: { ref: string } | { unresolvedLinkedTableId: string };
}

// ── POST /sync-drafts/:draftId/materialize (Phase 1) ──────────────────────────

/** Per-placeholder outcome of a materialize call. */
export interface MaterializePlaceholderResult {
  /** The placeholder `ref` (table or field) this result refers to. */
  ref: string;
  kind: 'table' | 'field';
  /**
   * - `created`         — newly created this call; resolved info written back.
   * - `alreadyResolved` — was already resolved; not re-attempted (the resume primitive).
   * - `failed`          — creation failed; still unresolved, safe to retry.
   */
  status: 'created' | 'alreadyResolved' | 'failed';
  /** The name actually created (may carry a server-appended disambiguator). */
  actualName?: string;
  /** For table placeholders, on success. */
  remoteTableId?: string[];
  /** For field placeholders, on success. */
  remoteFieldId?: string;
  error?: string;
}

export interface MaterializeResponse {
  /** The updated draft (placeholders may now be resolved). */
  draft: SyncDraft;
  results: MaterializePlaceholderResult[];
  /**
   * - `ok`      — every attempted placeholder resolved (draft is placeholder-free → ready to apply).
   * - `partial` — some resolved, some failed.
   * - `failed`  — nothing resolved this call.
   * - `noop`    — there were no unresolved placeholders to attempt.
   */
  status: 'ok' | 'partial' | 'failed' | 'noop';
}

// ── POST /sync-drafts/:draftId/apply (Phase 2) ────────────────────────────────

/**
 * Apply request body (optional — an absent/empty body applies with defaults). When
 * `createRoutine` is set, apply additionally writes a `routines/run-<syncId>.yaml`
 * routine file describing how to run the just-created sync (pull source → pull
 * destination → run sync → publish to destination) and records its path on the
 * workbook under `settings.sync_routine`. Routine generation is best-effort: it never
 * fails the apply (the sync is the primary deliverable).
 */
export const applySyncDraftSchema = z
  .object({
    createRoutine: z.boolean().optional(),
  })
  // Apply historically took no body; `.default({})` keeps an empty/absent POST valid (→ `{}`)
  // rather than failing the object parse on `undefined`.
  .default({});
export type ApplySyncDraftDto = z.infer<typeof applySyncDraftSchema>;

/** 422 body when apply is called with unresolved placeholders. */
export interface ApplyUnresolvedPlaceholdersError {
  error: 'SYNC_DRAFT_UNRESOLVED_PLACEHOLDERS';
  message: string;
  /** The placeholder refs (table and/or field) still needing materialize. */
  unresolvedRefs: string[];
}

/** Apply returns the live `Sync` it produced. */
export type ApplySyncDraftResponse = Sync;

// ── POST /sync-drafts/:draftId/save (both phases, as a job) ───────────────────

/**
 * Save request body: enqueue the `apply-sync-draft` job, which runs materialize then apply in the
 * background (DEV-10875) and reports progress via `ApplySyncDraftPublicProgress`. `createRoutine`
 * mirrors the apply body's flag and is threaded through to the job's apply phase. `.default({})`
 * keeps an empty/absent POST valid (→ `{}`), matching apply.
 */
export const saveSyncDraftSchema = z
  .object({
    createRoutine: z.boolean().optional(),
  })
  .default({});
export type SaveSyncDraftDto = z.infer<typeof saveSyncDraftSchema>;

/**
 * 202 acknowledgement for a save: the BullMQ job id of the enqueued (or already-running)
 * `apply-sync-draft` job. Poll it via GET /jobs/:jobId/progress (or the bulk-status endpoint);
 * the same id is surfaced on `SyncDraft.activeSaveJobId` while the job is in flight. Saving a
 * draft whose save job is already running returns that job's id rather than enqueuing a second
 * one, so a double-click or a second tab collapses into "watch the same job".
 */
export interface SaveSyncDraftResponse {
  jobId: string;
}

/** 409 body when materialize/apply is called directly while a background save job is running. */
export interface SyncDraftSaveInProgressError {
  error: 'SYNC_DRAFT_SAVE_IN_PROGRESS';
  message: string;
  /** The BullMQ job id of the in-flight save job — watch it instead of retrying. */
  jobId: string;
}
