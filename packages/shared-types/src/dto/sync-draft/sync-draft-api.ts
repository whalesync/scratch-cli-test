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
  tableMappings: draftTableMappingsSchema.optional(),
});
export type PatchSyncDraftDto = z.infer<typeof patchSyncDraftSchema>;

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

/** 422 body when apply is called with unresolved placeholders. */
export interface ApplyUnresolvedPlaceholdersError {
  error: 'SYNC_DRAFT_UNRESOLVED_PLACEHOLDERS';
  message: string;
  /** The placeholder refs (table and/or field) still needing materialize. */
  unresolvedRefs: string[];
}

/** Apply returns the live `Sync` it produced. */
export type ApplySyncDraftResponse = Sync;
