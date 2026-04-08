import DataEditor, {
  GridCellKind,
  type CellClickedEventArgs,
  type CustomCell,
  type CustomRenderer,
  type DrawCellCallback,
  type GridColumn,
  type Item,
} from '@glideapps/glide-data-grid';
import '@glideapps/glide-data-grid/dist/index.css';
import { Box, Group, Loader, Modal, Stack } from '@mantine/core';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Text12Medium, Text12Regular, Text13Regular } from '../../components/base/text';
import { FieldValuePanel, type FieldValueDiffKind } from './FieldValuePanel';
import { RecordDetailView } from './RecordDetailView';

// ── Types ──

type RowStatus = 'added' | 'modified' | 'unpublished' | 'deleted' | 'unchanged';

interface DiffRow extends Record<string, unknown> {
  __rowStatus: RowStatus;
  __changedFields: string[];
  __fromFields: Record<string, unknown>;
  __unpublishedFields: string[];
  __masterFields: Record<string, unknown>;
  __filename: string;
}

interface DiffGridResult {
  rows: DiffRow[];
  columns: string[];
  total: number;
  summary: { total: number; added: number; modified: number; unpublished: number; deleted: number };
}

type FilterStatus = 'unreviewed' | 'unpublished';

interface FolderDataGridProps {
  /** Included so memo() invalidates when switching workbooks even if folder path + local path match. */
  workspaceId: string;
  selectedFolderPath: string | null;
  workspacePath: string | null;
  dataRefreshKey: number;
}

// ── Constants ──

const PAGE_SIZE = 100;

// ── Diff colours ──

const DIFF_WORKING_BG = '#dbeafe'; // blue-100  — unreviewed (w != d)
const DIFF_WORKING_BORDER = '#60a5fa'; // blue-400
const DIFF_UNPUBLISHED_BG = '#eff6ff'; // blue-50   — unpublished (d != m, w == d)
const DIFF_UNPUBLISHED_BORDER = '#93c5fd'; // blue-300

// ── Helpers ──

function toDisplayString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function rowHasUnreviewedChanges(row: DiffRow): boolean {
  return row.__rowStatus === 'added' || row.__rowStatus === 'deleted' || row.__changedFields.length > 0;
}

function rowHasUnpublishedChanges(row: DiffRow): boolean {
  return row.__unpublishedFields.length > 0;
}

function inferCellKind(value: unknown): GridCellKind {
  if (typeof value === 'boolean') return GridCellKind.Boolean;
  if (typeof value === 'number') return GridCellKind.Number;
  return GridCellKind.Text;
}

function drawInspectIcon(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
  opacity = 1,
) {
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.fillStyle = color;
  ctx.font = `${size}px sans-serif`;
  ctx.textBaseline = 'top';
  ctx.fillText('\u{1F50D}', x, y);
  ctx.restore();
}

// ── Custom cell: status dot on first data column ──

interface StatusDotCellData {
  kind: 'status-dot-cell';
  displayText: string;
}

type StatusDotCell = CustomCell<StatusDotCellData>;

const statusDotRenderer: CustomRenderer<StatusDotCell> = {
  kind: GridCellKind.Custom,
  needsHover: true,
  isMatch: (c): c is StatusDotCell =>
    typeof c.data === 'object' && c.data !== null && (c.data as StatusDotCellData).kind === 'status-dot-cell',
  draw: ({ ctx, rect, cell, theme, hoverAmount }) => {
    const { x, y, width, height } = rect;
    const { displayText } = cell.data;
    const PADDING = 8;
    const iconSize = 12;
    const iconPad = 6;
    const hoverReserve = hoverAmount > 0 ? iconSize + iconPad : 0;
    const textMaxWidth = width - PADDING * 2 - hoverReserve;

    ctx.save();
    ctx.font = `${theme.baseFontStyle} ${theme.fontFamily}`;
    ctx.fillStyle = theme.textDark;
    ctx.textBaseline = 'middle';
    ctx.beginPath();
    ctx.rect(x + PADDING, y, textMaxWidth, height);
    ctx.clip();
    ctx.fillText(displayText, x + PADDING, y + height / 2);
    ctx.restore();

    if (hoverAmount > 0) {
      drawInspectIcon(
        ctx,
        x + width - iconSize - iconPad,
        y + (height - iconSize) / 2,
        iconSize,
        theme.textMedium ?? '#888',
        hoverAmount,
      );
    }

    return true;
  },
};

