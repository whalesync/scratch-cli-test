import { create } from 'zustand';

// ── Filter types (re-exported for FolderDataGrid and other consumers) ──

export type FilterKind = 'unreviewed' | 'unpublished' | 'has-problems';

export type GridFilter =
  | { scope: 'global'; kind: FilterKind }
  | { scope: 'column'; kind: FilterKind; columnId: string; columnTitle: string }
  | { scope: 'text'; columnId: string; columnTitle: string; value: string };

// ── View mode (derived, not stored) ──

export type ViewMode = 'grid' | 'record' | 'field';

// ── Updater helper type ──

type Updater<T> = T | ((prev: T) => T);

// ── Sort state type ──

export type SortState = { column: string | null; direction: 'asc' | 'desc' | null };

// ── Store state ──

export interface WorkspaceUiState {
  // --- Navigation / Selection ---
  selectedFolderPath: string | null;
  selectedRecordFilename: string | null;
  focusedFieldName: string | null;

  // --- Grid Configuration ---
  sort: SortState;
  activeFilters: GridFilter[];
  visibleColumnIds: string[] | null;
  columnWidths: Record<string, number>;
  page: number;

  // --- Actions ---
  setSelectedFolderPath: (path: string | null) => void;
  setSelectedRecordFilename: (filename: string | null) => void;
  setFocusedFieldName: (name: string | null) => void;

  /**
   * Switch to grid view, clearing record/field selection.
   */
  showGrid: () => void;
  /**
   * Switch to record detail view. `filename` is required — the caller must
   * pick a record (e.g. the first row) when none is selected.
   */
  showRecord: (filename: string) => void;
  /**
   * Switch to field detail view. Both a record and a field are required.
   */
  showField: (filename: string, fieldName: string) => void;
  setSort: (sort: Updater<SortState>) => void;
  setActiveFilters: (filters: Updater<GridFilter[]>) => void;
  setVisibleColumnIds: (ids: Updater<string[] | null>) => void;
  setColumnWidths: (widths: Updater<Record<string, number>>) => void;
  setPage: (page: Updater<number>) => void;
  resetFolderState: () => void;
}

const INITIAL_SORT: SortState = { column: null, direction: null };

/**
 * Derive viewMode from selection state. Not stored — computed on read.
 */
export function deriveViewMode(state: {
  selectedRecordFilename: string | null;
  focusedFieldName: string | null;
}): ViewMode {
  if (state.focusedFieldName) return 'field';
  if (state.selectedRecordFilename) return 'record';
  return 'grid';
}

export const useWorkspaceUiStore = create<WorkspaceUiState>((set, get) => ({
  // --- Navigation / Selection ---
  selectedFolderPath: null,
  selectedRecordFilename: null,
  focusedFieldName: null,

  // --- Grid Configuration ---
  sort: { column: null, direction: null },
  activeFilters: [],
  visibleColumnIds: null,
  columnWidths: {},
  page: 1,

  // --- Actions ---
  setSelectedFolderPath: (path) =>
    set((state) => {
      if (state.selectedFolderPath === path) return state;
      return {
        selectedFolderPath: path,
        selectedRecordFilename: null,
        focusedFieldName: null,
        sort: INITIAL_SORT,
        activeFilters: [],
        visibleColumnIds: null,
        columnWidths: {},
        page: 1,
      };
    }),

  setSelectedRecordFilename: (filename) =>
    set({ selectedRecordFilename: filename, focusedFieldName: filename ? get().focusedFieldName : null }),
  setFocusedFieldName: (name) => set({ focusedFieldName: name }),

  showGrid: () => set({ selectedRecordFilename: null, focusedFieldName: null }),
  showRecord: (filename) => set({ selectedRecordFilename: filename, focusedFieldName: null }),
  showField: (filename, fieldName) => set({ selectedRecordFilename: filename, focusedFieldName: fieldName }),
  setSort: (v) => set({ sort: typeof v === 'function' ? v(get().sort) : v }),
  setActiveFilters: (v) => set({ activeFilters: typeof v === 'function' ? v(get().activeFilters) : v }),
  setVisibleColumnIds: (v) => set({ visibleColumnIds: typeof v === 'function' ? v(get().visibleColumnIds) : v }),
  setColumnWidths: (v) => set({ columnWidths: typeof v === 'function' ? v(get().columnWidths) : v }),
  setPage: (v) => set({ page: typeof v === 'function' ? v(get().page) : v }),

  resetFolderState: () =>
    set({
      selectedRecordFilename: null,
      focusedFieldName: null,
      sort: INITIAL_SORT,
      activeFilters: [],
      visibleColumnIds: null,
      columnWidths: {},
      page: 1,
    }),
}));

/**
 * Selector that derives viewMode from the underlying state.
 * Usage: `const viewMode = useViewMode();`
 */
export function useViewMode(): ViewMode {
  return useWorkspaceUiStore((s) => deriveViewMode(s));
}
