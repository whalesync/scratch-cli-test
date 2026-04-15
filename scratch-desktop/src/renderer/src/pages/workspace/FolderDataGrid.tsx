import { ButtonSecondaryGhost, ButtonSecondaryOutline } from '@/components/base/buttons';
import DataEditor, {
  CompactSelection,
  GridCellKind,
  GridColumnMenuIcon,
  type DataEditorRef,
  type DrawCellCallback,
  type EditableGridCell,
  type GridColumn,
  type GridMouseEventArgs,
  type GridSelection,
  type HeaderClickedEventArgs,
  type Item,
  type Rectangle,
} from '@glideapps/glide-data-grid';
import '@glideapps/glide-data-grid/dist/index.css';
import { Box, Divider, Group, Loader, Modal, Popover, Portal, Stack, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Check, Columns3, Maximize2, RotateCcw } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Text12Medium, Text12Regular, Text13Medium, Text13Regular } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import { ColumnPickerMenu } from './ColumnPickerMenu';
import { FieldReferenceStrip } from './FieldReferenceStrip';
import { FieldValuePanel, type FieldValueDiffKind } from './FieldValuePanel';
import { FolderGridHeaderMenu } from './FolderGridHeaderMenu';
import { InvalidJsonFilesModal, type InvalidJsonFileListEntry } from './InvalidJsonFilesModal';
import { RecordDetailView } from './RecordDetailView';

// ── Types ──

type RowStatus = 'added' | 'modified' | 'unpublished' | 'deleted' | 'deletedUnpublished' | 'unchanged' | 'invalidJson';

interface DiffRow extends Record<string, unknown> {
  __rowStatus: RowStatus;
  __changedFields: string[];
  __fromFields: Record<string, unknown>;
  __unpublishedFields: string[];
  __masterFields: Record<string, unknown>;
  __filename: string;
  __parseError?: string;
}

interface DiffGridResult {
  rows: DiffRow[];
  columns: string[];
  total: number;
  summary: {
    total: number;
    added: number;
    modified: number;
    unpublished: number;
    deleted: number;
    invalidJson: number;
  };
  filterCounts: { unreviewed: number; unpublished: number };
  invalidJsonFiles: InvalidJsonFileListEntry[];
}

type FilterKind = 'unreviewed' | 'unpublished';
type EditorOverlayDiffKind = FieldValueDiffKind | 'none';

interface HeaderMenuState {
  columnId: string;
  columnTitle: string;
  bounds: Rectangle;
}

type GridFilter =
  | { scope: 'global'; kind: FilterKind }
  | { scope: 'column'; kind: FilterKind; columnId: string; columnTitle: string }
  | { scope: 'text'; columnId: string; columnTitle: string; value: string };

interface CellPopoverState {
  col: number;
  row: number;
  filename: string;
  fieldName: string;
  value: string;
  fromValue: string;
  diffKind: FieldValueDiffKind;
  bounds: { x: number; y: number; width: number; height: number };
}

interface FolderDataGridProps {
  /** Included so memo() invalidates when switching workbooks even if folder path + local path match. */
  workspaceId: string;
  selectedFolderPath: string | null;
  workspacePath: string | null;
  dataRefreshKey: number;
  onPublishFile?: (relativePath: string) => void;
}

// ── Constants ──

const PAGE_SIZE = 100;
const STATUS_COL_WIDTH = 50;
const STATUS_COL_ID = '__status';
const INSPECT_BUTTON_SIZE = 18;
const FLOATING_PANEL_GAP = 5;

/** Glide grid accent — uses the yellow highlight design tokens */
const GRID_THEME = {
  accentColor: '#D4C800', // highlight border
  accentFg: '#000000', // highlight text
  accentLight: '#FEFB8A', // highlight fill
};

// ── Diff colours (resolved from CSS vars in globals.css) ──

function getCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const DIFF_WORKING_BG = () => getCssVar('--needs-review-bg');
const DIFF_WORKING_BORDER = () => getCssVar('--needs-review-stroke');
const DIFF_UNPUBLISHED_BG = () => getCssVar('--approved-bg');
const DIFF_UNPUBLISHED_BORDER = () => getCssVar('--approved-stroke');
const DIFF_DELETE_REVIEW_BG = () => getCssVar('--delete-needs-review-bg');
const DIFF_DELETE_REVIEW_BORDER = () => getCssVar('--delete-needs-review-stroke');
const DIFF_DELETE_APPROVED_BG = () => getCssVar('--delete-approved-bg');
const DIFF_DELETE_APPROVED_BORDER = () => getCssVar('--delete-approved-stroke');

// ── Helpers ──

function toDisplayString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

// Mirrors parseFieldValue in src/main/local-files.ts — kept in sync by hand
// so the renderer can predict the backend's parse result for optimistic
// updates without an extra IPC round trip. If that function changes, update
// this one to match.
function parseCellValueLikeBackend(str: string): unknown {
  const trimmed = str.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return str;
  }
}

function diffValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

function deriveRowStatusAfterEdit(row: DiffRow): RowStatus {
  if (
    row.__rowStatus === 'added' ||
    row.__rowStatus === 'deleted' ||
    row.__rowStatus === 'deletedUnpublished' ||
    row.__rowStatus === 'invalidJson'
  ) {
    return row.__rowStatus;
  }
  if (row.__changedFields.length > 0) {
    return 'modified';
  }
  if (row.__unpublishedFields.length > 0) {
    return 'unpublished';
  }
  return 'unchanged';
}

function recomputeSummaryCount(prev: DiffRow, next: DiffRow, status: RowStatus, count: number): number {
  const wasStatus = prev.__rowStatus === status;
  const isStatus = next.__rowStatus === status;
  if (wasStatus === isStatus) return count;
  return count + (isStatus ? 1 : -1);
}

function recomputeFilterCount(prevHad: boolean, nextHas: boolean, count: number): number {
  if (prevHad === nextHas) return count;
  return count + (nextHas ? 1 : -1);
}

function replaceRowInResult(result: DiffGridResult, prevRow: DiffRow, nextRow: DiffRow): DiffGridResult {
  const nextRows = result.rows.map((r) => (r.__filename === prevRow.__filename ? nextRow : r));

  const prevHadUnreviewed =
    prevRow.__rowStatus === 'added' ||
    prevRow.__rowStatus === 'deleted' ||
    prevRow.__rowStatus === 'invalidJson' ||
    prevRow.__changedFields.length > 0;
  const nextHasUnreviewed =
    nextRow.__rowStatus === 'added' ||
    nextRow.__rowStatus === 'deleted' ||
    nextRow.__rowStatus === 'invalidJson' ||
    nextRow.__changedFields.length > 0;
  const prevHadUnpublished = prevRow.__rowStatus === 'deletedUnpublished' || prevRow.__unpublishedFields.length > 0;
  const nextHasUnpublished = nextRow.__rowStatus === 'deletedUnpublished' || nextRow.__unpublishedFields.length > 0;

  const summary: DiffGridResult['summary'] = {
    total: result.summary.total,
    added: recomputeSummaryCount(prevRow, nextRow, 'added', result.summary.added),
    modified: recomputeSummaryCount(prevRow, nextRow, 'modified', result.summary.modified),
    unpublished: recomputeSummaryCount(prevRow, nextRow, 'unpublished', result.summary.unpublished),
    deleted: recomputeFilterCount(
      prevRow.__rowStatus === 'deleted' || prevRow.__rowStatus === 'deletedUnpublished',
      nextRow.__rowStatus === 'deleted' || nextRow.__rowStatus === 'deletedUnpublished',
      result.summary.deleted,
    ),
    invalidJson: recomputeSummaryCount(prevRow, nextRow, 'invalidJson', result.summary.invalidJson),
  };

  const filterCounts = {
    unreviewed: recomputeFilterCount(prevHadUnreviewed, nextHasUnreviewed, result.filterCounts.unreviewed),
    unpublished: recomputeFilterCount(prevHadUnpublished, nextHasUnpublished, result.filterCounts.unpublished),
  };

  return { ...result, rows: nextRows, summary, filterCounts };
}

