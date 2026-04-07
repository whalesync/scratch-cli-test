import DataEditor, {
  type DrawCellCallback,
  GridCellKind,
  type GridColumn,
  type Item,
} from '@glideapps/glide-data-grid';
import '@glideapps/glide-data-grid/dist/index.css';
import { Box, Group, Loader, Stack } from '@mantine/core';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Text12Medium, Text12Regular, Text13Regular } from '../../components/base/text';
import { RecordDetailView } from './RecordDetailView';

interface GridDataResult {
  rows: Array<Record<string, unknown>>;
  columns: string[];
  total: number;
  offset: number;
  schema: Record<string, unknown> | null;
}

type FilterStatus = 'unreviewed' | 'unpublished';

interface FolderDataGridProps {
  selectedFolderPath: string | null;
  workspacePath: string | null;
}

export const FolderDataGrid = memo(function FolderDataGrid({ selectedFolderPath, workspacePath }: FolderDataGridProps) {
  const [gridData, setGridData] = useState<GridDataResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ column: string | null; direction: 'asc' | 'desc' | null }>({
    column: null,
    direction: null,
  });
  const [filterStatus, setFilterStatus] = useState<FilterStatus | null>(null);
  const [filterCounts, setFilterCounts] = useState<{ unreviewed: number; unpublished: number } | null>(null);

  const [detailRowIndex, setDetailRowIndex] = useState<number | null>(null);

  const [gridSize, setGridSize] = useState<{ width: number; height: number } | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  // Callback ref so the ResizeObserver attaches whenever the element mounts
  const wrapperRef = useCallback((el: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (!el) return;
    // Synchronously read the initial size so we never flash the wrong dimensions
    const rect = el.getBoundingClientRect();
    setGridSize({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setGridSize({ width: Math.floor(width), height: Math.floor(height) });
    });
    observer.observe(el);
    observerRef.current = observer;
  }, []);

  // Load data when folder or sort changes
  useEffect(() => {
    if (!selectedFolderPath) {
      setGridData(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const opts: {
      filterStatus?: 'unreviewed' | 'unpublished' | 'published';
      workspacePath?: string;
    } = {};
    if (workspacePath) {
      opts.workspacePath = workspacePath;
    }
    if (filterStatus) {
      opts.filterStatus = filterStatus;
    }

    window.scratchFiles
      .readGridData(selectedFolderPath, opts)
      .then((result) => {
        if (!cancelled) {
          setGridData(result);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load grid data');
          setGridData(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedFolderPath, filterStatus, workspacePath]);

  // Reset sort, filter, and detail view when folder changes
  useEffect(() => {
    setSort({ column: null, direction: null });
    setFilterStatus(null);
    setFilterCounts(null);
    setDetailRowIndex(null);
  }, [selectedFolderPath]);

  // Fetch filter counts when folder changes (requires workspacePath)
  useEffect(() => {
    if (!selectedFolderPath || !workspacePath) {
      setFilterCounts(null);
      return;
    }

    let cancelled = false;

    Promise.all([
      window.scratchFiles.readGridData(selectedFolderPath, {
        filterStatus: 'unreviewed',
        workspacePath,
        limit: 0,
      }),
      window.scratchFiles.readGridData(selectedFolderPath, {
        filterStatus: 'unpublished',
        workspacePath,
        limit: 0,
      }),
    ])
      .then(([unreviewed, unpublished]) => {
        if (!cancelled) {
          setFilterCounts({ unreviewed: unreviewed.total, unpublished: unpublished.total });
        }
      })
      .catch(() => {
        // Filter counts are non-critical; silently ignore errors
      });

    return () => {
      cancelled = true;
    };
  }, [selectedFolderPath, workspacePath]);

  // Extract titleColumnRemoteId from schema — it's a path array like ['properties', 'email']
  // which maps to the flattened column key 'properties.email'
  const titleColumnId = useMemo(() => {
    const raw = gridData?.schema?.titleColumnRemoteId;
    if (Array.isArray(raw) && raw.length > 0 && raw.every((s) => typeof s === 'string')) {
      return raw.join('.');
    }
    return null;
  }, [gridData?.schema]);

  const columns: GridColumn[] = useMemo(() => {
    const cols = gridData?.columns ?? [];
    // If a title column is defined in the schema, move it to the front
    let ordered = cols;
    if (titleColumnId && cols.includes(titleColumnId)) {
      ordered = [titleColumnId, ...cols.filter((c) => c !== titleColumnId)];
    }
    return ordered.map((name) => ({
      id: name,
      title: name,
      width: Math.max(120, Math.min(250, name.length * 9 + 40)),
    }));
  }, [gridData?.columns, titleColumnId]);

  // Sort rows in-memory
  const sortedRows = (() => {
    if (!gridData?.rows) return [];
    if (!sort.column || !sort.direction) return gridData.rows;

    const col = sort.column;
    const dir = sort.direction === 'asc' ? 1 : -1;
    return [...gridData.rows].sort((a, b) => {
      const aVal = a[col];
      const bVal = b[col];
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return dir;
      if (bVal == null) return -dir;
      if (typeof aVal === 'number' && typeof bVal === 'number') return (aVal - bVal) * dir;
      return toDisplayString(aVal).localeCompare(toDisplayString(bVal)) * dir;
    });
  })();

  const getCellContent = useCallback(
    ([col, row]: Item) => {
      const r = sortedRows[row];
      const colId = columns[col]?.id;

      if (!r || colId === undefined) {
        return { kind: GridCellKind.Text as const, data: '', displayData: '', allowOverlay: false as const };
      }

      const val = r[colId];
      const kind = inferCellKind(val);

      if (kind === GridCellKind.Boolean) {
        return { kind, data: Boolean(val), allowOverlay: false as const };
      }
      if (kind === GridCellKind.Number) {
        const num = val == null ? undefined : Number(val);
        return { kind, data: num, displayData: toDisplayString(val), allowOverlay: false as const };
      }
      const display = toDisplayString(val);
      return {
        kind: GridCellKind.Text as const,
        data: display,
        displayData: display,
        allowOverlay: false as const,
        hoverEffect: col === 0,
        cursor: col === 0 ? ('pointer' as const) : undefined,
      };
    },
    [sortedRows, columns],
  );

  const onHeaderClicked = useCallback(
    (colIndex: number) => {
      const colId = columns[colIndex]?.id;
      if (!colId) return;
      setSort((prev) => {
        if (prev.column === colId && prev.direction === 'asc') {
          return { column: colId, direction: 'desc' };
        }
        return { column: colId, direction: 'asc' };
      });
    },
    [columns],
  );

  // For column 0: draw text manually (skip built-in hover highlight), then overlay magnifying glass on hover
  const drawCell: DrawCellCallback = useCallback((args, drawContent) => {
    if (args.col !== 0) {
      drawContent();
      return;
    }
    const { ctx, rect, theme, cell, hoverAmount } = args;
    // Draw text ourselves to avoid the built-in hoverEffect highlight + cursor override
    if (cell.kind === GridCellKind.Text && cell.displayData) {
      const padX = theme.cellHorizontalPadding;
      ctx.save();
      ctx.fillStyle = theme.textDark;
      ctx.font = `${theme.baseFontStyle} ${theme.fontFamily}`;
      ctx.textBaseline = 'middle';
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
      ctx.clip();
      ctx.fillText(cell.displayData, rect.x + padX, rect.y + rect.height / 2);
      ctx.restore();
    }
    if (hoverAmount > 0) {
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
    }
    return true;
  }, []);

  const onCellClicked = useCallback(([col, row]: Item) => {
    if (col === 0) {
      setDetailRowIndex(row);
    }
  }, []);

  const handleFilterToggle = useCallback((status: FilterStatus) => {
    setFilterStatus((prev) => (prev === status ? null : status));
  }, []);

  const showFilterBar = workspacePath && selectedFolderPath && !error && detailRowIndex === null;

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
          }}
        >
          <Group gap={6} align="center">
            <Text12Medium c="var(--fg-muted)" style={{ marginRight: 4 }}>
              Filter
            </Text12Medium>
            <FilterPill
              label="Needs review"
              count={filterCounts?.unreviewed ?? null}
              active={filterStatus === 'unreviewed'}
              onClick={() => handleFilterToggle('unreviewed')}
            />
            <FilterPill
              label="Approved"
              count={filterCounts?.unpublished ?? null}
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

      {selectedFolderPath && !loading && !error && gridData && gridData.rows.length === 0 && (
        <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Text13Regular c="dimmed">
            {filterStatus ? 'No rows match the current filter' : 'No data in this folder'}
          </Text13Regular>
        </Box>
      )}

      {selectedFolderPath && !loading && !error && gridData && gridData.rows.length > 0 && (
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
                drawCell={drawCell}
                rowMarkers="number"
                freezeColumns={1}
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
              {gridData.total.toLocaleString()} rows &middot; {gridData.columns.length} columns
              {sort.column && (
                <span style={{ marginLeft: 8 }}>
                  &middot; Sorted by {sort.column} {sort.direction === 'desc' ? '\u2193' : '\u2191'}
                </span>
              )}
            </Text12Regular>
          </Box>
        </>
      )}
    </Stack>
  );
});

function FilterPill({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number | null;
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
        {count != null && ` (${count.toLocaleString()})`}
      </Text12Medium>
    </Box>
  );
}

function toDisplayString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
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

function inferCellKind(value: unknown): GridCellKind {
  if (typeof value === 'boolean') return GridCellKind.Boolean;
  if (typeof value === 'number') return GridCellKind.Number;
  return GridCellKind.Text;
}
