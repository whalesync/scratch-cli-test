import DataEditor, {
  GridCellKind,
  GridColumnMenuIcon,
  type CellClickedEventArgs,
  type DataEditorRef,
  type DrawCellCallback,
  type EditableGridCell,
  type GridColumn,
  type GridMouseEventArgs,
  type HeaderClickedEventArgs,
  type Item,
  type Rectangle,
} from '@glideapps/glide-data-grid';
import '@glideapps/glide-data-grid/dist/index.css';
import { Box, Group, Loader, Portal, Stack } from '@mantine/core';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Text12Medium, Text12Regular, Text13Regular } from '../../components/base/text';
import { FieldValuePanel, type FieldValueDiffKind } from './FieldValuePanel';
import { FolderGridHeaderMenu } from './FolderGridHeaderMenu';
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
  filterCounts: { unreviewed: number; unpublished: number };
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
  | { scope: 'column'; kind: FilterKind; columnId: string; columnTitle: string };

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

function isInsideGridEditorOverlay(target: Element): boolean {
  return Boolean(target.closest('.gdg-clip-region') || target.closest('.gdg-input'));
}

function filterKey(filter: GridFilter): string {
  return filter.scope === 'global' ? `global:${filter.kind}` : `column:${filter.columnId}:${filter.kind}`;
}

function filterLabel(filter: GridFilter): string {
  if (filter.scope === 'global') {
    return filter.kind === 'unreviewed' ? 'Needs review' : 'Approved';
  }

  return `${filter.columnTitle}: ${filter.kind === 'unreviewed' ? 'Needs review' : 'Approved'}`;
}

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

function ActiveFilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <Box
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 6px 2px 8px',
        borderRadius: 10,
        border: '1px solid var(--mantine-color-blue-4)',
        backgroundColor: 'var(--mantine-color-blue-0)',
        lineHeight: 1,
      }}
    >
      <Text12Medium c="var(--mantine-color-blue-7)" component="span">
        {label}
      </Text12Medium>
      <Box
        component="button"
        type="button"
        onClick={onRemove}
        style={{
          border: 0,
          backgroundColor: 'transparent',
          color: 'var(--mantine-color-blue-7)',
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
  const [activeEditorDiffKind, setActiveEditorDiffKind] = useState<EditorOverlayDiffKind | null>(null);
  const [cellPopover, setCellPopover] = useState<CellPopoverState | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [gridSize, setGridSize] = useState<{ width: number; height: number } | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const gridRef = useRef<DataEditorRef | null>(null);
  const cellPopoverRef = useRef<HTMLDivElement | null>(null);
  const hoveredCellRef = useRef<Item | null>(null);

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
    hoveredCellRef.current = null;
    setHeaderMenu(null);
    setActiveEditorDiffKind(null);
    setSchema(null);
    setCellPopover(null);
    setPage(1);
    setReloadKey(0);
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
      hasMenu: true,
      menuIcon: GridColumnMenuIcon.Dots,
    }));
  }, [columnWidths, diffData?.columns, titleColumnId]);

  const filterCounts = diffData?.filterCounts;

  const activeColumnFilters = useMemo(
    () =>
      activeFilters.filter((filter): filter is Extract<GridFilter, { scope: 'column' }> => filter.scope === 'column'),
    [activeFilters],
  );

  const hasGlobalFilter = useCallback(
    (kind: FilterKind) => activeFilters.some((filter) => filter.scope === 'global' && filter.kind === kind),
    [activeFilters],
  );

  const closeGridEditorChrome = useCallback(() => {
    setActiveEditorDiffKind(null);
    setCellPopover(null);
  }, []);

  const refreshGridData = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  const acceptGridCellChange = useCallback(
    (filename: string, fieldName: string, nextValue: string, logLabel: string) => {
      if (!selectedFolderPath || !workspacePath) {
        return;
      }

      void window.scratchFiles
        .acceptCellChange(selectedFolderPath, workspacePath, filename, fieldName, nextValue)
        .then(() => {
          closeGridEditorChrome();
          refreshGridData();
        })
        .catch((err: unknown) => {
          console.error(`[acceptCellChange] ${logLabel} failed:`, err);
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
      const rowTheme = rowBg ? { bgCell: rowBg } : {};
      const val = r[colId];
      const { diffKind } = getCellDiffState(r, colId);
      const diffTheme =
        diffKind === 'unreviewed'
          ? { bgCell: DIFF_WORKING_BG }
          : diffKind === 'unpublished'
            ? { bgCell: DIFF_UNPUBLISHED_BG }
            : {};
      const themeOverride = { ...rowTheme, ...diffTheme };
      const allowOverlay = status !== 'deleted';

      if (col === 0) {
        const kind = inferCellKind(val);
        if (kind === GridCellKind.Boolean) {
          return {
            kind,
            data: typeof val === 'boolean' ? val : undefined,
            allowOverlay,
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
          allowOverlay,
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
      drawContent();
      const hoveredCell = hoveredCellRef.current;
      const row = pagedRows[args.row] as DiffRow | undefined;
      const colId = columns[args.col]?.id;
      if (!row || !colId) {
        return;
      }

      const { diffKind } = getCellDiffState(row, colId);
      if (diffKind !== null) {
        args.ctx.save();
        args.ctx.fillStyle = diffKind === 'unreviewed' ? DIFF_WORKING_BORDER : DIFF_UNPUBLISHED_BORDER;
        args.ctx.fillRect(args.rect.x, args.rect.y, 3, args.rect.height);
        args.ctx.restore();
      }

      if (args.col !== 0 || hoveredCell?.[0] !== args.col || hoveredCell?.[1] !== args.row) {
        return;
      }

      drawInspectIcon(
        args.ctx,
        args.rect.x + args.rect.width - 12 - 6,
        args.rect.y + (args.rect.height - 12) / 2,
        12,
        args.theme.textMedium ?? '#888',
        1,
      );
    },
    [columns, pagedRows],
  );

  const onCellClicked = useCallback(([col, row]: Item, event: CellClickedEventArgs) => {
    setHeaderMenu(null);
    if (col !== 0) return;
    const iconZoneWidth = 12 + 6 * 2;
    if (event.localEventX >= event.bounds.width - iconZoneWidth) {
      setDetailRowIndex(row);
    }
  }, []);

  const setHoveredCellWithDamage = useCallback((next: Item | null) => {
    const prev = hoveredCellRef.current;
    const isSameCell = prev?.[0] === next?.[0] && prev?.[1] === next?.[1];
    if (isSameCell) {
      return;
    }

    hoveredCellRef.current = next;

    const damageCells: { cell: Item }[] = [];
    if (prev?.[0] === 0) {
      damageCells.push({ cell: prev });
    }
    if (next?.[0] === 0) {
      damageCells.push({ cell: next });
    }
    if (damageCells.length > 0) {
      gridRef.current?.updateCells(damageCells);
    }
  }, []);

  const onMouseMove = useCallback(
    (args: GridMouseEventArgs) => {
      setHoveredCellWithDamage(args.kind === 'cell' ? args.location : null);
    },
    [setHoveredCellWithDamage],
  );

  const onGridMouseLeave = useCallback(() => {
    setHoveredCellWithDamage(null);
  }, [setHoveredCellWithDamage]);

  const onCellActivated = useCallback(
    ([col, row]: Item) => {
      setHeaderMenu(null);
      const r = pagedRows[row] as DiffRow | undefined;
      const colId = columns[col]?.id;
      if (!r || !colId) return;
      if (r.__rowStatus === 'deleted') return;
      const bounds = gridRef.current?.getBounds(col, row);
      if (!bounds) return;
      const value = toDisplayString(r[colId]);
      const { diffKind, fromValue } = getCellDiffState(r, colId);
      setActiveEditorDiffKind(diffKind ?? 'none');
      if (diffKind === null) {
        setCellPopover(null);
        return;
      }
      setCellPopover({ col, row, filename: r.__filename, fieldName: colId, value, fromValue, diffKind, bounds });
    },
    [pagedRows, columns],
  );

  const onCellEdited = useCallback(
    ([col, row]: Item, newValue: EditableGridCell) => {
      const r = pagedRows[row] as DiffRow | undefined;
      const colId = columns[col]?.id;
      if (!r || !colId || r.__rowStatus === 'deleted') {
        return;
      }

      acceptGridCellChange(r.__filename, colId, editableCellToString(newValue), 'grid overlay save');
    },
    [acceptGridCellChange, columns, pagedRows],
  );

  const onFinishedEditing = useCallback(() => {
    closeGridEditorChrome();
  }, [closeGridEditorChrome]);

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
      const columnId = columns[colIndex]?.id ?? column.id;
      if (columnId === undefined) return;
      setColumnWidths((current) => ({ ...current, [String(columnId)]: newSize }));
    },
    [columns],
  );

  const handleGlobalFilterToggle = useCallback((kind: FilterKind) => {
    setActiveFilters((current) => {
      const exists = current.some((filter) => filter.scope === 'global' && filter.kind === kind);
      if (exists) {
        return current.filter((filter) => !(filter.scope === 'global' && filter.kind === kind));
      }
      return [...current, { scope: 'global', kind }];
    });
  }, []);

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

  const handleRemoveFilter = useCallback((filterToRemove: GridFilter) => {
    setActiveFilters((current) => current.filter((filter) => filterKey(filter) !== filterKey(filterToRemove)));
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
              active={hasGlobalFilter('unreviewed')}
              onClick={() => handleGlobalFilterToggle('unreviewed')}
            />
            <FilterPill
              label="Approved"
              count={filterCounts?.unpublished ?? 0}
              active={hasGlobalFilter('unpublished')}
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
                columns={columns}
                rows={pagedRows.length}
                getCellContent={getCellContent}
                width={gridSize.width}
                height={gridSize.height}
                smoothScrollX
                smoothScrollY
                onHeaderClicked={onHeaderClicked}
                onHeaderContextMenu={onHeaderContextMenu}
                onHeaderMenuClick={onHeaderMenuClick}
                onCellClicked={onCellClicked}
                onMouseMove={onMouseMove}
                onCellActivated={onCellActivated}
                onCellEdited={onCellEdited}
                onFinishedEditing={onFinishedEditing}
                isOutsideClick={isEditorOutsideClick}
                cellActivationBehavior="double-click"
                onColumnResize={onColumnResize}
                drawCell={drawCell}
                rowMarkers="number"
                freezeColumns={1}
              />
            )}
            <FolderGridHeaderMenu
              columnTitle={headerMenu?.columnTitle ?? ''}
              bounds={headerMenu?.bounds ?? null}
              onShowNeedsReview={() => handleAddColumnFilter('unreviewed')}
              onShowApproved={() => handleAddColumnFilter('unpublished')}
              onClose={() => setHeaderMenu(null)}
            />
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

      {cellPopover &&
        selectedFolderPath &&
        workspacePath &&
        (() => {
          const { bounds, diffKind, value, fromValue, filename, fieldName } = cellPopover;
          const popoverWidth = Math.max(280, Math.floor(bounds.width));
          const left = Math.max(12, Math.min(bounds.x, window.innerWidth - popoverWidth - 12));

          return (
            <Portal target="#portal">
              <Box
                className="click-outside-ignore"
                ref={cellPopoverRef}
                style={{
                  position: 'fixed',
                  left,
                  top: Math.max(8, bounds.y - 8),
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
                <FieldValuePanel
                  value={value}
                  fromValue={fromValue}
                  diffKind={diffKind}
                  onApprove={
                    diffKind === 'unreviewed'
                      ? () => acceptGridCellChange(filename, fieldName, value, 'approve')
                      : undefined
                  }
                  onUndo={
                    diffKind === 'unreviewed'
                      ? () => acceptGridCellChange(filename, fieldName, fromValue, 'undo')
                      : diffKind === 'unpublished'
                        ? () => undoApprovedGridCellChange(filename, fieldName)
                        : undefined
                  }
                />
              </Box>
            </Portal>
          );
        })()}
    </Stack>
  );
});
