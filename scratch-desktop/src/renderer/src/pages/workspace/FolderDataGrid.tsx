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
  Divider,
  Group,
  Loader,
  Menu,
  Modal,
  Popover,
  Portal,
  Stack,
  Table,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { TablePropertyType, TableView, TableViewBannerGroup, TableViewCol } from '@spinner/shared-types';
import {
  Check,
  Columns3,
  EllipsisVertical,
  GitCompare,
  Grid3X3Icon,
  Maximize2,
  Minus,
  Plus,
  RectangleHorizontalIcon,
  RotateCcw,
  Rows3Icon,
  Trash2,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { coerceCellInputTextWithSchema } from '../../../../shared/cell-value-coercion';
import { classifyFieldChange, type FieldChangeClassification } from '../../../../shared/field-change-classification';
import { createFallbackTableView, getByPath } from '../../../../shared/schema-columns';
// ValidationResultRow is no longer used — validation data comes from diffData.validationByCell
import { getWordDiffSegments } from '../../../../shared/word-diff';
import { Text12Medium, Text12Regular, Text13Medium, Text13Regular } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import { trackRefreshFolderDataGrid } from '../../lib/posthog';
import { useViewMode, useWorkspaceUiStore, type FilterKind, type GridFilter } from '../../stores/workspace-ui-store';
import type { ColumnDefinition } from '../../types/local-files';
import { ColumnPickerMenu } from './ColumnPickerMenu';
import { EditPropertyDialog } from './EditPropertyDialog';
import { formatFieldDisplay } from './field-formatters';
import { FieldReferenceStrip } from './FieldReferenceStrip';
import { FieldValuePanel, type FieldValueDiffKind } from './FieldValuePanel';
import { InvalidJsonFilesModal, type InvalidJsonFileListEntry } from './InvalidJsonFilesModal';
import { RecordDetailView } from './RecordDetailView';
import { drawUnifiedDiffCell, UNIFIED_DIFF_ROW_HEIGHT } from './unified-diff-cell';

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

interface DiffRow {
  __rowStatus: RowStatus;
  __changedFields: string[];
  __fromFields: Record<string, unknown>;
  __unpublishedFields: string[];
  __masterFields: Record<string, unknown>;
  __filename: string;
  __parseError?: string;
  __raw: Record<string, unknown>;
}

interface CellValidationEntry {
  field_path: string;
  validator_kind: string;
  level: string;
  message?: string | null;
  description?: string | null;
  fixable: boolean;
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
  filterCounts: { unreviewed: number; unpublished: number; errors: number };
  focusColumnIds: { unreviewed: string[]; unpublished: string[]; errors: string[] };
  invalidJsonFiles: InvalidJsonFileListEntry[];
  staleCount: number;
  validationByCell: Record<string, CellValidationEntry[]>;
  totalErrorCount: number;
  totalProblemsStaleCount: number;
}

type EditorOverlayDiffKind = FieldValueDiffKind | 'none';

const EMPTY_FILTERS: GridFilter[] = [];

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
  entries: CellValidationEntry[];
}