// ── Custom cell: changed field (blue bg + left border, current value only) ──

interface DiffCellData {
  kind: 'diff-cell';
  displayText: string;
  diffKind: 'unreviewed' | 'unpublished';
  isIdCol?: boolean;
}

type DiffCell = CustomCell<DiffCellData>;

const diffCellRenderer: CustomRenderer<DiffCell> = {
  kind: GridCellKind.Custom,
  needsHover: true,
  isMatch: (c): c is DiffCell =>
    typeof c.data === 'object' && c.data !== null && (c.data as DiffCellData).kind === 'diff-cell',
  draw: ({ ctx, rect, cell, theme, hoverAmount }) => {
    const { x, y, width, height } = rect;
    const { displayText, diffKind, isIdCol } = cell.data;
    const border = diffKind === 'unreviewed' ? DIFF_WORKING_BORDER : DIFF_UNPUBLISHED_BORDER;
    const BORDER_W = 3;
    const PADDING = 8;
    const iconSize = 12;
    const iconPad = 6;
    const hoverReserve = isIdCol && hoverAmount > 0 ? iconSize + iconPad : 0;

    ctx.save();

    // Left border
    ctx.fillStyle = border;
    ctx.fillRect(x, y, BORDER_W, height);

    // Text clipped to remaining width
    ctx.beginPath();
    ctx.rect(x + BORDER_W + PADDING, y, width - BORDER_W - PADDING * 2 - hoverReserve, height);
    ctx.clip();
    ctx.font = `${theme.baseFontStyle} ${theme.fontFamily}`;
    ctx.fillStyle = theme.textDark;
    ctx.textBaseline = 'middle';
    ctx.fillText(displayText, x + BORDER_W + PADDING, y + height / 2);

    ctx.restore();

    if (isIdCol && hoverAmount > 0) {
      drawInspectIcon(
        ctx,
        x + width - iconSize - iconPad,
        y + (height - iconSize) / 2,
        iconSize,
        theme.textMedium ?? '#888',
        hoverAmount,
      );
    }

    return true;
  },
};

// ── Row colours ──

const ROW_TINT: Record<RowStatus, string | undefined> = {
  added: '#f0fdf4',
  modified: undefined,
  unpublished: undefined,
  deleted: '#fef2f2',
  unchanged: undefined,
};

// ── Filter pill ──

