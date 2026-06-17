import { create } from 'zustand';

/**
 * Shares the in-progress "create routine" state between the editor (which owns the YAML being typed)
 * and the sidebar list (which previews the routine before it's saved). Holds only the projected,
 * slugified file name; null whenever no routine is being created.
 */
type State = {
  draftFileName: string | null;
};

type Actions = {
  setDraftFileName: (draftFileName: string | null) => void;
};

type RoutineDraftStore = State & Actions;

export const useRoutineDraftStore = create<RoutineDraftStore>((set) => ({
  draftFileName: null,
  setDraftFileName: (draftFileName: string | null) => set({ draftFileName }),
}));
