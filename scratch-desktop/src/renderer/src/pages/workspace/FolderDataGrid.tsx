import DataEditor, {
  GridCellKind,
  type CustomCell,
  type CustomRenderer,
  type DrawCellCallback,
  type GridColumn,
  type Item,
} from '@glideapps/glide-data-grid';
import '@glideapps/glide-data-grid/dist/index.css';
import { Box, Group, Loader, Stack } from '@mantine/core';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Text12Regular, Text13Regular } from '../../components/base/text';
import { RecordDetailView } from './RecordDetailView';

// ── Types ──

type RowStatus = 'added' | 'modified' | 'deleted' | 'unchanged';

interface DiffRow extends Record<string, unknown> {
  __rowStatus: RowStatus;
  __changedFields: string[];
  __fromFields: Record<string, unknown>;
  __filename: string;
}

interface DiffGridResult {
  rows: DiffRow[];
  columns: string[];
  total: number;
  summary: { total: number; added: number; modified: number; deleted: number };
}

interface FolderDataGridProps {
  /** Included so memo() invalidates when switching workbooks even if folder path + local path match. */
  workspaceId: string;
  selectedFolderPath: string | null;
  workspacePath: string | null;
}

// ── Helpers ──

function toDisplayString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
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
  dotColor: string | null;
}

type StatusDotCell = CustomCell<StatusDotCellData>;

const statusDotRenderer: CustomRenderer<StatusDotCell> = {
  kind: GridCellKind.Custom,
  needsHover: true,
  isMatch: (c): c is StatusDotCell =>
    typeof c.data === 'object' && c.data !== null && (c.data as StatusDotCellData).kind === 'status-dot-cell',
  draw: ({ ctx, rect, cell, theme, hoverAmount }) => {
    const { x, y, width, height } = rect;
    const { displayText, dotColor } = cell.data;
    const DOT_R = 4;
    const PADDING = 8;
    const iconSize = 12;
    const iconPad = 6;
    const dotsWidth = dotColor ? DOT_R * 2 + 8 : 0;
    const hoverReserve = hoverAmount > 0 ? iconSize + iconPad : 0;
    const textMaxWidth = width - PADDING * 2 - dotsWidth - hoverReserve;

    ctx.save();
    ctx.font = `${theme.baseFontStyle} ${theme.fontFamily}`;
    ctx.fillStyle = theme.textDark;
    ctx.textBaseline = 'middle';
    ctx.beginPath();
    ctx.rect(x + PADDING, y, textMaxWidth, height);
    ctx.clip();
    ctx.fillText(displayText, x + PADDING, y + height / 2);
    ctx.restore();

    if (dotColor) {
      ctx.beginPath();
      ctx.arc(x + width - PADDING - DOT_R - hoverReserve, y + height / 2, DOT_R, 0, Math.PI * 2);
      ctx.fillStyle = dotColor;
      ctx.fill();
    }

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

// ── Custom cell: diff value (old struck through + new value) ──

interface DiffValueCellData {
  kind: 'diff-value-cell';
  oldText: string;
  newText: string;
}

type DiffValueCell = CustomCell<DiffValueCellData>;

const diffValueRenderer: CustomRenderer<DiffValueCell> = {
  kind: GridCellKind.Custom,
  isMatch: (c): c is DiffValueCell =>
    typeof c.data === 'object' && c.data !== null && (c.data as DiffValueCellData).kind === 'diff-value-cell',
  draw: ({ ctx, rect, cell, theme }) => {
    const { x, y, width, height } = rect;
    const { oldText, newText } = cell.data;
    const PADDING = 8;
    const maxW = width - PADDING * 2;
    const midY = y + height / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x + PADDING, y + 1, maxW, height - 2);
    ctx.clip();

    // Old value — small, gray, struck through — above centre
    const oldY = midY - 7;
    ctx.font = `11px ${theme.fontFamily}`;
    ctx.fillStyle = '#9ca3af';
    ctx.textBaseline = 'middle';
    ctx.fillText(oldText, x + PADDING, oldY);
    const oldW = Math.min(ctx.measureText(oldText).width, maxW);
    ctx.strokeStyle = '#9ca3af';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + PADDING, oldY);
    ctx.lineTo(x + PADDING + oldW, oldY);
    ctx.stroke();

    // New value — normal, dark — below centre
    ctx.font = `${theme.baseFontStyle} ${theme.fontFamily}`;
    ctx.fillStyle = theme.textDark;
    ctx.fillText(newText, x + PADDING, midY + 7);

    ctx.restore();
    return true;
  },
};

