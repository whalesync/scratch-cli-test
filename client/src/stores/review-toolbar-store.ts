import { create } from 'zustand';

type ViewMode = 'split' | 'unified';

interface ReviewToolbarState {
  // View mode for diff display
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;

  // Summary text shown on the left side of the toolbar (e.g. "Base1 - testdata.Weather - 140 files")
  summary: string | null;
  setSummary: (summary: string | null) => void;

  // Per-file actions registered by ReviewFileViewer
  fileActions: {
    onPublishFile: (() => void) | null;
    onDiscardFile: (() => void) | null;
    onSaveFile: (() => void) | null;
    isPublishing: boolean;
    isDiscarding: boolean;
    isSaving: boolean;
    hasChanges: boolean;
  };
  setFileActions: (actions: Partial<ReviewToolbarState['fileActions']>) => void;
  clearFileActions: () => void;
}

const defaultFileActions: ReviewToolbarState['fileActions'] = {
  onPublishFile: null,
  onDiscardFile: null,
  onSaveFile: null,
  isPublishing: false,
  isDiscarding: false,
  isSaving: false,
  hasChanges: false,
};

export const useReviewToolbarStore = create<ReviewToolbarState>((set) => ({
  viewMode: 'split',
  setViewMode: (mode) => set({ viewMode: mode }),

  summary: null,
  setSummary: (summary) => set({ summary }),

  fileActions: { ...defaultFileActions },
  setFileActions: (actions) =>
    set((state) => ({
      fileActions: { ...state.fileActions, ...actions },
    })),
  clearFileActions: () => set({ fileActions: { ...defaultFileActions } }),
}));
