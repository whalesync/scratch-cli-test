import DataEditor, {
  GridCellKind,
  type CellClickedEventArgs,
  type CustomCell,
  type CustomRenderer,
  type GridColumn,
  type Item,
} from '@glideapps/glide-data-grid';
import '@glideapps/glide-data-grid/dist/index.css';
import { Box } from '@mantine/core';
import { diffWordsWithSpace, type Change } from 'diff';
import { useCallback, useState, type ReactNode } from 'react';

const OLD_SENTENCE = 'a table and a chair';
const NEW_SENTENCE = 'the table and the chair';

type DiffPart = { kind: 'equal'; text: string } | { kind: 'removed'; text: string } | { kind: 'added'; text: string };

interface PlaygroundDiffCellData {
  kind: 'playground-diff-cell';
  parts: DiffPart[];
}

type PlaygroundDiffCell = CustomCell<PlaygroundDiffCellData>;

const playgroundColumns: GridColumn[] = [
  { id: 'old', title: 'Old', width: 210 },
  { id: 'new', title: 'New', width: 210 },
];

function toDiffPart(change: Change): DiffPart {
  if (change.removed) {
    return { kind: 'removed', text: change.value };
  }
  if (change.added) {
    return { kind: 'added', text: change.value };
  }
  return { kind: 'equal', text: change.value };
}

const sentenceDiff = diffWordsWithSpace(OLD_SENTENCE, NEW_SENTENCE).map(toDiffPart);

interface ContextMenuState {
  x: number;
  y: number;
  cell: Item;
  submenuOpen: boolean;
}

const playgroundDiffRenderer: CustomRenderer<PlaygroundDiffCell> = {
  kind: GridCellKind.Custom,
  isMatch: (cell): cell is PlaygroundDiffCell =>
    typeof cell.data === 'object' &&
    cell.data !== null &&
    (cell.data as PlaygroundDiffCellData).kind === 'playground-diff-cell',
  draw: ({ ctx, rect, cell, theme }) => {
    const y = rect.y + rect.height / 2;
    let cursor = rect.x + 10;

    const drawPart = (part: DiffPart) => {
      const isRemoved = part.kind === 'removed';
      const isAdded = part.kind === 'added';
      const color = isRemoved ? '#dc2626' : isAdded ? '#16a34a' : theme.textDark;
      const text = isRemoved ? `(${part.text})` : isAdded ? `(${part.text})` : part.text;

      ctx.font = `${isAdded ? '700' : theme.baseFontStyle} ${theme.fontFamily}`;
      ctx.fillStyle = color;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, cursor, y);

      const width = ctx.measureText(text).width;
      if (isRemoved) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cursor, y);
        ctx.lineTo(cursor + width, y);
        ctx.stroke();
      }

      cursor += width;
    };

    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x + 8, rect.y + 1, rect.width - 16, rect.height - 2);
    ctx.clip();
    cell.data.parts.forEach(drawPart);
    ctx.restore();
    return true;
  },
};

function getPlaygroundCellContent([col, row]: Item) {
  if (col === 0 && row === 0) {
    return {
      kind: GridCellKind.Custom as const,
      allowOverlay: false as const,
      copyData: `${OLD_SENTENCE} -> ${NEW_SENTENCE}`,
      data: { kind: 'playground-diff-cell' as const, parts: sentenceDiff } satisfies PlaygroundDiffCellData,
    };
  }

  const display =
    col === 0 && row === 1
      ? OLD_SENTENCE
      : col === 1 && row === 1
        ? NEW_SENTENCE
        : `Diff: ${OLD_SENTENCE} -> ${NEW_SENTENCE}`;

  return {
    kind: GridCellKind.Text as const,
    data: display,
    displayData: display,
    allowOverlay: false as const,
  };
}

export function AdminPlaygroundGrid() {
  const [columns, setColumns] = useState<GridColumn[]>(playgroundColumns);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const openContextMenu = useCallback((cell: Item, event: CellClickedEventArgs) => {
    event.preventDefault();
    setContextMenu({ x: event.localEventX, y: event.localEventY, cell, submenuOpen: false });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const openSubmenu = useCallback(() => {
    setContextMenu((current) => (current ? { ...current, submenuOpen: true } : current));
  }, []);

  const closeSubmenu = useCallback(() => {
    setContextMenu((current) => (current ? { ...current, submenuOpen: false } : current));
  }, []);

  const handleColumnResize = useCallback((_column: GridColumn, newSize: number, colIndex: number) => {
    setColumns((current) =>
      current.map((column, index) => (index === colIndex ? { ...column, width: newSize } : column)),
    );
  }, []);

  return (
    <Box
      style={{
        position: 'relative',
        width: 420,
      }}
    >
      <Box
        style={{
          border: '1px solid var(--mantine-color-gray-3)',
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        <DataEditor
          columns={columns}
          rows={2}
          getCellContent={getPlaygroundCellContent}
          width={420}
          height={132}
          rowHeight={44}
          headerHeight={34}
          smoothScrollX
          smoothScrollY
          onCellClicked={closeContextMenu}
          onCellContextMenu={openContextMenu}
          onColumnResize={handleColumnResize}
          customRenderers={[playgroundDiffRenderer]}
        />
      </Box>
      {contextMenu && (
        <Box
          role="menu"
          style={{
            position: 'absolute',
            top: contextMenu.y,
            left: contextMenu.x,
            zIndex: 10,
            minWidth: 150,
            border: '1px solid var(--mantine-color-gray-3)',
            borderRadius: 8,
            background: 'var(--mantine-color-body)',
            boxShadow: '0 12px 30px rgba(15, 23, 42, 0.18)',
            padding: 4,
          }}
        >
          <ContextMenuButton onClick={closeContextMenu}>
            Inspect cell {contextMenu.cell[0] + 1}, {contextMenu.cell[1] + 1}
          </ContextMenuButton>
          <Box onMouseEnter={openSubmenu} onMouseLeave={closeSubmenu} style={{ position: 'relative' }}>
            <ContextMenuButton onClick={openSubmenu}>Transform ›</ContextMenuButton>
            {contextMenu.submenuOpen && (
              <Box
                role="menu"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: '100%',
                  minWidth: 128,
                  border: '1px solid var(--mantine-color-gray-3)',
                  borderRadius: 8,
                  background: 'var(--mantine-color-body)',
                  boxShadow: '0 12px 30px rgba(15, 23, 42, 0.18)',
                  padding: 4,
                }}
              >
                <ContextMenuButton onClick={closeContextMenu}>Prefer old</ContextMenuButton>
                <ContextMenuButton onClick={closeContextMenu}>Prefer new</ContextMenuButton>
              </Box>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}

function ContextMenuButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        border: 0,
        borderRadius: 6,
        background: 'transparent',
        color: 'var(--mantine-color-text)',
        cursor: 'pointer',
        font: 'inherit',
        padding: '7px 9px',
        textAlign: 'left',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  );
}
