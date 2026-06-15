import type { Sync } from '../../db/sync';
import type { SyncDraft } from '../../db/sync-draft';
import type {
  ApplySyncDraftResponse,
  CreateSyncDraftDto,
  MaterializeResponse,
  PatchSyncDraftDto,
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

    /** Phase 2: reconcile the placeholder-free draft into a live Sync. 422 if any placeholders remain. */
    apply: async (draftId: string): Promise<ApplySyncDraftResponse> => {
      const res = await http.post<Sync>(`/sync-drafts/${draftId}/apply`, undefined, {
        fallbackMessage: 'Failed to apply sync draft',
      });
      return res.data;
    },

    delete: async (draftId: string): Promise<void> => {
      await http.delete(`/sync-drafts/${draftId}`, { fallbackMessage: 'Failed to delete sync draft' });
    },
  };
}

export type SyncDraftsApi = ReturnType<typeof createSyncDraftsApi>;