function applyAcceptedCellChange(
  result: DiffGridResult,
  filename: string,
  fieldName: string,
  nextValue: unknown,
): DiffGridResult {
  const prevRow = result.rows.find((r) => r.__filename === filename);
  if (!prevRow) return result;

  const masterValue = prevRow.__masterFields[fieldName];
  const masterHadField = Object.prototype.hasOwnProperty.call(prevRow.__masterFields, fieldName);
  const nextFromFields = { ...prevRow.__fromFields };
  delete nextFromFields[fieldName];

  const wasUnpublished = prevRow.__unpublishedFields.includes(fieldName);
  const matchesMaster = masterHadField && diffValuesEqual(nextValue, masterValue);
  const nextUnpublishedFields = wasUnpublished
    ? matchesMaster
      ? prevRow.__unpublishedFields.filter((f) => f !== fieldName)
      : prevRow.__unpublishedFields
    : matchesMaster
      ? prevRow.__unpublishedFields
      : [...prevRow.__unpublishedFields, fieldName];

  const nextRow: DiffRow = {
    ...prevRow,
    [fieldName]: nextValue,
    __changedFields: prevRow.__changedFields.filter((f) => f !== fieldName),
    __fromFields: nextFromFields,
    __unpublishedFields: nextUnpublishedFields,
  };
  nextRow.__rowStatus = deriveRowStatusAfterEdit(nextRow);

  return replaceRowInResult(result, prevRow, nextRow);
}

function getCellDiffState(row: DiffRow, fieldName: string): { diffKind: FieldValueDiffKind; fromValue: string } {
  const isUnreviewed = row.__changedFields.includes(fieldName);
  const isUnpublished = !isUnreviewed && row.__unpublishedFields.includes(fieldName);
  if (isUnreviewed) {
    return {
      diffKind: 'unreviewed',
      fromValue: toDisplayString(row.__fromFields[fieldName]),
    };
  }
  if (isUnpublished) {
    return {
      diffKind: 'unpublished',
      fromValue: toDisplayString(row.__masterFields[fieldName]),
    };
  }
  return { diffKind: null, fromValue: '' };
}

function inferCellKind(value: unknown): GridCellKind {
  if (typeof value === 'boolean') return GridCellKind.Boolean;
  if (typeof value === 'number') return GridCellKind.Number;
  return GridCellKind.Text;
}

function editableCellToString(cell: EditableGridCell): string {
  switch (cell.kind) {
    case GridCellKind.Text:
    case GridCellKind.Markdown:
    case GridCellKind.Uri:
      return cell.data;
    case GridCellKind.Number:
      return cell.data == null ? '' : String(cell.data);
    case GridCellKind.Boolean:
      return cell.data == null ? '' : String(cell.data);
    default:
      return '';
  }
}

function isInsideGridEditorOverlay(target: Element): boolean {
  return Boolean(target.closest('.gdg-clip-region') || target.closest('.gdg-input'));
}

function filterKey(filter: GridFilter): string {
  if (filter.scope === 'global') {
    return `global:${filter.kind}`;
  }
  if (filter.scope === 'text') {
    return `text:${filter.columnId}`;
  }
  return `column:${filter.columnId}:${filter.kind}`;
}

function filterLabel(filter: GridFilter): string {
  if (filter.scope === 'global') {
    return filter.kind === 'unreviewed' ? 'Needs review' : 'Approved';
  }
  if (filter.scope === 'text') {
    return `${filter.columnTitle}: "${filter.value}"`;
  }

  return `${filter.columnTitle}: ${filter.kind === 'unreviewed' ? 'Needs review' : 'Approved'}`;
}

// ── Row colours ──

function getRowTint(status: RowStatus): string | undefined {
  switch (status) {
    case 'added':
      return '#f0fdf4';
    case 'deleted':
      return DIFF_DELETE_REVIEW_BG();
    case 'deletedUnpublished':
      return DIFF_DELETE_APPROVED_BG();
    case 'invalidJson':
      return '#fff7ed';
    default:
      return undefined;
  }
}

// ── Filter pill ──

function FilterPill({
  label,
  count,
  active,
  bulletColor,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  bulletColor: string;
  onClick: () => void;
}) {
  return (
    <Box
      component="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 10,
        border: active ? '1.5px solid var(--highlight-border)' : '0.5px solid var(--fg-divider)',
        backgroundColor: active ? 'var(--highlight-fill)' : 'transparent',
        cursor: 'pointer',
        lineHeight: 1,
      }}
    >
      <Box style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: bulletColor, flexShrink: 0 }} />
      <Text12Medium
        c={active ? 'var(--highlight-text)' : 'var(--fg-muted)'}
        fw={active ? 500 : undefined}
        component="span"
      >
        {label}
        {` (${count.toLocaleString()})`}
      </Text12Medium>
    </Box>
  );
}

function ActiveFilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <Box
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 6px 2px 8px',
        borderRadius: 10,
        border: '1.5px solid var(--highlight-border)',
        backgroundColor: 'var(--highlight-fill)',
        lineHeight: 1,
      }}
    >
      <Text12Medium c="var(--highlight-text)" fw={500} component="span">
        {label}
      </Text12Medium>
      <Box
        component="button"
        type="button"
        onClick={onRemove}
        style={{
          border: 0,
          backgroundColor: 'transparent',
          color: 'var(--highlight-text)',
          cursor: 'pointer',
          padding: 0,
          lineHeight: 1,
        }}
      >
        <Text12Regular c="inherit" component="span">
          ×
        </Text12Regular>
      </Box>
    </Box>
  );
}

// ── Component ──

