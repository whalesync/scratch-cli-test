import DataEditor, { GridCellKind, type GridColumn, type Item } from '@glideapps/glide-data-grid';
import '@glideapps/glide-data-grid/dist/index.css';
import { Box, Loader, Stack } from '@mantine/core';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Text12Regular, Text13Regular } from '../../components/base/text';

interface GridDataResult {
  rows: Array<Record<string, unknown>>;
  columns: string[];
  total: number;
  offset: number;
}

interface FolderDataGridProps {
  selectedFolderPath: string | null;
}

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

export const FolderDataGrid = memo(function FolderDataGrid({ selectedFolderPath }: FolderDataGridProps) {
  const [gridData, setGridData] = useState<GridDataResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ column: string | null; direction: 'asc' | 'desc' | null }>({
    column: null,
    direction: null,
  });

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

    window.scratchFiles
      .readGridData(selectedFolderPath)
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
  }, [selectedFolderPath]);

  // Reset sort when folder changes
  useEffect(() => {
    setSort({ column: null, direction: null });
  }, [selectedFolderPath]);

  const columns: GridColumn[] = (gridData?.columns ?? []).map((name) => ({
    id: name,
    title: name,
    width: Math.max(120, Math.min(250, name.length * 9 + 40)),
  }));

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

      {selectedFolderPath && !loading && !error && gridData && gridData.rows.length === 0 && (
        <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Text13Regular c="dimmed">No data in this folder</Text13Regular>
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
                rowMarkers="number"
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
