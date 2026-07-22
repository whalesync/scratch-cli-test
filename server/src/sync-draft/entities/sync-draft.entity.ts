import { SyncDraft as PrismaSyncDraft } from '@prisma/client';
import { DraftTableMapping, SyncDraft, SyncDraftId, SyncId, WorkbookId } from '@spinner/shared-types';

/**
 * Builds the shared `SyncDraft` wire type from a Prisma row. Timestamps become
 * ISO strings; the `tableMappings` JSON column is the validated draft contents
 * (written only via the zod-checked PATCH path or our own server writers), so it
 * is surfaced as `DraftTableMapping[]`.
 */
export const SyncDraftEntity = {
  from(row: PrismaSyncDraft): SyncDraft {
    return {
      id: row.id as SyncDraftId,
      workbookId: row.workbookId as WorkbookId,
      version: row.version,
      displayName: row.displayName,
      schedule: row.schedule,
      sourceSyncId: row.sourceSyncId as SyncId | null,
      publishAfterSync: row.publishAfterSync,
      tableMappings: (row.tableMappings ?? []) as unknown as DraftTableMapping[],
      activeSaveJobId: row.activeSaveJobId,
      archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
      appliedSyncId: row.appliedSyncId as SyncId | null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  },
};