function FilterPill({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
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
        border: active ? '1px solid var(--mantine-color-blue-4)' : '1px solid var(--fg-divider)',
        backgroundColor: active ? 'var(--mantine-color-blue-0)' : 'transparent',
        cursor: 'pointer',
        lineHeight: 1,
      }}
    >
      <Text12Medium c={active ? 'var(--mantine-color-blue-7)' : 'var(--fg-muted)'} component="span">
        {label}
        {` (${count.toLocaleString()})`}
      </Text12Medium>
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
  const [filterStatus, setFilterStatus] = useState<FilterStatus | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [detailRowIndex, setDetailRowIndex] = useState<number | null>(null);
  const [schema, setSchema] = useState<Record<string, unknown> | null>(null);
  const [page, setPage] = useState(1);
  const [cellModal, setCellModal] = useState<{
    col: number;
    row: number;
    filename: string;
    fieldName: string;
    value: string;
    fromValue: string;
    diffKind: FieldValueDiffKind;
  } | null>(null);
  const [cellModalEditing, setCellModalEditing] = useState(false);
  const [cellModalEditValue, setCellModalEditValue] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const [gridSize, setGridSize] = useState<{ width: number; height: number } | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const wrapperRef = useCallback((el: HTMLDivElement | null) => {
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
      .readDiffGridData(selectedFolderPath, workspacePath)
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
  }, [dataRefreshKey, selectedFolderPath, workspacePath, reloadKey]);

  // Reset state when folder changes
  useEffect(() => {
    setSort({ column: null, direction: null });
    setFilterStatus(null);
    setColumnWidths({});
    setDetailRowIndex(null);
    setSchema(null);
    setCellModal(null);
    setCellModalEditing(false);
    setPage(1);
    setReloadKey(0);
  }, [selectedFolderPath]);

  // Reset to page 1 when filter or sort changes
  useEffect(() => {
    setPage(1);
  }, [filterStatus, sort]);

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
        console.debug('Retrieved folder metadata', meta);
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

  // ── Derived ──

  const filteredRows = useMemo(() => {
    const allRows = diffData?.rows ?? [];
    if (!filterStatus) return allRows;
    if (filterStatus === 'unreviewed') {
      return allRows.filter((r) => rowHasUnreviewedChanges(r));
    }
    // unpublished
    return allRows.filter((r) => rowHasUnpublishedChanges(r));
  }, [diffData?.rows, filterStatus]);

  const sortedRows = useMemo(() => {
    if (!filteredRows.length || !sort.column || !sort.direction) return filteredRows;
    const col = sort.column;
    const dir = sort.direction === 'asc' ? 1 : -1;
    return [...filteredRows].sort((a, b) => {
      const aVal = a[col];
      const bVal = b[col];
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return dir;
      if (bVal == null) return -dir;
      if (typeof aVal === 'number' && typeof bVal === 'number') return (aVal - bVal) * dir;
      return toDisplayString(aVal).localeCompare(toDisplayString(bVal)) * dir;
    });
  }, [filteredRows, sort]);

  const totalPages = Math.ceil(sortedRows.length / PAGE_SIZE);
  const pagedRows = useMemo(() => sortedRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [sortedRows, page]);

  const titleColumnId = useMemo(() => {
    const raw = schema?.titleColumnRemoteId;
    if (Array.isArray(raw) && raw.length > 0 && raw.every((s) => typeof s === 'string')) {
      return raw.join('.');
    }
    return null;
  }, [schema]);

  const columns: GridColumn[] = useMemo(() => {
    const cols = diffData?.columns ?? [];
    let ordered = cols;
    if (titleColumnId && cols.includes(titleColumnId)) {
      ordered = [titleColumnId, ...cols.filter((c) => c !== titleColumnId)];
    }
    return ordered.map((name) => ({
      id: name,
      title: name,
      width: columnWidths[name] ?? Math.max(120, Math.min(250, name.length * 9 + 40)),
    }));
  }, [columnWidths, diffData?.columns, titleColumnId]);

  const filterCounts = useMemo(() => {
    const rows = diffData?.rows ?? [];
    return {
      unreviewed: rows.filter((row) => rowHasUnreviewedChanges(row)).length,
      unpublished: rows.filter((row) => rowHasUnpublishedChanges(row)).length,
    };
  }, [diffData?.rows]);

  // ── Cell content ──

  const getCellContent = useCallback(
    ([col, row]: Item) => {
      const r = pagedRows[row] as DiffRow | undefined;
      const colId = columns[col]?.id;

      if (!r || colId === undefined) {
        return { kind: GridCellKind.Text as const, data: '', displayData: '', allowOverlay: false as const };
      }

      const status = r.__rowStatus;
      const rowBg = ROW_TINT[status];
      const rowTheme = rowBg ? { bgCell: rowBg } : undefined;
      const val = r[colId];
      const isUnreviewed = r.__changedFields.includes(colId);
      const isUnpublished = !isUnreviewed && r.__unpublishedFields.includes(colId);

      // Unreviewed change (w != d): darker blue
      if (isUnreviewed) {
        return {
          kind: GridCellKind.Custom as const,
          allowOverlay: false as const,
          ...(col === 0 ? { cursor: 'pointer' } : {}),
          copyData: toDisplayString(val),
          themeOverride: { bgCell: DIFF_WORKING_BG },
          data: {
            kind: 'diff-cell' as const,
            displayText: toDisplayString(val),
            diffKind: 'unreviewed',
            isIdCol: col === 0,
          } satisfies DiffCellData,
        };
      }

      // Unpublished change (w == d but d != m): lighter blue
      if (isUnpublished) {
        return {
          kind: GridCellKind.Custom as const,
          allowOverlay: false as const,
          ...(col === 0 ? { cursor: 'pointer' } : {}),
          copyData: toDisplayString(val),
          themeOverride: { bgCell: DIFF_UNPUBLISHED_BG },
          data: {
            kind: 'diff-cell' as const,
            displayText: toDisplayString(val),
            diffKind: 'unpublished',
            isIdCol: col === 0,
          } satisfies DiffCellData,
        };
      }

      // First column: inspect-on-hover
      if (col === 0) {
        return {
          kind: GridCellKind.Custom as const,
          allowOverlay: false as const,
          cursor: 'pointer',
          copyData: toDisplayString(val),
          themeOverride: rowTheme,
          data: {
            kind: 'status-dot-cell' as const,
            displayText: toDisplayString(val),
          } satisfies StatusDotCellData,
        };
      }

      // Standard cells
      const kind = inferCellKind(val);
      if (kind === GridCellKind.Boolean) {
        return { kind, data: Boolean(val), allowOverlay: false as const, themeOverride: rowTheme };
      }
      if (kind === GridCellKind.Number) {
        return {
          kind,
          data: val == null ? undefined : Number(val),
          displayData: toDisplayString(val),
          allowOverlay: false as const,
          themeOverride: rowTheme,
        };
      }
      const display = toDisplayString(val);
      return {
        kind: GridCellKind.Text as const,
        data: display,
        displayData: display,
        allowOverlay: false as const,
        themeOverride: rowTheme,
      };
    },
    [pagedRows, columns],
  );

  const onHeaderClicked = useCallback(
    (colIndex: number) => {
      const colId = columns[colIndex]?.id;
      if (!colId) return;
      setSort((prev) => {
        if (prev.column === colId && prev.direction === 'asc') return { column: colId, direction: 'desc' };
        return { column: colId, direction: 'asc' };
      });
    },
    [columns],
  );

  const drawCell: DrawCellCallback = useCallback((args, drawContent) => {
    drawContent();
    if (args.col !== 0 || args.hoverAmount === 0) return;
    const { ctx, rect, theme, hoverAmount } = args;
    drawInspectIcon(
      ctx,
      rect.x + rect.width - 12 - 6,
      rect.y + (rect.height - 12) / 2,
      12,
      theme.textMedium ?? '#888',
      hoverAmount,
    );
  }, []);

  const onCellClicked = useCallback(([col, row]: Item, event: CellClickedEventArgs) => {
    if (col !== 0) return;
    const iconZoneWidth = 12 + 6 * 2;
    if (event.localEventX >= event.bounds.width - iconZoneWidth) {
      setDetailRowIndex(row);
    }
  }, []);

  const onCellActivated = useCallback(
    ([col, row]: Item) => {
      const r = pagedRows[row] as DiffRow | undefined;
      const colId = columns[col]?.id;
      if (!r || !colId) return;
      if (r.__rowStatus === 'deleted') return;
      const value = toDisplayString(r[colId]);
      const isUnreviewed = r.__changedFields.includes(colId);
      const isUnpublished = !isUnreviewed && r.__unpublishedFields.includes(colId);
      const diffKind: FieldValueDiffKind = isUnreviewed ? 'unreviewed' : isUnpublished ? 'unpublished' : null;
      const fromValue = isUnreviewed
        ? toDisplayString(r.__fromFields[colId])
        : isUnpublished
          ? toDisplayString(r.__masterFields[colId])
          : '';
      setCellModal({ col, row, filename: r.__filename, fieldName: colId, value, fromValue, diffKind });
      if (diffKind !== null) {
        setCellModalEditing(false);
      } else {
        setCellModalEditValue(value);
        setCellModalEditing(true);
      }
    },
    [pagedRows, columns],
  );

  const onColumnResize = useCallback(
    (column: GridColumn, newSize: number, colIndex: number) => {
      const columnId = columns[colIndex]?.id ?? column.id;
      if (columnId === undefined) return;
      setColumnWidths((current) => ({ ...current, [String(columnId)]: newSize }));
    },
    [columns],
  );

  const handleFilterToggle = useCallback((status: FilterStatus) => {
    setFilterStatus((prev) => (prev === status ? null : status));
  }, []);

  // ── Render ──

  const summary = diffData?.summary;
  const hasChanges =
    summary && (summary.added > 0 || summary.modified > 0 || summary.unpublished > 0 || summary.deleted > 0);
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
        <Box style={{ padding: '6px 12px', borderBottom: '0.5px solid var(--fg-divider)' }}>
          <Group gap={6} align="center">
            <Text12Medium c="var(--fg-muted)" style={{ marginRight: 4 }}>
              Filter
            </Text12Medium>
            <FilterPill
              label="Needs review"
              count={filterCounts?.unreviewed ?? 0}
              active={filterStatus === 'unreviewed'}
              onClick={() => handleFilterToggle('unreviewed')}
            />
            <FilterPill
              label="Approved"
              count={filterCounts?.unpublished ?? 0}
              active={filterStatus === 'unpublished'}
              onClick={() => handleFilterToggle('unpublished')}
            />
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
            {filterStatus ? 'No rows match the current filter' : 'No data in this folder'}
          </Text13Regular>
        </Box>
      )}

      {selectedFolderPath && !loading && !error && pagedRows.length > 0 && (
        <>
          <Box ref={wrapperRef} style={{ flex: 1, position: 'relative', minHeight: 0 }}>
            {gridSize && (
              <DataEditor
                columns={columns}
                rows={pagedRows.length}
                getCellContent={getCellContent}
                width={gridSize.width}
                height={gridSize.height}
                smoothScrollX
                smoothScrollY
                onHeaderClicked={onHeaderClicked}
                onCellClicked={onCellClicked}
                onCellActivated={onCellActivated}
                cellActivationBehavior="double-click"
                onColumnResize={onColumnResize}
                drawCell={drawCell}
                rowMarkers="number"
                freezeColumns={1}
                customRenderers={[statusDotRenderer, diffCellRenderer]}
              />
            )}
            {detailRowIndex !== null && selectedFolderPath && workspacePath && (
              <RecordDetailView
                rows={pagedRows}
                selectedIndex={detailRowIndex}
                folderPath={selectedFolderPath}
                workspacePath={workspacePath}
                titleColumnId={titleColumnId}
                onSelectIndex={setDetailRowIndex}
                onClose={() => setDetailRowIndex(null)}
                onRecordChanged={() => setReloadKey((k) => k + 1)}
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
              {sortedRows.length.toLocaleString()} rows &middot; {columns.length} columns
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
                      <Box style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: DIFF_WORKING_BORDER }} />
                      <Text12Regular c="var(--fg-muted)">{summary.modified} modified</Text12Regular>
                    </Group>
                  )}
                  {summary.unpublished > 0 && (
                    <Group gap={4}>
                      <Box
                        style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: DIFF_UNPUBLISHED_BORDER }}
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

      <Modal opened={cellModal !== null} onClose={() => setCellModal(null)} title={cellModal?.fieldName} size="lg">
        {cellModal &&
          selectedFolderPath &&
          workspacePath &&
          (() => {
            const { diffKind, value, fromValue, filename, fieldName } = cellModal;
            const saveAndClose = (saveValue: string, logLabel: string) => {
              void window.scratchFiles
                .acceptCellChange(selectedFolderPath, workspacePath, filename, fieldName, saveValue)
                .then(() => {
                  setCellModal(null);
                  setReloadKey((k) => k + 1);
                })
                .catch((err: unknown) => {
                  console.error(`[acceptCellChange] ${logLabel} failed:`, err);
                });
            };
            const undoApprovedAndClose = () => {
              void window.scratchFiles
                .undoApprovedCellChange(selectedFolderPath, workspacePath, filename, fieldName)
                .then(() => {
                  setCellModal(null);
                  setReloadKey((k) => k + 1);
                })
                .catch((err: unknown) => {
                  console.error('[undoApprovedCellChange] undo failed:', err);
                });
            };

            return (
              <FieldValuePanel
                value={value}
                fromValue={fromValue}
                diffKind={diffKind}
                editing={cellModalEditing}
                editValue={cellModalEditValue}
                onEditValueChange={setCellModalEditValue}
                onSave={() => saveAndClose(cellModalEditValue, 'save')}
                onCancel={() => {
                  if (diffKind !== null) {
                    setCellModalEditing(false);
                  } else {
                    setCellModal(null);
                  }
                }}
                onApprove={diffKind === 'unreviewed' ? () => saveAndClose(value, 'approve') : undefined}
                onUndo={
                  diffKind === 'unreviewed'
                    ? () => saveAndClose(fromValue, 'undo')
                    : diffKind === 'unpublished'
                      ? undoApprovedAndClose
                      : undefined
                }
                onEdit={() => {
                  setCellModalEditValue(value);
                  setCellModalEditing(true);
                }}
              />
            );
          })()}
      </Modal>
    </Stack>
  );
});
