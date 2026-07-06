import { ButtonSecondaryGhost, ButtonSecondaryOutline } from '@/components/base/buttons';
import { Text12Regular, Text13Medium, Text13Regular } from '@/components/base/text';
import { Box, Group, Loader, Modal } from '@mantine/core';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { trackOpenRecordChangesDrawer } from '../../../lib/posthog';
import { useWorkspaceUiStore, type FilterKind } from '../../../stores/workspace-ui-store';
import type { WorkspaceConnection } from '../../../types/local-files';
import { applyAcceptedFieldChangeToFolderDiffData } from '../diff-grid-types';
import { rowHasUnreviewedChanges } from '../record-diff-helpers';
import { RecordDetailView } from '../RecordDetailView';
import { RecordReviewDrawer } from '../RecordReviewDrawer';
import { buildByTypeGroupModel, type ByTypeGroupModel, type ByTypeSourceColumn } from './build-by-type-group-model';
import { ByTypeView } from './ByTypeView';
import { ReviewContextBanner } from './ReviewContextBanner';
import { ReviewSubbar } from './ReviewSubbar';
import { ReviewTableGrid } from './ReviewTableGrid';
import { useFolderSchemaAndTableView } from './use-folder-schema-and-table-view';
import { useReviewDetailColumnMetadata } from './use-review-detail-column-metadata';
import { useReviewLadderActions, type BulkReviewAction } from './use-review-ladder-actions';
import { useReviewSurfaceData } from './use-review-surface-data';

/**
 * The v2 review surface's top-level host — a sibling to `FolderDataGrid` (never a fork), rendered
 * *instead of* it when `DESKTOP_REVIEW_SURFACE_V2` is on. It keeps `FolderDataGrid`'s exact props
 * (plus `connections`, threaded from `WorkspaceContent` to name the banner's connector), so the
 * Phase 7 cutover is a one-line ternary and the revert a one-liner.
 *
 * It owns the header chrome (`ReviewContextBanner` + `ReviewSubbar`), the body switch
 * (`reviewSurfaceViewMode` → `ReviewTableGrid` | `ByTypeView`), the pagination footer, the
 * bulk approve/reject/discard confirm modal, and — since the Phase 7 cutover — the
 * `RecordChangesDrawer` stepper (opened by a row / By-type group-row click) plus the
 * `RecordDetailView` deep-edit overlay (opened by the store's record selection, e.g.
 * ValidationPanel's "navigate to field"). It composes the two hooks
 * (`useReviewSurfaceData` + `useReviewLadderActions`) for all data and IPC.
 *
 * `targetRecord` (search jump) stays deferred to Phase 9; it is accepted on the interface for
 * prop-contract parity with `FolderDataGrid` but not yet wired.
 */
interface FolderReviewSurfaceProps {
  /** Included so the cutover memo invalidates when switching workbooks even if paths match. */
  workspaceId: string;
  selectedFolderPath: string | null;
  workspacePath: string | null;
  /** Search jump — deferred to Phase 9; accepted on the interface for prop-contract parity. */
  targetRecord?: { filename: string; trigger: string } | null;
  workspaceLevelDataInvalidationCounter: number;
  invalidateWorkspaceLevelData: () => void;
  /** Per-record publish — flows through to the `RecordDetailView` housing. */
  onPublishFile?: (relativePath: string) => void;
  /** Activates a global filter (the header "N to review" pill) once the folder is ready. */
  activateGlobalFilter?: { kind: FilterKind; trigger: number } | null;
  onActivateGlobalFilterConsumed?: () => void;
  onIndexingProgress?: (message: string | null) => void;
  /** Workspace connections (threaded from `WorkspaceContent`) — names the banner's connector. */
  connections: WorkspaceConnection[];
}

// Root frame shared by the surface and its no-folder empty state, matching `FolderDataGrid`'s
// bordered panel so both drop into the same slot: `flex: 1` + `minWidth: 0` fills the remaining
// width (instead of sizing to the grid's content), and the border/radius/overflow give the frame.
const REVIEW_SURFACE_FRAME_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  backgroundColor: 'var(--bg-base)',
  border: '0.5px solid var(--fg-divider)',
  borderRadius: 4,
  overflow: 'hidden',
};

