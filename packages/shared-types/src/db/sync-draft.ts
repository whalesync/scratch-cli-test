import type { DraftTableMapping } from '../dto/sync-draft/sync-draft-content';
import { SyncDraftId, SyncId, WorkbookId } from '../ids';

///
/// NOTE: Keep this in sync with server/prisma/schema.prisma SyncDraft model
/// Begin "keep in sync" section
///

/**
 * The transient, desired-state working copy the UI edits while provisioning (or
 * editing) a sync — including tables/fields to create on a remote service. It is
 * the single artifact spanning both saga phases: the reconciler input for apply
 * (Phase 2) and the checkpoint that makes materialize (Phase 1) retryable.
 *
 * The real `Sync` stays canonical; a draft is created blank (new) or from an
 * existing sync (edit), saved incrementally, and reconciled away on apply (which
 * archives, not deletes, the row — kept for debugging).
 */
export interface SyncDraft {
  id: SyncDraftId;
  workbookId: WorkbookId;
  /** Optimistic-concurrency token; bumped on every write. PATCH must echo it (409 on mismatch). */
  version: number;
  displayName: string;
  /** Cron expression mirroring SaveSyncBody.schedule, or null for no schedule. */
  schedule: string | null;
  /** Set when initialized from an existing sync (edit flow); apply diffs against it. */
  sourceSyncId: SyncId | null;
  /**
   * Whether apply should configure the resulting Sync to auto-publish after a
   * successful sync (mirrors SaveSyncBody.publishAfterSync). Defaults to false
   * for a blank draft; seeded from the existing sync in the edit flow.
   */
  publishAfterSync: boolean;
  /** The desired-state working copy. */
  tableMappings: DraftTableMapping[];
  /** Set once the draft has been applied; an archived draft is never edited or re-applied. */
  archivedAt: string | null;
  /** The Sync produced by apply (set alongside archivedAt). */
  appliedSyncId: SyncId | null;
  createdAt: string;
  updatedAt: string;
}

///
/// End "keep in sync" section
///