interface FolderDataGridProps {
  /** Included so memo() invalidates when switching workbooks even if folder path + local path match. */
  workspaceId: string;
  selectedFolderPath: string | null;
  workspacePath: string | null;
  targetRecord?: { filename: string; trigger: string } | null;
  dataRefreshKey: number;
  onDataRefresh: () => void;
  onPublishFile?: (relativePath: string) => void;
  /** When set, activates the given filter once the folder is ready. Increment trigger to re-trigger. */
  activateGlobalFilter?: { kind: FilterKind; trigger: number } | null;
  onActivateGlobalFilterConsumed?: () => void;
  /**
   * Fires with the latest progress message while a full folder reindex is running, and with `null`
   * when the reindex finishes. Lets the parent block UI to prevent overlapping reindex requests.
   */
  onIndexingProgress?: (message: string | null) => void;
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

const VALIDATION_GUTTER_WIDTH = 28;

/**
 * Draw a full-height validation gutter on the right edge of a cell with a centred
 * lucide triangle-alert icon. The gutter acts as a distinct affordance zone rather
 * than a floating overlay on top of cell content.
 */
function drawValidationGutter(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number },
  level: 'error' | 'warning',
): void {
  const bg = level === 'error' ? '#ffebe8' : '#fff2e9';
  const fg =
    level === 'error'
      ? getCssVar('--mantine-color-red-6') || '#e03131'
      : getCssVar('--mantine-color-orange-6') || '#f08c00';

  const gutterX = rect.x + rect.width - VALIDATION_GUTTER_WIDTH;

  ctx.save();

  // Full-height background fill
  ctx.fillStyle = bg;
  ctx.fillRect(gutterX, rect.y, VALIDATION_GUTTER_WIDTH, rect.height);

  // Lucide triangle-alert icon centred in the gutter.
  // Lucide icons use a 24x24 viewBox; we scale to fit a 16px icon.
  const iconSize = 16;
  const scale = iconSize / 24;
  const iconX = gutterX + (VALIDATION_GUTTER_WIDTH - iconSize) / 2;
  const iconY = rect.y + (rect.height - iconSize) / 2;
  ctx.translate(iconX, iconY);
  ctx.scale(scale, scale);

  ctx.strokeStyle = fg;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Triangle body
  const triangle = new Path2D('M21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z');
  ctx.stroke(triangle);

  // Exclamation line
  const line = new Path2D('M12 9v4');
  ctx.stroke(line);

  // Exclamation dot
  ctx.fillStyle = fg;
  ctx.beginPath();
  ctx.arc(12, 17, 1, 0, Math.PI * 2);
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

/** Immutably sets a value at a dot-separated path, returning a shallow clone of the affected objects. */
function setByPath(obj: Record<string, unknown>, dotPath: string, value: unknown): Record<string, unknown> {
  const parts = dotPath.split('.');
  if (parts.length === 1) {
    return { ...obj, [parts[0]]: value };
  }
  const [head, ...rest] = parts;
  const child =
    typeof obj[head] === 'object' && obj[head] !== null && !Array.isArray(obj[head])
      ? (obj[head] as Record<string, unknown>)
      : {};
  return { ...obj, [head]: setByPath(child, rest.join('.'), value) };
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
    errors: result.filterCounts.errors,
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

  const nextRaw = setByPath(prevRow.__raw, fieldName, nextValue);
  const nextRow: DiffRow = {
    ...prevRow,
    __raw: nextRaw,
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

function getCellDiffState(row: DiffRow, fieldName: string, viewCol: TableViewCol | undefined): CellDiffState {
  // Row-level statuses (added, deleted, invalidJson) are styled at the row level — don't
  // overlay per-cell diff colours on top. Exception: an approved create ('addedUnpublished')
  // with edited fields should still show per-cell diffs for those edits.
  if (
    row.__rowStatus === 'added' ||
    (row.__rowStatus === 'addedUnpublished' && row.__changedFields.length === 0) ||
    row.__rowStatus === 'deleted' ||
    row.__rowStatus === 'deletedUnpublished' ||
    row.__rowStatus === 'invalidJson'
  ) {
    return { diffKind: null, fromValue: '', classification: null };
  }
  // __changedFields / __unpublishedFields contain leaf-level paths (e.g. "title.raw").
  // When the column has a selected subfield, check the effective path too.
  const effectivePath = resolveEffectivePath(fieldName, viewCol);
  const isUnreviewed =
    row.__changedFields.includes(fieldName) ||
    (effectivePath !== fieldName && row.__changedFields.includes(effectivePath));
  const isUnpublished =
    !isUnreviewed &&
    (row.__unpublishedFields.includes(fieldName) ||
      (effectivePath !== fieldName && row.__unpublishedFields.includes(effectivePath)));
  // Use the path that actually appears in the diff arrays for value lookups.
  const diffKey = row.__changedFields.includes(effectivePath)
    ? effectivePath
    : row.__unpublishedFields.includes(effectivePath)
      ? effectivePath
      : fieldName;
  if (isUnreviewed) {
    const rawFrom = row.__fromFields[diffKey];
    return {
      diffKind: 'unreviewed',
      fromValue: toDisplayString(rawFrom),
      classification: classifyFieldChange(rawFrom, getByPath(row.__raw, effectivePath), viewCol),
    };
  }
  if (isUnpublished) {
    const rawFrom = row.__masterFields[diffKey];
    return {
      diffKind: 'unpublished',
      fromValue: toDisplayString(rawFrom),
      classification: classifyFieldChange(rawFrom, getByPath(row.__raw, effectivePath), viewCol),
    };
  }
  return { diffKind: null, fromValue: '', classification: null };
}

/** When a subfield is selected on a view column, returns the full dot-path to the subfield; otherwise the root colId. */
function resolveEffectivePath(colId: string, viewCol: TableViewCol | undefined): string {
  if (viewCol?.selectedSubfield != null && viewCol.subfields?.[viewCol.selectedSubfield]) {
    return `${colId}.${viewCol.subfields[viewCol.selectedSubfield].relativePath}`;
  }
  return colId;
}

/** Returns true if the column (or the currently selected subfield) is readonly. */
function isColumnReadonly(viewCol: TableViewCol | undefined): boolean {
  if (viewCol?.readonly) return true;
  if (viewCol?.selectedSubfield != null && viewCol.subfields?.[viewCol.selectedSubfield]) {
    return viewCol.subfields[viewCol.selectedSubfield].readonly === true;
  }
  return false;
}

/** Returns the effective TablePropertyType, preferring the active subfield's type when one is selected. */
function resolveEffectiveType(viewCol: TableViewCol | undefined): TablePropertyType | undefined {
  if (viewCol?.selectedSubfield != null && viewCol.subfields?.[viewCol.selectedSubfield]) {
    return viewCol.subfields[viewCol.selectedSubfield].type ?? viewCol.type;
  }
  return viewCol?.type;
}

function inferCellKind(value: unknown, propertyType?: TablePropertyType): GridCellKind {
  if (propertyType === 'checkbox') return GridCellKind.Boolean;
  if (propertyType === 'number') return GridCellKind.Number;
  if (propertyType === 'url') return GridCellKind.Uri;
  // Fall back to runtime type detection when view type is unset or generic
  if (propertyType == null || propertyType === 'string' || propertyType === 'object') {
    if (typeof value === 'boolean') return GridCellKind.Boolean;
    if (typeof value === 'number') return GridCellKind.Number;
  }
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
  const {
    workspaceId,
    selectedFolderPath,
    workspacePath,
    targetRecord,
    dataRefreshKey,
    onDataRefresh,
    activateGlobalFilter,
    onActivateGlobalFilterConsumed,
  } = props;
  const validate = useWorkspaceUiStore((s) => s.validateEnabled);
  const [diffData, setDiffData] = useState<DiffGridResult | null>(null);
  const [loadingMode, setLoadingMode] = useState<GridLoadMode>('idle');
  const [error, setError] = useState<string | null>(null);
  const [errorQueryKey, setErrorQueryKey] = useState<string | null>(null);
  const [resolvedQueryKey, setResolvedQueryKey] = useState<string | null>(null);
  const sort = useWorkspaceUiStore((s) => s.sort);
  const setSort = useWorkspaceUiStore((s) => s.setSort);
  const activeFilters = useWorkspaceUiStore((s) => s.activeFilters);
  const setActiveFilters = useWorkspaceUiStore((s) => s.setActiveFilters);
  const columnWidths = useWorkspaceUiStore((s) => s.columnWidths);
  const setColumnWidths = useWorkspaceUiStore((s) => s.setColumnWidths);
  const selectedRecordFilename = useWorkspaceUiStore((s) => s.selectedRecordFilename);
  const setSelectedRecordFilename = useWorkspaceUiStore((s) => s.setSelectedRecordFilename);
  const detailFocusFieldName = useWorkspaceUiStore((s) => s.focusedFieldName);
  const setDetailFocusFieldName = useWorkspaceUiStore((s) => s.setFocusedFieldName);

  const viewMode = useViewMode();
  const showGrid = useWorkspaceUiStore((s) => s.showGrid);
  const showRecord = useWorkspaceUiStore((s) => s.showRecord);
  const showField = useWorkspaceUiStore((s) => s.showField);

  const [schema, setSchema] = useState<Record<string, unknown> | null>(null);
  const page = useWorkspaceUiStore((s) => s.page);
  const setPage = useWorkspaceUiStore((s) => s.setPage);
  const [gridSelection, setGridSelection] = useState<GridSelection | undefined>(undefined);
  const [activeEditorDiffKind, setActiveEditorDiffKind] = useState<EditorOverlayDiffKind | null>(null);
  const [editingCell, setEditingCell] = useState<Item | null>(null);
  const [cellPopover, setCellPopover] = useState<CellPopoverState | null>(null);
  const [validationHover, setValidationHover] = useState<ValidationHoverState | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const visibleColumnIds = useWorkspaceUiStore((s) => s.visibleColumnIds);
  const setVisibleColumnIds = useWorkspaceUiStore((s) => s.setVisibleColumnIds);
  const [tableView, setTableView] = useState<TableView | null>(null);
  const tableViewJsonRef = useRef<string | null>(null);
  useEffect(() => {
    tableViewJsonRef.current = tableView ? JSON.stringify(tableView) : null;
  }, [tableView]);
  const [viewSource, setViewSource] = useState<string>('Generated');
  const [availableViewNames, setAvailableViewNames] = useState<string[]>([]);

  // Derive per-cell validation map from diffData — keyed by validationCellKey(filename, fieldPath).
  // This replaces the old async getFolderValidationResults flow; errors now come back with each page.
  const validationByCell = useMemo(() => {
    const map = new Map<string, CellValidationEntry[]>();
    const rowErrors = diffData?.validationByCell;
    if (!rowErrors) return map;
    for (const [filename, errors] of Object.entries(rowErrors)) {
      for (const error of errors) {
        const key = validationCellKey(filename, error.field_path);
        const existing = map.get(key) ?? [];
        existing.push(error);
        map.set(key, existing);
      }
    }
    return map;
  }, [diffData]);

  const [gridSize, setGridSize] = useState<{ width: number; height: number } | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const gridRef = useRef<DataEditorRef | null>(null);
  const wrapperElRef = useRef<HTMLDivElement | null>(null);
  const cellPopoverRef = useRef<HTMLDivElement | null>(null);
  const [hoveredRowIdx, setHoveredRowIdx] = useState<number | null>(null);
  const [inspectButtonRect, setInspectButtonRect] = useState<{ x: number; y: number; height: number } | null>(null);
  const [editPropertyCol, setEditPropertyCol] = useState<TableViewCol | null>(null);
  const [invalidJsonModalOpen, setInvalidJsonModalOpen] = useState(false);
  const [bulkActionConfirm, setBulkActionConfirm] = useState<'approve' | 'reject' | 'discard' | null>(null);
  // Experimental "Unified Diffs" view mode — see UnifiedDiffMode.tsx.
  const [unifiedDiffMode, setUnifiedDiffMode] = useState(false);
  useEffect(() => {
    if (unifiedDiffMode && (diffData?.filterCounts?.unreviewed ?? 0) === 0) {
      setUnifiedDiffMode(false);
    }
  }, [unifiedDiffMode, diffData?.filterCounts?.unreviewed]);
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  const [indexingProgress, setIndexingProgress] = useState<string | null>(null);
  const loadGenerationRef = useRef(0);
  const didMountDataRefreshRef = useRef(false);
  // Tracks the last folder for which the per-folder state reset (page/sort/filters) has been
  // applied. Until the reset effect runs, queryKey uses defaults so the state flush doesn't
  // produce a different queryKey and trigger a second blocking load.
  const lastResetFolderRef = useRef<string | null>(null);
  const hasCurrentQueryDataRef = useRef(false);
  const currentQueryRef = useRef<GridQueryState | null>(null);
  // Refs for the activateGlobalFilter prop — allow effects to read the latest value without dep-array churn.
  const activateGlobalFilterRef = useRef(activateGlobalFilter);
  activateGlobalFilterRef.current = activateGlobalFilter;
  // Tracks which trigger value was last consumed so we don't apply the same activation twice.
  const lastConsumedFilterTriggerRef = useRef(0);
  // Set when a filter activation arrives before data loads; cleared once column narrowing is applied.
  // When a global filter is applied, the column-narrow set must come from the
  // post-filter row set (which can include records not visible on the current
  // page). We defer narrowing until the new data lands by stashing the kind
  // here; the post-load effect picks it up and applies the narrow against the
  // freshly-computed focusColumnIds.
  const pendingColumnNarrowRef = useRef<FilterKind | null>(null);
  const pendingRecordTargetRef = useRef<{ filename: string; trigger: string; triedOffsetLookup: boolean } | null>(null);
  const lastRecordTargetTriggerRef = useRef<string | null>(null);
  const recordOffsetLookupGenerationRef = useRef(0);

  // True when the folder just changed but the per-folder state reset hasn't been applied yet.
  // When pending, use query defaults so the reset's state flush lands on the same queryKey.
  const folderPending = selectedFolderPath !== lastResetFolderRef.current;
  const qPage = folderPending ? 1 : page;
  const qSortColumn = folderPending ? null : sort.column;
  const qSortDirection = folderPending ? null : sort.direction;
  const qActiveFilters = folderPending || activeFilters.length === 0 ? EMPTY_FILTERS : activeFilters;

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
  const hasCurrentQueryError = error !== null && errorQueryKey === queryKey;
  const isBlockingLoad = loadingMode === 'blocking';
  const isRefreshing = loadingMode === 'refreshing';
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

  useEffect(() => {
    if (!isBlockingLoad) {
      setIndexingProgress(null);
      return;
    }
    return window.scratchDesktop.onGridProgress((line) => {
      // Two signals open / update the modal:
      //   1. "[reindex] Reindexing N file(s)..." — the up-front start signal — but only when
      //      N > 1000. Below that the reindex completes within a single batch (faster than the
      //      modal would be useful), so we'd just flash the modal for nothing.
      //   2. Any per-batch progress line containing a "done/total" fraction — keeps the modal
      //      message updating once a long reindex is underway.
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

  // Surface indexing state to the parent so it can block the workspace UI while a full
  // reindex is running (prevents the user from queuing a second parallel reindex by
  // switching folders mid-reindex).
  const onIndexingProgressRef = useRef(props.onIndexingProgress);
  onIndexingProgressRef.current = props.onIndexingProgress;
  useEffect(() => {
    onIndexingProgressRef.current?.(indexingProgress);
  }, [indexingProgress]);

  const validateRef = useRef(validate);
  validateRef.current = validate;

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
        validate: validateRef.current,
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

  // When validation is disabled, clear any active has-problems filter.
  useEffect(() => {
    if (!validate) {
      setActiveFilters((prev) => prev.filter((f) => !(f.scope === 'global' && f.kind === 'has-problems')));
    }
  }, [validate, setActiveFilters]);

  // Load data for query changes and explicit user-triggered reloads.
  useEffect(() => {
    void loadDiffData('blocking', currentQuery);
  }, [currentQuery, loadDiffData, reloadKey]);

  // Keep the current rows painted during passive background refreshes (e.g. app focus).
  // currentQuery and selectedFolderPath are intentionally NOT in the dep array — we read them
  // via refs so this effect only fires when dataRefreshKey changes, never on folder switches or
  // user-initiated query changes. Folder switches are handled by the main load effect above.
  // Without this separation, both effects would fire on every folder switch and the second
  // (refreshing) call would race and cancel the first (blocking) one.
  useEffect(() => {
    if (!didMountDataRefreshRef.current) {
      didMountDataRefreshRef.current = true;
      return;
    }
    const q = currentQueryRef.current;
    if (!q?.selectedFolderPath || !q?.workspacePath) {
      return;
    }
    void loadDiffData('refreshing', q);
  }, [dataRefreshKey, loadDiffData]);

  // Reconcile visibleColumnIds with the focus column set on every data load.
  //
  // - On INITIAL narrow (pendingColumnNarrowRef set, or visibleColumnIds is
  //   null and a global filter is active): replace visibleColumnIds with
  //   the locked title + focus columns for the filter's kind.
  // - On SUBSEQUENT data loads while a global filter is active (e.g. the
  //   user paginated): additively merge any newly-discovered focus columns
  //   into visibleColumnIds so the next page's relevant columns appear.
  //   Existing columns aren't removed — users can still see what they had,
  //   and pages they've already seen keep their focus visible.
  useEffect(() => {
    const pendingKind = pendingColumnNarrowRef.current;
    pendingColumnNarrowRef.current = null;
    const activeKind = activeFiltersRef.current.find((f) => f.scope === 'global')?.kind ?? null;
    const kind = pendingKind ?? activeKind;
    if (!kind) return;

    const ids =
      kind === 'unreviewed'
        ? unreviewedColumnIdsRef.current
        : kind === 'unpublished'
          ? approvedColumnIdsRef.current
          : errorsColumnIdsRef.current;
    const titleId = titleColumnIdRef.current;
    const locked = titleId ? [titleId] : [];

    setVisibleColumnIds((prev) => {
      if (prev === null) {
        // Initial narrow: collapse to locked + focus only.
        return [...locked, ...ids.filter((c) => c !== titleId)];
      }
      // Subsequent reload with the same filter still active: extend with
      // any focus columns we hadn't seen yet (typically appears as the user
      // pages through and new records bring new changed-field columns).
      const existing = new Set(prev);
      const additions = ids.filter((c) => !existing.has(c));
      if (additions.length === 0) return prev;
      return [...prev, ...additions];
    });
  }, [resolvedQueryKey, setVisibleColumnIds]);

  // Reset local-only state when folder changes. Store-managed state (sort, filters, page,
  // columnWidths, visibleColumnIds, selectedRecordFilename, focusedFieldName) is already reset
  // by WorkspacePage's setSelectedFolderPath wrapper (which calls resetFolderState). We still need to:
  // 1. Sync lastResetFolderRef for the folderPending/queryKey mechanism
  // 2. Apply activateGlobalFilter if pending
  // 3. Reset grid-local state (selection, schema, popover, etc.)
  useEffect(() => {
    lastResetFolderRef.current = selectedFolderPath ?? null;
    const pending = activateGlobalFilterRef.current;
    const shouldApply =
      pending !== null && pending !== undefined && pending.trigger > lastConsumedFilterTriggerRef.current;
    if (shouldApply && pending) {
      lastConsumedFilterTriggerRef.current = pending.trigger;
      if (pending.kind === 'has-problems') {
        pendingColumnNarrowRef.current = pending.kind;
      }
      // Override the store's default empty filters with the activated filter
      setActiveFilters([{ scope: 'global', kind: pending.kind }]);
    }
    setHoveredRowIdx(null);
    setInspectButtonRect(null);
    setGridSelection(undefined);
    setActiveEditorDiffKind(null);
    setEditingCell(null);
    setSchema(null);
    setCellPopover(null);
    setReloadKey(0);
    if (shouldApply) {
      onActivateGlobalFilterConsumed?.();
    }
  }, [selectedFolderPath]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!targetRecord || !selectedFolderPath || !workspacePath) {
      return;
    }
    if (targetRecord.trigger === lastRecordTargetTriggerRef.current) {
      return;
    }

    lastRecordTargetTriggerRef.current = targetRecord.trigger;
    pendingRecordTargetRef.current = {
      filename: targetRecord.filename,
      trigger: targetRecord.trigger,
      triedOffsetLookup: false,
    };

    setSort({ column: null, direction: null });
    setActiveFilters([]);
    setSelectedRecordFilename(null);
    setDetailFocusFieldName(null);
    setGridSelection(undefined);
    setCellPopover(null);
    setPage(1);
  }, [
    selectedFolderPath,
    targetRecord,
    workspacePath,
    setSort,
    setActiveFilters,
    setSelectedRecordFilename,
    setDetailFocusFieldName,
    setPage,
  ]);

  // Same-folder case: activate filter when prop changes but folder is already current
  useEffect(() => {
    if (!activateGlobalFilter) return;
    if (activateGlobalFilter.trigger <= lastConsumedFilterTriggerRef.current) return;
    lastConsumedFilterTriggerRef.current = activateGlobalFilter.trigger;
    setActiveFilters((current) => {
      const withoutGlobal = current.filter((f) => f.scope !== 'global');
      return [...withoutGlobal, { scope: 'global', kind: activateGlobalFilter.kind }];
    });
    if (activateGlobalFilter.kind === 'has-problems') {
      const ids = errorsColumnIdsRef.current;
      const locked = titleColumnIdRef.current ? [titleColumnIdRef.current] : [];
      if (ids.length > 0) {
        setVisibleColumnIds([...locked, ...ids.filter((c) => c !== titleColumnIdRef.current)]);
      } else {
        pendingColumnNarrowRef.current = 'has-problems';
      }
    }
    onActivateGlobalFilterConsumed?.();
  }, [activateGlobalFilter, onActivateGlobalFilterConsumed, setActiveFilters, setVisibleColumnIds]);

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
  }, [activeFilters, sort, setPage]);

  // Load schema and view when folder changes
  useEffect(() => {
    if (!selectedFolderPath || !workspacePath) {
      setSchema(null);
      setTableView(null);
      setViewSource('Generated');
      setAvailableViewNames([]);
      return;
    }
    let cancelled = false;
    void window.scratchFiles
      .getFolderMetadata(selectedFolderPath, workspacePath)
      .then((meta) => {
        if (!cancelled) {
          setSchema(meta.schema);
          setAvailableViewNames(meta.availableViewNames ?? []);
          // Use the on-disk "default" view if available; otherwise fall back to the generated view.
          const hasDefaultView = (meta.availableViewNames ?? []).includes('default');
          if (hasDefaultView && meta.view) {
            setTableView(meta.view);
            setViewSource('default');
          } else if (meta.schema) {
            setTableView(createFallbackTableView(meta.schema));
            setViewSource('Generated');
          } else {
            setTableView(null);
            setViewSource('Generated');
          }
        }
      })
      .catch((err) => {
        console.error('Failed to load folder metadata:', err);
        if (!cancelled) {
          setSchema(null);
          setTableView(null);
          setViewSource('Generated');
          setAvailableViewNames([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedFolderPath, workspacePath]);

  // Re-read schema and view from disk when a connection file changes (dev-time hot reload).
  useEffect(() => {
    if (!window.scratchDesktop?.onConnectionFileChanged) return;
    if (!selectedFolderPath || !workspacePath) return;

    const unsubscribe = window.scratchDesktop.onConnectionFileChanged(() => {
      // Reload schema + view metadata from disk.
      void window.scratchFiles
        .getFolderMetadata(selectedFolderPath, workspacePath)
        .then((meta) => {
          setSchema(meta.schema);
          setAvailableViewNames(meta.availableViewNames ?? []);

          if (viewSource === 'Generated') {
            // Regenerate fallback view from the (possibly updated) schema.
            setTableView(meta.schema ? createFallbackTableView(meta.schema) : null);
          } else {
            // Re-read the named view from disk.
            void window.scratchFiles
              .readConnectionView(selectedFolderPath, workspacePath, viewSource)
              .then((view) => {
                if (view) {
                  // Only reset visible columns when the view definition actually changed.
                  // Many CLI commands (accept, reject, etc.) call sync_schema_files_from_worktree
                  // which re-copies the identical view file, triggering this handler even though
                  // the view content hasn't changed. Resetting visibleColumnIds in that case would
                  // blow away the user's active filter-narrowed column set.
                  const changed = JSON.stringify(view) !== tableViewJsonRef.current;
                  setTableView(view);
                  if (changed) {
                    setVisibleColumnIds(null);
                  }
                }
              })
              .catch((err: unknown) => console.debug('Failed to reload view on file change:', err));
          }
        })
        .catch((err: unknown) => console.debug('Failed to reload folder metadata on file change:', err));
    });

    return unsubscribe;
  }, [viewSource, selectedFolderPath, workspacePath, setVisibleColumnIds]);

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

  // Derive detailRowIndex from store's selectedRecordFilename
  const detailRowIndex = useMemo(() => {
    if (!selectedRecordFilename) return null;
    const idx = pagedRows.findIndex((r) => r.__filename === selectedRecordFilename);
    return idx >= 0 ? idx : null;
  }, [selectedRecordFilename, pagedRows]);

  // Helper to set the selected record by row index
  const setDetailRowIndex = useCallback(
    (index: number | null) => {
      if (index === null) {
        setSelectedRecordFilename(null);
        return;
      }
      const row = pagedRows[index] as DiffRow | undefined;
      setSelectedRecordFilename(row?.__filename ?? null);
    },
    [pagedRows, setSelectedRecordFilename],
  );

  useEffect(() => {
    const pending = pendingRecordTargetRef.current;
    if (!pending || !selectedFolderPath || !workspacePath || !hasCurrentQueryData) {
      return;
    }
    if (sort.column || sort.direction || activeFilters.length > 0) {
      return;
    }

    const rowIndex = pagedRows.findIndex((row) => row.__filename === pending.filename);
    if (rowIndex >= 0) {
      pendingRecordTargetRef.current = null;
      showRecord(pending.filename);
      setGridSelection(undefined);
      setCellPopover(null);
      return;
    }

    if (pending.triedOffsetLookup) {
      return;
    }

    pending.triedOffsetLookup = true;
    const lookupGeneration = ++recordOffsetLookupGenerationRef.current;
    void window.scratchFiles.findRecordOffset(selectedFolderPath, workspacePath, pending.filename).then((offset) => {
      if (lookupGeneration !== recordOffsetLookupGenerationRef.current) {
        return;
      }
      if (pendingRecordTargetRef.current?.trigger !== pending.trigger) {
        return;
      }
      if (offset === null) {
        pendingRecordTargetRef.current = null;
        notifications.show({
          title: 'Record not found',
          message: `${pending.filename} was not found in this folder.`,
          color: 'red',
        });
        return;
      }
      setPage(Math.floor(offset / PAGE_SIZE) + 1);
    });
  }, [
    activeFilters.length,
    hasCurrentQueryData,
    pagedRows,
    selectedFolderPath,
    showRecord,
    setPage,
    sort.column,
    sort.direction,
    workspacePath,
  ]);

  const totalPages = Math.max(1, Math.ceil((diffData?.total ?? 0) / PAGE_SIZE));

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages, setPage]);

  /** Flatten view cols (handle banner groups) into a single ordered list. */
  const flatViewCols: TableViewCol[] = useMemo(() => {
    if (!tableView) return [];
    return tableView.cols.flatMap((item) => (item.kind === 'banner-group' ? item.cols : [item]));
  }, [tableView]);

  /** Build a lookup from path → TableViewCol for rendering. */
  const viewColMap = useMemo(() => {
    const map = new Map<string, TableViewCol>();
    for (const col of flatViewCols) map.set(col.path, col);
    return map;
  }, [flatViewCols]);

  /** Map from column path → group name for banner-group columns. */
  const columnGroupMap = useMemo(() => {
    const map = new Map<string, string>();
    if (!tableView) return map;
    for (const item of tableView.cols) {
      if (item.kind === 'banner-group') {
        for (const col of item.cols) {
          map.set(col.path, item.name);
        }
      }
    }
    return map;
  }, [tableView]);

  const hasAnyGroups = columnGroupMap.size > 0;

  /** Column groups for ColumnPickerMenu — derived from banner-group items in the view. */
  const columnGroups = useMemo(() => {
    if (!tableView) return [];
    return tableView.cols
      .filter((item): item is TableViewBannerGroup => item.kind === 'banner-group')
      .map((group) => ({ name: group.name, columnIds: group.cols.map((c) => c.path) }));
  }, [tableView]);

  const titleColumnId = useMemo(() => flatViewCols[0]?.path ?? null, [flatViewCols]);

  /** Set of field paths that are read-only according to the view, for RecordDetailView. */
  const readonlyFields = useMemo(() => {
    const set = new Set<string>();
    for (const col of flatViewCols) {
      if (isColumnReadonly(col)) set.add(col.path);
    }
    return set;
  }, [flatViewCols]);

  const allColumnIds = useMemo(() => flatViewCols.map((c) => c.path), [flatViewCols]);

  const handleSwitchView = useCallback(
    (viewName: string) => {
      if (viewName === 'Generated') {
        if (schema) {
          setTableView(createFallbackTableView(schema));
          setViewSource('Generated');
          setVisibleColumnIds(null);
        }
        return;
      }
      if (!selectedFolderPath || !workspacePath) return;
      void window.scratchFiles
        .readConnectionView(selectedFolderPath, workspacePath, viewName)
        .then((view) => {
          if (view) {
            setTableView(view);
            setViewSource(viewName);
            setVisibleColumnIds(null);
          }
        })
        .catch((err: unknown) => console.debug('Failed to load view:', err));
    },
    [schema, selectedFolderPath, workspacePath, setVisibleColumnIds],
  );

  const effectiveVisibleColumns = useMemo(
    () => visibleColumnIds ?? flatViewCols.filter((c) => !c.hidden).map((c) => c.path),
    [visibleColumnIds, flatViewCols],
  );

  /** Add a new column from the JSON view by its dot-path. */
  const handleAddColumn = useCallback(
    (path: string) => {
      if (!tableView) return;
      if (flatViewCols.some((c) => c.path === path)) return;
      const newCol: TableViewCol = { kind: 'col', path };
      setTableView({ ...tableView, cols: [...tableView.cols, newCol] });
      setVisibleColumnIds((prev) => (prev ? [...prev, path] : [...effectiveVisibleColumns, path]));
    },
    [tableView, flatViewCols, effectiveVisibleColumns, setVisibleColumnIds],
  );

  /** Save handler for the Edit Property dialog. */
  const handleSaveProperty = useCallback(
    (original: TableViewCol, updated: TableViewCol) => {
      if (!tableView) return;
      const updatedCols = tableView.cols.map((item) => {
        if (item.kind === 'banner-group') {
          return { ...item, cols: item.cols.map((col) => (col.path === original.path ? updated : col)) };
        }
        return item.kind === 'col' && item.path === original.path ? updated : item;
      });
      setTableView({ ...tableView, cols: updatedCols });
      if (original.path !== updated.path) {
        setVisibleColumnIds((prev) => {
          if (!prev) return prev;
          return prev.map((id) => (id === original.path ? updated.path : id));
        });
      }
      setEditPropertyCol(null);
    },
    [tableView, setVisibleColumnIds],
  );

  /** Open the Edit Property dialog from the column picker. */
  const handleEditPropertyFromPicker = useCallback(
    (columnId: string) => {
      const vc = viewColMap.get(columnId);
      setEditPropertyCol(vc ?? { kind: 'col', path: columnId });
    },
    [viewColMap],
  );

  /** Toggle visibility of an existing column from the JSON view tooltip. */
  const handleToggleColumnVisible = useCallback(
    (path: string) => {
      const isVisible = effectiveVisibleColumns.includes(path);
      if (isVisible) {
        setVisibleColumnIds(effectiveVisibleColumns.filter((c) => c !== path));
      } else {
        setVisibleColumnIds([...effectiveVisibleColumns, path]);
      }
    },
    [effectiveVisibleColumns, setVisibleColumnIds],
  );

  const allColumnPathsSet = useMemo(() => new Set(flatViewCols.map((c) => c.path)), [flatViewCols]);
  const visibleColumnPathsSet = useMemo(() => new Set(effectiveVisibleColumns), [effectiveVisibleColumns]);

  /** Map from column ID to display label (for column picker, header menu, etc.) */
  const columnLabelsMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const col of flatViewCols) {
      if (col.name) map.set(col.path, col.name);
    }
    return map;
  }, [flatViewCols]);

  /** Map from column ID to resolved property type (for detail view rendering, e.g. checkbox). */
  const columnTypesMap = useMemo(() => {
    const map = new Map<string, TablePropertyType>();
    for (const col of flatViewCols) {
      const t = resolveEffectiveType(col);
      if (t) map.set(col.path, t);
    }
    return map;
  }, [flatViewCols]);

  /** Map from column ID to effective display path, accounting for selected subfields. */
  const columnEffectivePathsMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const col of flatViewCols) {
      const effective = resolveEffectivePath(col.path, col);
      if (effective !== col.path) map.set(col.path, effective);
    }
    return map;
  }, [flatViewCols]);

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
        const viewCol = viewColMap.get(name);
        const displayName = viewCol?.name ?? name;
        const group = columnGroupMap.get(name);
        const isTitle = name === titleColumnId;
        const baseWidth = Math.max(120, Math.min(250, displayName.length * 9 + 40));
        const defaultWidth = isTitle
          ? baseWidth * 2
          : resolveEffectiveType(viewCol) === 'date'
            ? Math.round(baseWidth * 1.3) + 30
            : baseWidth;
        return {
          id: name,
          title: displayName,
          width: columnWidths[name] ?? defaultWidth,
          hasMenu: true,
          menuIcon: GridColumnMenuIcon.Dots,
          ...(group ? { group } : {}),
        };
      });
    return [statusColumn, ...dataCols];
  }, [allColumnIds, columnGroupMap, viewColMap, columnWidths, effectiveVisibleColumns, statusColumn, titleColumnId]);

  /** Column IDs that should be focused for Needs review, across the current non-global query. */
  const unreviewedColumnIds: string[] = useMemo(() => {
    if (!diffData) return [];
    const set = new Set<string>(diffData.focusColumnIds.unreviewed);
    for (const row of diffData.rows) {
      for (const field of row.__changedFields) set.add(field);
    }
    return allColumnIds.filter((c) => set.has(c) || set.has(resolveEffectivePath(c, viewColMap.get(c))));
  }, [allColumnIds, diffData, viewColMap]);

  /** Column IDs that should be focused for Approved, across the current non-global query. */
  const approvedColumnIds: string[] = useMemo(() => {
    if (!diffData) return [];
    const set = new Set<string>(diffData.focusColumnIds.unpublished);
    for (const row of diffData.rows) {
      for (const field of row.__unpublishedFields) set.add(field);
    }
    return allColumnIds.filter((c) => set.has(c) || set.has(resolveEffectivePath(c, viewColMap.get(c))));
  }, [allColumnIds, diffData, viewColMap]);

  /** Column IDs that should be focused for Has errors, across the current non-global query. */
  const errorsColumnIds: string[] = useMemo(() => {
    if (!diffData) return [];
    const errorSet = new Set<string>(diffData.focusColumnIds.errors);
    return allColumnIds.filter((c) => errorSet.has(c) || errorSet.has(resolveEffectivePath(c, viewColMap.get(c))));
  }, [allColumnIds, diffData, viewColMap]);

  // Stable refs for column-narrowing values used inside effects that fire on unrelated deps.
  const errorsColumnIdsRef = useRef(errorsColumnIds);
  errorsColumnIdsRef.current = errorsColumnIds;
  const unreviewedColumnIdsRef = useRef(unreviewedColumnIds);
  unreviewedColumnIdsRef.current = unreviewedColumnIds;
  const approvedColumnIdsRef = useRef(approvedColumnIds);
  approvedColumnIdsRef.current = approvedColumnIds;
  const titleColumnIdRef = useRef(titleColumnId);
  titleColumnIdRef.current = titleColumnId;
  const activeFiltersRef = useRef(activeFilters);
  activeFiltersRef.current = activeFilters;

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

      const { diffKind, fromValue, classification } = getCellDiffState(record, columnId, viewColMap.get(columnId));
      if (diffKind === null) {
        return null;
      }

      const bounds = gridRef.current?.getBounds(col, row);
      if (!bounds) {
        return null;
      }

      const effectivePath = resolveEffectivePath(columnId, viewColMap.get(columnId));
      return {
        col,
        row,
        filename: record.__filename,
        fieldName: effectivePath,
        value: toDisplayString(getByPath(record.__raw, effectivePath)),
        fromValue,
        diffKind,
        classification,
        bounds,
      };
    },
    [viewColMap, columns, pagedRows, titleColumnId],
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
          refreshGridDataInBackground();
          onDataRefresh();
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
    [
      closeGridEditorChrome,
      onDataRefresh,
      refreshGridData,
      refreshGridDataInBackground,
      schema,
      selectedFolderPath,
      workspacePath,
    ],
  );

  const rejectUnreviewedGridCellChange = useCallback(
    (filename: string, fieldName: string) => {
      if (!selectedFolderPath || !workspacePath) {
        return;
      }

      void window.scratchFiles
        .rejectCellChange(selectedFolderPath, workspacePath, filename, fieldName)
        .then(() => {
          closeGridEditorChrome();
          refreshGridDataInBackground();
          onDataRefresh();
        })
        .catch((err: unknown) => {
          console.error('[rejectCellChange] reject failed:', err);
        });
    },
    [closeGridEditorChrome, onDataRefresh, refreshGridDataInBackground, selectedFolderPath, workspacePath],
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
          refreshGridDataInBackground();
          onDataRefresh();
        })
        .catch((err: unknown) => {
          console.error('[undoApprovedCellChange] undo failed:', err);
        });
    },
    [closeGridEditorChrome, onDataRefresh, refreshGridDataInBackground, selectedFolderPath, workspacePath],
  );

  const acceptGridFieldChanges = useCallback(
    (columnId: string, columnTitle: string) => {
      if (!selectedFolderPath || !workspacePath) {
        return;
      }

      closeGridEditorChrome();

      void window.scratchFiles
        .acceptFieldChanges(selectedFolderPath, workspacePath, columnId)
        .then((result) => {
          refreshGridDataInBackground();
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
            message: `Approved ${fileCount.toLocaleString()} file${fileCount === 1 ? '' : 's'} for "${columnTitle}".`,
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
    },
    [closeGridEditorChrome, refreshGridDataInBackground, selectedFolderPath, workspacePath],
  );

  const rejectGridFieldChanges = useCallback(
    (columnId: string, columnTitle: string) => {
      if (!selectedFolderPath || !workspacePath) {
        return;
      }

      closeGridEditorChrome();

      void window.scratchFiles
        .rejectFieldChanges(selectedFolderPath, workspacePath, columnId)
        .then((result) => {
          refreshGridDataInBackground();
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
            message: `Discarded ${fileCount.toLocaleString()} file${fileCount === 1 ? '' : 's'} for "${columnTitle}".`,
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
    },
    [closeGridEditorChrome, refreshGridDataInBackground, selectedFolderPath, workspacePath],
  );

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
          // Reject all: one CLI call, folder-scoped, covers every unreviewed file
          // in the folder — not just the visible page.
          const result = await window.scratchDesktop.rejectAllChanges(workspacePath, relativeFolderPath || undefined);
          if (result.exitCode !== 0) {
            throw new Error(result.stderr.trim() || result.stdout.trim() || 'Failed to reject changes');
          }
          notifications.show({
            color: 'green',
            title: 'All changes rejected',
            message: 'Rejected all pending changes.',
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
    [workspacePath, selectedFolderPath, refreshGridData],
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
      const viewCol = viewColMap.get(colId);
      const isReadOnly = isColumnReadonly(viewCol);
      const rowTheme = { ...(rowBg ? { bgCell: rowBg } : {}), ...(rowTextColor ? { textDark: rowTextColor } : {}) };
      const effectivePath = resolveEffectivePath(colId, viewCol);
      const val = getByPath(r.__raw, effectivePath);
      const { diffKind } = getCellDiffState(r, colId, viewCol);
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

      const colType = resolveEffectiveType(viewCol);
      const kind = inferCellKind(val, colType);
      if (kind === GridCellKind.Boolean) {
        return {
          kind,
          data: typeof val === 'boolean' ? val : undefined,
          readonly: isReadOnly,
          allowOverlay: false as const,
          copyData: toDisplayString(val),
          themeOverride,
        };
      }
      if (kind === GridCellKind.Number) {
        const raw = toDisplayString(val);
        return {
          kind,
          data: val == null ? undefined : Number(val),
          displayData: formatFieldDisplay(raw, colType),
          allowOverlay,
          copyData: raw,
          themeOverride,
        };
      }
      if (kind === GridCellKind.Uri) {
        const display = toDisplayString(val);
        return {
          kind,
          data: display,
          allowOverlay,
          copyData: display,
          themeOverride,
        };
      }
      const raw = toDisplayString(val);
      const display = formatFieldDisplay(raw, colType);
      return {
        kind: GridCellKind.Text as const,
        data: raw,
        displayData: display,
        allowOverlay,
        copyData: raw,
        themeOverride,
      };
    },
    [viewColMap, pagedRows, columns],
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
    [columns, setSort],
  );

  const openHeaderMenu = useCallback(
    (colIndex: number) => {
      if (colIndex === 0) return; // Status column
      const column = columns[colIndex];
      if (!column) {
        return;
      }

      const colId = String(column.id);
      const colTitle = column.title;
      const viewCol = viewColMap.get(colId);
      closeGridEditorChrome();

      const isTitleColumn = colId === titleColumnId;

      const items: Array<{
        id: string;
        label: string;
        type?: 'separator';
        enabled?: boolean;
        submenu?: Array<{ id: string; label: string; checked?: boolean }>;
      }> = [];

      // Hide column (disabled for the title column)
      items.push({ id: 'hide', label: 'Hide column', enabled: !isTitleColumn });

      // Show field submenu (only when subfields exist)
      const subfields = viewCol?.subfields;
      if (subfields && subfields.length > 0) {
        const selectedIdx = viewCol?.selectedSubfield;
        items.push({
          id: 'show-field',
          label: 'Show field',
          submenu: [
            { id: 'subfield:all', label: 'All', checked: selectedIdx === undefined },
            ...subfields.map((sf, idx) => ({
              id: `subfield:${idx}`,
              label: sf.name ?? sf.relativePath,
              checked: selectedIdx === idx,
            })),
          ],
        });
      }

      items.push({ id: 'sep-1', label: '', type: 'separator' });

      // Sort
      items.push({ id: 'sort-asc', label: 'Sort A \u2192 Z' });
      items.push({ id: 'sort-desc', label: 'Sort Z \u2192 A' });

      items.push({ id: 'sep-2', label: '', type: 'separator' });

      // Approve / Reject
      items.push({ id: 'approve', label: 'Approve all' });
      items.push({ id: 'reject', label: 'Reject all' });

      items.push({ id: 'sep-3', label: '', type: 'separator' });

      // Filters
      items.push({ id: 'filter-unreviewed', label: 'Filter to "Needs Review"' });
      items.push({ id: 'filter-approved', label: 'Filter to "Approved"' });

      items.push({ id: 'sep-4', label: '', type: 'separator' });

      // Edit column
      items.push({ id: 'edit-column', label: 'Edit Column\u2026' });

      window.scratchDesktop.showNativeContextMenu(items, (id) => {
        if (id === 'edit-column') {
          const vc = viewColMap.get(colId);
          setEditPropertyCol(vc ?? { kind: 'col', path: colId });
        } else if (id === 'hide') {
          setVisibleColumnIds(effectiveVisibleColumns.filter((c) => c !== colId));
        } else if (id === 'sort-asc') {
          setSort({ column: colId, direction: 'asc' });
        } else if (id === 'sort-desc') {
          setSort({ column: colId, direction: 'desc' });
        } else if (id === 'approve') {
          acceptGridFieldChanges(colId, colTitle);
        } else if (id === 'reject') {
          rejectGridFieldChanges(colId, colTitle);
        } else if (id === 'filter-unreviewed') {
          setActiveFilters((current) => {
            const withoutSameColumn = current.filter(
              (filter) => !(filter.scope === 'column' && filter.columnId === colId),
            );
            return [
              ...withoutSameColumn,
              { scope: 'column', kind: 'unreviewed' as FilterKind, columnId: colId, columnTitle: colTitle },
            ];
          });
        } else if (id === 'filter-approved') {
          setActiveFilters((current) => {
            const withoutSameColumn = current.filter(
              (filter) => !(filter.scope === 'column' && filter.columnId === colId),
            );
            return [
              ...withoutSameColumn,
              { scope: 'column', kind: 'unpublished' as FilterKind, columnId: colId, columnTitle: colTitle },
            ];
          });
        } else if (id === 'subfield:all') {
          if (tableView) {
            const updatedCols = tableView.cols.map((item) => {
              if (item.kind === 'banner-group') {
                return {
                  ...item,
                  cols: item.cols.map((col) => (col.path === colId ? { ...col, selectedSubfield: undefined } : col)),
                };
              }
              return item.path === colId ? { ...item, selectedSubfield: undefined } : item;
            });
            setTableView({ ...tableView, cols: updatedCols });
          }
        } else if (id.startsWith('subfield:')) {
          const index = parseInt(id.slice('subfield:'.length), 10);
          if (tableView && !isNaN(index)) {
            const updatedCols = tableView.cols.map((item) => {
              if (item.kind === 'banner-group') {
                return {
                  ...item,
                  cols: item.cols.map((col) => (col.path === colId ? { ...col, selectedSubfield: index } : col)),
                };
              }
              return item.path === colId ? { ...item, selectedSubfield: index } : item;
            });
            setTableView({ ...tableView, cols: updatedCols });
          }
        }
      });
    },
    [
      acceptGridFieldChanges,
      closeGridEditorChrome,
      columns,
      effectiveVisibleColumns,
      rejectGridFieldChanges,
      setActiveFilters,
      setSort,
      setVisibleColumnIds,
      tableView,
      titleColumnId,
      viewColMap,
    ],
  );

  const onHeaderMenuClick = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    (colIndex: number, _bounds: Rectangle) => {
      openHeaderMenu(colIndex);
    },
    [openHeaderMenu],
  );

  const onHeaderContextMenu = useCallback(
    (colIndex: number, event: HeaderClickedEventArgs) => {
      event.preventDefault();
      openHeaderMenu(colIndex);
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

      const { diffKind, fromValue, classification } = getCellDiffState(row, colId, viewColMap.get(colId));

      // Check for validation entries up-front so we can clip content away from the gutter.
      const validationEntries = validationByCell.get(validationCellKey(row.__filename, colId));
      const hasValidation = validationEntries && validationEntries.length > 0;

      // Clip content to leave room for the validation gutter on the right.
      if (hasValidation) {
        args.ctx.save();
        args.ctx.beginPath();
        args.ctx.rect(args.rect.x, args.rect.y, args.rect.width - VALIDATION_GUTTER_WIDTH, args.rect.height);
        args.ctx.clip();
      }

      // Small / extra-small text fields render the new value with changed words highlighted
      // blue. Boolean / Number cells fall through to glide's default rendering even when
      // their classification is XS — only string text is word-diffable.
      const isWordDiffCandidate =
        diffKind !== null &&
        args.cell.kind === GridCellKind.Text &&
        (classification?.fieldSize === 'XS' || classification?.fieldSize === 'S');
      if (unifiedDiffMode) {
        // Compute the "after" value the same way the cell popover does — via
        // toDisplayString without a propertyType — so date/object fields render
        // consistently with the "before" side and don't leak the cell's pre-formatted
        // (e.g. localized date) displayData into the diff view.
        const viewCol = viewColMap.get(colId);
        const effectivePath = resolveEffectivePath(colId, viewCol);
        const toValue = diffKind === 'unreviewed' ? toDisplayString(getByPath(row.__raw, effectivePath)) : undefined;
        drawUnifiedDiffCell(args, { diffKind, fromValue, toValue, classification });
      } else if (isWordDiffCandidate) {
        const cell = args.cell;
        const toText = 'displayData' in cell && typeof cell.displayData === 'string' ? cell.displayData : '';
        drawWordDiffText(args.ctx, args.rect, args.theme, fromValue, toText);
      } else {
        drawContent();
      }

      // Restore clip before drawing overlays that span the full cell width.
      if (hasValidation) {
        args.ctx.restore();
      }

      if (diffKind !== null) {
        args.ctx.save();
        args.ctx.fillStyle = diffKind === 'unreviewed' ? DIFF_WORKING_BORDER() : DIFF_UNPUBLISHED_BORDER();
        args.ctx.fillRect(args.rect.x, args.rect.y, 3, args.rect.height);
        args.ctx.restore();
      }

      if (hasValidation) {
        const level = validationEntries.some((entry) => entry.level === 'error') ? 'error' : 'warning';
        drawValidationGutter(args.ctx, args.rect, level);
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
    [viewColMap, columns, page, pagedRows, validationByCell, unifiedDiffMode],
  );

  const onCellClicked = useCallback(
    (cell: Item) => {
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
        args.kind === 'cell' && args.localEventX > args.bounds.width - args.bounds.height
          ? buildValidationHoverState(args.location[0], args.location[1])
          : null;
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
      const r = pagedRows[row] as DiffRow | undefined;
      const colId = columns[col]?.id;
      if (!r || !colId) return;
      if (r.__rowStatus === 'deleted' || r.__rowStatus === 'deletedUnpublished' || r.__rowStatus === 'invalidJson')
        return;
      const { diffKind } = getCellDiffState(r, colId, viewColMap.get(colId));
      setActiveEditorDiffKind(diffKind ?? 'none');
      setEditingCell([col, row]);
      if (diffKind === null) {
        setCellPopover(null);
        return;
      }
      setCellPopover(buildCellPopoverState(col, row));
    },
    [buildCellPopoverState, viewColMap, columns, pagedRows],
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

      const fieldPath = resolveEffectivePath(colId, viewColMap.get(colId));
      acceptGridCellChange(r.__filename, fieldPath, editableCellToString(newValue), 'grid overlay save');
    },
    [acceptGridCellChange, columns, pagedRows, viewColMap],
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
    [columns, setColumnWidths],
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
        setActiveFilters([...withoutGlobal, { scope: 'global', kind }]);
        // Defer column narrowing to the post-load effect. The current
        // focusColumnIds were computed from rows visible BEFORE the filter,
        // which is only the current page; records on other pages with focus
        // columns of their own would be missed. After the filter triggers a
        // refetch, the new diffData carries focus columns derived from the
        // full filtered set.
        pendingColumnNarrowRef.current = kind;
      }
    },
    [activeFilters, setActiveFilters, setVisibleColumnIds],
  );

  const handleRemoveFilter = useCallback(
    (filterToRemove: GridFilter) => {
      setActiveFilters((current) => current.filter((filter) => filterKey(filter) !== filterKey(filterToRemove)));
    },
    [setActiveFilters],
  );

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
        <Group
          style={{
            borderBottom: '0.5px solid var(--fg-divider)',
          }}
          p={6}
          align="center"
          justify="space-between"
        >
          <ActionIcon.Group style={{ border: '1px solid var(--fg-divider)', borderRadius: 4 }}>
            <Tooltip label="Grid view" withArrow zIndex={10020}>
              <ActionIcon
                variant="subtle"
                size="md"
                radius={3}
                aria-label="Grid view"
                onClick={() => showGrid()}
                style={
                  viewMode === 'grid'
                    ? { backgroundColor: 'var(--highlight-fill)', outline: '1px solid var(--highlight-border)' }
                    : undefined
                }
              >
                <StyledLucideIcon
                  Icon={Grid3X3Icon}
                  size={16}
                  strokeWidth={1}
                  c={viewMode === 'grid' ? 'var(--highlight-text)' : undefined}
                />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Record view" withArrow zIndex={10020}>
              <ActionIcon
                variant="subtle"
                size="md"
                radius={3}
                aria-label="Record view"
                onClick={() => {
                  const target = selectedRecordFilename ?? pagedRows[0]?.__filename;
                  if (target) showRecord(target);
                }}
                disabled={pagedRows.length === 0}
                style={
                  viewMode === 'record'
                    ? { backgroundColor: 'var(--highlight-fill)', outline: '1px solid var(--highlight-border)' }
                    : undefined
                }
              >
                <StyledLucideIcon
                  Icon={Rows3Icon}
                  size={16}
                  strokeWidth={1}
                  c={viewMode === 'record' ? 'var(--highlight-text)' : undefined}
                />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Field view" withArrow zIndex={10020}>
              <ActionIcon
                variant="subtle"
                size="md"
                radius={3}
                aria-label="Field view"
                onClick={() => {
                  const target = selectedRecordFilename ?? pagedRows[0]?.__filename;
                  if (target) showField(target, detailFocusFieldName ?? effectiveVisibleColumns[0] ?? '');
                }}
                disabled={pagedRows.length === 0}
                style={
                  viewMode === 'field'
                    ? { backgroundColor: 'var(--highlight-fill)', outline: '1px solid var(--highlight-border)' }
                    : undefined
                }
              >
                <StyledLucideIcon
                  Icon={RectangleHorizontalIcon}
                  size={16}
                  strokeWidth={1}
                  c={viewMode === 'field' ? 'var(--highlight-text)' : undefined}
                />
              </ActionIcon>
            </Tooltip>
          </ActionIcon.Group>

          <Divider orientation="vertical" />

          <Group gap="xs">
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
            {validate && (
              <FilterPill
                label="Problems"
                count={filterCounts?.errors ?? 0}
                active={hasGlobalFilter('has-problems')}
                bulletColor="var(--mantine-color-red-6)"
                disabled={disableGlobalFilterPills || (filterCounts?.errors ?? 0) === 0}
                onClick={() => handleGlobalFilterToggle('has-problems')}
              />
            )}
          </Group>
          {validate && (diffData?.totalProblemsStaleCount ?? 0) > 0 && (
            <Text12Regular c="var(--fg-muted)">
              {diffData!.totalProblemsStaleCount} record{diffData!.totalProblemsStaleCount === 1 ? '' : 's'} need
              validation
            </Text12Regular>
          )}
          {activeColumnFilters.map((filter) => (
            <ActiveFilterChip
              key={filterKey(filter)}
              label={filterLabel(filter)}
              onRemove={() => handleRemoveFilter(filter)}
            />
          ))}

          <Box flex={1} />

          {(filterCounts?.unreviewed ?? 0) > 0 && detailRowIndex === null && (
            <>
              <Divider orientation="vertical" />
              <Group gap="xs">
                <UnstyledButton onClick={() => handleGlobalFilterToggle('unreviewed')} style={{ whiteSpace: 'nowrap' }}>
                  <Text12Regular c="var(--fg-link)" style={{ textDecoration: 'underline' }}>
                    {filterCounts!.unreviewed} record{filterCounts!.unreviewed === 1 ? '' : 's'} need
                    {filterCounts!.unreviewed === 1 ? 's' : ''} review
                  </Text12Regular>
                </UnstyledButton>
                <ButtonSecondaryGhost size="compact-xs" c="green.8" onClick={() => setBulkActionConfirm('approve')}>
                  {filterCounts!.unreviewed === 1 ? 'Approve' : 'Approve all'}
                </ButtonSecondaryGhost>
                <ButtonSecondaryGhost size="compact-xs" c="red.8" onClick={() => setBulkActionConfirm('reject')}>
                  {filterCounts!.unreviewed === 1 ? 'Reject' : 'Reject all'}
                </ButtonSecondaryGhost>
              </Group>
            </>
          )}
          <Divider orientation="vertical" />
          <Popover>
            <Popover.Target>
              <ButtonSecondaryGhost size="compact-xs" leftSection={<Columns3 size={16} />}>
                Columns
                {visibleColumnIds && visibleColumnIds.length < allColumnIds.length
                  ? ` (${visibleColumnIds.length.toLocaleString()})`
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
                columnGroups={columnGroups}
                onChangeVisible={setVisibleColumnIds}
                activeViewName={viewSource}
                availableViewNames={availableViewNames}
                onSwitchView={handleSwitchView}
                onEditProperty={handleEditPropertyFromPicker}
              />
            </Popover.Dropdown>
          </Popover>
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon size="sm" variant="subtle" color="gray">
                <EllipsisVertical size={14} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<GitCompare size={14} />}
                onClick={() => setUnifiedDiffMode((v) => !v)}
                disabled={(filterCounts?.unreviewed ?? 0) === 0}
                rightSection={unifiedDiffMode ? <Check size={14} /> : undefined}
              >
                Unified diffs
              </Menu.Item>
              <Menu.Item
                leftSection={<RotateCcw size={14} />}
                onClick={() => {
                  void trackRefreshFolderDataGrid(workspaceId, selectedFolderPath);
                  onDataRefresh();
                }}
                disabled={loadingMode === 'blocking'}
              >
                Refresh
              </Menu.Item>
              {(filterCounts?.unreviewed ?? 0) + (filterCounts?.unpublished ?? 0) > 0 && detailRowIndex === null && (
                <>
                  <Menu.Divider />
                  <Menu.Item c="red" leftSection={<Trash2 size={14} />} onClick={() => setBulkActionConfirm('discard')}>
                    Discard all unpublished changes
                  </Menu.Item>
                </>
              )}
            </Menu.Dropdown>
          </Menu>
        </Group>
      )}

      {!selectedFolderPath && (
        <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Text13Regular c="dimmed">Select a folder to view data</Text13Regular>
        </Box>
      )}

      {selectedFolderPath && showBlockingLoader && (
        <Box
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          <Loader size="sm" />
          {indexingProgress && (
            <Text13Regular c="dimmed" style={{ fontFamily: 'monospace', fontSize: 11 }}>
              {indexingProgress}
            </Text13Regular>
          )}
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
                groupHeaderHeight={hasAnyGroups ? 28 : 0}
                rowMarkers="none"
                freezeColumns={titleColumnId && columns[1]?.id === titleColumnId ? 2 : 1}
                rowHeight={unifiedDiffMode ? UNIFIED_DIFF_ROW_HEIGHT : 34}
              />
            )}
            {inspectButtonRect && hoveredRowIdx !== null && (
              <UnstyledButton
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.currentTarget.blur();
                  if (hoveredRowIdx !== null) {
                    const filename = pagedRows[hoveredRowIdx]?.__filename;
                    if (filename) showRecord(filename);
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
                readonlyFields={readonlyFields}
                columnTypes={columnTypesMap}
                onSelectIndex={(nextIndex) => {
                  setDetailRowIndex(nextIndex);
                }}
                onClose={() => {
                  showGrid();
                  // Drop the cell selection so the rebuild effect can't restore the popover
                  // when returning to the grid — require a fresh click.
                  setGridSelection(undefined);
                }}
                dataRefreshKey={dataRefreshKey}
                onRecordChanged={() => {
                  refreshGridDataInBackground();
                  onDataRefresh();
                }}
                onRecordFieldChanged={(filename, fieldName, nextValue) => {
                  setDiffData((prev) => (prev ? applyAcceptedCellChange(prev, filename, fieldName, nextValue) : prev));
                  onDataRefresh();
                }}
                onPublishFile={props.onPublishFile}
                onAddColumn={handleAddColumn}
                onToggleColumnVisible={handleToggleColumnVisible}
                allColumnPaths={allColumnPathsSet}
                visibleColumnPaths={visibleColumnPathsSet}
                columnEffectivePaths={columnEffectivePathsMap}
                columnGroups={columnGroupMap}
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
              {(diffData?.total ?? 0).toLocaleString()} rows &middot; {columns.length.toLocaleString()} columns
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
                  <Text12Regular c="var(--fg-muted)">
                    {(filterCounts?.unreviewed ?? 0).toLocaleString()} needs review
                  </Text12Regular>
                </Group>
              )}
              {hasChanges && (
                <Group gap={10}>
                  {summary.addedApproved > 0 && (
                    <Group gap={3}>
                      <Plus size={12} color="var(--create-approved-stroke)" />
                      <Text12Regular c="var(--fg-muted)">{summary.addedApproved.toLocaleString()} added</Text12Regular>
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
                      <Text12Regular c="var(--fg-muted)">{summary.unpublished.toLocaleString()} modified</Text12Regular>
                    </Group>
                  )}
                  {summary.deletedApproved > 0 && (
                    <Group gap={3}>
                      <Minus size={12} color="var(--delete-approved-stroke)" />
                      <Text12Regular c="var(--fg-muted)">
                        {summary.deletedApproved.toLocaleString()} deleted
                      </Text12Regular>
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
                          {summary.invalidJson.toLocaleString()} invalid files
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
                </Group>
              )}
            </Group>
          </Box>
        </>
      )}

      <EditPropertyDialog
        opened={editPropertyCol !== null}
        col={editPropertyCol}
        schema={schema}
        onSave={handleSaveProperty}
        onClose={() => setEditPropertyCol(null)}
      />

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
                Discard {((filterCounts?.unreviewed ?? 0) + (filterCounts?.unpublished ?? 0)).toLocaleString()}{' '}
                {(filterCounts?.unreviewed ?? 0) + (filterCounts?.unpublished ?? 0) === 1 ? 'change' : 'changes'} in{' '}
                {selectedFolderPath?.split('/').filter(Boolean).pop() ?? 'this folder'}?
              </>
            ) : (
              <>
                {bulkActionConfirm === 'approve' ? 'Approve' : 'Reject'}{' '}
                {(filterCounts?.unreviewed ?? 0).toLocaleString()} pending{' '}
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
              {(filterCounts?.unreviewed ?? 0).toLocaleString()} pending +{' '}
              {(filterCounts?.unpublished ?? 0).toLocaleString()} approved ={' '}
              {((filterCounts?.unreviewed ?? 0) + (filterCounts?.unpublished ?? 0)).toLocaleString()} changes will be
              discarded.
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
          const centeredLeft = validationHover.bounds.x + validationHover.bounds.width / 2 - tooltipWidth / 2;
          const left = Math.max(12, Math.min(centeredLeft, window.innerWidth - tooltipWidth - 12));
          const belowTop = validationHover.bounds.y + validationHover.bounds.height;
          const estimatedHeight = Math.min(260, 54 + validationHover.entries.length * 42);
          const top =
            belowTop + estimatedHeight < window.innerHeight - 12
              ? belowTop
              : Math.max(12, validationHover.bounds.y - estimatedHeight);

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
                  backgroundColor: 'var(--bg-base)',
                  border: '1px solid var(--fg-divider)',
                  borderRadius: 0,
                  boxShadow: 'none',
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
                          const filename = pagedRows[cellPopover.row]?.__filename;
                          if (filename) showRecord(filename);
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
            undoAction = () => rejectUnreviewedGridCellChange(filename, fieldName);
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
                            const fn = pagedRows[cellPopover.row]?.__filename;
                            if (fn) showField(fn, fieldName);
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