export function FolderReviewSurface(props: FolderReviewSurfaceProps): ReactElement {
  const {
    workspaceId,
    selectedFolderPath,
    workspacePath,
    workspaceLevelDataInvalidationCounter,
    invalidateWorkspaceLevelData,
    activateGlobalFilter,
    onActivateGlobalFilterConsumed,
    onIndexingProgress,
    connections,
  } = props;

  // Shared review UI state (identical slices the v1 grid drives — only one surface renders at a time).
  const reviewSurfaceViewMode = useWorkspaceUiStore((s) => s.reviewSurfaceViewMode);
  const setReviewSurfaceViewMode = useWorkspaceUiStore((s) => s.setReviewSurfaceViewMode);
  const activeFilters = useWorkspaceUiStore((s) => s.activeFilters);
  const setActiveFilters = useWorkspaceUiStore((s) => s.setActiveFilters);
  const validate = useWorkspaceUiStore((s) => s.validateEnabled);
  const page = useWorkspaceUiStore((s) => s.page);
  const setPage = useWorkspaceUiStore((s) => s.setPage);
  // Column visibility (null = auto: all columns, or just changed+title while a review filter is on).
  const visibleColumnIds = useWorkspaceUiStore((s) => s.visibleColumnIds);
  const setVisibleColumnIds = useWorkspaceUiStore((s) => s.setVisibleColumnIds);
  // Deep-edit overlay selection (also set by ValidationPanel's "navigate to field"): drives RecordDetailView.
  const selectedRecordFilename = useWorkspaceUiStore((s) => s.selectedRecordFilename);
  const showGrid = useWorkspaceUiStore((s) => s.showGrid);
  const showRecord = useWorkspaceUiStore((s) => s.showRecord);

  // Inside the host the v2 flag is implicitly on (the parent only renders us when it is), so By-type
  // mode is just the view-mode selection.
  const isByTypeMode = reviewSurfaceViewMode === 'by-type';

  const { schema, tableView } = useFolderSchemaAndTableView(selectedFolderPath, workspacePath);

  const {
    diffData,
    error,
    isBlockingLoad,
    loadedFolderPath,
    totalPages,
    byTypeDiffData,
    byTypeIsTruncated,
    byTypeLoadedRecordCount,
    byTypeTotalPendingRecordCount,
    bumpReviewDataVersion,
    applyOptimisticDiff,
  } = useReviewSurfaceData({
    selectedFolderPath,
    workspacePath,
    workspaceLevelDataInvalidationCounter,
    isByTypeMode,
    onIndexingProgress,
  });

  // Column metadata for the By-type model and the RecordDetailView deep-edit overlay — a shared,
  // verbatim lift of `FolderDataGrid`'s column memos (`FolderDataGrid` keeps its own copies until the
  // Phase 8 deletion). `flatViewColumns` is the FULL flattened view (so view-hidden columns with
  // changes still group); `columnEffectivePaths` is the sparse WordPress `title` → `title.raw` map.
  const columnMetadata = useReviewDetailColumnMetadata(tableView, diffData);
  const { flatViewColumns, titleColumnId, columnLabels, columnEffectivePaths } = columnMetadata;

  const byTypeColumns = useMemo<ByTypeSourceColumn[]>(
    () => flatViewColumns.map((col) => ({ id: col.path, displayName: col.name ?? col.path })),
    [flatViewColumns],
  );
  const byTypeGroups = useMemo(
    () =>
      byTypeDiffData
        ? buildByTypeGroupModel(byTypeDiffData.rows, byTypeColumns, columnEffectivePaths, titleColumnId)
        : [],
    [byTypeDiffData, byTypeColumns, columnEffectivePaths, titleColumnId],
  );

  // Deep-edit overlay: the store's record selection (set by the maximize action or ValidationPanel's
  // "navigate to field") drives RecordDetailView, indexed into the current page's rows.
  const detailRowIndex = useMemo(() => {
    if (!selectedRecordFilename || !diffData) return null;
    const index = diffData.rows.findIndex((row) => row.__filename === selectedRecordFilename);
    return index >= 0 ? index : null;
  }, [selectedRecordFilename, diffData]);
  // ── Column visibility + picker (ported from FolderDataGrid) ──
  // A global review filter (Pending, or an externally-activated unreviewed/unpublished) narrows the
  // default column set to just the changed columns + the title; All shows every column.
  const globalFilterKind = activeFilters.find((filter) => filter.scope === 'global')?.kind ?? null;
  const isReviewFilterActive =
    globalFilterKind === 'pending' || globalFilterKind === 'unreviewed' || globalFilterKind === 'unpublished';

  // Column ids carrying a diff, ordered by the view's column order for a stable display.
  const changedColumnIds = useMemo(() => {
    if (!diffData) return [];
    const changed = new Set<string>([...diffData.focusColumnIds.unreviewed, ...diffData.focusColumnIds.unpublished]);
    return columnMetadata.columnOrder.filter((path) => changed.has(path));
  }, [diffData, columnMetadata.columnOrder]);

  // The columns the grid actually renders. `visibleColumnIds` non-null = user's explicit choice;
  // null = auto (changed+title while reviewing, else all columns).
  const effectiveVisibleColumnIds = useMemo<string[] | null>(() => {
    if (visibleColumnIds !== null) return visibleColumnIds;
    if (isReviewFilterActive && changedColumnIds.length > 0) {
      const anchorColumnId = titleColumnId ?? columnMetadata.columnOrder[0] ?? null;
      return anchorColumnId
        ? [anchorColumnId, ...changedColumnIds.filter((path) => path !== anchorColumnId)]
        : changedColumnIds;
    }
    return null;
  }, [visibleColumnIds, isReviewFilterActive, changedColumnIds, titleColumnId, columnMetadata.columnOrder]);

  // What the ColumnPickerMenu and RecordDetailView treat as "visible" (the effective set, or all).
  const effectiveVisibleColumnList = effectiveVisibleColumnIds ?? columnMetadata.columnOrder;
  const visibleColumnPaths = useMemo(() => new Set(effectiveVisibleColumnList), [effectiveVisibleColumnList]);

  // Banner groups reshaped for ColumnPickerMenu (`Map<path, groupName>` → `{ name, columnIds }[]`).
  const columnGroupsForPicker = useMemo(() => {
    const columnIdsByGroupName = new Map<string, string[]>();
    const groupNameOrder: string[] = [];
    for (const path of columnMetadata.columnOrder) {
      const groupName = columnMetadata.columnGroups.get(path);
      if (!groupName) continue;
      let ids = columnIdsByGroupName.get(groupName);
      if (!ids) {
        ids = [];
        columnIdsByGroupName.set(groupName, ids);
        groupNameOrder.push(groupName);
      }
      ids.push(path);
    }
    return groupNameOrder.map((name) => ({ name, columnIds: columnIdsByGroupName.get(name) ?? [] }));
  }, [columnMetadata.columnOrder, columnMetadata.columnGroups]);

  const { editCell, approveAllForGroup, approvingGroupKeys, runBulkAction, bulkActionLoading, handleRecordReviewed } =
    useReviewLadderActions({
      workspaceId,
      selectedFolderPath,
      workspacePath,
      schema,
      byTypeIsTruncated,
      bumpReviewDataVersion,
      applyOptimisticDiff,
      invalidateWorkspaceLevelData,
    });

  // The header "N to review" pill activates a global filter; the new surface has no column picker, so
  // this just sets the shared filter state (no column narrowing).
  const lastConsumedFilterTriggerRef = useRef(0);
  useEffect(() => {
    if (!activateGlobalFilter || activateGlobalFilter.trigger <= lastConsumedFilterTriggerRef.current) return;
    lastConsumedFilterTriggerRef.current = activateGlobalFilter.trigger;
    setActiveFilters([{ scope: 'global', kind: activateGlobalFilter.kind }]);
    onActivateGlobalFilterConsumed?.();
  }, [activateGlobalFilter, setActiveFilters, onActivateGlobalFilterConsumed]);

  // Default a freshly-opened folder that has pending/approved changes to the "Pending" filter, so
  // the user lands straight on the work that needs attention. Applied once per folder, and only once
  // a settled load for THAT folder has landed (`loadedFolderPath` guards against acting on the stale
  // data still painted mid-switch) — never over a filter the user or the header pill already set.
  const defaultedReviewFilterFolderRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedFolderPath || loadedFolderPath !== selectedFolderPath) return;
    if (defaultedReviewFilterFolderRef.current === selectedFolderPath) return;
    defaultedReviewFilterFolderRef.current = selectedFolderPath;
    const pendingCount = diffData?.filterCounts?.pending ?? 0;
    const hasGlobalFilter = activeFilters.some((filter) => filter.scope === 'global');
    if (pendingCount > 0 && !hasGlobalFilter) {
      setActiveFilters([{ scope: 'global', kind: 'pending' }]);
    }
  }, [selectedFolderPath, loadedFolderPath, diffData, activeFilters, setActiveFilters]);

  // "By field" is only meaningful when there's something to review — if the pending count drops to
  // zero while it's active (all approved/rejected), fall back to the table so it's never left empty.
  useEffect(() => {
    if (
      reviewSurfaceViewMode === 'by-type' &&
      loadedFolderPath === selectedFolderPath &&
      (diffData?.filterCounts?.pending ?? 0) === 0
    ) {
      setReviewSurfaceViewMode('table');
    }
  }, [reviewSurfaceViewMode, loadedFolderPath, selectedFolderPath, diffData, setReviewSurfaceViewMode]);

  // Exclusive global filter for the subbar pills: `null` = All (clear). Selecting a scope also
  // resets column narrowing to auto so the default (changed+title when reviewing, all otherwise)
  // recomputes for the new scope.
  const onSelectGlobalFilter = useCallback(
    (kind: 'pending' | 'has-problems' | null) => {
      setActiveFilters((prev) => {
        const withoutGlobal = prev.filter((filter) => filter.scope !== 'global');
        return kind === null ? withoutGlobal : [...withoutGlobal, { scope: 'global', kind }];
      });
      setVisibleColumnIds(null);
    },
    [setActiveFilters, setVisibleColumnIds],
  );

  // ── Record-changes drawer (the stepper overlay opened by a single click on a changed row) ──
  // Local, modal-like state (per stores/CLAUDE.md), mutually exclusive with the RecordDetailView
  // deep-edit overlay (which the store's `selectedRecordFilename` drives). `ReviewTableGrid` owns the
  // single-vs-double-click debounce, so these handlers just open the drawer immediately.
  const [recordChangesDrawerFilename, setRecordChangesDrawerFilename] = useState<string | null>(null);
  // A By-type group's records when opened from there (the stepper cycles within the group); null means
  // page-scoped (the table's changed records). Pruned as records are reviewed so the stepper never
  // lands back on an already-approved record.
  const [recordChangesDrawerFilenameSet, setRecordChangesDrawerFilenameSet] = useState<string[] | null>(null);

  // Changed records on the current page, in the grid's displayed order (`ReviewTableGrid` renders
  // `diffData.rows` verbatim), so the stepper matches what the user sees.
  const changedRecordFilenames = useMemo(
    () => (diffData?.rows ?? []).filter((row) => rowHasUnreviewedChanges(row)).map((row) => row.__filename),
    [diffData?.rows],
  );
  const drawerFilenames = useMemo(
    () => recordChangesDrawerFilenameSet ?? changedRecordFilenames,
    [recordChangesDrawerFilenameSet, changedRecordFilenames],
  );
  const recordChangesDrawerIndex = useMemo(
    () => (recordChangesDrawerFilename ? drawerFilenames.indexOf(recordChangesDrawerFilename) : -1),
    [recordChangesDrawerFilename, drawerFilenames],
  );

  const closeRecordChangesDrawer = useCallback(() => {
    setRecordChangesDrawerFilename(null);
    setRecordChangesDrawerFilenameSet(null);
  }, []);

  const handleOpenRecordDrawer = useCallback(
    (filename: string) => {
      const row = diffData?.rows.find((r) => r.__filename === filename);
      // Changed records step through the page's changed set; a no-change record opens on its own
      // (1/1) so clicking any row reveals its full record in the drawer's All-fields mode.
      setRecordChangesDrawerFilenameSet(rowHasUnreviewedChanges(row) ? null : [filename]);
      setRecordChangesDrawerFilename(filename);
      void trackOpenRecordChangesDrawer(workspaceId, {
        folderPath: selectedFolderPath,
        rowStatus: row?.__rowStatus ?? 'unknown',
      });
    },
    [diffData?.rows, workspaceId, selectedFolderPath],
  );

  const handleOpenGroupRow = useCallback(
    (group: ByTypeGroupModel, filename: string) => {
      setRecordChangesDrawerFilenameSet(group.recordFilenames); // group-scoped stepper
      setRecordChangesDrawerFilename(filename);
      void trackOpenRecordChangesDrawer(workspaceId, {
        folderPath: selectedFolderPath,
        rowStatus: group.rows.find((groupRow) => groupRow.filename === filename)?.rowStatus ?? 'unknown',
      });
    },
    [workspaceId, selectedFolderPath],
  );

  // The record to show after the current one leaves the stepped set, computed from the set as it is
  // now (before the async refetch resolves). Null when nothing remains, which closes the drawer.
  const nextChangedRecordAfter = useCallback(
    (filename: string): string | null => {
      const index = drawerFilenames.indexOf(filename);
      const remaining = drawerFilenames.filter((f) => f !== filename);
      if (remaining.length === 0) return null;
      return remaining[Math.min(Math.max(index, 0), remaining.length - 1)] ?? null;
    },
    [drawerFilenames],
  );

  const handleRecordChangeReviewed = useCallback(
    (filename: string, action: 'approve' | 'reject') => {
      // The reviewed record may be off the current page (drawer opened from a By-type group), so fall
      // back to the folder-wide By-type set for the tracking snapshot.
      const row =
        diffData?.rows.find((r) => r.__filename === filename) ??
        byTypeDiffData?.rows.find((r) => r.__filename === filename);
      const trackProps = {
        rowStatus: row?.__rowStatus ?? 'unknown',
        changedFieldCount: row?.__changedFields.length ?? 0,
      };
      // Advance the stepper (or close when none remain) and drop the reviewed record from a
      // group-scoped set so the stepper never lands back on it.
      setRecordChangesDrawerFilename(nextChangedRecordAfter(filename));
      setRecordChangesDrawerFilenameSet((set) => (set ? set.filter((f) => f !== filename) : set));
      // The drawer already ran the accept/reject IPC; the hook only tracks + refreshes both surfaces
      // and invalidates the workspace-level counts. Stepper advance stays here in the host.
      handleRecordReviewed(action, trackProps);
    },
    [diffData?.rows, byTypeDiffData, nextChangedRecordAfter, handleRecordReviewed],
  );

  // Opening the deep-edit overlay (store selection) closes the drawer, so the two never co-render.
  useEffect(() => {
    if (selectedRecordFilename) closeRecordChangesDrawer();
  }, [selectedRecordFilename, closeRecordChangesDrawer]);
  // Close the drawer when the folder changes.
  useEffect(() => {
    closeRecordChangesDrawer();
  }, [selectedFolderPath, closeRecordChangesDrawer]);
  // Switching Table ⇄ By-type closes the drawer so a group-scoped stepper never lingers over the table.
  useEffect(() => {
    closeRecordChangesDrawer();
  }, [reviewSurfaceViewMode, closeRecordChangesDrawer]);
  // Close if the open record dropped out of the stepped set (approved/rejected, or its group emptied).
  useEffect(() => {
    if (recordChangesDrawerFilename && recordChangesDrawerIndex < 0) {
      closeRecordChangesDrawer();
    }
  }, [recordChangesDrawerFilename, recordChangesDrawerIndex, closeRecordChangesDrawer]);

  // ── Bulk confirm modal (host owns the modal open/close flag) ──
  const [bulkActionConfirm, setBulkActionConfirm] = useState<BulkReviewAction | null>(null);
  const filterCounts = diffData?.filterCounts;
  const pendingCount = filterCounts?.unreviewed ?? 0;
  const approvedCount = filterCounts?.unpublished ?? 0;

  const confirmBulkAction = useCallback(() => {
    if (!bulkActionConfirm) return;
    void runBulkAction(bulkActionConfirm).finally(() => setBulkActionConfirm(null));
  }, [bulkActionConfirm, runBulkAction]);

  const folderLabel = selectedFolderPath?.split('/').filter(Boolean).pop() ?? 'this folder';

  // No folder selected → the same clean "Select a folder to view data" panel as `FolderDataGrid`,
  // not the review chrome (banner + subbar), which looks broken with nothing to review.
  if (!selectedFolderPath || !workspacePath) {
    return (
      <Box style={REVIEW_SURFACE_FRAME_STYLE}>
        <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Text13Regular c="dimmed">Select a folder to view data</Text13Regular>
        </Box>
      </Box>
    );
  }

  const body = ((): ReactElement => {
    if (isByTypeMode) {
      if (byTypeDiffData === null) {
        return (
          <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Loader size="sm" />
          </Box>
        );
      }
      return (
        <ByTypeView
          groups={byTypeGroups}
          isTruncated={byTypeIsTruncated}
          loadedRecordCount={byTypeLoadedRecordCount}
          totalPendingRecordCount={byTypeTotalPendingRecordCount}
          approvingGroupKeys={approvingGroupKeys}
          onApproveAllForGroup={approveAllForGroup}
          onOpenGroupRow={handleOpenGroupRow}
        />
      );
    }
    if (error && !diffData) {
      return (
        <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
          <Text13Regular c="var(--mantine-color-red-6)">{error}</Text13Regular>
        </Box>
      );
    }
    if (isBlockingLoad || diffData === null) {
      return (
        <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Loader size="sm" />
        </Box>
      );
    }
    return (
      <ReviewTableGrid
        diffData={diffData}
        tableView={tableView}
        schema={schema}
        visibleColumnIds={effectiveVisibleColumnIds}
        onOpenRecordDrawer={handleOpenRecordDrawer}
        onCellEdited={editCell}
      />
    );
  })();

  return (
    <Box style={REVIEW_SURFACE_FRAME_STYLE}>
      <ReviewContextBanner
        selectedFolderPath={selectedFolderPath}
        connections={connections}
        pendingCount={pendingCount}
        approvedCount={approvedCount}
        onDiscardAll={() => setBulkActionConfirm('discard')}
        discardDisabled={pendingCount + approvedCount === 0 || bulkActionLoading}
      />
      <ReviewSubbar
        viewMode={reviewSurfaceViewMode}
        onViewModeChange={setReviewSurfaceViewMode}
        filterCounts={filterCounts}
        activeFilters={activeFilters}
        onSelectGlobalFilter={onSelectGlobalFilter}
        validate={validate}
        disabled={isBlockingLoad}
        columnPicker={{
          allColumns: columnMetadata.columnOrder,
          visibleColumns: effectiveVisibleColumnList,
          titleColumnId,
          unreviewedColumnIds: diffData?.focusColumnIds.unreviewed ?? [],
          approvedColumnIds: diffData?.focusColumnIds.unpublished ?? [],
          columnLabels,
          columnGroups: columnGroupsForPicker,
          onChangeVisible: setVisibleColumnIds,
        }}
      />

      <Box style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
        {body}
        {detailRowIndex !== null && diffData && selectedFolderPath && workspacePath && (
          <RecordDetailView
            rows={diffData.rows}
            selectedIndex={detailRowIndex}
            folderPath={selectedFolderPath}
            workspacePath={workspacePath}
            schema={schema}
            titleColumnId={titleColumnId}
            columnOrder={columnMetadata.columnOrder}
            columnLabels={columnLabels}
            columnDescriptions={columnMetadata.columnDescriptions}
            readonlyFields={columnMetadata.readonlyFields}
            columnTypes={columnMetadata.columnTypes}
            columnEffectivePaths={columnEffectivePaths}
            columnGroups={columnMetadata.columnGroups}
            allColumnPaths={columnMetadata.allColumnPaths}
            visibleColumnPaths={visibleColumnPaths}
            onSelectIndex={(nextIndex) => {
              const nextFilename = diffData.rows[nextIndex]?.__filename;
              if (nextFilename) showRecord(nextFilename);
            }}
            onClose={() => showGrid()}
            workspaceLevelDataInvalidationCounter={workspaceLevelDataInvalidationCounter}
            onRecordStructurallyChangedRefetchAll={() => {
              bumpReviewDataVersion();
              invalidateWorkspaceLevelData();
            }}
            onSingleFieldAcceptedApplyOptimistically={(filename, fieldName, nextValue) =>
              applyOptimisticDiff((prev) =>
                applyAcceptedFieldChangeToFolderDiffData(prev, filename, fieldName, nextValue),
              )
            }
            onPublishFile={props.onPublishFile}
          />
        )}
      </Box>

      {!isByTypeMode && totalPages > 1 && (
        <Box
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 4,
            padding: '6px 16px',
            borderTop: '0.5px solid var(--fg-divider)',
          }}
        >
          <Box
            component="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            style={{
              padding: '1px 6px',
              border: '1px solid var(--fg-divider)',
              borderRadius: 4,
              backgroundColor: 'transparent',
              cursor: page <= 1 ? 'default' : 'pointer',
              opacity: page <= 1 ? 0.4 : 1,
            }}
          >
            <Text12Regular>&#8592;</Text12Regular>
          </Box>
          <Text12Regular c="var(--fg-muted)">
            {page.toLocaleString()} / {totalPages.toLocaleString()}
          </Text12Regular>
          <Box
            component="button"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            style={{
              padding: '1px 6px',
              border: '1px solid var(--fg-divider)',
              borderRadius: 4,
              backgroundColor: 'transparent',
              cursor: page >= totalPages ? 'default' : 'pointer',
              opacity: page >= totalPages ? 0.4 : 1,
            }}
          >
            <Text12Regular>&#8594;</Text12Regular>
          </Box>
        </Box>
      )}

      <Modal
        opened={bulkActionConfirm !== null}
        onClose={() => setBulkActionConfirm(null)}
        title={
          <Text13Medium>
            {bulkActionConfirm === 'discard' ? (
              <>
                Discard {(pendingCount + approvedCount).toLocaleString()}{' '}
                {pendingCount + approvedCount === 1 ? 'change' : 'changes'} in {folderLabel}?
              </>
            ) : (
              <>
                {bulkActionConfirm === 'approve' ? 'Approve' : 'Reject'} {pendingCount.toLocaleString()} pending{' '}
                {pendingCount === 1 ? 'change' : 'changes'} in {folderLabel}?
              </>
            )}
          </Text13Medium>
        }
        size="sm"
        padding="md"
      >
        {bulkActionConfirm === 'discard' && (
          <>
            <Text13Regular>
              This will discard all pending and approved changes in this table, reverting every record to its last
              published state. This cannot be undone.
            </Text13Regular>
            <Text12Regular c="var(--fg-muted)" mt="xs">
              {pendingCount.toLocaleString()} pending + {approvedCount.toLocaleString()} approved ={' '}
              {(pendingCount + approvedCount).toLocaleString()} changes will be discarded.
            </Text12Regular>
          </>
        )}
        <Group justify="flex-end" mt="md">
          <ButtonSecondaryOutline size="compact-sm" onClick={() => setBulkActionConfirm(null)}>
            Cancel
          </ButtonSecondaryOutline>
          <ButtonSecondaryGhost
            size="compact-sm"
            c={bulkActionConfirm === 'approve' ? 'green.8' : 'red.8'}
            loading={bulkActionLoading}
            onClick={confirmBulkAction}
          >
            {bulkActionConfirm === 'approve'
              ? 'Approve all'
              : bulkActionConfirm === 'discard'
                ? 'Discard all'
                : 'Reject all'}
          </ButtonSecondaryGhost>
        </Group>
      </Modal>

      {/* The changes drawer (a Portal) overlays whichever review body is shown — the canvas grid or
          the By-type view — and is mutually exclusive with the deep-edit RecordDetailView. */}
      {recordChangesDrawerFilename &&
        recordChangesDrawerIndex >= 0 &&
        selectedRecordFilename === null &&
        selectedFolderPath &&
        workspacePath && (
          <RecordReviewDrawer
            folderPath={selectedFolderPath}
            workspacePath={workspacePath}
            titleColumnId={titleColumnId}
            columnLabels={columnLabels}
            columnEffectivePaths={columnEffectivePaths}
            changedFilenames={drawerFilenames}
            currentIndex={recordChangesDrawerIndex}
            onSelectIndex={(index) => setRecordChangesDrawerFilename(drawerFilenames[index] ?? null)}
            onClose={closeRecordChangesDrawer}
            onApproved={(filename) => handleRecordChangeReviewed(filename, 'approve')}
            onRejected={(filename) => handleRecordChangeReviewed(filename, 'reject')}
            onSingleFieldAccepted={(filename, fieldName, nextValue) =>
              applyOptimisticDiff((prev) =>
                applyAcceptedFieldChangeToFolderDiffData(prev, filename, fieldName, nextValue),
              )
            }
            onFieldReviewedRefetchAll={() => {
              bumpReviewDataVersion();
              invalidateWorkspaceLevelData();
            }}
          />
        )}
    </Box>
  );
}
