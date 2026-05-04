import { ButtonSecondaryGhost, ButtonSecondaryOutline } from '@/components/base/buttons';
import DataEditor, {
  CompactSelection,
  getMiddleCenterBias,
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
import {
  ActionIcon,
  Box,
  Button,
  Divider,
  Group,
  Loader,
  Modal,
  Popover,
  Portal,
  Stack,
  Table,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Check, Columns3, Maximize2, Minus, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { coerceCellInputTextWithSchema } from '../../../../shared/cell-value-coercion';
import { classifyFieldChange, type FieldChangeClassification } from '../../../../shared/field-change-classification';
import { getWordDiffSegments } from '../../../../shared/word-diff';
import { Text12Medium, Text12Regular, Text13Medium, Text13Regular } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import type { ColumnDefinition } from '../../types/local-files';
import { ColumnPickerMenu } from './ColumnPickerMenu';
import { FieldReferenceStrip } from './FieldReferenceStrip';
import { FieldValuePanel, type FieldValueDiffKind } from './FieldValuePanel';
import { FolderGridHeaderMenu } from './FolderGridHeaderMenu';
import { InvalidJsonFilesModal, type InvalidJsonFileListEntry } from './InvalidJsonFilesModal';
import { RecordDetailView } from './RecordDetailView';

// ── Types ──

type RowStatus =
  | 'added'
  | 'addedUnpublished'
  | 'modified'
  | 'unpublished'
  | 'deleted'
  | 'deletedUnpublished'
  | 'unchanged'
  | 'invalidJson';

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
  columns: ColumnDefinition[];
  total: number;
  summary: {
    total: number;
    added: number;
    addedApproved: number;
    modified: number;
    unpublished: number;
    deleted: number;
    deletedApproved: number;
    invalidJson: number;
  };
  filterCounts: { unreviewed: number; unpublished: number };
  focusColumnIds: { unreviewed: string[]; unpublished: string[] };
  invalidJsonFiles: InvalidJsonFileListEntry[];
}

type GridValidationEntry = {
  file_name?: string;
  field_path: string;
  validator_kind: string;
  level: 'error' | 'warning';
  message: string | null;
  description: string | null;
  fixable: boolean;
};

type FilterKind = 'unreviewed' | 'unpublished';
type EditorOverlayDiffKind = FieldValueDiffKind | 'none';

interface HeaderMenuState {
  columnId: string;
  columnTitle: string;
  columnDescription: string;
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
  /** Null for record-level popovers (creates/deletes), where there's no per-field change to classify. */
  classification: FieldChangeClassification | null;
  bounds: { x: number; y: number; width: number; height: number };
  recordLevel?: boolean;
  recordAction?: 'added' | 'deleted';
}

interface ValidationHoverState {
  col: number;
  row: number;
  bounds: { x: number; y: number; width: number; height: number };
  entries: GridValidationEntry[];
}

interface FolderDataGridProps {
  /** Included so memo() invalidates when switching workbooks even if folder path + local path match. */
  workspaceId: string;
  selectedFolderPath: string | null;
  workspacePath: string | null;
  dataRefreshKey: number;
  onPublishFile?: (relativePath: string) => void;
}

type GridLoadMode = 'idle' | 'blocking' | 'refreshing';

interface GridQueryState {
  key: string;
  selectedFolderPath: string | null;
  workspacePath: string | null;
  page: number;
  sortColumn: string | null;
  sortDirection: 'asc' | 'desc' | null;
  activeFilters: GridFilter[];
}

// ── Constants ──

const PAGE_SIZE = 100;
const STATUS_COL_WIDTH = 50;
const STATUS_COL_ID = '__status';
const INSPECT_BUTTON_SIZE = 18;
const FLOATING_PANEL_GAP = 0;

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

function validationCellKey(filename: string, fieldPath: string): string {
  return `${filename}\u0000${fieldPath}`;
}

const DIFF_WORKING_BG = () => getCssVar('--modified-needs-review-bg');
const DIFF_WORKING_BORDER = () => getCssVar('--modified-needs-review-stroke');
const DIFF_UNPUBLISHED_BG = () => getCssVar('--modified-approved-bg');
const DIFF_UNPUBLISHED_BORDER = () => getCssVar('--modified-approved-stroke');
const DIFF_CREATE_REVIEW_BG = () => getCssVar('--create-needs-review-bg');
const DIFF_CREATE_APPROVED_BG = () => getCssVar('--create-approved-bg');
const DIFF_DELETE_REVIEW_BG = () => getCssVar('--delete-needs-review-bg');
const DIFF_DELETE_APPROVED_BG = () => getCssVar('--delete-approved-bg');
const DIFF_CREATE_REVIEW_BORDER = () => getCssVar('--create-needs-review-stroke');
const DIFF_CREATE_APPROVED_BORDER = () => getCssVar('--create-approved-stroke');
const DIFF_DELETE_REVIEW_BORDER = () => getCssVar('--delete-needs-review-stroke');
const DIFF_DELETE_APPROVED_BORDER = () => getCssVar('--delete-approved-stroke');

// ── Status icon canvas drawing (lucide Plus / Minus / Diff, viewBox 0 0 24 24) ──

type StatusIconKind = 'plus' | 'minus' | 'diff';

function drawStatusIcon(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, kind: StatusIconKind): void {
  ctx.save();
  const s = size / 24;
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (kind === 'plus') {
    ctx.beginPath();
    ctx.moveTo(5, 12);
    ctx.lineTo(19, 12);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(12, 5);
    ctx.lineTo(12, 19);
    ctx.stroke();
  } else if (kind === 'minus') {
    ctx.beginPath();
    ctx.moveTo(5, 12);
    ctx.lineTo(19, 12);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(12, 12, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

function drawValidationIcon(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  level: 'error' | 'warning',
): void {
  ctx.save();
  ctx.fillStyle =
    level === 'error'
      ? getCssVar('--mantine-color-red-6') || '#e03131'
      : getCssVar('--mantine-color-orange-6') || '#f08c00';
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';

  ctx.beginPath();
  ctx.moveTo(x + size / 2, y + 1.5);
  ctx.lineTo(x + size - 1.5, y + size - 1.5);
  ctx.lineTo(x + 1.5, y + size - 1.5);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = '#fff';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x + size / 2, y + 5);
  ctx.lineTo(x + size / 2, y + size - 6);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size - 3.5, 0.9, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.restore();
}

/**
 * Draw the new value of a modified text cell with each changed word coloured blue
 * (matching `--modified-needs-review-stroke`) while unchanged words use the design
 * system's default text colour. The cell background is already painted by the grid
 * before drawCell runs, so we only paint text on top.
 */
function drawWordDiffText(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number },
  theme: { cellHorizontalPadding: number; baseFontStyle: string; fontFamily: string },
  fromText: string,
  toText: string,
): void {
  const segments = getWordDiffSegments(fromText, toText);
  if (segments.length === 0) return;

  // Glide's text rendering matches: left-aligned, `middle` baseline biased so
  // x-height visually centers in the row.
  const padX = theme.cellHorizontalPadding;
  const startX = rect.x + padX + 0.5;
  const fontFull = `${theme.baseFontStyle} ${theme.fontFamily}`;
  const bias = getMiddleCenterBias(ctx, fontFull);
  const y = rect.y + rect.height / 2 + bias;

  const baseColor = getCssVar('--fg-primary') || '#000';
  const accentColor = getCssVar('--modified-needs-review-stroke') || '#0551cd';

  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  // Clip so an over-long value can't bleed into the next cell.
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();

  let x = startX;
  for (const seg of segments) {
    ctx.fillStyle = seg.changed ? accentColor : baseColor;
    ctx.fillText(seg.text, x, y);
    x += ctx.measureText(seg.text).width;
    // Stop early once we're past the visible region; clipping handles correctness,
    // but skipping measureText/fillText for off-screen tail saves work on long values.
    if (x > rect.x + rect.width) break;
  }
  ctx.restore();
}

// ── Helpers ──

function toDisplayString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
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
    row.__rowStatus === 'addedUnpublished' ||
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
  const prevHadUnpublished =
    prevRow.__rowStatus === 'addedUnpublished' ||
    prevRow.__rowStatus === 'deletedUnpublished' ||
    prevRow.__unpublishedFields.length > 0;
  const nextHasUnpublished =
    nextRow.__rowStatus === 'addedUnpublished' ||
    nextRow.__rowStatus === 'deletedUnpublished' ||
    nextRow.__unpublishedFields.length > 0;

  const summary: DiffGridResult['summary'] = {
    total: result.summary.total,
    added: recomputeFilterCount(
      prevRow.__rowStatus === 'added' || prevRow.__rowStatus === 'addedUnpublished',
      nextRow.__rowStatus === 'added' || nextRow.__rowStatus === 'addedUnpublished',
      result.summary.added,
    ),
    addedApproved: recomputeSummaryCount(prevRow, nextRow, 'addedUnpublished', result.summary.addedApproved),
    modified: recomputeSummaryCount(prevRow, nextRow, 'modified', result.summary.modified),
    unpublished: recomputeSummaryCount(prevRow, nextRow, 'unpublished', result.summary.unpublished),
    deleted: recomputeFilterCount(
      prevRow.__rowStatus === 'deleted' || prevRow.__rowStatus === 'deletedUnpublished',
      nextRow.__rowStatus === 'deleted' || nextRow.__rowStatus === 'deletedUnpublished',
      result.summary.deleted,
    ),
    deletedApproved: recomputeSummaryCount(prevRow, nextRow, 'deletedUnpublished', result.summary.deletedApproved),
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

interface CellDiffState {
  diffKind: FieldValueDiffKind;
  fromValue: string;
  /** Populated only when diffKind !== null. */
  classification: FieldChangeClassification | null;
}

function getCellDiffState(row: DiffRow, fieldName: string, colDef: ColumnDefinition | undefined): CellDiffState {
  // Row-level statuses (added, deleted, invalidJson) are styled at the row level — don't
  // overlay per-cell diff colours on top.
  if (
    row.__rowStatus === 'added' ||
    row.__rowStatus === 'addedUnpublished' ||
    row.__rowStatus === 'deleted' ||
    row.__rowStatus === 'deletedUnpublished' ||
    row.__rowStatus === 'invalidJson'
  ) {
    return { diffKind: null, fromValue: '', classification: null };
  }
  const isUnreviewed = row.__changedFields.includes(fieldName);
  const isUnpublished = !isUnreviewed && row.__unpublishedFields.includes(fieldName);
  if (isUnreviewed) {
    const rawFrom = row.__fromFields[fieldName];
    return {
      diffKind: 'unreviewed',
      fromValue: toDisplayString(rawFrom),
      classification: classifyFieldChange(rawFrom, row[fieldName], colDef),
    };
  }
  if (isUnpublished) {
    const rawFrom = row.__masterFields[fieldName];
    return {
      diffKind: 'unpublished',
      fromValue: toDisplayString(rawFrom),
      classification: classifyFieldChange(rawFrom, row[fieldName], colDef),
    };
  }
  return { diffKind: null, fromValue: '', classification: null };
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

function getStatusCellTint(status: RowStatus): string | undefined {
  switch (status) {
    case 'added':
      return DIFF_CREATE_REVIEW_BG();
    case 'addedUnpublished':
      return DIFF_CREATE_APPROVED_BG();
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

function getRowTextColor(status: RowStatus): string | undefined {
  switch (status) {
    case 'added':
    case 'addedUnpublished':
      return DIFF_CREATE_REVIEW_BORDER();
    case 'deleted':
    case 'deletedUnpublished':
      return DIFF_DELETE_REVIEW_BORDER();
    default:
      return undefined;
  }
}

function getRowTint(status: RowStatus): string | undefined {
  switch (status) {
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
  disabled = false,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  bulletColor: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Box
      component="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 10,
        border: active ? '1.5px solid var(--highlight-border)' : '0.5px solid var(--fg-divider)',
        backgroundColor: active ? 'var(--highlight-fill)' : 'transparent',
        cursor: disabled ? 'default' : 'pointer',
        lineHeight: 1,
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <Box
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: bulletColor,
          flexShrink: 0,
        }}
      />
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
  const [validationByCell, setValidationByCell] = useState<Map<string, GridValidationEntry[]>>(new Map());
  const [loadingMode, setLoadingMode] = useState<GridLoadMode>('idle');
  const [error, setError] = useState<string | null>(null);
  const [errorQueryKey, setErrorQueryKey] = useState<string | null>(null);
  const [resolvedQueryKey, setResolvedQueryKey] = useState<string | null>(null);
  const [sort, setSort] = useState<{ column: string | null; direction: 'asc' | 'desc' | null }>({
    column: null,
    direction: null,
  });
  const [activeFilters, setActiveFilters] = useState<GridFilter[]>([]);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [detailRowIndex, setDetailRowIndex] = useState<number | null>(null);
  const [detailFocusFieldName, setDetailFocusFieldName] = useState<string | null>(null);
  const [schema, setSchema] = useState<Record<string, unknown> | null>(null);
  const [page, setPage] = useState(1);
  const [headerMenu, setHeaderMenu] = useState<HeaderMenuState | null>(null);
  const [gridSelection, setGridSelection] = useState<GridSelection | undefined>(undefined);
  const [activeEditorDiffKind, setActiveEditorDiffKind] = useState<EditorOverlayDiffKind | null>(null);
  const [editingCell, setEditingCell] = useState<Item | null>(null);
  const [cellPopover, setCellPopover] = useState<CellPopoverState | null>(null);
  const [validationHover, setValidationHover] = useState<ValidationHoverState | null>(null);
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
  const [bulkActionConfirm, setBulkActionConfirm] = useState<'approve' | 'reject' | 'discard' | null>(null);
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  const loadGenerationRef = useRef(0);
  const validationLoadGenerationRef = useRef(0);
  const didMountDataRefreshRef = useRef(false);
  const hasCurrentQueryDataRef = useRef(false);
  const currentQueryRef = useRef<GridQueryState | null>(null);

  const queryKey = useMemo(
    () =>
      JSON.stringify({
        selectedFolderPath,
        workspacePath,
        page,
        sortColumn: sort.column,
        sortDirection: sort.direction,
        activeFilters,
      }),
    [activeFilters, page, selectedFolderPath, sort.column, sort.direction, workspacePath],
  );

  const hasCurrentQueryData = diffData !== null && resolvedQueryKey === queryKey;
  const hasCurrentQueryError = error !== null && errorQueryKey === queryKey;
  const isBlockingLoad = loadingMode === 'blocking';
  const isRefreshing = loadingMode === 'refreshing';
  const currentQuery = useMemo<GridQueryState>(
    () => ({
      key: queryKey,
      selectedFolderPath,
      workspacePath,
      page,
      sortColumn: sort.column,
      sortDirection: sort.direction,
      activeFilters,
    }),
    [activeFilters, page, queryKey, selectedFolderPath, sort.column, sort.direction, workspacePath],
  );

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

  useEffect(() => {
    hasCurrentQueryDataRef.current = hasCurrentQueryData;
  }, [hasCurrentQueryData]);

  useEffect(() => {
    currentQueryRef.current = currentQuery;
  });

  const loadDiffData = useCallback(async (mode: 'blocking' | 'refreshing', currentQueryState: GridQueryState) => {
    const {
      key,
      selectedFolderPath: nextSelectedFolderPath,
      workspacePath: nextWorkspacePath,
      page: nextPage,
      sortColumn,
      sortDirection,
      activeFilters: nextActiveFilters,
    } = currentQueryState;

    if (!nextSelectedFolderPath || !nextWorkspacePath) {
      loadGenerationRef.current += 1;
      setDiffData(null);
      setError(null);
      setErrorQueryKey(null);
      setResolvedQueryKey(null);
      setLoadingMode('idle');
      return;
    }

    const shouldKeepShowingCurrentData = mode === 'refreshing' && hasCurrentQueryDataRef.current;
    const generation = ++loadGenerationRef.current;
    setLoadingMode(shouldKeepShowingCurrentData ? 'refreshing' : 'blocking');
    if (!shouldKeepShowingCurrentData) {
      setError(null);
      setErrorQueryKey(null);
    }

    try {
      const result = await window.scratchFiles.readDiffGridData(nextSelectedFolderPath, nextWorkspacePath, {
        offset: (nextPage - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
        sortBy: sortColumn ?? undefined,
        sortOrder: sortDirection ?? undefined,
        filters: nextActiveFilters,
      });
      if (generation !== loadGenerationRef.current) {
        return;
      }
      setDiffData(result as DiffGridResult);
      setResolvedQueryKey(key);
      setError(null);
      setErrorQueryKey(null);
    } catch (err: unknown) {
      if (generation !== loadGenerationRef.current) {
        return;
      }
      if (shouldKeepShowingCurrentData) {
        console.debug('[FolderDataGrid] background refresh failed:', err);
        return;
      }
      setError(err instanceof Error ? err.message : 'Failed to load grid data');
      setErrorQueryKey(key);
      setDiffData(null);
      setResolvedQueryKey(null);
    } finally {
      if (generation === loadGenerationRef.current) {
        setLoadingMode('idle');
      }
    }
  }, []);

  // Load data for query changes and explicit user-triggered reloads.
  useEffect(() => {
    void loadDiffData('blocking', currentQuery);
  }, [currentQuery, loadDiffData, reloadKey]);

  useEffect(() => {
    if (!selectedFolderPath || !workspacePath || !diffData) {
      validationLoadGenerationRef.current += 1;
      setValidationByCell(new Map());
      return;
    }

    const generation = ++validationLoadGenerationRef.current;
    void window.scratchFiles
      .getFolderValidationResults(workspacePath, selectedFolderPath)
      .then((results) => {
        if (generation !== validationLoadGenerationRef.current) {
          return;
        }
        const next = new Map<string, GridValidationEntry[]>();
        for (const result of results as GridValidationEntry[]) {
          if (!result.file_name) {
            continue;
          }
          const key = validationCellKey(result.file_name, result.field_path);
          const entries = next.get(key) ?? [];
          entries.push(result);
          next.set(key, entries);
        }
        setValidationByCell(next);
      })
      .catch((error: unknown) => {
        if (generation !== validationLoadGenerationRef.current) {
          return;
        }
        console.debug('[FolderDataGrid] failed to load validation results:', error);
        setValidationByCell(new Map());
      });
  }, [diffData, selectedFolderPath, workspacePath]);

  // Keep the current rows painted during passive background refreshes (e.g. app focus).
  // currentQuery is intentionally NOT in the dep array — we read it via ref so this effect
  // only fires when dataRefreshKey changes, never on user-initiated query changes. Without
  // this separation, both effects would fire on every filter/sort/page change and the
  // second (refreshing) call would race and cancel the first (blocking) one.
  useEffect(() => {
    if (!didMountDataRefreshRef.current) {
      didMountDataRefreshRef.current = true;
      return;
    }
    if (!selectedFolderPath || !workspacePath) {
      return;
    }
    if (currentQueryRef.current) {
      void loadDiffData('refreshing', currentQueryRef.current);
    }
  }, [dataRefreshKey, loadDiffData, selectedFolderPath, workspacePath]);

  // Reset state when folder changes
  useEffect(() => {
    setSort({ column: null, direction: null });
    setActiveFilters([]);
    setColumnWidths({});
    setDetailRowIndex(null);
    setDetailFocusFieldName(null);
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

  const pagedRows = useMemo(() => {
    const rows = diffData?.rows ?? [];
    if (sort.column !== STATUS_COL_ID || !sort.direction) return rows;
    const statusOrder: Record<string, number> = {
      added: 1,
      addedUnpublished: 2,
      modified: 3,
      unpublished: 4,
      deleted: 5,
      deletedUnpublished: 6,
      unchanged: 7,
      invalidJson: 8,
    };
    const sorted = [...rows].sort((a, b) => {
      const aOrder = statusOrder[a.__rowStatus] ?? 99;
      const bOrder = statusOrder[b.__rowStatus] ?? 99;
      return sort.direction === 'asc' ? aOrder - bOrder : bOrder - aOrder;
    });
    return sorted;
  }, [diffData?.rows, sort.column, sort.direction]);
  const totalPages = Math.max(1, Math.ceil((diffData?.total ?? 0) / PAGE_SIZE));

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  /** Map from column ID to its ColumnDefinition for metadata lookup. */
  const columnDefsMap = useMemo(() => {
    const map = new Map<string, ColumnDefinition>();
    for (const col of diffData?.columns ?? []) {
      map.set(col.id, col);
    }
    return map;
  }, [diffData?.columns]);

  /** Map from column ID to display label (for column picker, header menu, etc.) */
  const columnLabelsMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const col of diffData?.columns ?? []) {
      if (typeof col.id === 'string' && typeof col.displayName === 'string') {
        map.set(col.id, col.displayName);
      }
    }
    return map;
  }, [diffData?.columns]);

  /** Map from column ID to description (for header menu, detail view, etc.) */
  const columnDescriptionsMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const col of diffData?.columns ?? []) {
      if (typeof col.id === 'string' && typeof col.description === 'string' && col.description.length > 0) {
        map.set(col.id, col.description);
      }
    }
    return map;
  }, [diffData?.columns]);

  const titleColumnId = useMemo(() => {
    const raw = schema?.titleColumnRemoteId;
    const colIds = diffData?.columns?.map((c) => c.id) ?? [];
    // WORKAROUND(ryder): The titleColumnRemoteId isn't always set properly in the schema, or at least doesn't match
    // what we are comparing it to. If it give us an invalid value, then fall back to the first column as the title.
    if (Array.isArray(raw) && raw.length > 0 && raw.every((s) => typeof s === 'string')) {
      const realValue = raw.join('.');
      if (colIds.includes(realValue)) {
        return realValue;
      }
    }
    // Fallback to the first column as the title.
    return colIds[0] ?? null;
  }, [schema, diffData?.columns]);

  /** All column IDs in schema order, with title column first. */
  const allColumnIds: string[] = useMemo(() => {
    const colIds = diffData?.columns?.map((c) => c.id) ?? [];
    if (titleColumnId && colIds.includes(titleColumnId)) {
      return [titleColumnId, ...colIds.filter((c) => c !== titleColumnId)];
    }
    return colIds;
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
      .map((name) => {
        const def = columnDefsMap.get(name);
        const displayName = def?.displayName ?? name;
        return {
          id: name,
          title: displayName,
          width: columnWidths[name] ?? Math.max(120, Math.min(250, displayName.length * 9 + 40)),
          hasMenu: true,
          menuIcon: GridColumnMenuIcon.Dots,
        };
      });
    return [statusColumn, ...dataCols];
  }, [allColumnIds, columnDefsMap, columnWidths, effectiveVisibleColumns, statusColumn]);

  /** Column IDs that should be focused for Needs review, across the current non-global query. */
  const unreviewedColumnIds: string[] = useMemo(() => {
    if (!diffData) return [];
    const set = new Set<string>(diffData.focusColumnIds.unreviewed);
    for (const row of diffData.rows) {
      for (const field of row.__changedFields) set.add(field);
    }
    return allColumnIds.filter((c) => set.has(c));
  }, [allColumnIds, diffData]);

  /** Column IDs that should be focused for Approved, across the current non-global query. */
  const approvedColumnIds: string[] = useMemo(() => {
    if (!diffData) return [];
    const set = new Set<string>(diffData.focusColumnIds.unpublished);
    for (const row of diffData.rows) {
      for (const field of row.__unpublishedFields) set.add(field);
    }
    return allColumnIds.filter((c) => set.has(c));
  }, [allColumnIds, diffData]);

  const buildValidationHoverState = useCallback(
    (col: number, row: number): ValidationHoverState | null => {
      if (col === 0) return null;
      const record = pagedRows[row] as DiffRow | undefined;
      const columnId = columns[col]?.id;
      if (!record || !columnId) return null;

      const entries = validationByCell.get(validationCellKey(record.__filename, columnId));
      if (!entries || entries.length === 0) return null;

      const bounds = gridRef.current?.getBounds(col, row);
      if (!bounds) return null;

      return { col, row, bounds, entries };
    },
    [columns, pagedRows, validationByCell],
  );

  const buildCellPopoverState = useCallback(
    (col: number, row: number): CellPopoverState | null => {
      const record = pagedRows[row] as DiffRow | undefined;
      if (!record || record.__rowStatus === 'invalidJson') return null;

      // Record-level popover for needs-review creates/deletes
      if (record.__rowStatus === 'added' || record.__rowStatus === 'deleted') {
        const titleColIndex = columns.findIndex((c) => c.id === titleColumnId);
        const targetCol = titleColIndex >= 0 ? titleColIndex : 1;
        const bounds = gridRef.current?.getBounds(targetCol, row);
        if (!bounds) return null;
        return {
          col: targetCol,
          row,
          filename: record.__filename,
          fieldName: '',
          value: '',
          fromValue: '',
          diffKind: 'unreviewed',
          classification: null,
          bounds,
          recordLevel: true,
          recordAction: record.__rowStatus,
        };
      }

      if (col === 0) return null; // Status column
      const columnId = columns[col]?.id;
      if (!columnId || record.__rowStatus === 'deletedUnpublished') {
        return null;
      }

      const { diffKind, fromValue, classification } = getCellDiffState(record, columnId, columnDefsMap.get(columnId));
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
        classification,
        bounds,
      };
    },
    [columnDefsMap, columns, pagedRows, titleColumnId],
  );

  useEffect(() => {
    // While the record detail view is open, suppress the cell popover entirely —
    // otherwise the rebuild path here re-creates it on top of (or alongside) the detail view.
    if (detailRowIndex !== null) {
      setCellPopover(null);
      return;
    }
    const currentCell = gridSelection?.current?.cell;
    if (!currentCell) {
      setCellPopover(null);
      return;
    }

    const [col, row] = currentCell;
    setCellPopover(buildCellPopoverState(col, row));
  }, [buildCellPopoverState, detailRowIndex, gridSelection]);

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

  useEffect(() => {
    setValidationHover(null);
  }, [selectedFolderPath, validationByCell, workspacePath]);

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

  const refreshGridDataInBackground = useCallback(() => {
    if (currentQueryRef.current) {
      void loadDiffData('refreshing', currentQueryRef.current);
    }
  }, [loadDiffData]);

  const acceptGridCellChange = useCallback(
    (filename: string, fieldName: string, nextValue: string, logLabel: string) => {
      if (!selectedFolderPath || !workspacePath) {
        return;
      }

      // Apply optimistically before awaiting the IPC so the grid canvas never
      // repaints the pre-edit value in the gap between the overlay closing
      // and the backend write completing. We reuse the same shared coercion
      // helper as the main-process save path so the optimistic value matches
      // the value that will be written on disk. On failure we trigger a full
      // refresh to resync the grid with the authoritative on-disk state rather
      // than trying to surgically revert — any intervening edits on other
      // cells are preserved that way.
      let parsedValue: unknown;
      try {
        parsedValue = coerceCellInputTextWithSchema(schema, fieldName, nextValue);
      } catch (err) {
        notifications.show({
          color: 'red',
          title: 'Invalid value',
          message: err instanceof Error ? err.message : 'The value does not match the field schema.',
        });
        return;
      }
      setDiffData((prev) => (prev ? applyAcceptedCellChange(prev, filename, fieldName, parsedValue) : prev));

      void window.scratchFiles
        .acceptCellInputText(selectedFolderPath, workspacePath, filename, fieldName, nextValue)
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
    [closeGridEditorChrome, refreshGridData, schema, selectedFolderPath, workspacePath],
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
    async (action: 'approve' | 'reject' | 'discard') => {
      if (!workspacePath) return;

      const relativeFolderPath =
        selectedFolderPath && selectedFolderPath.startsWith(workspacePath)
          ? selectedFolderPath.slice(workspacePath.length).replace(/^\//, '')
          : (selectedFolderPath?.replace(/^\//, '') ?? '');

      setBulkActionLoading(true);
      try {
        if (action === 'approve') {
          const result = await window.scratchDesktop.acceptAllChanges(workspacePath, relativeFolderPath || undefined);
          if (result.exitCode !== 0) {
            throw new Error(result.stderr.trim() || result.stdout.trim() || 'Failed to approve changes');
          }
          notifications.show({
            color: 'green',
            title: 'All changes approved',
            message: `Approved all pending changes.`,
          });
        } else if (action === 'discard') {
          const result = await window.scratchDesktop.discardAllChanges(workspacePath, relativeFolderPath || undefined);
          if (result.exitCode !== 0) {
            throw new Error(result.stderr.trim() || result.stdout.trim() || 'Failed to discard changes');
          }
          notifications.show({
            color: 'green',
            title: 'All changes discarded',
            message: `Discarded all pending and approved changes.`,
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

          for (const filename of unreviewedFilenames) {
            const recordPath = relativeFolderPath ? `${relativeFolderPath}/${filename}` : filename;
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
        const statusBg = r ? getStatusCellTint(r.__rowStatus) : undefined;
        return {
          kind: GridCellKind.Text as const,
          data: '',
          displayData: '',
          allowOverlay: false as const,
          themeOverride: statusBg ? { bgCell: statusBg } : undefined,
        };
      }

      const colId = columns[col]?.id;

      if (!r || colId === undefined) {
        return { kind: GridCellKind.Text as const, data: '', displayData: '', allowOverlay: false as const };
      }

      const status = r.__rowStatus;
      const rowBg = getRowTint(status);
      const rowTextColor = getRowTextColor(status);
      const colDef = columnDefsMap.get(colId);
      const isReadOnly = colDef?.attributes.readOnly === true;
      const rowTheme = { ...(rowBg ? { bgCell: rowBg } : {}), ...(rowTextColor ? { textDark: rowTextColor } : {}) };
      const val = r[colId];
      const { diffKind } = getCellDiffState(r, colId, colDef);
      const diffTheme =
        diffKind === 'unreviewed'
          ? { bgCell: DIFF_WORKING_BG(), textDark: DIFF_WORKING_BORDER() }
          : diffKind === 'unpublished'
            ? { bgCell: DIFF_UNPUBLISHED_BG() }
            : {};
      const readOnlyTheme = isReadOnly ? { textDark: getCssVar('--fg-muted') } : {};
      const themeOverride = { ...rowTheme, ...diffTheme, ...readOnlyTheme };
      const allowOverlay =
        !isReadOnly && status !== 'deleted' && status !== 'deletedUnpublished' && status !== 'invalidJson';

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
    [columnDefsMap, pagedRows, columns],
  );

  const onHeaderClicked = useCallback(
    (colIndex: number) => {
      if (colIndex === 0) {
        setSort((prev) => {
          if (prev.column === STATUS_COL_ID && prev.direction === 'asc')
            return { column: STATUS_COL_ID, direction: 'desc' };
          return { column: STATUS_COL_ID, direction: 'asc' };
        });
        return;
      }
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
        columnDescription: columnDefsMap.get(String(column.id))?.description ?? '',
        bounds,
      });
    },
    [closeGridEditorChrome, columnDefsMap, columns],
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

      // Status column — draw row number + status icon
      if (args.col === 0) {
        // Tint status cell background for modified/unpublished rows
        // (creates/deletes get status-cell-only tint via getStatusCellTint in getCellContent)
        if (
          row &&
          row.__rowStatus !== 'added' &&
          row.__rowStatus !== 'addedUnpublished' &&
          row.__rowStatus !== 'deleted' &&
          row.__rowStatus !== 'deletedUnpublished' &&
          row.__rowStatus !== 'invalidJson' &&
          (row.__changedFields.length > 0 || row.__unpublishedFields.length > 0)
        ) {
          const bg = row.__changedFields.length > 0 ? DIFF_WORKING_BG() : DIFF_UNPUBLISHED_BG();
          args.ctx.save();
          args.ctx.fillStyle = bg;
          args.ctx.fillRect(args.rect.x, args.rect.y, args.rect.width, args.rect.height);
          args.ctx.restore();
        }
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
        const isCreateReview = row.__rowStatus === 'added';
        const isCreateApproved = row.__rowStatus === 'addedUnpublished';
        const isDeletedReview = row.__rowStatus === 'deleted';
        const isDeletedApproved = row.__rowStatus === 'deletedUnpublished';
        const hasUnreviewed =
          isCreateReview || isDeletedReview || row.__rowStatus === 'invalidJson' || row.__changedFields.length > 0;
        const hasApproved = isCreateApproved || isDeletedApproved || row.__unpublishedFields.length > 0;
        if (hasUnreviewed || hasApproved) {
          const kind: StatusIconKind =
            isCreateReview || isCreateApproved ? 'plus' : isDeletedReview || isDeletedApproved ? 'minus' : 'diff';
          const color = isCreateReview
            ? DIFF_CREATE_REVIEW_BORDER()
            : isCreateApproved
              ? DIFF_CREATE_APPROVED_BORDER()
              : isDeletedReview
                ? DIFF_DELETE_REVIEW_BORDER()
                : isDeletedApproved
                  ? DIFF_DELETE_APPROVED_BORDER()
                  : hasUnreviewed
                    ? DIFF_WORKING_BORDER()
                    : DIFF_UNPUBLISHED_BORDER();
          const iconSize = 14;
          ctx.save();
          ctx.strokeStyle = color;
          ctx.fillStyle = color;
          drawStatusIcon(ctx, rect.x + 3, rect.y + (rect.height - iconSize) / 2, iconSize, kind);
          ctx.restore();
        }
        return;
      }

      const colId = columns[args.col]?.id;
      if (!row || !colId) {
        drawContent();
        return;
      }

      const { diffKind, fromValue, classification } = getCellDiffState(row, colId, columnDefsMap.get(colId));

      // Small / extra-small text fields render the new value with changed words highlighted
      // blue. Boolean / Number cells fall through to glide's default rendering even when
      // their classification is XS — only string text is word-diffable.
      const isWordDiffCandidate =
        diffKind !== null &&
        args.cell.kind === GridCellKind.Text &&
        (classification?.fieldSize === 'XS' || classification?.fieldSize === 'S');
      if (isWordDiffCandidate) {
        const cell = args.cell;
        const toText = 'displayData' in cell && typeof cell.displayData === 'string' ? cell.displayData : '';
        drawWordDiffText(args.ctx, args.rect, args.theme, fromValue, toText);
      } else {
        drawContent();
      }

      if (diffKind !== null) {
        args.ctx.save();
        args.ctx.fillStyle = diffKind === 'unreviewed' ? DIFF_WORKING_BORDER() : DIFF_UNPUBLISHED_BORDER();
        args.ctx.fillRect(args.rect.x, args.rect.y, 3, args.rect.height);
        args.ctx.restore();
      }

      const validationEntries = validationByCell.get(validationCellKey(row.__filename, colId));
      if (validationEntries && validationEntries.length > 0) {
        const level = validationEntries.some((entry) => entry.level === 'error') ? 'error' : 'warning';
        const iconSize = 14;
        drawValidationIcon(
          args.ctx,
          args.rect.x + args.rect.width - iconSize - 8,
          args.rect.y + (args.rect.height - iconSize) / 2,
          iconSize,
          level,
        );
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
    [columnDefsMap, columns, page, pagedRows, validationByCell],
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

      const nextValidationHover =
        args.kind === 'cell' ? buildValidationHoverState(args.location[0], args.location[1]) : null;
      setValidationHover((current) => {
        if (
          current &&
          nextValidationHover &&
          current.col === nextValidationHover.col &&
          current.row === nextValidationHover.row &&
          current.entries === nextValidationHover.entries
        ) {
          return current;
        }
        return nextValidationHover;
      });
    },
    [buildValidationHoverState, recomputeInspectRect],
  );

  const onGridMouseLeave = useCallback(() => {
    setHoveredRowIdx(null);
    setInspectButtonRect(null);
    setValidationHover(null);
  }, []);

  const onVisibleRegionChanged = useCallback(() => {
    // Reposition the inspect button as the user scrolls.
    recomputeInspectRect(hoveredRowIdx);
    setValidationHover(null);
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
      const { diffKind } = getCellDiffState(r, colId, columnDefsMap.get(colId));
      setActiveEditorDiffKind(diffKind ?? 'none');
      setEditingCell([col, row]);
      if (diffKind === null) {
        setCellPopover(null);
        return;
      }
      setCellPopover(buildCellPopoverState(col, row));
    },
    [buildCellPopoverState, columnDefsMap, columns, pagedRows],
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
        // Applying a filter narrows the visible columns to the focus set for
        // that filter, computed from the current query with only the global
        // review filter removed.
        setActiveFilters([...withoutGlobal, { scope: 'global', kind }]);
        const matchingCols = kind === 'unreviewed' ? unreviewedColumnIds : approvedColumnIds;
        const locked = titleColumnId ? [titleColumnId] : [];
        setVisibleColumnIds([...locked, ...matchingCols.filter((c) => c !== titleColumnId)]);
      }
    },
    [activeFilters, approvedColumnIds, titleColumnId, unreviewedColumnIds],
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
  const showFilterBar = workspacePath && selectedFolderPath && !hasCurrentQueryError;
  const showBlockingLoader = Boolean(
    selectedFolderPath && (isBlockingLoad || (!hasCurrentQueryData && !hasCurrentQueryError && workspacePath)),
  );
  const disableGlobalFilterPills = isBlockingLoad;

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
              bulletColor="var(--modified-needs-review-stroke)"
              disabled={disableGlobalFilterPills}
              onClick={() => handleGlobalFilterToggle('unreviewed')}
            />
            <FilterPill
              label="Approved"
              count={filterCounts?.unpublished ?? 0}
              active={hasGlobalFilter('unpublished')}
              bulletColor="var(--modified-approved-stroke)"
              disabled={disableGlobalFilterPills}
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
            {(filterCounts?.unreviewed ?? 0) > 0 && detailRowIndex === null && (
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
            {(filterCounts?.unreviewed ?? 0) + (filterCounts?.unpublished ?? 0) > 0 && detailRowIndex === null && (
              <>
                {(filterCounts?.unreviewed ?? 0) === 0 && <Divider orientation="vertical" />}
                <ButtonSecondaryGhost
                  size="compact-xs"
                  c="red.8"
                  leftSection={<Trash2 size={12} />}
                  onClick={() => setBulkActionConfirm('discard')}
                >
                  Discard all
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
                  columnLabels={columnLabelsMap}
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

      {selectedFolderPath && showBlockingLoader && (
        <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Loader size="sm" />
        </Box>
      )}

      {selectedFolderPath && hasCurrentQueryError && (
        <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Text13Regular c="var(--mantine-color-red-6)">{error}</Text13Regular>
        </Box>
      )}

      {selectedFolderPath && !showBlockingLoader && !hasCurrentQueryError && pagedRows.length === 0 && (
        <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Text13Regular c="dimmed">
            {activeFilters.length > 0 ? 'No rows match the current filter' : 'No data in this folder'}
          </Text13Regular>
        </Box>
      )}

      {selectedFolderPath && !showBlockingLoader && !hasCurrentQueryError && pagedRows.length > 0 && (
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
                  if (hoveredRowIdx !== null) {
                    setDetailFocusFieldName(null);
                    setDetailRowIndex(hoveredRowIdx);
                  }
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
              columnId={headerMenu?.columnId ?? ''}
              columnTitle={headerMenu?.columnTitle ?? ''}
              columnDescription={headerMenu?.columnDescription ?? ''}
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
                schema={schema}
                titleColumnId={titleColumnId}
                columnOrder={effectiveVisibleColumns}
                columnLabels={columnLabelsMap}
                columnDescriptions={columnDescriptionsMap}
                initialFocusedFieldName={detailFocusFieldName ?? undefined}
                onSelectIndex={(nextIndex) => {
                  if (nextIndex !== detailRowIndex) setDetailFocusFieldName(null);
                  setDetailRowIndex(nextIndex);
                }}
                onClose={() => {
                  setDetailRowIndex(null);
                  setDetailFocusFieldName(null);
                  // Drop the cell selection so the rebuild effect can't restore the popover
                  // when returning to the grid — require a fresh click.
                  setGridSelection(undefined);
                }}
                onRecordChanged={refreshGridDataInBackground}
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
                  &middot; Sorted by {sort.column === STATUS_COL_ID ? 'Status' : sort.column}{' '}
                  {sort.direction === 'desc' ? '\u2193' : '\u2191'}
                </span>
              )}
            </Text12Regular>

            <Group gap={10} align="center">
              {isRefreshing && detailRowIndex === null && (
                <Group gap={6} align="center">
                  <Loader size="xs" />
                  <Text12Regular c="var(--fg-muted)">Refreshing…</Text12Regular>
                </Group>
              )}
              {(filterCounts?.unreviewed ?? 0) > 0 && (
                <Group gap={3}>
                  <Box
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      backgroundColor: 'var(--modified-needs-review-stroke)',
                      flexShrink: 0,
                    }}
                  />
                  <Text12Regular c="var(--fg-muted)">{filterCounts?.unreviewed} needs review</Text12Regular>
                </Group>
              )}
              {hasChanges && (
                <Group gap={10}>
                  {summary.addedApproved > 0 && (
                    <Group gap={3}>
                      <Plus size={12} color="var(--create-approved-stroke)" />
                      <Text12Regular c="var(--fg-muted)">{summary.addedApproved} added</Text12Regular>
                    </Group>
                  )}
                  {summary.unpublished > 0 && (
                    <Group gap={3}>
                      <Box
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          backgroundColor: 'var(--modified-approved-stroke)',
                          flexShrink: 0,
                        }}
                      />
                      <Text12Regular c="var(--fg-muted)">{summary.unpublished} modified</Text12Regular>
                    </Group>
                  )}
                  {summary.deletedApproved > 0 && (
                    <Group gap={3}>
                      <Minus size={12} color="var(--delete-approved-stroke)" />
                      <Text12Regular c="var(--fg-muted)">{summary.deletedApproved} deleted</Text12Regular>
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
                      <Group gap={3}>
                        <Box
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: '50%',
                            backgroundColor: '#ea580c',
                            flexShrink: 0,
                          }}
                        />
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
            {bulkActionConfirm === 'discard' ? (
              <>
                Discard {(filterCounts?.unreviewed ?? 0) + (filterCounts?.unpublished ?? 0)}{' '}
                {(filterCounts?.unreviewed ?? 0) + (filterCounts?.unpublished ?? 0) === 1 ? 'change' : 'changes'} in{' '}
                {selectedFolderPath?.split('/').filter(Boolean).pop() ?? 'this folder'}?
              </>
            ) : (
              <>
                {bulkActionConfirm === 'approve' ? 'Approve' : 'Reject'} {filterCounts?.unreviewed ?? 0} pending{' '}
                {(filterCounts?.unreviewed ?? 0) === 1 ? 'change' : 'changes'} in{' '}
                {selectedFolderPath?.split('/').filter(Boolean).pop() ?? 'this folder'}?
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
              {filterCounts?.unreviewed ?? 0} pending + {filterCounts?.unpublished ?? 0} approved ={' '}
              {(filterCounts?.unreviewed ?? 0) + (filterCounts?.unpublished ?? 0)} changes will be discarded.
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
            onClick={() => {
              if (bulkActionConfirm) void handleBulkAction(bulkActionConfirm);
            }}
          >
            {bulkActionConfirm === 'approve'
              ? 'Approve all'
              : bulkActionConfirm === 'discard'
                ? 'Discard all'
                : 'Reject all'}
          </ButtonSecondaryGhost>
        </Group>
      </Modal>

      {validationHover &&
        (() => {
          const tooltipWidth = 520;
          const left = Math.max(
            12,
            Math.min(
              validationHover.bounds.x + validationHover.bounds.width - tooltipWidth,
              window.innerWidth - tooltipWidth - 12,
            ),
          );
          const belowTop = validationHover.bounds.y + validationHover.bounds.height + 8;
          const estimatedHeight = Math.min(260, 54 + validationHover.entries.length * 42);
          const top =
            belowTop + estimatedHeight < window.innerHeight - 12
              ? belowTop
              : Math.max(12, validationHover.bounds.y - estimatedHeight - 8);

          return (
            <Portal target="#portal">
              <Box
                style={{
                  position: 'fixed',
                  left,
                  top,
                  zIndex: 10020,
                  width: tooltipWidth,
                  maxWidth: Math.max(280, window.innerWidth - 24),
                  maxHeight: 260,
                  overflow: 'auto',
                  pointerEvents: 'none',
                  background: '#fff',
                  border: '1px solid rgba(15, 23, 42, 0.12)',
                  borderRadius: 12,
                  boxShadow: '0 18px 44px rgba(15, 23, 42, 0.18)',
                  padding: 10,
                }}
              >
                <Table
                  fz="xs"
                  withRowBorders={false}
                  horizontalSpacing={8}
                  verticalSpacing={6}
                  styles={{
                    th: {
                      color: 'rgba(15, 23, 42, 0.48)',
                      fontSize: 10,
                      fontWeight: 800,
                      letterSpacing: '0.08em',
                      paddingBottom: 7,
                      textTransform: 'uppercase',
                    },
                    td: {
                      color: 'rgba(15, 23, 42, 0.88)',
                      lineHeight: 1.35,
                      verticalAlign: 'top',
                    },
                  }}
                >
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th style={{ width: 76 }}>Level</Table.Th>
                      <Table.Th>Message</Table.Th>
                      <Table.Th style={{ width: 132 }}>Validator</Table.Th>
                      <Table.Th style={{ width: 120 }}>Actions</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {validationHover.entries.map((entry, index) => {
                      const isError = entry.level === 'error';
                      return (
                        <Table.Tr key={`${entry.validator_kind}-${entry.field_path}-${index}`}>
                          <Table.Td>
                            <Box
                              component="span"
                              style={{
                                display: 'inline-flex',
                                borderRadius: 999,
                                background: isError ? 'var(--mantine-color-red-0)' : 'var(--mantine-color-yellow-0)',
                                color: isError ? 'var(--mantine-color-red-7)' : 'var(--mantine-color-orange-7)',
                                fontSize: 10,
                                fontWeight: 800,
                                letterSpacing: '0.04em',
                                padding: '3px 7px',
                                textTransform: 'uppercase',
                              }}
                            >
                              {entry.level}
                            </Box>
                          </Table.Td>
                          <Table.Td style={{ wordBreak: 'break-word' }}>
                            <Stack gap={3}>
                              <Text12Medium c="rgba(15, 23, 42, 0.92)">{entry.message ?? 'No message'}</Text12Medium>
                              {entry.description && (
                                <Text12Regular c="rgba(15, 23, 42, 0.62)" style={{ lineHeight: 1.35 }}>
                                  {entry.description}
                                </Text12Regular>
                              )}
                            </Stack>
                          </Table.Td>
                          <Table.Td
                            style={{
                              color: 'rgba(15, 23, 42, 0.58)',
                              fontFamily: 'monospace',
                              fontSize: 11,
                              overflowWrap: 'anywhere',
                            }}
                          >
                            {entry.validator_kind.replace(/[_-]+/g, ' ')}
                          </Table.Td>
                          <Table.Td>
                            <Group gap={4} wrap="nowrap">
                              {entry.fixable && (
                                <Button size="compact-xs" variant="light" color="gray">
                                  Fix
                                </Button>
                              )}
                              <Button size="compact-xs" variant="light" color="gray">
                                Ignore
                              </Button>
                            </Group>
                          </Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              </Box>
            </Portal>
          );
        })()}

      {cellPopover &&
        selectedFolderPath &&
        workspacePath &&
        (() => {
          const { bounds, diffKind, value, fromValue, filename, fieldName, classification } = cellPopover;
          const shouldTruncate = classification?.fieldSize === 'M' || classification?.fieldSize === 'L';
          // Truncated previews cap at 100 chars; widen the popover so the single-line preview fits.
          const minPopoverWidth = shouldTruncate ? 560 : 280;
          const popoverWidth = Math.min(Math.max(minPopoverWidth, Math.floor(bounds.width)), window.innerWidth - 24);
          const left = Math.max(12, Math.min(bounds.x, window.innerWidth - popoverWidth - 12));

          // Record-level popover for creates/deletes
          if (cellPopover.recordLevel && cellPopover.recordAction) {
            const relativeFolderPath = selectedFolderPath.startsWith(workspacePath)
              ? selectedFolderPath.slice(workspacePath.length).replace(/^\//, '')
              : selectedFolderPath.replace(/^\//, '');
            const recordPath = relativeFolderPath ? `${relativeFolderPath}/${filename}` : filename;
            const handleRecordApprove = () => {
              void window.scratchDesktop.acceptRecord(workspacePath, recordPath).then((result) => {
                if (result.exitCode === 0) {
                  setCellPopover(null);
                  refreshGridData();
                }
              });
            };
            const handleRecordReject = () => {
              void window.scratchDesktop.rejectRecord(workspacePath, recordPath).then((result) => {
                if (result.exitCode === 0) {
                  setCellPopover(null);
                  refreshGridData();
                }
              });
            };

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
                  <Group align="stretch" gap={8} wrap="nowrap">
                    <Box
                      style={{
                        flex: 1,
                        minWidth: 0,
                        display: 'flex',
                        alignItems: 'center',
                        padding: '8px 12px',
                      }}
                    >
                      <UnstyledButton
                        onClick={() => {
                          setCellPopover(null);
                          setDetailFocusFieldName(null);
                          setDetailRowIndex(cellPopover.row);
                        }}
                      >
                        <Text12Medium
                          style={{
                            color: 'var(--fg-secondary)',
                            whiteSpace: 'nowrap',
                            textDecoration: 'underline',
                          }}
                        >
                          {cellPopover.recordAction === 'added' ? 'Record added' : 'Record removed'}
                        </Text12Medium>
                      </UnstyledButton>
                    </Box>
                    <Stack
                      gap={6}
                      align="center"
                      justify="center"
                      style={{ flexShrink: 0, width: 28, padding: '2px 0' }}
                    >
                      <Tooltip label="Approve" position="left" withArrow zIndex={10020}>
                        <ActionIcon
                          variant="transparent"
                          size={24}
                          radius={3}
                          aria-label="Approve"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={handleRecordApprove}
                          styles={{
                            root: {
                              backgroundColor: 'var(--mantine-color-green-1)',
                              color: 'var(--mantine-color-green-8)',
                              border: '1px solid var(--mantine-color-green-3)',
                              minWidth: 24,
                              minHeight: 24,
                              padding: 3,
                              boxShadow: '0 1px 2px rgba(15, 23, 42, 0.08)',
                            },
                          }}
                        >
                          <StyledLucideIcon Icon={Check} size={14} strokeWidth={2.25} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Reject" position="left" withArrow zIndex={10020}>
                        <ActionIcon
                          variant="transparent"
                          size={24}
                          radius={3}
                          aria-label="Reject"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={handleRecordReject}
                          styles={{
                            root: {
                              backgroundColor: 'var(--mantine-color-red-1)',
                              color: 'var(--mantine-color-red-8)',
                              border: '1px solid var(--mantine-color-red-3)',
                              minWidth: 24,
                              minHeight: 24,
                              padding: 3,
                              boxShadow: '0 1px 2px rgba(15, 23, 42, 0.08)',
                            },
                          }}
                        >
                          <StyledLucideIcon Icon={RotateCcw} size={14} strokeWidth={2.25} />
                        </ActionIcon>
                      </Tooltip>
                    </Stack>
                  </Group>
                </Box>
              </Portal>
            );
          }

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
                    truncate={shouldTruncate}
                    onApprove={() => acceptGridCellChange(filename, fieldName, value, 'approve')}
                    onUndo={undoAction}
                    onView={
                      shouldTruncate
                        ? () => {
                            setCellPopover(null);
                            setDetailFocusFieldName(fieldName);
                            setDetailRowIndex(cellPopover.row);
                          }
                        : undefined
                    }
                  />
                ) : (
                  <FieldReferenceStrip
                    value={fromValue}
                    label={diffKind === 'unpublished' ? 'Last published' : 'Last approved'}
                    truncate={shouldTruncate}
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
