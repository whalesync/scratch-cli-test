import type { Sync } from '../../db/sync';
import type { SyncDraft } from '../../db/sync-draft';
import type {
  ApplySyncDraftDto,
  ApplySyncDraftResponse,
  CreateSyncDraftDto,
  MaterializeResponse,
  PatchSyncDraftDto,
  SaveSyncDraftDto,
  SaveSyncDraftResponse,
} from '../../dto/sync-draft/sync-draft-api';
import type { Http } from '../http';

/**
 * SyncDraft operations: provision (or edit) a sync — including tables/fields to
 * create — through a durable draft, then drive its two phases (materialize →
 * apply). Reached as `client.syncDrafts.*`.
 *
 * The client is a thin editor over the server draft and a driver of the phases;
 * it never speaks column path ids or mapping versions for created entities.
 */
export function createSyncDraftsApi(http: Http) {
  return {
    /**
     * Open the editor for a target: get-or-create the active draft keyed by
     * `(workbookId, fromSyncId ?? null)`. Idempotent — call it on every cold page
     * load (new bridge → just the workbook; editing → pass `fromSyncId`) and the
     * draft is rediscovered from that durable key, so the id is never tracked on
     * the client. Concurrent calls (e.g. two tabs) converge on the same draft.
     */
    getOrCreate: async (workbookId: string, body: CreateSyncDraftDto = {}): Promise<SyncDraft> => {
      const res = await http.post<SyncDraft>(`/workbooks/${workbookId}/sync-drafts`, body, {
        fallbackMessage: 'Failed to open sync draft',
      });
      return res.data;
    },

    get: async (draftId: string): Promise<SyncDraft> => {
      const res = await http.get<SyncDraft>(`/sync-drafts/${draftId}`, {
        fallbackMessage: 'Failed to fetch sync draft',
      });
      return res.data;
    },

    /** Replace-merge the draft's contents. `body.version` must match the server's (409 on conflict). */
    patch: async (draftId: string, body: PatchSyncDraftDto): Promise<SyncDraft> => {
      const res = await http.patch<SyncDraft>(`/sync-drafts/${draftId}`, body, {
        fallbackMessage: 'Failed to update sync draft',
      });
      return res.data;
    },

    /** Phase 1: create the still-unresolved remote tables/fields and checkpoint each into the draft. Re-callable. */
    materialize: async (draftId: string): Promise<MaterializeResponse> => {
      const res = await http.post<MaterializeResponse>(`/sync-drafts/${draftId}/materialize`, undefined, {
        fallbackMessage: 'Failed to materialize sync draft',
      });
      return res.data;
    },

    /**
     * Phase 2: reconcile the placeholder-free draft into a live Sync. 422 if any placeholders remain.
     * Pass `{ createRoutine: true }` to also generate a routine for the new sync (best-effort).
     */
    apply: async (draftId: string, body?: ApplySyncDraftDto): Promise<ApplySyncDraftResponse> => {
      const res = await http.post<Sync>(`/sync-drafts/${draftId}/apply`, body, {
        fallbackMessage: 'Failed to apply sync draft',
      });
      return res.data;
    },

    /**
     * Both phases as a background job (DEV-10875): enqueue the `apply-sync-draft` job (materialize →
     * apply) and return its job id immediately. Poll the job (GET /jobs/:jobId/progress) and render
     * `ApplySyncDraftPublicProgress`; while it runs, `SyncDraft.activeSaveJobId` carries the same id
     * so a reloaded page rediscovers the in-flight save. Saving while a save job is already running
     * returns that job's id (single-flight). Retry after a partial failure just calls save again —
     * placeholders already resolved are skipped.
     */
    save: async (draftId: string, body?: SaveSyncDraftDto): Promise<SaveSyncDraftResponse> => {
      const res = await http.post<SaveSyncDraftResponse>(`/sync-drafts/${draftId}/save`, body, {
        fallbackMessage: 'Failed to save sync draft',
      });
      return res.data;
    },

    delete: async (draftId: string): Promise<void> => {
      await http.delete(`/sync-drafts/${draftId}`, { fallbackMessage: 'Failed to delete sync draft' });
    },
  };
}

export type SyncDraftsApi = ReturnType<typeof createSyncDraftsApi>;
