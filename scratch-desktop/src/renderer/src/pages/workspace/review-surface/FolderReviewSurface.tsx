import { ButtonSecondaryGhost, ButtonSecondaryOutline } from '@/components/base/buttons';
import { Text12Regular, Text13Medium, Text13Regular } from '@/components/base/text';
import { Box, Group, Loader, Modal } from '@mantine/core';
import type { TableViewCol } from '@spinner/shared-types';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { flattenTableViewColumns } from '../../../../../shared/schema-columns';
import { useWorkspaceUiStore, type FilterKind } from '../../../stores/workspace-ui-store';
import type { WorkspaceConnection } from '../../../types/local-files';
import { resolveEffectivePath } from '../grid-cell-diff-state';
import { buildByTypeGroupModel, type ByTypeSourceColumn } from './build-by-type-group-model';
import { ByTypeView } from './ByTypeView';
import { ReviewContextBanner } from './ReviewContextBanner';
import { ReviewSubbar } from './ReviewSubbar';
import { ReviewTableGrid } from './ReviewTableGrid';
import { useFolderSchemaAndTableView } from './use-folder-schema-and-table-view';
import { useReviewLadderActions, type BulkReviewAction } from './use-review-ladder-actions';
import { useReviewSurfaceData } from './use-review-surface-data';

/**
 * The v2 review surface's top-level host — a sibling to `FolderDataGrid` (never a fork), rendered
 * *instead of* it when `DESKTOP_REVIEW_SURFACE_V2` is on. It keeps `FolderDataGrid`'s exact props
 * (plus `connections`, threaded from `WorkspaceContent` to name the banner's connector), so the
 * Phase 7 cutover is a one-line ternary and the revert a one-liner.
 *
 * It owns the header chrome (`ReviewContextBanner` + `ReviewSubbar`), the body switch
 * (`reviewSurfaceViewMode` → `ReviewTableGrid` | `ByTypeView`), the pagination footer, and the
 * bulk approve/reject/discard confirm modal — composing the two hooks
 * (`useReviewSurfaceData` + `useReviewLadderActions`) for all data and IPC.
 *
 * **Ships dark (Phase 6):** nothing mounts it until the Phase 7 cutover, which additionally moves
 * the `RecordChangesDrawer` + `RecordDetailView` overlay housing here. Until then the row-click /
 * group-row-click callbacks are deliberate no-op stubs, and `targetRecord` (search jump) /
 * `onPublishFile` (per-record publish) are accepted on the interface but wired at cutover.
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
  /** Per-record publish — wired into the `RecordDetailView` housing at the Phase 7 cutover. */
  onPublishFile?: (relativePath: string) => void;
  /** Activates a global filter (the header "N to review" pill) once the folder is ready. */
  activateGlobalFilter?: { kind: FilterKind; trigger: number } | null;
  onActivateGlobalFilterConsumed?: () => void;
  onIndexingProgress?: (message: string | null) => void;
  /** Workspace connections (threaded from `WorkspaceContent`) — names the banner's connector. */
  connections: WorkspaceConnection[];
}

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

  // Inside the host the v2 flag is implicitly on (the parent only renders us when it is), so By-type
  // mode is just the view-mode selection.
  const isByTypeMode = reviewSurfaceViewMode === 'by-type';

  const { schema, tableView } = useFolderSchemaAndTableView(selectedFolderPath, workspacePath);

  const {
    diffData,
    error,
    isBlockingLoad,
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

  // By-type group inputs, built the same way `FolderDataGrid` does: from the FULL flattened view
  // columns (so view-hidden columns with changes still group), a sparse effective-path map (WordPress
  // `title` → `title.raw`), and the first column as the record's title. The table grid builds its own
  // columns internally, so the host only computes what the By-type model needs.
  const flatViewCols = useMemo<TableViewCol[]>(
    () => (tableView ? flattenTableViewColumns(tableView) : []),
    [tableView],
  );
  const byTypeColumns = useMemo<ByTypeSourceColumn[]>(
    () => flatViewCols.map((col) => ({ id: col.path, displayName: col.name ?? col.path })),
    [flatViewCols],
  );
  const titleColumnId = useMemo(() => flatViewCols[0]?.path ?? null, [flatViewCols]);
  const columnEffectivePaths = useMemo(() => {
    const map = new Map<string, string>();
    for (const col of flatViewCols) {
      const effective = resolveEffectivePath(col.path, col);
      if (effective !== col.path) map.set(col.path, effective);
    }
    return map;
  }, [flatViewCols]);
  const byTypeGroups = useMemo(
    () =>
      byTypeDiffData
        ? buildByTypeGroupModel(byTypeDiffData.rows, byTypeColumns, columnEffectivePaths, titleColumnId)
        : [],
    [byTypeDiffData, byTypeColumns, columnEffectivePaths, titleColumnId],
  );

  const { editCell, approveAllForGroup, approvingGroupKeys, runBulkAction, bulkActionLoading } = useReviewLadderActions(
    {
      workspaceId,
      selectedFolderPath,
      workspacePath,
      schema,
      byTypeIsTruncated,
      bumpReviewDataVersion,
      applyOptimisticDiff,
      invalidateWorkspaceLevelData,
    },
  );

  // The header "N to review" pill activates a global filter; the new surface has no column picker, so
  // this just sets the shared filter state (no column narrowing).
  const lastConsumedFilterTriggerRef = useRef(0);
  useEffect(() => {
    if (!activateGlobalFilter || activateGlobalFilter.trigger <= lastConsumedFilterTriggerRef.current) return;
    lastConsumedFilterTriggerRef.current = activateGlobalFilter.trigger;
    setActiveFilters([{ scope: 'global', kind: activateGlobalFilter.kind }]);
    onActivateGlobalFilterConsumed?.();
  }, [activateGlobalFilter, setActiveFilters, onActivateGlobalFilterConsumed]);

  // A single global filter at a time: toggle the kind, dropping any other active global filter.
  const onToggleGlobalFilter = useCallback(
    (kind: FilterKind) => {
      setActiveFilters((prev) => {
        const alreadyActive = prev.some((filter) => filter.scope === 'global' && filter.kind === kind);
        const withoutGlobal = prev.filter((filter) => filter.scope !== 'global');
        return alreadyActive ? withoutGlobal : [...withoutGlobal, { scope: 'global', kind }];
      });
    },
    [setActiveFilters],
  );

  // Phase 7 wires these to the RecordChangesDrawer; dark no-op stubs until then. Typed with no params
  // so they satisfy both callback signatures (`(filename)` and `(group, filename)`) without unused args.
  const handleOpenRecordDrawer = useCallback(() => {
    // Phase 7: opens RecordChangesDrawer scoped to the page's changed records.
  }, []);
  const handleOpenGroupRow = useCallback(() => {
    // Phase 7: opens RecordChangesDrawer scoped to the By-type group's records.
  }, []);

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

  const body = ((): ReactElement => {
    if (!selectedFolderPath || !workspacePath) {
      return (
        <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
          <Text13Regular c="var(--fg-muted)">Select a folder to review its pending changes.</Text13Regular>
        </Box>
      );
    }
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
        onOpenRecordDrawer={handleOpenRecordDrawer}
        onCellEdited={editCell}
      />
    );
  })();

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
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
        onToggleGlobalFilter={onToggleGlobalFilter}
        validate={validate}
        disabled={isBlockingLoad}
      />

      <Box style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
        {body}
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
    </Box>
  );
}
