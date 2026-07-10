import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { serverGridFilters, useWorkspaceUiStore, type GridFilter } from '../../../stores/workspace-ui-store';
import type { DiffGridResult } from '../diff-grid-types';

/**
 * The review surface's data hook — the single owner of both diff loads for
 * `FolderReviewSurface`, lifted from `FolderDataGrid`'s inline data effects (behavior
 * identical) so the sibling surface pages, sorts, filters, and refreshes exactly the
 * same way:
 *
 *  1. **The paged table load** — `readDiffGridData` at `PAGE_SIZE`, keyed off the shared
 *     store's page / sort / filters (+ the folder-switch reset guard), with a generation
 *     ref that drops stale responses and a blocking-vs-in-place refresh distinction.
 *  2. **The folder-wide pending load** — a separate `readDiffGridData` capped at
 *     `BY_TYPE_MAX_PENDING_RECORDS`, filtered to the pending union, feeding the By-type view's groups
 *     and the Table-view change-type chips (their counts + client-side filter). Runs whenever the
 *     folder has pending changes, in either view mode.
 *
 * They can't share one IPC result (the table pages at 100 with sort/filters; By-type is
 * folder-wide) so they share *invalidation and types*, not bytes: a single
 * `bumpReviewDataVersion()` refreshes both in place, keeping their counts consistent after
 * any approve / reject / edit. Fetched data stays here (never the store) per `stores/CLAUDE.md`.
 */

const PAGE_SIZE = 100;
/** Cap on the folder-wide By-type load — beyond this the view truncates and disables bulk approve. */
const BY_TYPE_MAX_PENDING_RECORDS = 1000;

/** A stable empty-filters reference so an unfiltered query key never churns between renders. */
const EMPTY_FILTERS: GridFilter[] = [];

interface GridQueryState {
  key: string;
  selectedFolderPath: string | null;
  workspacePath: string | null;
  page: number;
  sortColumn: string | null;
  sortDirection: 'asc' | 'desc' | null;
  activeFilters: GridFilter[];
}

export interface UseReviewSurfaceDataArgs {
  selectedFolderPath: string | null;
  workspacePath: string | null;
  /** Bumped by the host when workspace-level data may have changed (a pull, a publish); triggers an in-place refresh. */
  workspaceLevelDataInvalidationCounter: number;
  /** Mirrors `FolderDataGrid`: reports reindex progress (a message) and completion (`null`) to the host. */
  onIndexingProgress?: (message: string | null) => void;
}

export interface UseReviewSurfaceData {
  // ── Paged table load ──
  diffData: DiffGridResult | null;
  error: string | null;
  /** A full-screen "loading" state: no current-query data is painted. */
  isBlockingLoad: boolean;
  /** A refresh that keeps the current rows painted (post-action / passive refetch). */
  isBackgroundRefreshing: boolean;
  /** The folder `diffData` currently belongs to (null while loading or unloaded) — distinguishes a
   * settled load for the selected folder from stale data painted during a folder switch. */
  loadedFolderPath: string | null;
  totalPages: number;

  // ── Folder-wide By-type load ──
  byTypeDiffData: DiffGridResult | null;
  byTypeIsTruncated: boolean;
  byTypeLoadedRecordCount: number;
  byTypeTotalPendingRecordCount: number;

  // ── Invalidation + optimism ──
  /** Post-action refresh: in-place table refresh + By-type reload (rows stay painted). */
  bumpReviewDataVersion: () => void;
  /** Hard blocking reload (error retry / manual). */
  reloadReviewData: () => void;
  /** Apply an optimistic update to the in-memory table diff (used by cell edits). */
  applyOptimisticDiff: (updater: (prev: DiffGridResult) => DiffGridResult) => void;
}

