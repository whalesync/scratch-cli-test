import DataEditor, {
  GridCellKind,
  type DataEditorRef,
  type DrawCellCallback,
  type DrawHeaderCallback,
  type EditableGridCell,
  type GridColumn,
  type GridSelection,
  type Item,
} from '@glideapps/glide-data-grid';
import '@glideapps/glide-data-grid/dist/index.css';
import { Box } from '@mantine/core';
import type { TableView } from '@spinner/shared-types';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { getByPath, resolveDisplayString } from '../../../../../shared/schema-columns';
import { useWorkspaceUiStore } from '../../../stores/workspace-ui-store';
import type { DiffGridResult, DiffRow } from '../diff-grid-types';
import { formatFieldDisplay } from '../field-formatters';
import {
  editableCellToString,
  formatReferenceDisplay,
  getCellDiffState,
  inferCellKind,
  isCellReadonly,
  resolveEffectivePath,
  resolveEffectiveType,
} from '../grid-cell-diff-state';
import { toDisplayString } from '../record-diff-helpers';
import {
  buildReviewTableColumns,
  GRID_THEME,
  MAX_RESIZABLE_COLUMN_WIDTH,
  STATUS_COL_ID,
} from './build-review-table-columns';
import {
  drawStatusCheck,
  drawStatusDot,
  drawValidationWarningIcon,
  drawWordDiffText,
  getCssVar,
  getStatusCellStroke,
  getStatusCellTint,
  getStatusDotVar,
  isFullyApprovedRowStatus,
  wordDiffCacheKey,
  type ValidationLevel,
} from './review-table-cell-drawing';

/**
 * A small, purpose-built canvas grid for the v2 review surface — a sibling to `FolderDataGrid`,
 * never a fork of it. It renders the SAME rows through the SHARED diff-state modules but with its
 * own draw code: inline `del → ins` diffs at every field size, solid change-type cell fills, a
 * status column (change-type dot + validation-warning icon), and diff-aware column widths.
 *
 * It is deliberately CONTROLLED and ships dark (unmounted until the Phase 7 cutover): the host
 * passes `diffData` + edit/drawer callbacks and owns data fetching, paging, filters, the
 * optimistic apply, and the review-ladder IPC. This grid reads only the shared `sort`/
 * `columnWidths` store slices (so widths stay consistent with the v1 grid) and emits intents.
 */

// A single click on a changed row opens the changes drawer, but only after this delay so a
// double-click (which edits the cell) can cancel it first — see onCellClicked / onCellActivated.
const RECORD_CHANGES_DRAWER_CLICK_DELAY_MS = 250;

// Status-column indicator layout: a change-type dot (or a check for a fully-approved row), then
// (optionally) a validation-warning icon.
const STATUS_INDICATOR_LEFT_PAD = 8;
const STATUS_DOT_RADIUS = 4;
const STATUS_CHECK_SIZE = 12;
const STATUS_INDICATOR_GAP = 6;
const STATUS_WARNING_ICON_SIZE = 14;

export interface ReviewTableGridProps {
  diffData: DiffGridResult;
  tableView: TableView | null;
  schema: Record<string, unknown> | null;
  /** The columns to render, narrowed by the picker / "just changed" default; null = all non-hidden. */
  visibleColumnIds: string[] | null;
  /** Open the record-changes drawer for a row (deferred so a double-click edits instead). */
  onOpenRecordDrawer: (filename: string) => void;
  /** A committed cell edit. The host coerces the raw input text and applies it optimistically. */
  onCellEdited: (filename: string, fieldPath: string, inputText: string) => void;
}

