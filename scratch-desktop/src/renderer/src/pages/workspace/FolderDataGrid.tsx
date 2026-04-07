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
import { Box, Group, Loader, Modal, Stack, Textarea } from '@mantine/core';
import { diffWordsWithSpace } from 'diff';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ButtonDangerLight, ButtonPrimaryLight, ButtonSecondaryOutline } from '../../components/base/buttons';
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

// ── Diff colours (working vs dirty) ──

const DIFF_WORKING_BG = '#dbeafe'; // blue-100
const DIFF_WORKING_BORDER = '#60a5fa'; // blue-400

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

// ── Custom cell: changed field (light blue bg + left border, current value only) ──

interface DiffCellData {
  kind: 'diff-cell';
  displayText: string;
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
    const { displayText, isIdCol } = cell.data;
    const BORDER_W = 3;
    const PADDING = 8;
    const iconSize = 12;
    const iconPad = 6;
    const hoverReserve = isIdCol && hoverAmount > 0 ? iconSize + iconPad : 0;

    ctx.save();

    // Left border
    ctx.fillStyle = DIFF_WORKING_BORDER;
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
  modified: undefined, // cell-level blue only
  deleted: '#fef2f2',
  unchanged: undefined,
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
  const [cellModal, setCellModal] = useState<{
    col: number;
    row: number;
    filename: string;
    fieldName: string;
    value: string;
    dirtyValue: string;
    isDiff: boolean;
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
  }, [selectedFolderPath, workspacePath, reloadKey]);

  // Reset state when folder changes
  useEffect(() => {
    setSort({ column: null, direction: null });
    setColumnWidths({});
    setDetailRowIndex(null);
    setSchema(null);
    setCellModal(null);
    setCellModalEditing(false);
    setReloadKey(0);
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
      const rowBg = ROW_TINT[status];
      const rowTheme = rowBg ? { bgCell: rowBg } : undefined;

      const val = r[colId];

      // Changed cell in a modified row: blue bg + left border via DiffCell renderer
      if (status === 'modified' && r.__changedFields.includes(colId)) {
        return {
          kind: GridCellKind.Custom as const,
          allowOverlay: false as const,
          ...(col === 0 ? { cursor: 'pointer' } : {}),
          copyData: toDisplayString(val),
          themeOverride: { bgCell: DIFF_WORKING_BG },
          data: {
            kind: 'diff-cell' as const,
            displayText: toDisplayString(val),
            isIdCol: col === 0,
          } satisfies DiffCellData,
        };
      }

      // First column (not a diff): ID cell with inspect-on-hover magnifying glass
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

      // All other cells: standard rendering with optional row tint
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

  const onCellClicked = useCallback(([col, row]: Item, event: CellClickedEventArgs) => {
    if (col !== 0) return;
    // Only open record detail when the click lands on the inspect icon (right edge of cell)
    const iconSize = 12;
    const iconPad = 6;
    const iconZoneWidth = iconSize + iconPad * 2;
    if (event.localEventX >= event.bounds.width - iconZoneWidth) {
      setDetailRowIndex(row);
    }
  }, []);

  // Double-click or Enter opens the cell modal.
  // Diff cells (modified + changed field) open in view mode; all others go straight to edit mode.
  const onCellActivated = useCallback(
    ([col, row]: Item) => {
      const r = sortedRows[row] as DiffRow | undefined;
      const colId = columns[col]?.id;
      if (!r || !colId) return;
      // Skip deleted rows — no working copy file to edit
      if (r.__rowStatus === 'deleted') return;
      const isDiff = r.__rowStatus === 'modified' && r.__changedFields.includes(colId);
      const value = toDisplayString(r[colId]);
      setCellModal({
        col,
        row,
        filename: r.__filename,
        fieldName: colId,
        value,
        dirtyValue: toDisplayString(r.__fromFields[colId]),
        isDiff,
      });
      if (!isDiff) {
        setCellModalEditValue(value);
        setCellModalEditing(true);
      } else {
        setCellModalEditing(false);
      }
    },
    [sortedRows, columns],
  );

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
                    <Box style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: DIFF_WORKING_BORDER }} />
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

      <Modal opened={cellModal !== null} onClose={() => setCellModal(null)} title={cellModal?.fieldName} size="lg">
        {cellModal && selectedFolderPath && workspacePath && (
          <Group align="flex-start" gap="md" wrap="nowrap">
            <Box style={{ flex: 1, minWidth: 0 }}>
              {cellModalEditing ? (
                <Textarea
                  autoFocus
                  autosize
                  minRows={4}
                  value={cellModalEditValue}
                  onChange={(e) => setCellModalEditValue(e.currentTarget.value)}
                  styles={
                    cellModal.isDiff
                      ? {
                          input: {
                            backgroundColor: DIFF_WORKING_BG,
                            borderLeft: `4px solid ${DIFF_WORKING_BORDER}`,
                            borderRadius: 4,
                            fontFamily: 'monospace',
                            fontSize: 13,
                          },
                        }
                      : { input: { fontFamily: 'monospace', fontSize: 13 } }
                  }
                />
              ) : (
                <Box
                  style={{
                    backgroundColor: DIFF_WORKING_BG,
                    borderLeft: `4px solid ${DIFF_WORKING_BORDER}`,
                    borderRadius: 4,
                    padding: '12px 16px',
                    fontFamily: 'monospace',
                    fontSize: 13,
                    lineHeight: 1.6,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                  }}
                >
                  {diffWordsWithSpace(cellModal.dirtyValue, cellModal.value).map((part, i) => {
                    if (part.removed) {
                      return (
                        <span key={i} style={{ color: '#dc2626', textDecoration: 'line-through' }}>
                          {part.value}
                        </span>
                      );
                    }
                    if (part.added) {
                      return (
                        <span key={i} style={{ color: '#16a34a', fontWeight: 700 }}>
                          {part.value}
                        </span>
                      );
                    }
                    return <span key={i}>{part.value}</span>;
                  })}
                </Box>
              )}
            </Box>

            <Stack gap="xs" style={{ flexShrink: 0, width: 100 }}>
              {cellModalEditing ? (
                <>
                  <ButtonPrimaryLight
                    fullWidth
                    onClick={() => {
                      void window.scratchFiles
                        .acceptCellChange(
                          selectedFolderPath,
                          workspacePath,
                          cellModal.filename,
                          cellModal.fieldName,
                          cellModalEditValue,
                        )
                        .then(() => {
                          setCellModal(null);
                          setReloadKey((k) => k + 1);
                        })
                        .catch((err: unknown) => {
                          console.error('[acceptCellChange] save failed:', err);
                        });
                    }}
                  >
                    Save
                  </ButtonPrimaryLight>
                  <ButtonSecondaryOutline
                    fullWidth
                    onClick={() => {
                      if (cellModal.isDiff) {
                        setCellModalEditing(false);
                      } else {
                        setCellModal(null);
                      }
                    }}
                  >
                    Cancel
                  </ButtonSecondaryOutline>
                </>
              ) : (
                <>
                  <ButtonPrimaryLight
                    fullWidth
                    onClick={() => {
                      void window.scratchFiles
                        .acceptCellChange(
                          selectedFolderPath,
                          workspacePath,
                          cellModal.filename,
                          cellModal.fieldName,
                          cellModal.value,
                        )
                        .then(() => {
                          setCellModal(null);
                          setReloadKey((k) => k + 1);
                        })
                        .catch((err: unknown) => {
                          console.error('[acceptCellChange] approve failed:', err);
                        });
                    }}
                  >
                    Approve
                  </ButtonPrimaryLight>
                  <ButtonDangerLight
                    fullWidth
                    onClick={() => {
                      void window.scratchFiles
                        .acceptCellChange(
                          selectedFolderPath,
                          workspacePath,
                          cellModal.filename,
                          cellModal.fieldName,
                          cellModal.dirtyValue,
                        )
                        .then(() => {
                          setCellModal(null);
                          setReloadKey((k) => k + 1);
                        })
                        .catch((err: unknown) => {
                          console.error('[acceptCellChange] undo failed:', err);
                        });
                    }}
                  >
                    Undo
                  </ButtonDangerLight>
                  <ButtonSecondaryOutline
                    fullWidth
                    onClick={() => {
                      setCellModalEditValue(cellModal.value);
                      setCellModalEditing(true);
                    }}
                  >
                    Edit
                  </ButtonSecondaryOutline>
                </>
              )}
            </Stack>
          </Group>
        )}
      </Modal>
    </Stack>
  );
});