export const FolderDataGrid = memo(function FolderDataGrid(props: FolderDataGridProps) {
  const { selectedFolderPath, workspacePath, dataRefreshKey } = props;
  const [diffData, setDiffData] = useState<DiffGridResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ column: string | null; direction: 'asc' | 'desc' | null }>({
    column: null,
    direction: null,
  });
  const [activeFilters, setActiveFilters] = useState<GridFilter[]>([]);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [detailRowIndex, setDetailRowIndex] = useState<number | null>(null);
  const [schema, setSchema] = useState<Record<string, unknown> | null>(null);
  const [page, setPage] = useState(1);
  const [headerMenu, setHeaderMenu] = useState<HeaderMenuState | null>(null);
  const [gridSelection, setGridSelection] = useState<GridSelection | undefined>(undefined);
  const [activeEditorDiffKind, setActiveEditorDiffKind] = useState<EditorOverlayDiffKind | null>(null);
  const [editingCell, setEditingCell] = useState<Item | null>(null);
  const [cellPopover, setCellPopover] = useState<CellPopoverState | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [visibleColumnIds, setVisibleColumnIds] = useState<string[] | null>(null);

  const [gridSize, setGridSize] = useState<{ width: number; height: number } | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const gridRef = useRef<DataEditorRef | null>(null);
  const wrapperElRef = useRef<HTMLDivElement | null>(null);
  const cellPopoverRef = useRef<HTMLDivElement | null>(null);
  const [hoveredRowIdx, setHoveredRowIdx] = useState<number | null>(null);
  const [inspectButtonRect, setInspectButtonRect] = useState<{ x: number; y: number; height: number } | null>(null);
  const [invalidJsonModalOpen, setInvalidJsonModalOpen] = useState(false);
  const [bulkActionConfirm, setBulkActionConfirm] = useState<'approve' | 'reject' | null>(null);
  const [bulkActionLoading, setBulkActionLoading] = useState(false);

  const wrapperRef = useCallback((el: HTMLDivElement | null) => {
    wrapperElRef.current = el;
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setGridSize({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setGridSize({ width: Math.floor(width), height: Math.floor(height) });
    });
    observer.observe(el);
    observerRef.current = observer;
  }, []);

  // Load data
  useEffect(() => {
    if (!selectedFolderPath || !workspacePath) {
      setDiffData(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    window.scratchFiles
      .readDiffGridData(selectedFolderPath, workspacePath, {
        offset: (page - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
        sortBy: sort.column ?? undefined,
        sortOrder: sort.direction ?? undefined,
        filters: activeFilters,
      })
      .then((result) => {
        if (!cancelled) setDiffData(result as DiffGridResult);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load grid data');
          setDiffData(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeFilters, dataRefreshKey, page, reloadKey, selectedFolderPath, sort.column, sort.direction, workspacePath]);

  // Reset state when folder changes
  useEffect(() => {
    setSort({ column: null, direction: null });
    setActiveFilters([]);
    setColumnWidths({});
    setDetailRowIndex(null);
    setHoveredRowIdx(null);
    setInspectButtonRect(null);
    setHeaderMenu(null);
    setGridSelection(undefined);
    setActiveEditorDiffKind(null);
    setEditingCell(null);
    setSchema(null);
    setCellPopover(null);
    setPage(1);
    setReloadKey(0);
    setVisibleColumnIds(null);
  }, [selectedFolderPath]);

  useEffect(() => {
    const { body } = document;
    if (activeEditorDiffKind == null) {
      delete body.dataset.gridEditorDiff;
      return;
    }
    body.dataset.gridEditorDiff = activeEditorDiffKind;
    return () => {
      delete body.dataset.gridEditorDiff;
    };
  }, [activeEditorDiffKind]);

  // Reset to page 1 when filter or sort changes
  useEffect(() => {
    setPage(1);
  }, [activeFilters, sort]);

  // Load schema when folder changes
  useEffect(() => {
    if (!selectedFolderPath || !workspacePath) {
      setSchema(null);
      return;
    }
    let cancelled = false;
    void window.scratchFiles
      .getFolderMetadata(selectedFolderPath, workspacePath)
      .then((meta) => {
        if (!cancelled) setSchema(meta.schema);
      })
      .catch((err) => {
        console.error('Failed to load folder metadata:', err);
        if (!cancelled) setSchema(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedFolderPath, workspacePath]);

  useEffect(() => {
    if (!cellPopover) {
      return;
    }

    const nextBounds = gridRef.current?.getBounds(cellPopover.col, cellPopover.row);
    if (!nextBounds) {
      return;
    }

    setCellPopover((current) =>
      current == null ||
      (current.bounds.x === nextBounds.x &&
        current.bounds.y === nextBounds.y &&
        current.bounds.width === nextBounds.width &&
        current.bounds.height === nextBounds.height)
        ? current
        : {
            ...current,
            bounds: nextBounds,
          },
    );
  }, [cellPopover, gridSize]);

  useEffect(() => {
    if (!cellPopover) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      if (cellPopoverRef.current?.contains(target)) {
        return;
      }

      if (isInsideGridEditorOverlay(target)) {
        return;
      }

      setCellPopover(null);
    };

    window.addEventListener('mousedown', handlePointerDown, true);
    return () => window.removeEventListener('mousedown', handlePointerDown, true);
  }, [cellPopover]);

  // ── Derived ──

  const pagedRows = useMemo(() => diffData?.rows ?? [], [diffData?.rows]);
  const totalPages = Math.max(1, Math.ceil((diffData?.total ?? 0) / PAGE_SIZE));

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const titleColumnId = useMemo(() => {
    const raw = schema?.titleColumnRemoteId;
    const cols = diffData?.columns ?? [];
    // WORKAROUND(ryder): The titleColumnRemoteId isn't always set properly in the schema, or at least doesn't match
    // what we are comparing it to. If it give us an invalid value, then fall back to the first column as the title.
    if (Array.isArray(raw) && raw.length > 0 && raw.every((s) => typeof s === 'string')) {
      const realValue = raw.join('.');
      if (cols.includes(realValue)) {
        return realValue;
      }
    }
    // Fallback to the first column as the title.
    return cols[0] ?? null;
  }, [schema, diffData?.columns]);

  /** All column IDs in schema order, with title column first. */
  const allColumnIds: string[] = useMemo(() => {
    const cols = diffData?.columns ?? [];
    if (titleColumnId && cols.includes(titleColumnId)) {
      return [titleColumnId, ...cols.filter((c) => c !== titleColumnId)];
    }
    return cols;
  }, [diffData?.columns, titleColumnId]);

  /** The effective list of visible column IDs (defaults to all when picker hasn't been used yet). */
  const effectiveVisibleColumns: string[] = useMemo(
    () => visibleColumnIds ?? allColumnIds,
    [visibleColumnIds, allColumnIds],
  );

  const statusColumn: GridColumn = useMemo(
    () => ({
      id: STATUS_COL_ID,
      title: '',
      width: STATUS_COL_WIDTH,
      hasMenu: false,
      themeOverride: { borderColor: 'transparent' },
    }),
    [],
  );

  const columns: GridColumn[] = useMemo(() => {
    const visibleSet = new Set(effectiveVisibleColumns);
    const ordered = effectiveVisibleColumns.filter((c) => allColumnIds.includes(c));
    const dataCols = ordered
      .filter((name) => visibleSet.has(name))
      .map((name) => ({
        id: name,
        title: name,
        width: columnWidths[name] ?? Math.max(120, Math.min(250, name.length * 9 + 40)),
        hasMenu: true,
        menuIcon: GridColumnMenuIcon.Dots,
      }));
    return [statusColumn, ...dataCols];
  }, [allColumnIds, columnWidths, effectiveVisibleColumns, statusColumn]);

  /** Column IDs that have unreviewed changes in at least one row (from current page). */
  const unreviewedColumnIds: string[] = useMemo(() => {
    if (!diffData) return [];
    const set = new Set<string>();
    for (const row of diffData.rows) {
      for (const field of row.__changedFields) set.add(field);
    }
    return allColumnIds.filter((c) => set.has(c));
  }, [allColumnIds, diffData]);

  /** Column IDs that have approved (unpublished) changes in at least one row (from current page). */
  const approvedColumnIds: string[] = useMemo(() => {
    if (!diffData) return [];
    const set = new Set<string>();
    for (const row of diffData.rows) {
      for (const field of row.__unpublishedFields) set.add(field);
    }
    return allColumnIds.filter((c) => set.has(c));
  }, [allColumnIds, diffData]);

  // Snapshot column lists from unfiltered data so filter toggles can reference them
  // even when the current rows are already filtered to a different kind.
  const unfilteredColsRef = useRef<{ unreviewed: string[]; approved: string[] }>({
    unreviewed: [],
    approved: [],
  });
  const hasGlobalFilterActive = activeFilters.some((f) => f.scope === 'global');
  useEffect(() => {
    if (!hasGlobalFilterActive && diffData) {
      unfilteredColsRef.current = { unreviewed: unreviewedColumnIds, approved: approvedColumnIds };
    }
  }, [hasGlobalFilterActive, diffData, unreviewedColumnIds, approvedColumnIds]);

  const buildCellPopoverState = useCallback(
    (col: number, row: number): CellPopoverState | null => {
      if (col === 0) return null; // Status column
      const record = pagedRows[row] as DiffRow | undefined;
      const columnId = columns[col]?.id;
      if (
        !record ||
        !columnId ||
        record.__rowStatus === 'deleted' ||
        record.__rowStatus === 'deletedUnpublished' ||
        record.__rowStatus === 'invalidJson'
      ) {
        return null;
      }

      const { diffKind, fromValue } = getCellDiffState(record, columnId);
      if (diffKind === null) {
        return null;
      }

      const bounds = gridRef.current?.getBounds(col, row);
      if (!bounds) {
        return null;
      }

      return {
        col,
        row,
        filename: record.__filename,
        fieldName: columnId,
        value: toDisplayString(record[columnId]),
        fromValue,
        diffKind,
        bounds,
      };
    },
    [columns, pagedRows],
  );

  useEffect(() => {
    const currentCell = gridSelection?.current?.cell;
    if (!currentCell) {
      setCellPopover(null);
      return;
    }

    const [col, row] = currentCell;
    setCellPopover(buildCellPopoverState(col, row));
  }, [buildCellPopoverState, gridSelection]);

  useEffect(() => {
    const currentCell = gridSelection?.current?.cell;
    if (!currentCell || editingCell == null) {
      return;
    }

    if (currentCell[0] !== editingCell[0] || currentCell[1] !== editingCell[1]) {
      setEditingCell(null);
      setActiveEditorDiffKind(null);
    }
  }, [editingCell, gridSelection]);

  const filterCounts = diffData?.filterCounts;

  const activeColumnFilters = useMemo(
    () =>
      activeFilters.filter((filter): filter is Exclude<GridFilter, { scope: 'global' }> => filter.scope !== 'global'),
    [activeFilters],
  );

  const hasGlobalFilter = useCallback(
    (kind: FilterKind) => activeFilters.some((filter) => filter.scope === 'global' && filter.kind === kind),
    [activeFilters],
  );

  const clearActiveEditorState = useCallback(() => {
    setActiveEditorDiffKind(null);
    setEditingCell(null);
  }, []);

  const closeGridEditorChrome = useCallback(() => {
    clearActiveEditorState();
    setCellPopover(null);
  }, [clearActiveEditorState]);

  const refreshGridData = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  const acceptGridCellChange = useCallback(
    (filename: string, fieldName: string, nextValue: string, logLabel: string) => {
      if (!selectedFolderPath || !workspacePath) {
        return;
      }

      // Apply optimistically before awaiting the IPC so the grid canvas never
      // repaints the pre-edit value in the gap between the overlay closing
      // and the backend write completing. The backend's parseFieldValue is
      // a JSON.parse-or-string fallback, which we mirror here. On failure we
      // trigger a full refresh to resync the grid with the authoritative
      // on-disk state rather than trying to surgically revert — any
      // intervening edits on other cells are preserved that way.
      const parsedValue = parseCellValueLikeBackend(nextValue);
      setDiffData((prev) => (prev ? applyAcceptedCellChange(prev, filename, fieldName, parsedValue) : prev));

      void window.scratchFiles
        .acceptCellChange(selectedFolderPath, workspacePath, filename, fieldName, nextValue)
        .then(() => {
          closeGridEditorChrome();
        })
        .catch((err: unknown) => {
          console.error(`[acceptCellChange] ${logLabel} failed:`, err);
          closeGridEditorChrome();
          refreshGridData();
          notifications.show({
            color: 'red',
            title: 'Failed to save cell',
            message: err instanceof Error ? err.message : 'Unknown error',
          });
        });
    },
    [closeGridEditorChrome, refreshGridData, selectedFolderPath, workspacePath],
  );

  const undoApprovedGridCellChange = useCallback(
    (filename: string, fieldName: string) => {
      if (!selectedFolderPath || !workspacePath) {
        return;
      }

      void window.scratchFiles
        .undoApprovedCellChange(selectedFolderPath, workspacePath, filename, fieldName)
        .then(() => {
          closeGridEditorChrome();
          refreshGridData();
        })
        .catch((err: unknown) => {
          console.error('[undoApprovedCellChange] undo failed:', err);
        });
    },
    [closeGridEditorChrome, refreshGridData, selectedFolderPath, workspacePath],
  );

  const discardUnreviewedGridCellChange = useCallback(
    (filename: string, fieldName: string, dirtyValue: string) => {
      if (!selectedFolderPath || !workspacePath) {
        return;
      }

      void window.scratchFiles
        .acceptCellChange(selectedFolderPath, workspacePath, filename, fieldName, dirtyValue)
        .then(() => {
          closeGridEditorChrome();
          refreshGridData();
        })
        .catch((err: unknown) => {
          console.error('[acceptCellChange] discard unreviewed failed:', err);
        });
    },
    [closeGridEditorChrome, refreshGridData, selectedFolderPath, workspacePath],
  );

  const acceptGridFieldChanges = useCallback(() => {
    if (!selectedFolderPath || !workspacePath || !headerMenu) {
      return;
    }

    const { columnId, columnTitle } = headerMenu;
    closeGridEditorChrome();

    void window.scratchFiles
      .acceptFieldChanges(selectedFolderPath, workspacePath, columnId)
      .then((result) => {
        refreshGridData();
        if (result.status === 'no_changes') {
          notifications.show({
            color: 'gray',
            title: 'Nothing to approve',
            message: `No field changes to approve for "${columnTitle}".`,
          });
          return;
        }

        const fileCount = result.filesAccepted ?? result.paths.length;
        notifications.show({
          color: 'green',
          title: 'Field approved',
          message: `Approved ${fileCount} file${fileCount === 1 ? '' : 's'} for "${columnTitle}".`,
        });
      })
      .catch((err: unknown) => {
        console.error('[acceptFieldChanges] field approve failed:', err);
        notifications.show({
          color: 'red',
          title: 'Failed to approve field',
          message: err instanceof Error ? err.message : 'Unknown error',
        });
      });
  }, [closeGridEditorChrome, headerMenu, refreshGridData, selectedFolderPath, workspacePath]);

  const rejectGridFieldChanges = useCallback(() => {
    if (!selectedFolderPath || !workspacePath || !headerMenu) {
      return;
    }

    const { columnId, columnTitle } = headerMenu;
    closeGridEditorChrome();

    void window.scratchFiles
      .rejectFieldChanges(selectedFolderPath, workspacePath, columnId)
      .then((result) => {
        refreshGridData();
        if (result.status === 'no_changes') {
          notifications.show({
            color: 'gray',
            title: 'Nothing to discard',
            message: `No field changes to discard for "${columnTitle}".`,
          });
          return;
        }

        const fileCount = result.filesRejected ?? result.paths.length;
        notifications.show({
          color: 'green',
          title: 'Field discarded',
          message: `Discarded ${fileCount} file${fileCount === 1 ? '' : 's'} for "${columnTitle}".`,
        });
      })
      .catch((err: unknown) => {
        console.error('[rejectFieldChanges] field reject failed:', err);
        notifications.show({
          color: 'red',
          title: 'Failed to discard field',
          message: err instanceof Error ? err.message : 'Unknown error',
        });
      });
  }, [closeGridEditorChrome, headerMenu, refreshGridData, selectedFolderPath, workspacePath]);

  const handleBulkAction = useCallback(
    async (action: 'approve' | 'reject') => {
      if (!workspacePath) return;

      setBulkActionLoading(true);
      try {
        if (action === 'approve') {
          const result = await window.scratchDesktop.acceptAllChanges(workspacePath);
          if (result.exitCode !== 0) {
            throw new Error(result.stderr.trim() || result.stdout.trim() || 'Failed to approve changes');
          }
          notifications.show({
            color: 'green',
            title: 'All changes approved',
            message: `Approved all pending changes.`,
          });
        } else {
          // Reject all: gather unreviewed filenames and reject each
          const rows = diffData?.rows ?? [];
          const unreviewedFilenames = rows
            .filter(
              (r) =>
                r.__rowStatus === 'added' ||
                r.__rowStatus === 'deleted' ||
                r.__rowStatus === 'invalidJson' ||
                r.__changedFields.length > 0,
            )
            .map((r) => r.__filename);

          if (unreviewedFilenames.length === 0) return;

          const relativeFolderPath =
            selectedFolderPath && workspacePath && selectedFolderPath.startsWith(workspacePath)
              ? selectedFolderPath.slice(workspacePath.length).replace(/^\//, '')
              : (selectedFolderPath?.replace(/^\//, '') ?? '');
          const folderPrefix = relativeFolderPath;
          for (const filename of unreviewedFilenames) {
            const recordPath = folderPrefix ? `${folderPrefix}/${filename}` : filename;
            const result = await window.scratchDesktop.rejectRecord(workspacePath, recordPath);
            if (result.exitCode !== 0) {
              throw new Error(
                result.stderr.trim() || result.stdout.trim() || `Failed to reject changes for ${filename}`,
              );
            }
          }
          notifications.show({
            color: 'green',
            title: 'All changes rejected',
            message: `Rejected ${unreviewedFilenames.length} pending change${unreviewedFilenames.length === 1 ? '' : 's'}.`,
          });
        }
        refreshGridData();
      } catch (err) {
        console.error(`[handleBulkAction] ${action} failed:`, err);
        notifications.show({
          color: 'red',
          title: `Failed to ${action} changes`,
          message: err instanceof Error ? err.message : 'Unknown error',
        });
      } finally {
        setBulkActionLoading(false);
        setBulkActionConfirm(null);
      }
    },
    [workspacePath, diffData?.rows, selectedFolderPath, refreshGridData],
  );

  // ── Cell content ──

  const getCellContent = useCallback(
    ([col, row]: Item) => {
      const r = pagedRows[row] as DiffRow | undefined;

      // Status column — empty, non-editable cell (drawing handled by drawCell)
      if (col === 0) {
        const rowBg = r ? getRowTint(r.__rowStatus) : undefined;
        return {
          kind: GridCellKind.Text as const,
          data: '',
          displayData: '',
          allowOverlay: false as const,
          themeOverride: rowBg ? { bgCell: rowBg } : undefined,
        };
      }

      const colId = columns[col]?.id;

      if (!r || colId === undefined) {
        return { kind: GridCellKind.Text as const, data: '', displayData: '', allowOverlay: false as const };
      }

      const status = r.__rowStatus;
      const rowBg = getRowTint(status);
      const rowTheme = rowBg ? { bgCell: rowBg } : {};
      const val = r[colId];
      const { diffKind } = getCellDiffState(r, colId);
      const diffTheme =
        diffKind === 'unreviewed'
          ? { bgCell: DIFF_WORKING_BG(), textDark: DIFF_WORKING_BORDER() }
          : diffKind === 'unpublished'
            ? { bgCell: DIFF_UNPUBLISHED_BG() }
            : {};
      const themeOverride = { ...rowTheme, ...diffTheme };
      const allowOverlay = status !== 'deleted' && status !== 'deletedUnpublished' && status !== 'invalidJson';

      if (col === 1) {
        const kind = inferCellKind(val);
        if (kind === GridCellKind.Boolean) {
          return {
            kind,
            data: typeof val === 'boolean' ? val : undefined,
            allowOverlay: false as const,
            copyData: toDisplayString(val),
            themeOverride,
          };
        }
        if (kind === GridCellKind.Number) {
          return {
            kind,
            data: val == null ? undefined : Number(val),
            displayData: toDisplayString(val),
            allowOverlay,
            copyData: toDisplayString(val),
            themeOverride,
          };
        }
        const display = toDisplayString(val);
        return {
          kind: GridCellKind.Text as const,
          data: display,
          displayData: display,
          allowOverlay,
          copyData: display,
          themeOverride,
        };
      }

      const kind = inferCellKind(val);
      if (kind === GridCellKind.Boolean) {
        return {
          kind,
          data: typeof val === 'boolean' ? val : undefined,
          allowOverlay: false as const,
          copyData: toDisplayString(val),
          themeOverride,
        };
      }
      if (kind === GridCellKind.Number) {
        return {
          kind,
          data: val == null ? undefined : Number(val),
          displayData: toDisplayString(val),
          allowOverlay,
          copyData: toDisplayString(val),
          themeOverride,
        };
      }
      const display = toDisplayString(val);
      return {
        kind: GridCellKind.Text as const,
        data: display,
        displayData: display,
        allowOverlay,
        copyData: display,
        themeOverride,
      };
    },
    [pagedRows, columns],
  );

  const onHeaderClicked = useCallback(
    (colIndex: number) => {
      // TODO: sort by approval status when clicking the status column header
      if (colIndex === 0) return;
      const colId = columns[colIndex]?.id;
      if (!colId) return;
      setSort((prev) => {
        if (prev.column === colId && prev.direction === 'asc') return { column: colId, direction: 'desc' };
        return { column: colId, direction: 'asc' };
      });
    },
    [columns],
  );

  const openHeaderMenu = useCallback(
    (colIndex: number, bounds: Rectangle) => {
      if (colIndex === 0) return; // Status column
      const column = columns[colIndex];
      if (!column) {
        return;
      }

      closeGridEditorChrome();
      setHeaderMenu({
        columnId: String(column.id),
        columnTitle: column.title,
        bounds,
      });
    },
    [closeGridEditorChrome, columns],
  );

  const onHeaderMenuClick = useCallback(
    (colIndex: number, bounds: Rectangle) => {
      openHeaderMenu(colIndex, bounds);
    },
    [openHeaderMenu],
  );

  const onHeaderContextMenu = useCallback(
    (colIndex: number, event: HeaderClickedEventArgs) => {
      event.preventDefault();
      openHeaderMenu(colIndex, event.bounds);
    },
    [openHeaderMenu],
  );

  const drawCell: DrawCellCallback = useCallback(
    (args, drawContent) => {
      const row = pagedRows[args.row] as DiffRow | undefined;

      // Status column — draw row number + vertical status bar
      if (args.col === 0) {
        drawContent();
        const { ctx, rect } = args;

        // Row number
        const rowNum = (page - 1) * PAGE_SIZE + args.row + 1;
        ctx.save();
        ctx.font = '11px Inter, sans-serif';
        ctx.fillStyle = '#999';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(rowNum), rect.x + rect.width - 8, rect.y + rect.height / 2);
        ctx.restore();

        if (!row) return;
        const isDeletedReview = row.__rowStatus === 'deleted';
        const isDeletedApproved = row.__rowStatus === 'deletedUnpublished';
        const hasUnreviewed =
          row.__rowStatus === 'added' ||
          isDeletedReview ||
          row.__rowStatus === 'invalidJson' ||
          row.__changedFields.length > 0;
        const hasApproved = isDeletedApproved || row.__unpublishedFields.length > 0;
        if (hasUnreviewed || hasApproved) {
          const barWidth = 4;
          const barX = rect.x + 6;
          const barInset = 4;
          ctx.save();
          ctx.fillStyle = isDeletedReview
            ? DIFF_DELETE_REVIEW_BORDER()
            : isDeletedApproved
              ? DIFF_DELETE_APPROVED_BORDER()
              : hasUnreviewed
                ? DIFF_WORKING_BORDER()
                : DIFF_UNPUBLISHED_BORDER();
          ctx.beginPath();
          ctx.roundRect(barX, rect.y + barInset, barWidth, rect.height - barInset * 2, 2);
          ctx.fill();
          ctx.restore();
        }
        return;
      }

      drawContent();
      const colId = columns[args.col]?.id;
      if (!row || !colId) {
        return;
      }

      const { diffKind } = getCellDiffState(row, colId);
      if (diffKind !== null) {
        args.ctx.save();
        args.ctx.fillStyle = diffKind === 'unreviewed' ? DIFF_WORKING_BORDER() : DIFF_UNPUBLISHED_BORDER();
        args.ctx.fillRect(args.rect.x, args.rect.y, 3, args.rect.height);
        args.ctx.restore();
      }

      // Strikethrough for deleted rows
      if (row.__rowStatus === 'deleted' || row.__rowStatus === 'deletedUnpublished') {
        const cell = args.cell;
        const displayText =
          'displayData' in cell && typeof cell.displayData === 'string' ? cell.displayData : undefined;
        if (displayText) {
          const { ctx, rect, theme } = args;
          const pad = theme.cellHorizontalPadding ?? 8;
          ctx.save();
          ctx.font = `${theme.baseFontStyle} ${theme.fontFamily}`;
          const textWidth = Math.min(ctx.measureText(displayText).width, rect.width - pad * 2);
          ctx.strokeStyle = '#999';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(rect.x + pad, rect.y + rect.height / 2);
          ctx.lineTo(rect.x + pad + textWidth, rect.y + rect.height / 2);
          ctx.stroke();
          ctx.restore();
        }
      }
    },
    [columns, page, pagedRows],
  );

  const onCellClicked = useCallback(
    (cell: Item) => {
      setHeaderMenu(null);
      if (cell[0] === 0) {
        setGridSelection({
          current: undefined,
          columns: CompactSelection.empty(),
          rows: CompactSelection.empty().add(cell[1]),
        });
      }
    },
    [setGridSelection],
  );

  const recomputeInspectRect = useCallback((rowIdx: number | null) => {
    if (rowIdx === null) {
      setInspectButtonRect(null);
      return;
    }
    // Use col 1 (first data column) for reliable bounds; the marker and status
    // columns live immediately to its left, so we anchor the button off col 1's left edge.
    const bounds = gridRef.current?.getBounds(1, rowIdx);
    const wrapperRect = wrapperElRef.current?.getBoundingClientRect();
    if (!bounds || bounds.height === 0 || !wrapperRect) {
      setInspectButtonRect(null);
      return;
    }
    // getBounds returns viewport-relative coordinates, but the button is
    // absolutely positioned inside the wrapper, so subtract the wrapper origin.
    setInspectButtonRect({
      x: bounds.x - wrapperRect.left,
      y: bounds.y - wrapperRect.top,
      height: bounds.height,
    });
  }, []);

  const onMouseMove = useCallback(
    (args: GridMouseEventArgs) => {
      const nextRow = args.kind === 'cell' ? args.location[1] : null;
      setHoveredRowIdx((prev) => (prev === nextRow ? prev : nextRow));
      recomputeInspectRect(nextRow);
    },
    [recomputeInspectRect],
  );

  const onGridMouseLeave = useCallback(() => {
    setHoveredRowIdx(null);
    setInspectButtonRect(null);
  }, []);

  const onVisibleRegionChanged = useCallback(() => {
    // Reposition the inspect button as the user scrolls.
    recomputeInspectRect(hoveredRowIdx);
  }, [recomputeInspectRect, hoveredRowIdx]);

  const onCellActivated = useCallback(
    ([col, row]: Item) => {
      if (col === 0) return; // Status column
      setHeaderMenu(null);
      const r = pagedRows[row] as DiffRow | undefined;
      const colId = columns[col]?.id;
      if (!r || !colId) return;
      if (r.__rowStatus === 'deleted' || r.__rowStatus === 'deletedUnpublished' || r.__rowStatus === 'invalidJson')
        return;
      const { diffKind } = getCellDiffState(r, colId);
      setActiveEditorDiffKind(diffKind ?? 'none');
      setEditingCell([col, row]);
      if (diffKind === null) {
        setCellPopover(null);
        return;
      }
      setCellPopover(buildCellPopoverState(col, row));
    },
    [buildCellPopoverState, columns, pagedRows],
  );

  const onCellEdited = useCallback(
    ([col, row]: Item, newValue: EditableGridCell) => {
      if (col === 0) return; // Status column
      const r = pagedRows[row] as DiffRow | undefined;
      const colId = columns[col]?.id;
      if (
        !r ||
        !colId ||
        r.__rowStatus === 'deleted' ||
        r.__rowStatus === 'deletedUnpublished' ||
        r.__rowStatus === 'invalidJson'
      ) {
        return;
      }

      acceptGridCellChange(r.__filename, colId, editableCellToString(newValue), 'grid overlay save');
    },
    [acceptGridCellChange, columns, pagedRows],
  );

  const onFinishedEditing = useCallback(() => {
    clearActiveEditorState();
  }, [clearActiveEditorState]);

  const isEditorOutsideClick = useCallback((event: MouseEvent | TouchEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return true;
    }

    if (cellPopoverRef.current?.contains(target)) {
      return false;
    }

    return true;
  }, []);

  const onColumnResize = useCallback(
    (column: GridColumn, newSize: number, colIndex: number) => {
      if (colIndex === 0) return; // Status column is not resizable
      const columnId = columns[colIndex]?.id ?? column.id;
      if (columnId === undefined) return;
      setColumnWidths((current) => ({ ...current, [String(columnId)]: newSize }));
    },
    [columns],
  );

  const handleGlobalFilterToggle = useCallback(
    (kind: FilterKind) => {
      const alreadyActive = activeFilters.some((f) => f.scope === 'global' && f.kind === kind);
      const withoutGlobal = activeFilters.filter((f) => f.scope !== 'global');

      if (alreadyActive) {
        // Clearing the filter — reset columns to show all
        setActiveFilters(withoutGlobal);
        setVisibleColumnIds(null);
      } else {
        // Applying a filter — use the unfiltered snapshot so switching between
        // filters works even when the current rows are already filtered.
        setActiveFilters([...withoutGlobal, { scope: 'global', kind }]);
        const { unreviewed, approved } = unfilteredColsRef.current;
        const matchingCols = kind === 'unreviewed' ? unreviewed : approved;
        const locked = titleColumnId ? [titleColumnId] : [];
        setVisibleColumnIds([...locked, ...matchingCols.filter((c) => c !== titleColumnId)]);
      }
    },
    [activeFilters, titleColumnId],
  );

  const handleAddColumnFilter = useCallback(
    (kind: FilterKind) => {
      if (!headerMenu) {
        return;
      }

      setActiveFilters((current) => {
        const withoutSameColumn = current.filter(
          (filter) => !(filter.scope === 'column' && filter.columnId === headerMenu.columnId),
        );
        return [
          ...withoutSameColumn,
          {
            scope: 'column',
            kind,
            columnId: headerMenu.columnId,
            columnTitle: headerMenu.columnTitle,
          },
        ];
      });
    },
    [headerMenu],
  );

  const handleApplyTextFilter = useCallback(
    (value: string) => {
      if (!headerMenu) {
        return;
      }

      const nextValue = value.trim();
      setActiveFilters((current) => {
        const withoutSameColumnText = current.filter(
          (filter) => !(filter.scope === 'text' && filter.columnId === headerMenu.columnId),
        );
        if (nextValue.length === 0) {
          return withoutSameColumnText;
        }
        return [
          ...withoutSameColumnText,
          {
            scope: 'text',
            columnId: headerMenu.columnId,
            columnTitle: headerMenu.columnTitle,
            value: nextValue,
          },
        ];
      });
    },
    [headerMenu],
  );

  const handleRemoveFilter = useCallback((filterToRemove: GridFilter) => {
    setActiveFilters((current) => current.filter((filter) => filterKey(filter) !== filterKey(filterToRemove)));
  }, []);

  // ── Render ──

  const summary = diffData?.summary;
  const hasChanges =
    summary &&
    (summary.added > 0 ||
      summary.modified > 0 ||
      summary.unpublished > 0 ||
      summary.deleted > 0 ||
      summary.invalidJson > 0);
  const showFilterBar = workspacePath && selectedFolderPath && !error;

  return (
    <Stack
      gap={0}
      style={{
        flex: 1,
        minWidth: 0,
        backgroundColor: 'var(--bg-base)',
        border: '0.5px solid var(--fg-divider)',
        borderRadius: 4,
        overflow: 'hidden',
      }}
    >
      {showFilterBar && (
        <Box
          style={{
            padding: '6px 12px',
            borderBottom: '0.5px solid var(--fg-divider)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Group gap={6} align="center">
            <Text12Medium c="var(--fg-muted)" style={{ marginRight: 4 }}>
              Filter
            </Text12Medium>
            <FilterPill
              label="Needs review"
              count={filterCounts?.unreviewed ?? 0}
              active={hasGlobalFilter('unreviewed')}
              bulletColor="var(--needs-review-stroke)"
              onClick={() => handleGlobalFilterToggle('unreviewed')}
            />
            <FilterPill
              label="Approved"
              count={filterCounts?.unpublished ?? 0}
              active={hasGlobalFilter('unpublished')}
              bulletColor="var(--approved-stroke)"
              onClick={() => handleGlobalFilterToggle('unpublished')}
            />
            {activeColumnFilters.map((filter) => (
              <ActiveFilterChip
                key={filterKey(filter)}
                label={filterLabel(filter)}
                onRemove={() => handleRemoveFilter(filter)}
              />
            ))}
          </Group>
          <Group gap={6} align="center">
            {(filterCounts?.unreviewed ?? 0) > 0 && (
              <>
                <Divider orientation="vertical" />
                <ButtonSecondaryGhost
                  size="compact-xs"
                  c="green.8"
                  leftSection={<Check size={12} />}
                  onClick={() => setBulkActionConfirm('approve')}
                >
                  Approve all
                </ButtonSecondaryGhost>
                <ButtonSecondaryGhost
                  size="compact-xs"
                  c="red.8"
                  leftSection={<RotateCcw size={12} />}
                  onClick={() => setBulkActionConfirm('reject')}
                >
                  Reject all
                </ButtonSecondaryGhost>
              </>
            )}
            <Divider orientation="vertical" />
            <Popover>
              <Popover.Target>
                <ButtonSecondaryGhost size="compact-xs" leftSection={<Columns3 size={16} />}>
                  Columns
                  {visibleColumnIds && visibleColumnIds.length < allColumnIds.length
                    ? ` (${visibleColumnIds.length})`
                    : ''}
                </ButtonSecondaryGhost>
              </Popover.Target>
              <Popover.Dropdown w={420}>
                <ColumnPickerMenu
                  allColumns={allColumnIds}
                  visibleColumns={effectiveVisibleColumns}
                  titleColumnId={titleColumnId}
                  unreviewedColumnIds={unreviewedColumnIds}
                  approvedColumnIds={approvedColumnIds}
                  onChangeVisible={setVisibleColumnIds}
                />
              </Popover.Dropdown>
            </Popover>
          </Group>
        </Box>
      )}

      {!selectedFolderPath && (
        <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Text13Regular c="dimmed">Select a folder to view data</Text13Regular>
        </Box>
      )}

      {selectedFolderPath && loading && (
        <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Loader size="sm" />
        </Box>
      )}

      {selectedFolderPath && error && (
        <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Text13Regular c="var(--mantine-color-red-6)">{error}</Text13Regular>
        </Box>
      )}

      {selectedFolderPath && !loading && !error && pagedRows.length === 0 && (
        <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Text13Regular c="dimmed">
            {activeFilters.length > 0 ? 'No rows match the current filter' : 'No data in this folder'}
          </Text13Regular>
        </Box>
      )}

      {selectedFolderPath && !loading && !error && pagedRows.length > 0 && (
        <>
          <Box ref={wrapperRef} onMouseLeave={onGridMouseLeave} style={{ flex: 1, position: 'relative', minHeight: 0 }}>
            {gridSize && (
              <DataEditor
                ref={gridRef}
                theme={GRID_THEME}
                columns={columns}
                rows={pagedRows.length}
                getCellContent={getCellContent}
                width={gridSize.width}
                height={gridSize.height}
                smoothScrollX
                smoothScrollY
                gridSelection={gridSelection}
                onGridSelectionChange={(sel) => {
                  // Prevent selecting the status column via header click
                  if (sel.columns.hasIndex(0)) {
                    setGridSelection({ ...sel, columns: sel.columns.remove(0) });
                  } else {
                    setGridSelection(sel);
                  }
                }}
                onSelectionCleared={() => {
                  setGridSelection(undefined);
                  setCellPopover(null);
                  clearActiveEditorState();
                }}
                onHeaderClicked={onHeaderClicked}
                onHeaderContextMenu={onHeaderContextMenu}
                onHeaderMenuClick={onHeaderMenuClick}
                onCellClicked={onCellClicked}
                onMouseMove={onMouseMove}
                onVisibleRegionChanged={onVisibleRegionChanged}
                onCellActivated={onCellActivated}
                onCellEdited={onCellEdited}
                onFinishedEditing={onFinishedEditing}
                isOutsideClick={isEditorOutsideClick}
                cellActivationBehavior="double-click"
                onColumnResize={onColumnResize}
                drawCell={drawCell}
                verticalBorder={(col) => col !== 0}
                rowMarkers="none"
                freezeColumns={titleColumnId && columns[1]?.id === titleColumnId ? 2 : 1}
              />
            )}
            {inspectButtonRect && hoveredRowIdx !== null && (
              <UnstyledButton
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.currentTarget.blur();
                  if (hoveredRowIdx !== null) setDetailRowIndex(hoveredRowIdx);
                }}
                tabIndex={-1}
                aria-label="Open record detail"
                style={{
                  position: 'absolute',
                  left: inspectButtonRect.x - INSPECT_BUTTON_SIZE - 6,
                  top: inspectButtonRect.y + (inspectButtonRect.height - INSPECT_BUTTON_SIZE) / 2,
                  width: INSPECT_BUTTON_SIZE,
                  height: INSPECT_BUTTON_SIZE,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 3,
                  border: '0.5px solid var(--fg-divider)',
                  backgroundColor: 'var(--bg-base)',
                  cursor: 'pointer',
                  zIndex: 3,
                  padding: 0,
                }}
              >
                <StyledLucideIcon Icon={Maximize2} size={12} c="var(--fg-muted)" strokeWidth={2} />
              </UnstyledButton>
            )}
            <FolderGridHeaderMenu
              columnTitle={headerMenu?.columnTitle ?? ''}
              bounds={headerMenu?.bounds ?? null}
              initialFilterValue={
                headerMenu == null
                  ? ''
                  : (activeFilters.find(
                      (filter): filter is Extract<GridFilter, { scope: 'text' }> =>
                        filter.scope === 'text' && filter.columnId === headerMenu.columnId,
                    )?.value ?? '')
              }
              onShowNeedsReview={() => handleAddColumnFilter('unreviewed')}
              onShowApproved={() => handleAddColumnFilter('unpublished')}
              onApplyTextFilter={handleApplyTextFilter}
              onApproveField={acceptGridFieldChanges}
              onRejectField={rejectGridFieldChanges}
              onClose={() => setHeaderMenu(null)}
            />
            {detailRowIndex !== null && selectedFolderPath && workspacePath && (
              <RecordDetailView
                rows={pagedRows}
                selectedIndex={detailRowIndex}
                folderPath={selectedFolderPath}
                workspacePath={workspacePath}
                titleColumnId={titleColumnId}
                columnOrder={effectiveVisibleColumns}
                onSelectIndex={setDetailRowIndex}
                onClose={() => setDetailRowIndex(null)}
                onRecordChanged={() => setReloadKey((k) => k + 1)}
                onRecordFieldChanged={(filename, fieldName, nextValue) =>
                  setDiffData((prev) => (prev ? applyAcceptedCellChange(prev, filename, fieldName, nextValue) : prev))
                }
                onPublishFile={props.onPublishFile}
              />
            )}
          </Box>

          <Box
            style={{
              padding: '6px 12px',
              borderTop: '0.5px solid var(--fg-divider)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <Text12Regular c="var(--fg-muted)">
              {(diffData?.total ?? 0).toLocaleString()} rows &middot; {columns.length} columns
              {sort.column && (
                <span style={{ marginLeft: 8 }}>
                  &middot; Sorted by {sort.column} {sort.direction === 'desc' ? '\u2193' : '\u2191'}
                </span>
              )}
            </Text12Regular>

            <Group gap={8} align="center">
              {hasChanges && (
                <Group gap={10}>
                  {summary.added > 0 && (
                    <Group gap={4}>
                      <Box style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: '#22c55e' }} />
                      <Text12Regular c="var(--fg-muted)">{summary.added} added</Text12Regular>
                    </Group>
                  )}
                  {summary.modified > 0 && (
                    <Group gap={4}>
                      <Box
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          backgroundColor: 'var(--needs-review-stroke)',
                        }}
                      />
                      <Text12Regular c="var(--fg-muted)">{summary.modified} modified</Text12Regular>
                    </Group>
                  )}
                  {summary.unpublished > 0 && (
                    <Group gap={4}>
                      <Box
                        style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: 'var(--approved-stroke)' }}
                      />
                      <Text12Regular c="var(--fg-muted)">{summary.unpublished} unpublished</Text12Regular>
                    </Group>
                  )}
                  {summary.deleted > 0 && (
                    <Group gap={4}>
                      <Box style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: '#ef4444' }} />
                      <Text12Regular c="var(--fg-muted)">{summary.deleted} deleted</Text12Regular>
                    </Group>
                  )}
                  {summary.invalidJson > 0 && (
                    <UnstyledButton
                      type="button"
                      onClick={() => setInvalidJsonModalOpen(true)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        border: 'none',
                        background: 'transparent',
                        padding: 0,
                        margin: 0,
                        cursor: 'pointer',
                      }}
                    >
                      <Group gap={4}>
                        <Box style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: '#ea580c' }} />
                        <Text12Regular c="var(--fg-muted)" style={{ textDecoration: 'underline' }}>
                          {summary.invalidJson} invalid files
                        </Text12Regular>
                      </Group>
                    </UnstyledButton>
                  )}
                </Group>
              )}

              {totalPages > 1 && (
                <Group gap={4} align="center">
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
                    {page} / {totalPages}
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
                </Group>
              )}
            </Group>
          </Box>
        </>
      )}

      <InvalidJsonFilesModal
        opened={invalidJsonModalOpen}
        onClose={() => setInvalidJsonModalOpen(false)}
        entries={diffData?.invalidJsonFiles ?? []}
        onFileSaved={refreshGridData}
      />

      <Modal
        opened={bulkActionConfirm !== null}
        onClose={() => setBulkActionConfirm(null)}
        title={
          <Text13Medium>
            {bulkActionConfirm === 'approve' ? 'Approve' : 'Reject'} {filterCounts?.unreviewed ?? 0} pending{' '}
            {(filterCounts?.unreviewed ?? 0) === 1 ? 'change' : 'changes'} in{' '}
            {selectedFolderPath?.split('/').filter(Boolean).pop() ?? 'this folder'}?
          </Text13Medium>
        }
        size="sm"
        padding="md"
      >
        <Group justify="flex-end" mt="md">
          <ButtonSecondaryOutline size="compact-sm" onClick={() => setBulkActionConfirm(null)}>
            Cancel
          </ButtonSecondaryOutline>
          <ButtonSecondaryGhost
            size="compact-sm"
            c={bulkActionConfirm === 'approve' ? 'green.8' : 'red.8'}
            loading={bulkActionLoading}
            onClick={() => {
              if (bulkActionConfirm) void handleBulkAction(bulkActionConfirm);
            }}
          >
            {bulkActionConfirm === 'approve' ? 'Approve all' : 'Reject all'}
          </ButtonSecondaryGhost>
        </Group>
      </Modal>

      {cellPopover &&
        selectedFolderPath &&
        workspacePath &&
        (() => {
          const { bounds, diffKind, value, fromValue, filename, fieldName } = cellPopover;
          const popoverWidth = Math.max(280, Math.floor(bounds.width));
          const left = Math.max(12, Math.min(bounds.x, window.innerWidth - popoverWidth - 12));
          const isEditingPopover =
            editingCell != null && editingCell[0] === cellPopover.col && editingCell[1] === cellPopover.row;
          let undoAction: (() => void) | undefined;
          if (diffKind === 'unreviewed') {
            undoAction = () => discardUnreviewedGridCellChange(filename, fieldName, fromValue);
          } else if (diffKind === 'unpublished') {
            undoAction = () => undoApprovedGridCellChange(filename, fieldName);
          }

          return (
            <Portal target="#portal">
              <Box
                className="click-outside-ignore"
                ref={cellPopoverRef}
                style={{
                  position: 'fixed',
                  left,
                  top: Math.max(FLOATING_PANEL_GAP, bounds.y - FLOATING_PANEL_GAP),
                  transform: 'translateY(-100%)',
                  zIndex: 10010,
                  width: popoverWidth,
                  maxWidth: Math.max(280, window.innerWidth - 24),
                  backgroundColor: 'var(--bg-base)',
                  border: '1px solid var(--fg-divider)',
                  borderRadius: 0,
                  boxShadow: 'none',
                  padding: 0,
                }}
              >
                {!isEditingPopover && diffKind === 'unreviewed' ? (
                  <FieldValuePanel
                    value={value}
                    fromValue={fromValue}
                    diffKind={diffKind}
                    displayMode="diff"
                    onApprove={() => acceptGridCellChange(filename, fieldName, value, 'approve')}
                    onUndo={undoAction}
                  />
                ) : (
                  <FieldReferenceStrip
                    value={fromValue}
                    label={diffKind === 'unpublished' ? 'Last published' : 'Last approved'}
                    onUndo={undoAction}
                  />
                )}
              </Box>
            </Portal>
          );
        })()}
    </Stack>
  );
});