export function ReviewTableGrid({
  diffData,
  tableView,
  visibleColumnIds,
  onOpenRecordDrawer,
  onCellEdited,
}: ReviewTableGridProps): ReactElement {
  const sort = useWorkspaceUiStore((s) => s.sort);
  const setSort = useWorkspaceUiStore((s) => s.setSort);
  const columnWidths = useWorkspaceUiStore((s) => s.columnWidths);
  const setColumnWidths = useWorkspaceUiStore((s) => s.setColumnWidths);

  const gridRef = useRef<DataEditorRef | null>(null);
  const wrapperElRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const [gridSize, setGridSize] = useState<{ width: number; height: number } | null>(null);
  const [gridSelection, setGridSelection] = useState<GridSelection | undefined>(undefined);
  const recordChangesDrawerOpenTimerRef = useRef<number | null>(null);

  const rows = diffData.rows;
  const referenceLabels = diffData.referenceLabels;

  const { columns, viewColMap, titleColumnId } = useMemo(
    () => buildReviewTableColumns(tableView, diffData, columnWidths, visibleColumnIds),
    [tableView, diffData, columnWidths, visibleColumnIds],
  );

  // The validation level per record. `validationByCell` arrives keyed by filename (each value is
  // that record's full error list); a record with any error-level entry is an error, otherwise a
  // warning. Drives the status-column warning icon, which is independent of the change-type dot.
  const recordValidationLevelByFilename = useMemo(() => {
    const levelByFilename = new Map<string, ValidationLevel>();
    for (const [filename, entries] of Object.entries(diffData.validationByCell)) {
      if (!entries || entries.length === 0) continue;
      levelByFilename.set(filename, entries.some((entry) => entry.level === 'error') ? 'error' : 'warning');
    }
    return levelByFilename;
  }, [diffData.validationByCell]);

  // Self-measure so the grid drops into any layout (and so fullscreen Storybook stories work).
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

  const clearRecordChangesDrawerOpenTimer = useCallback(() => {
    if (recordChangesDrawerOpenTimerRef.current != null) {
      clearTimeout(recordChangesDrawerOpenTimerRef.current);
      recordChangesDrawerOpenTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (recordChangesDrawerOpenTimerRef.current != null) {
        clearTimeout(recordChangesDrawerOpenTimerRef.current);
      }
    };
  }, []);

  const getCellContent = useCallback(
    ([col, row]: Item) => {
      const r = rows[row] as DiffRow | undefined;

      // Status column — empty, non-editable cell (the dot + warning icon are drawn in drawCell).
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
      // Created/deleted/invalid rows get a solid change-type fill on every cell; modified rows are
      // filled per changed cell via diffTheme below (unchanged cells stay clear).
      const rowBg = getStatusCellTint(status);
      // Deleted rows: keep the title/id column at full strength so the record stays identifiable,
      // but fade every other cell's text so the eye reads "gone" (on top of the strikethrough).
      const isDeletedRow = status === 'deleted' || status === 'deletedUnpublished';
      const rowTextColor =
        isDeletedRow && colId !== titleColumnId ? getCssVar('--fg-muted') : getStatusCellStroke(status);
      const viewCol = viewColMap.get(colId);
      const isReadOnly = isCellReadonly(viewCol, r);
      const rowTheme = { ...(rowBg ? { bgCell: rowBg } : {}), ...(rowTextColor ? { textDark: rowTextColor } : {}) };
      const effectivePath = resolveEffectivePath(colId, viewCol);
      const val = getByPath(r.__raw, effectivePath);
      const { diffKind } = getCellDiffState(r, colId, viewCol);
      const diffTheme =
        diffKind === 'unreviewed'
          ? { bgCell: getCssVar('--modified-needs-review-bg'), textDark: getCssVar('--modified-needs-review-stroke') }
          : diffKind === 'unpublished'
            ? { bgCell: getCssVar('--modified-approved-bg') }
            : {};
      const readOnlyTheme = isReadOnly ? { textDark: getCssVar('--fg-muted') } : {};
      const themeOverride = { ...rowTheme, ...diffTheme, ...readOnlyTheme };
      const allowOverlay =
        !isReadOnly && status !== 'deleted' && status !== 'deletedUnpublished' && status !== 'invalidJson';

      // Foreign-key (reference) cell: show the linked record's name(s) when resolved (DEV-10530);
      // the raw id stays in data/copyData so editing, copy, and publish use the verbatim value.
      const referenceLabelsForCol = referenceLabels?.[colId];
      if (referenceLabelsForCol) {
        const raw = toDisplayString(val);
        return {
          kind: GridCellKind.Text as const,
          data: raw,
          displayData: formatReferenceDisplay(val, referenceLabelsForCol),
          allowOverlay,
          copyData: raw,
          themeOverride,
        };
      }

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
        return { kind, data: display, allowOverlay, copyData: display, themeOverride };
      }
      const raw = toDisplayString(val);
      // A column may carry a declarative displayTransformer (server-set, e.g. flatten a Notion
      // rich-text array to plain_text). resolveDisplayString runs it through the generic
      // fail-closed applier; data/copyData stay the raw value.
      const display = viewCol?.displayTransformer
        ? resolveDisplayString(val, viewCol)
        : formatFieldDisplay(raw, colType);
      return {
        kind: GridCellKind.Text as const,
        data: raw,
        displayData: display,
        allowOverlay,
        copyData: raw,
        themeOverride,
      };
    },
    [rows, columns, viewColMap, referenceLabels, titleColumnId],
  );

  const drawCell: DrawCellCallback = useCallback(
    (args, drawContent) => {
      const row = rows[args.row] as DiffRow | undefined;

      // Status column — a change-type dot and, independently, a validation-warning icon so a
      // record can show its update type and its invalid state at the same time.
      if (args.col === 0) {
        drawContent();
        if (!row) return;
        const { ctx, rect } = args;
        const centerY = rect.y + rect.height / 2;
        let x = rect.x + STATUS_INDICATOR_LEFT_PAD;
        if (isFullyApprovedRowStatus(row.__rowStatus)) {
          // Fully approved: a gray check marks the whole row as approved, in place of the change-type dot.
          drawStatusCheck(ctx, x, centerY - STATUS_CHECK_SIZE / 2, STATUS_CHECK_SIZE, getCssVar('--fg-muted'));
          x += STATUS_CHECK_SIZE + STATUS_INDICATOR_GAP;
        } else {
          const dotVar = getStatusDotVar(row.__rowStatus);
          if (dotVar) {
            drawStatusDot(ctx, x + STATUS_DOT_RADIUS, centerY, STATUS_DOT_RADIUS, getCssVar(dotVar));
            x += STATUS_DOT_RADIUS * 2 + STATUS_INDICATOR_GAP;
          }
        }
        // A record fails validation when any of its cells carry a problem; an unparseable record
        // (invalidJson) is always an error.
        const validationLevel =
          recordValidationLevelByFilename.get(row.__filename) ??
          (row.__rowStatus === 'invalidJson' ? 'error' : undefined);
        if (validationLevel) {
          drawValidationWarningIcon(
            ctx,
            x,
            centerY - STATUS_WARNING_ICON_SIZE / 2,
            STATUS_WARNING_ICON_SIZE,
            validationLevel,
          );
        }
        return;
      }

      const colId = columns[args.col]?.id;
      if (!row || !colId) {
        drawContent();
        return;
      }

      const viewCol = viewColMap.get(colId);
      const { diffKind, fromValue, classification } = getCellDiffState(row, colId, viewCol);

      // Inline del→ins for every modified textual cell at any field size. Booleans keep their
      // checkbox; created/deleted rows (diffKind === null) fall through to the plain value (with
      // the deleted-row strikethrough applied below).
      const isInlineDiffCell =
        diffKind !== null &&
        (args.cell.kind === GridCellKind.Text ||
          args.cell.kind === GridCellKind.Number ||
          args.cell.kind === GridCellKind.Uri);
      if (isInlineDiffCell) {
        const effectivePath = resolveEffectivePath(colId, viewCol);
        // Recompute the "after" value the same way as the "before" so date/object formatting
        // matches fromValue (don't diff formatted vs raw).
        const toValue = toDisplayString(getByPath(row.__raw, effectivePath));
        // XS scalars (numbers, dates) and non-text cells show whole old → whole new; real text
        // (S/M/L) uses a word-level inline diff.
        const fieldSize = classification?.fieldSize;
        const wholeValue = fieldSize === 'XS' || args.cell.kind !== GridCellKind.Text;
        // Long-form (M/L) text is windowed around the change so a deep edit is visible instead of the
        // unchanged prefix (DEV-10687); short (S) text already fits, so it draws from the start.
        const windowAroundChange = !wholeValue && (fieldSize === 'M' || fieldSize === 'L');
        drawWordDiffText(args.ctx, args.rect, args.theme, fromValue, toValue, {
          showRemoved: true,
          wholeValue,
          windowAroundChange,
          cacheKey: wordDiffCacheKey(row.__filename, colId, fromValue, toValue),
        });
      } else {
        drawContent();
      }

      // Strikethrough for deleted rows.
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
    [rows, columns, viewColMap, recordValidationLevelByFilename],
  );

  // Draw a sort-direction caret (↑/↓) in the sorted column's header, right-aligned — the review
  // surface's equivalent of FolderDataGrid's sort indicator, now on the column heading itself.
  const drawHeader: DrawHeaderCallback = useCallback(
    (args, drawContent) => {
      drawContent();
      const colId = columns[args.columnIndex]?.id;
      if (!colId || sort.column !== colId || !sort.direction) return true;
      const { ctx, rect, theme } = args;
      const pad = theme.cellHorizontalPadding ?? 8;
      ctx.save();
      ctx.fillStyle = theme.textHeader;
      ctx.font = `${theme.headerFontStyle} ${theme.fontFamily}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(sort.direction === 'desc' ? '↓' : '↑', rect.x + rect.width - pad, rect.y + rect.height / 2);
      ctx.restore();
      return true;
    },
    [columns, sort],
  );

  const onHeaderClicked = useCallback(
    (colIndex: number) => {
      // The dark grid only records the sort intent in the shared store; the host re-derives the
      // sorted rows and re-queries. It never reorders diffData.rows locally.
      if (colIndex === 0) {
        setSort((prev) =>
          prev.column === STATUS_COL_ID && prev.direction === 'asc'
            ? { column: STATUS_COL_ID, direction: 'desc' }
            : { column: STATUS_COL_ID, direction: 'asc' },
        );
        return;
      }
      const colId = columns[colIndex]?.id;
      if (!colId) return;
      setSort((prev) =>
        prev.column === colId && prev.direction === 'asc'
          ? { column: colId, direction: 'desc' }
          : { column: colId, direction: 'asc' },
      );
    },
    [columns, setSort],
  );

  const onColumnResize = useCallback(
    (column: GridColumn, newSize: number, colIndex: number) => {
      if (colIndex === 0) return; // Status column is not resizable.
      const columnId = columns[colIndex]?.id ?? column.id;
      if (columnId === undefined) return;
      setColumnWidths((current) => ({ ...current, [String(columnId)]: newSize }));
    },
    [columns, setColumnWidths],
  );

  const onCellClicked = useCallback(
    (cell: Item) => {
      // Open the record drawer on a single click of any row — changed records open on their changes,
      // no-change records in All-fields mode (the host decides). Deferred briefly and cancelled by
      // onCellActivated so a double-click edits the cell instead.
      clearRecordChangesDrawerOpenTimer();
      const clickedRow = rows[cell[1]] as DiffRow | undefined;
      if (!clickedRow) return;
      const filename = clickedRow.__filename;
      recordChangesDrawerOpenTimerRef.current = window.setTimeout(() => {
        recordChangesDrawerOpenTimerRef.current = null;
        onOpenRecordDrawer(filename);
      }, RECORD_CHANGES_DRAWER_CLICK_DELAY_MS);
    },
    [rows, clearRecordChangesDrawerOpenTimer, onOpenRecordDrawer],
  );

  const onCellActivated = useCallback(() => {
    // A double-click edits the cell — cancel the pending single-click drawer open.
    clearRecordChangesDrawerOpenTimer();
  }, [clearRecordChangesDrawerOpenTimer]);

  const handleCellEdited = useCallback(
    ([col, row]: Item, newValue: EditableGridCell) => {
      if (col === 0) return; // Status column.
      const r = rows[row] as DiffRow | undefined;
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
      const viewCol = viewColMap.get(colId);
      // Defense-in-depth: allowOverlay already blocks the editor, but a paste/fill could target
      // a readonly / locked write-once cell.
      if (isCellReadonly(viewCol, r)) return;
      const fieldPath = resolveEffectivePath(colId, viewCol);
      onCellEdited(r.__filename, fieldPath, editableCellToString(newValue));
    },
    [rows, columns, viewColMap, onCellEdited],
  );

  return (
    <Box ref={wrapperRef} style={{ flex: 1, position: 'relative', minHeight: 0 }}>
      {gridSize && (
        <DataEditor
          ref={gridRef}
          theme={GRID_THEME}
          columns={columns}
          rows={rows.length}
          getCellContent={getCellContent}
          drawCell={drawCell}
          drawHeader={drawHeader}
          width={gridSize.width}
          height={gridSize.height}
          smoothScrollX
          smoothScrollY
          gridSelection={gridSelection}
          onGridSelectionChange={(sel) => {
            // Never let the status column be selected via a header click.
            if (sel.columns.hasIndex(0)) {
              setGridSelection({ ...sel, columns: sel.columns.remove(0) });
            } else {
              setGridSelection(sel);
            }
          }}
          onHeaderClicked={onHeaderClicked}
          onCellClicked={onCellClicked}
          onCellActivated={onCellActivated}
          onCellEdited={handleCellEdited}
          onColumnResize={onColumnResize}
          cellActivationBehavior="double-click"
          maxColumnWidth={MAX_RESIZABLE_COLUMN_WIDTH}
          verticalBorder={(col) => col !== 0}
          rowMarkers="none"
          rowHeight={34}
          freezeColumns={titleColumnId && columns[1]?.id === titleColumnId ? 2 : 1}
        />
      )}
    </Box>
  );
}