export function useReviewSurfaceData({
  selectedFolderPath,
  workspacePath,
  workspaceLevelDataInvalidationCounter,
  onIndexingProgress,
}: UseReviewSurfaceDataArgs): UseReviewSurfaceData {
  // Grid query inputs live in the shared store (so widths/sort/filters stay consistent across surfaces).
  const page = useWorkspaceUiStore((s) => s.page);
  const sort = useWorkspaceUiStore((s) => s.sort);
  const activeFilters = useWorkspaceUiStore((s) => s.activeFilters);
  const validate = useWorkspaceUiStore((s) => s.validateEnabled);

  const [diffData, setDiffData] = useState<DiffGridResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMode, setLoadingMode] = useState<'idle' | 'blocking' | 'refreshing'>('idle');
  const [resolvedQueryKey, setResolvedQueryKey] = useState<string | null>(null);
  // The folder path the current `diffData` actually belongs to — lets callers tell a settled load for
  // the selected folder apart from stale data still painted during a folder switch.
  const [loadedFolderPath, setLoadedFolderPath] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [reviewDataVersion, setReviewDataVersion] = useState(0);

  const loadGenerationRef = useRef(0);
  const didMountDataRefreshRef = useRef(false);
  // Last folder for which the parent's per-folder state reset (page/sort/filters) has landed. Until it
  // catches up, the query uses defaults so the reset's flush doesn't trigger a second blocking load.
  const lastResetFolderRef = useRef<string | null>(null);
  const hasCurrentQueryDataRef = useRef(false);
  const currentQueryRef = useRef<GridQueryState | null>(null);
  const validateRef = useRef(validate);
  validateRef.current = validate;

  // True right after a folder switch, before the store's reset has applied. Use query defaults while
  // pending so the flush lands on the same query key (no wasted stale query). Mirrors FolderDataGrid.
  const folderPending = selectedFolderPath !== lastResetFolderRef.current;
  const qPage = folderPending ? 1 : page;
  const qSortColumn = folderPending ? null : sort.column;
  const qSortDirection = folderPending ? null : sort.direction;
  // Only GLOBAL-scope filters drive the paged server query. The change-type chip filter
  // (`scope: 'change-type'`, DEV-10656) is applied CLIENT-SIDE over the folder-wide pending set by
  // the host, so it must neither reach `readDiffGridData` (the main process only maps global scopes)
  // nor churn the query key. Keyed on the serialized global subset so this stays a STABLE reference
  // across change-type chip toggles (which replace `activeFilters` but leave its global subset
  // identical) — the query-key / current-query memos below rely on `qActiveFilters` identity.
  const serializedGlobalActiveFilters = JSON.stringify(activeFilters.filter((filter) => filter.scope === 'global'));
  const qActiveFilters = useMemo<GridFilter[]>(() => {
    if (folderPending) return EMPTY_FILTERS;
    const globalActiveFilters = activeFilters.filter((filter) => filter.scope === 'global');
    return globalActiveFilters.length === 0 ? EMPTY_FILTERS : globalActiveFilters;
    // `activeFilters` is intentionally captured via its serialized global subset (the dep below):
    // depending on it directly would refetch the paged table on every client-side chip toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serializedGlobalActiveFilters, folderPending]);

  const queryKey = useMemo(
    () =>
      JSON.stringify({
        selectedFolderPath,
        workspacePath,
        page: qPage,
        sortColumn: qSortColumn,
        sortDirection: qSortDirection,
        activeFilters: qActiveFilters,
        validate,
      }),
    [qActiveFilters, qPage, qSortColumn, qSortDirection, selectedFolderPath, validate, workspacePath],
  );

  const hasCurrentQueryData = diffData !== null && resolvedQueryKey === queryKey;
  hasCurrentQueryDataRef.current = hasCurrentQueryData;
  const isBlockingLoad = loadingMode === 'blocking';
  const isBackgroundRefreshing = loadingMode === 'refreshing';

  const currentQuery = useMemo<GridQueryState>(
    () => ({
      key: queryKey,
      selectedFolderPath,
      workspacePath,
      page: qPage,
      sortColumn: qSortColumn,
      sortDirection: qSortDirection,
      activeFilters: qActiveFilters,
    }),
    [qActiveFilters, qPage, qSortColumn, qSortDirection, queryKey, selectedFolderPath, workspacePath],
  );
  currentQueryRef.current = currentQuery;

  const loadDiffData = useCallback(async (mode: 'blocking' | 'refreshing', query: GridQueryState) => {
    const {
      key,
      selectedFolderPath: nextFolderPath,
      workspacePath: nextWorkspacePath,
      page: nextPage,
      sortColumn,
      sortDirection,
      activeFilters: nextActiveFilters,
    } = query;

    if (!nextFolderPath || !nextWorkspacePath) {
      loadGenerationRef.current += 1;
      setDiffData(null);
      setError(null);
      setResolvedQueryKey(null);
      setLoadedFolderPath(null);
      setLoadingMode('idle');
      return;
    }

    const shouldKeepShowingCurrentData = mode === 'refreshing' && hasCurrentQueryDataRef.current;
    const generation = ++loadGenerationRef.current;
    setLoadingMode(shouldKeepShowingCurrentData ? 'refreshing' : 'blocking');
    if (!shouldKeepShowingCurrentData) {
      setError(null);
    }

    try {
      const result = await window.scratchFiles.readDiffGridData(nextFolderPath, nextWorkspacePath, {
        offset: (nextPage - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
        sortBy: sortColumn ?? undefined,
        sortOrder: sortDirection ?? undefined,
        filters: serverGridFilters(nextActiveFilters),
        validate: validateRef.current,
      });
      if (generation !== loadGenerationRef.current) return;
      setDiffData(result as DiffGridResult);
      setResolvedQueryKey(key);
      setLoadedFolderPath(nextFolderPath);
      setError(null);
    } catch (err: unknown) {
      if (generation !== loadGenerationRef.current) return;
      if (shouldKeepShowingCurrentData) {
        console.debug('[useReviewSurfaceData] background refresh failed:', err);
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to load grid data');
      setDiffData(null);
      setResolvedQueryKey(null);
      setLoadedFolderPath(null);
    } finally {
      if (generation === loadGenerationRef.current) {
        setLoadingMode('idle');
      }
    }
  }, []);

  // Blocking load on query change (folder / page / sort / filter) and explicit reloads.
  useEffect(() => {
    void loadDiffData('blocking', currentQuery);
  }, [currentQuery, loadDiffData, reloadKey]);

  // In-place refresh on workspace-level invalidation or a post-action bump — reads the query via a
  // ref so it never fires on folder/query changes (those are the blocking effect's job).
  useEffect(() => {
    if (!didMountDataRefreshRef.current) {
      didMountDataRefreshRef.current = true;
      return;
    }
    const query = currentQueryRef.current;
    if (!query?.selectedFolderPath || !query?.workspacePath) return;
    void loadDiffData('refreshing', query);
  }, [workspaceLevelDataInvalidationCounter, reviewDataVersion, loadDiffData]);

  // On folder change, record the new folder (so `folderPending` clears once the parent's reset lands)
  // and drop any pending manual-reload key.
  useEffect(() => {
    lastResetFolderRef.current = selectedFolderPath ?? null;
    setReloadKey(0);
  }, [selectedFolderPath]);

  // ── Folder-wide By-type load ──
  const [byTypeDiffData, setByTypeDiffData] = useState<DiffGridResult | null>(null);
  const byTypeLoadGenerationRef = useRef(0);
  const byTypePrevScopeRef = useRef<string | null>(null);

  const loadByTypeDiffData = useCallback(async () => {
    if (!selectedFolderPath || !workspacePath) return;
    const generation = ++byTypeLoadGenerationRef.current;
    try {
      const result = await window.scratchFiles.readDiffGridData(selectedFolderPath, workspacePath, {
        offset: 0,
        limit: BY_TYPE_MAX_PENDING_RECORDS,
        // The pending union (unreviewed ∪ approved-but-unpublished) so the By-Field view can show
        // approved changes with a ✓ alongside the ones still needing review (DEV-10687).
        filters: [{ scope: 'global', kind: 'pending' }],
        validate: false,
      });
      if (generation !== byTypeLoadGenerationRef.current) return;
      setByTypeDiffData(result as DiffGridResult);
    } catch (err) {
      if (generation !== byTypeLoadGenerationRef.current) return;
      console.error('[useReviewSurfaceData] failed to load folder-wide pending changes', err);
    }
  }, [selectedFolderPath, workspacePath]);

  // Load the folder-wide pending set whenever the folder HAS pending changes — not only in By-type
  // mode. The Table-view change-type chips (DEV-10656) need it for their live counts and the client-
  // side filter, and the By-type toggle is disabled when nothing is pending, so this one gate serves
  // both. `filterCounts.pending` is the true folder-wide union total (page-independent).
  const folderHasPendingChanges = (diffData?.filterCounts.pending ?? 0) > 0;
  useEffect(() => {
    if (!folderHasPendingChanges || !selectedFolderPath || !workspacePath) {
      setByTypeDiffData(null);
      byTypePrevScopeRef.current = null;
      return;
    }
    const scope = `${workspacePath}::${selectedFolderPath}`;
    if (byTypePrevScopeRef.current !== scope) {
      byTypePrevScopeRef.current = scope;
      setByTypeDiffData(null); // folder changed → clear stale before reload (avoids a flash)
    }
    void loadByTypeDiffData();
  }, [
    folderHasPendingChanges,
    selectedFolderPath,
    workspacePath,
    workspaceLevelDataInvalidationCounter,
    reviewDataVersion,
    loadByTypeDiffData,
  ]);

  // filterCounts.pending is the TRUE folder-wide union total (not page-bounded), matching the
  // 'pending' filter the load uses, so this truncation check is honest even though rows are capped
  // at BY_TYPE_MAX_PENDING_RECORDS.
  const byTypeLoadedRecordCount = byTypeDiffData?.rows.length ?? 0;
  const byTypeTotalPendingRecordCount = byTypeDiffData?.filterCounts.pending ?? 0;
  const byTypeIsTruncated = byTypeDiffData ? byTypeLoadedRecordCount < byTypeTotalPendingRecordCount : false;

  // ── Reindex-progress passthrough (mirrors FolderDataGrid) ──
  const onIndexingProgressRef = useRef(onIndexingProgress);
  onIndexingProgressRef.current = onIndexingProgress;
  const [indexingProgress, setIndexingProgress] = useState<string | null>(null);

  useEffect(() => {
    if (!isBlockingLoad) {
      setIndexingProgress(null);
      return;
    }
    return window.scratchDesktop.onGridProgress((line) => {
      // Open/update on the up-front reindex start (only when big enough to be worth showing), then on
      // any per-batch "done/total" progress line.
      const startMatch = /^\[reindex\]\s+Reindexing\s+(\d+)/.exec(line);
      if (startMatch) {
        if (parseInt(startMatch[1], 10) > 1000) {
          setIndexingProgress(line.replace(/^\[\w+\]\s*/, ''));
        }
        return;
      }
      if (/\d+\/\d+/.test(line)) {
        setIndexingProgress(line.replace(/^\[\w+\]\s*/, ''));
      }
    });
  }, [isBlockingLoad]);

  useEffect(() => {
    onIndexingProgressRef.current?.(indexingProgress);
  }, [indexingProgress]);

  // ── Public callbacks ──
  const bumpReviewDataVersion = useCallback(() => setReviewDataVersion((version) => version + 1), []);
  const reloadReviewData = useCallback(() => setReloadKey((key) => key + 1), []);
  const applyOptimisticDiff = useCallback((updater: (prev: DiffGridResult) => DiffGridResult) => {
    setDiffData((prev) => (prev ? updater(prev) : prev));
  }, []);

  const totalPages = Math.max(1, Math.ceil((diffData?.total ?? 0) / PAGE_SIZE));

  return {
    diffData,
    error,
    isBlockingLoad,
    isBackgroundRefreshing,
    loadedFolderPath,
    totalPages,
    byTypeDiffData,
    byTypeIsTruncated,
    byTypeLoadedRecordCount,
    byTypeTotalPendingRecordCount,
    bumpReviewDataVersion,
    reloadReviewData,
    applyOptimisticDiff,
  };
}