// ── Tint colours ──

const TINT: Record<RowStatus, string | undefined> = {
  added: '#f0fdf4',
  modified: '#fffbeb',
  deleted: '#fef2f2',
  unchanged: undefined,
};

const DOT_COLOR: Record<RowStatus, string | null> = {
  added: '#22c55e',
  modified: '#f59e0b',
  deleted: '#ef4444',
  unchanged: null,
};

// ── Component ──

export const FolderDataGrid = memo(function FolderDataGrid(props: FolderDataGridProps) {
  const { selectedFolderPath, workspacePath } = props;
  const [diffData, setDiffData] = useState<DiffGridResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ column: string | null; direction: 'asc' | 'desc' | null }>({
    column: null,
    direction: null,
  });
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const [detailRowIndex, setDetailRowIndex] = useState<number | null>(null);
  const [schema, setSchema] = useState<Record<string, unknown> | null>(null);

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
    if (!selectedFolderPath) {
      setDiffData(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const load = workspacePath
      ? window.scratchFiles.readDiffGridData(selectedFolderPath, workspacePath)
      : window.scratchFiles.readGridData(selectedFolderPath).then((r) => ({
          rows: r.rows.map((row) => ({
            ...row,
            __rowStatus: 'unchanged' as RowStatus,
            __changedFields: [] as string[],
            __fromFields: {} as Record<string, unknown>,
            __filename: (row['__filename'] as string) ?? '',
          })),
          columns: r.columns,
          total: r.total,
          summary: { total: r.total, added: 0, modified: 0, deleted: 0 },
        }));

    load
      .then((result) => {
        if (!cancelled) setDiffData(result as DiffGridResult);
      })
      .catch((err) => {
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
  }, [selectedFolderPath, workspacePath]);

  // Reset sort and detail view when folder changes
  useEffect(() => {
    setSort({ column: null, direction: null });
    setColumnWidths({});
    setDetailRowIndex(null);
    setSchema(null);
  }, [selectedFolderPath]);

  // Load folder metadata (schema) when folder changes
  useEffect(() => {
    if (!selectedFolderPath || !workspacePath) {
      setSchema(null);
      return;
    }
    let cancelled = false;
    void window.scratchFiles.getFolderMetadata(selectedFolderPath, workspacePath).then((meta) => {
      if (!cancelled) setSchema(meta.schema);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedFolderPath, workspacePath]);

  // ── Derived ──

  const rows = diffData?.rows ?? [];

  // Extract titleColumnRemoteId from schema — it's a path array like ['properties', 'email']
  // which maps to the flattened column key 'properties.email'
  const titleColumnId = useMemo(() => {
    const raw = schema?.titleColumnRemoteId;
    if (Array.isArray(raw) && raw.length > 0 && raw.every((s) => typeof s === 'string')) {
      return raw.join('.');
    }
    return null;
  }, [schema]);

  const columns: GridColumn[] = useMemo(() => {
    const cols = diffData?.columns ?? [];
    // If a title column is defined in the schema, move it to the front
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

  const sortedRows = (() => {
    if (!rows.length || !sort.column || !sort.direction) return rows;
    const col = sort.column;
    const dir = sort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const aVal = a[col];
      const bVal = b[col];
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return dir;
      if (bVal == null) return -dir;
      if (typeof aVal === 'number' && typeof bVal === 'number') return (aVal - bVal) * dir;
      return toDisplayString(aVal).localeCompare(toDisplayString(bVal)) * dir;
    });
  })();

  // ── Cell content ──

  const getCellContent = useCallback(
    ([col, row]: Item) => {
      const r = sortedRows[row] as DiffRow | undefined;
      const colId = columns[col]?.id;

      if (!r || colId === undefined) {
        return { kind: GridCellKind.Text as const, data: '', displayData: '', allowOverlay: false as const };
      }

      const status = r.__rowStatus;
      const bgCell = TINT[status];
      const themeOverride = bgCell ? { bgCell } : undefined;

      // For modified rows, only tint changed cells (not the whole row)
      const cellBg = status === 'modified' ? (r.__changedFields.includes(colId) ? TINT.modified : undefined) : bgCell;
      const cellTheme = cellBg ? { bgCell: cellBg } : undefined;

      // First column: status dot (custom renderer handles hover icon via hoverAmount)
      if (col === 0) {
        return {
          kind: GridCellKind.Custom as const,
          allowOverlay: false as const,
          cursor: 'pointer',
          copyData: toDisplayString(r[colId]),
          themeOverride,
          data: {
            kind: 'status-dot-cell' as const,
            displayText: toDisplayString(r[colId]),
            dotColor: DOT_COLOR[status],
          } satisfies StatusDotCellData,
        };
      }

      const val = r[colId];

      // Modified changed cells: show old (struck through) + new value
      if (status === 'modified' && r.__changedFields.includes(colId)) {
        const oldVal = r.__fromFields[colId];
        return {
          kind: GridCellKind.Custom as const,
          allowOverlay: false as const,
          copyData: toDisplayString(val),
          themeOverride: cellTheme,
          data: {
            kind: 'diff-value-cell' as const,
            oldText: toDisplayString(oldVal),
            newText: toDisplayString(val),
          } satisfies DiffValueCellData,
        };
      }

      const kind = inferCellKind(val);

      if (kind === GridCellKind.Boolean) {
        return { kind, data: Boolean(val), allowOverlay: false as const, themeOverride: cellTheme };
      }
      if (kind === GridCellKind.Number) {
        return {
          kind,
          data: val == null ? undefined : Number(val),
          displayData: toDisplayString(val),
          allowOverlay: false as const,
          themeOverride: cellTheme,
        };
      }
      const display = toDisplayString(val);
      return {
        kind: GridCellKind.Text as const,
        data: display,
        displayData: display,
        allowOverlay: false as const,
        themeOverride: cellTheme,
      };
    },
    [sortedRows, columns],
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

  // Draw magnifying glass hover icon for non-custom cells on col 0 (custom cells handle it themselves)
  const drawCell: DrawCellCallback = useCallback((args, drawContent) => {
    drawContent();
    if (args.col !== 0 || args.hoverAmount === 0) return;
    const { ctx, rect, theme, hoverAmount } = args;
    const size = 12;
    const padding = 6;
    drawInspectIcon(
      ctx,
      rect.x + rect.width - size - padding,
      rect.y + (rect.height - size) / 2,
      size,
      theme.textMedium ?? '#888',
      hoverAmount,
    );
  }, []);

  const onCellClicked = useCallback(([col, row]: Item) => {
    if (col === 0) setDetailRowIndex(row);
  }, []);

  const onColumnResize = useCallback(
    (column: GridColumn, newSize: number, colIndex: number) => {
      const columnId = columns[colIndex]?.id ?? column.id;
      if (columnId === undefined) return;
      setColumnWidths((current) => ({ ...current, [String(columnId)]: newSize }));
    },
    [columns],
  );

  // ── Render ──

  const summary = diffData?.summary;
  const hasChanges = summary && (summary.added > 0 || summary.modified > 0 || summary.deleted > 0);

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

      {selectedFolderPath && !loading && !error && rows.length === 0 && (
        <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Text13Regular c="dimmed">No data in this folder</Text13Regular>
        </Box>
      )}

      {selectedFolderPath && !loading && !error && rows.length > 0 && (
        <>
          <Box ref={wrapperRef} style={{ flex: 1, position: 'relative', minHeight: 0 }}>
            {gridSize && (
              <DataEditor
                columns={columns}
                rows={sortedRows.length}
                getCellContent={getCellContent}
                width={gridSize.width}
                height={gridSize.height}
                smoothScrollX
                smoothScrollY
                onHeaderClicked={onHeaderClicked}
                onCellClicked={onCellClicked}
                onColumnResize={onColumnResize}
                drawCell={drawCell}
                rowMarkers="number"
                freezeColumns={1}
                customRenderers={[statusDotRenderer, diffValueRenderer]}
              />
            )}
            {detailRowIndex !== null && selectedFolderPath && workspacePath && (
              <RecordDetailView
                rows={sortedRows}
                selectedIndex={detailRowIndex}
                folderPath={selectedFolderPath}
                workspacePath={workspacePath}
                titleColumnId={titleColumnId}
                onSelectIndex={setDetailRowIndex}
                onClose={() => setDetailRowIndex(null)}
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
              {(summary?.total ?? rows.length).toLocaleString()} records &middot; {columns.length} columns
              {sort.column && (
                <span style={{ marginLeft: 8 }}>
                  &middot; Sorted by {sort.column} {sort.direction === 'desc' ? '\u2193' : '\u2191'}
                </span>
              )}
            </Text12Regular>

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
                    <Box style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: '#f59e0b' }} />
                    <Text12Regular c="var(--fg-muted)">{summary.modified} modified</Text12Regular>
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
          </Box>
        </>
      )}
    </Stack>
  );
});
