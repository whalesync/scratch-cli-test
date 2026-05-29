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

// ── Diff view mode ──

export type DiffViewMode = 'side-by-side' | 'inline-words';

// ── Store state ──

export interface WorkspaceUiState {
  // --- Navigation / Selection ---
  // `selectedFolderPath` is intentionally NOT stored here. It is owned by
  // WorkspacePage's local state, which resets on workspace switch via the
  // `<WorkspacePage key={id} />` remount in App.tsx. Keeping it in the
  // module-level store let stale absolute paths from a previous workspace
  // leak into the next one, producing `relative()` output starting with
  // `..` and triggering "connection '..' not in marker" downstream.
  selectedRecordFilename: string | null;
  focusedFieldName: string | null;
  showConnectionsPanel: boolean;
  /** When true, the central content area shows the Publish History panel
   * instead of the folder grid or connections panel. */
  showPublishHistoryPanel: boolean;
  /** When true, the central content area shows the Validation panel. */
  showValidationPanel: boolean;
  /** When non-null while `showPublishHistoryPanel` is true, the panel drills
   * into the detail view for this plan id. Null means "show the list". */
  publishHistoryDetailPlanId: string | null;

  // --- Grid Configuration ---
  sort: SortState;
  activeFilters: GridFilter[];
  visibleColumnIds: string[] | null;
  columnWidths: Record<string, number>;
  page: number;

  // --- Diff View ---
  /** User-chosen diff view mode. `null` means "use the default" (side-by-side when diffs exist, inline otherwise). */
  diffViewMode: DiffViewMode | null;

  // --- Per-workbook settings ---
  /** The active workbook ID, used for persisting per-workbook settings. */
  currentWorkbookId: string | null;
  /** Whether inline validation is enabled for this workbook. Not reset on folder change. */
  validateEnabled: boolean;

  // --- Actions ---
  setSelectedRecordFilename: (filename: string | null) => void;
  setFocusedFieldName: (name: string | null) => void;
  setShowConnectionsPanel: (show: boolean) => void;
  setShowPublishHistoryPanel: (show: boolean) => void;
  setShowValidationPanel: (show: boolean) => void;
  setPublishHistoryDetailPlanId: (planId: string | null) => void;

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
  setDiffViewMode: (mode: DiffViewMode | null) => void;
  setCurrentWorkbookId: (id: string | null) => void;
  hydrateWorkbookSettings: (settings: { validateEnabled?: boolean }) => void;
  setValidateEnabled: (enabled: boolean) => void;
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
  selectedRecordFilename: null,
  focusedFieldName: null,
  showConnectionsPanel: false,
  showPublishHistoryPanel: false,
  showValidationPanel: false,
  publishHistoryDetailPlanId: null,

  // --- Grid Configuration ---
  sort: { column: null, direction: null },
  activeFilters: [],
  visibleColumnIds: null,
  columnWidths: {},
  page: 1,
  diffViewMode: null,
  currentWorkbookId: null,
  validateEnabled: false,

  // --- Actions ---
  setSelectedRecordFilename: (filename) => {
    const prev = get().selectedRecordFilename;
    const resetDiff = prev !== filename;
    set({
      selectedRecordFilename: filename,
      focusedFieldName: filename ? get().focusedFieldName : null,
      ...(resetDiff ? { diffViewMode: null } : {}),
    });
  },
  setFocusedFieldName: (name) => set({ focusedFieldName: name }),
  setShowConnectionsPanel: (show) =>
    set({
      showConnectionsPanel: show,
      ...(show ? { showPublishHistoryPanel: false, showValidationPanel: false } : {}),
    }),
  setShowPublishHistoryPanel: (show) =>
    set({
      showPublishHistoryPanel: show,
      ...(show ? { showConnectionsPanel: false, showValidationPanel: false } : { publishHistoryDetailPlanId: null }),
    }),
  setShowValidationPanel: (show) =>
    set({
      showValidationPanel: show,
      ...(show ? { showConnectionsPanel: false, showPublishHistoryPanel: false } : {}),
    }),
  setPublishHistoryDetailPlanId: (planId) => set({ publishHistoryDetailPlanId: planId }),

  showGrid: () => set({ selectedRecordFilename: null, focusedFieldName: null, diffViewMode: null }),
  showRecord: (filename) => {
    const resetDiff = get().selectedRecordFilename !== filename;
    set({
      selectedRecordFilename: filename,
      focusedFieldName: null,
      ...(resetDiff ? { diffViewMode: null } : {}),
    });
  },
  showField: (filename, fieldName) => {
    const resetDiff = get().selectedRecordFilename !== filename;
    set({
      selectedRecordFilename: filename,
      focusedFieldName: fieldName,
      ...(resetDiff ? { diffViewMode: null } : {}),
    });
  },
  setSort: (v) => set({ sort: typeof v === 'function' ? v(get().sort) : v }),
  setActiveFilters: (v) => set({ activeFilters: typeof v === 'function' ? v(get().activeFilters) : v }),
  setVisibleColumnIds: (v) => set({ visibleColumnIds: typeof v === 'function' ? v(get().visibleColumnIds) : v }),
  setColumnWidths: (v) => set({ columnWidths: typeof v === 'function' ? v(get().columnWidths) : v }),
  setPage: (v) => set({ page: typeof v === 'function' ? v(get().page) : v }),
  setDiffViewMode: (mode) => set({ diffViewMode: mode }),
  setCurrentWorkbookId: (id) => set({ currentWorkbookId: id }),
  hydrateWorkbookSettings: (settings) => {
    set({ validateEnabled: settings.validateEnabled ?? false });
  },
  setValidateEnabled: (enabled) => {
    set({ validateEnabled: enabled });
    const workbookId = get().currentWorkbookId;
    if (workbookId) {
      void window.scratchPreferences.setWorkbookSetting(workbookId, 'validateEnabled', enabled);
    }
  },

  resetFolderState: () =>
    set({
      selectedRecordFilename: null,
      focusedFieldName: null,
      sort: INITIAL_SORT,
      activeFilters: [],
      visibleColumnIds: null,
      columnWidths: {},
      page: 1,
      diffViewMode: null,
    }),
}));

/**
 * Selector that derives viewMode from the underlying state.
 * Usage: `const viewMode = useViewMode();`
 */
export function useViewMode(): ViewMode {
  return useWorkspaceUiStore((s) => deriveViewMode(s));
}
