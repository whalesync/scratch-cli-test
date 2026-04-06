import DataEditor, { GridCellKind, type GridColumn, type Item } from '@glideapps/glide-data-grid';
import '@glideapps/glide-data-grid/dist/index.css';
import { Box } from '@mantine/core';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { flattenObject } from '../../utils/flatten-object';

function toDisplayString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

interface RecordFieldsGridProps {
  data: Record<string, unknown>;
}

export const RecordFieldsGrid = memo(function RecordFieldsGrid({ data }: RecordFieldsGridProps) {
  const entries = useMemo(() => {
    const flat = flattenObject(data);
    return Object.entries(flat);
  }, [data]);

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
    const observer = new ResizeObserver((obs) => {
      const { width, height } = obs[0].contentRect;
      setGridSize({ width: Math.floor(width), height: Math.floor(height) });
    });
    observer.observe(el);
    observerRef.current = observer;
  }, []);

  const columns: GridColumn[] = useMemo(
    () => [
      { id: 'field', title: 'Field', width: 200 },
      { id: 'value', title: 'Value', width: gridSize ? Math.max(200, gridSize.width - 200) : 400 },
    ],
    [gridSize],
  );

  const getCellContent = useCallback(
    ([col, row]: Item) => {
      const entry = entries[row];
      if (!entry) {
        return { kind: GridCellKind.Text as const, data: '', displayData: '', allowOverlay: false as const };
      }

      if (col === 0) {
        return {
          kind: GridCellKind.Text as const,
          data: entry[0],
          displayData: entry[0],
          allowOverlay: false as const,
          themeOverride: { baseFontStyle: '500 13px' },
        };
      }

      const display = toDisplayString(entry[1]);
      return {
        kind: GridCellKind.Text as const,
        data: display,
        displayData: display,
        allowOverlay: true as const,
      };
    },
    [entries],
  );

  return (
    <Box ref={wrapperRef} style={{ flex: 1, position: 'relative', minHeight: 0 }}>
      {gridSize && (
        <DataEditor
          columns={columns}
          rows={entries.length}
          getCellContent={getCellContent}
          width={gridSize.width}
          height={gridSize.height}
          smoothScrollY
          rowMarkers="none"
        />
      )}
    </Box>
  );
});
