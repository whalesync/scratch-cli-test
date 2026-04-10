import { Box, Checkbox, Divider, Group, Portal, Stack, TextInput } from '@mantine/core';
import { GripVertical } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ButtonSecondaryOutline } from '../../components/base/buttons';
import { Text12Regular } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';

type ColumnPreset = 'all' | 'none' | 'needs-review' | 'approved';

interface ColumnPickerMenuProps {
  /** All available column IDs, in schema order. */
  allColumns: string[];
  /** Currently visible column IDs, in display order. */
  visibleColumns: string[];
  /** The title/primary column ID — always visible and pinned first. */
  titleColumnId: string | null;
  /** Column IDs that have unreviewed changes in at least one row. */
  unreviewedColumnIds: string[];
  /** Column IDs that have approved (unpublished) changes in at least one row. */
  approvedColumnIds: string[];
  /** Bounding rect of the trigger button, used for positioning. */
  anchorRect: DOMRect;
  onChangeVisible: (columnIds: string[]) => void;
  onClose: () => void;
}

export function ColumnPickerMenu({
  allColumns,
  visibleColumns,
  titleColumnId,
  unreviewedColumnIds,
  approvedColumnIds,
  anchorRect,
  onChangeVisible,
  onClose,
}: ColumnPickerMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [search, setSearch] = useState('');
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  // Close on outside click
  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (menuRef.current?.contains(target)) return;
      onClose();
    };

    window.addEventListener('mousedown', handlePointerDown, true);
    return () => window.removeEventListener('mousedown', handlePointerDown, true);
  }, [onClose]);

  // Reorderable columns = visible minus title column
  const reorderableColumns = useMemo(
    () => visibleColumns.filter((c) => c !== titleColumnId),
    [visibleColumns, titleColumnId],
  );

  const visibleSet = useMemo(() => new Set(visibleColumns), [visibleColumns]);

  const filteredColumns = useMemo(() => {
    if (!search.trim()) return allColumns;
    const q = search.trim().toLowerCase();
    return allColumns.filter((c) => c.toLowerCase().includes(q));
  }, [allColumns, search]);

  const toggleColumn = useCallback(
    (columnId: string) => {
      if (columnId === titleColumnId) return;
      if (visibleSet.has(columnId)) {
        onChangeVisible(visibleColumns.filter((c) => c !== columnId));
      } else {
        onChangeVisible([...visibleColumns, columnId]);
      }
    },
    [titleColumnId, visibleSet, visibleColumns, onChangeVisible],
  );

  const applyPreset = useCallback(
    (preset: ColumnPreset) => {
      switch (preset) {
        case 'all':
          onChangeVisible(allColumns);
          break;
        case 'none':
          onChangeVisible(titleColumnId ? [titleColumnId] : []);
          break;
        case 'needs-review':
          onChangeVisible(
            titleColumnId
              ? [titleColumnId, ...unreviewedColumnIds.filter((c) => c !== titleColumnId)]
              : [...unreviewedColumnIds],
          );
          break;
        case 'approved':
          onChangeVisible(
            titleColumnId
              ? [titleColumnId, ...approvedColumnIds.filter((c) => c !== titleColumnId)]
              : [...approvedColumnIds],
          );
          break;
      }
    },
    [allColumns, titleColumnId, unreviewedColumnIds, approvedColumnIds, onChangeVisible],
  );

  // Drag-and-drop reorder
  const onDragStart = useCallback(
    (e: React.DragEvent, idx: number) => {
      if (reorderableColumns[idx] === titleColumnId) return;
      setDragIdx(idx);
      e.dataTransfer.effectAllowed = 'move';
    },
    [reorderableColumns, titleColumnId],
  );

  const onDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIdx(idx);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent, dropIdx: number) => {
      e.preventDefault();
      if (dragIdx == null || dragIdx === dropIdx) {
        setDragIdx(null);
        setDragOverIdx(null);
        return;
      }
      const next = [...reorderableColumns];
      const [moved] = next.splice(dragIdx, 1);
      next.splice(dropIdx, 0, moved);
      onChangeVisible(titleColumnId ? [titleColumnId, ...next] : next);
      setDragIdx(null);
      setDragOverIdx(null);
    },
    [dragIdx, reorderableColumns, titleColumnId, onChangeVisible],
  );

  const onDragEnd = useCallback(() => {
    setDragIdx(null);
    setDragOverIdx(null);
  }, []);

  // Positioning
  const menuWidth = 420;
  const left = Math.max(12, Math.min(anchorRect.left, window.innerWidth - menuWidth - 12));
  const top = Math.max(12, Math.min(anchorRect.bottom + 4, window.innerHeight - 420));

  return (
    <Portal target="#portal">
      <Box
        ref={menuRef}
        style={{
          position: 'fixed',
          left,
          top,
          zIndex: 10020,
          width: menuWidth,
          maxHeight: 420,
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: 'var(--bg-base)',
          border: '1px solid var(--fg-divider)',
          borderRadius: 10,
          boxShadow: '0 18px 32px rgba(15, 23, 42, 0.16)',
          padding: 8,
        }}
      >
        {/* Preset buttons */}
        <Group gap={4} px={4} pb={4}>
          <ButtonSecondaryOutline size="compact-xs" style={{ flex: 1 }} onClick={() => applyPreset('all')}>
            All
          </ButtonSecondaryOutline>
          <ButtonSecondaryOutline size="compact-xs" style={{ flex: 1 }} onClick={() => applyPreset('none')}>
            None
          </ButtonSecondaryOutline>
          <ButtonSecondaryOutline size="compact-xs" style={{ flex: 1 }} onClick={() => applyPreset('needs-review')}>
            Needs review
          </ButtonSecondaryOutline>
          <ButtonSecondaryOutline size="compact-xs" style={{ flex: 1 }} onClick={() => applyPreset('approved')}>
            Approved
          </ButtonSecondaryOutline>
        </Group>

        <Divider my={4} />

        {/* Search */}
        <Box px={4} pb={4}>
          <TextInput
            placeholder="Search columns..."
            size="xs"
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
          />
        </Box>

        {/* Column list */}
        <Stack
          gap={0}
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
          }}
        >
          {/* Title column — always first, not toggleable (only show if it's a real data column) */}
          {titleColumnId &&
            allColumns.includes(titleColumnId) &&
            (!search.trim() || titleColumnId.toLowerCase().includes(search.trim().toLowerCase())) && (
              <ColumnRow
                columnId={titleColumnId}
                checked={true}
                disabled={true}
                draggable={false}
                onToggle={() => {}}
              />
            )}

          {/* Remaining columns in display order (visible first for reorder, then hidden) */}
          {reorderableColumns
            .filter((c) => filteredColumns.includes(c))
            .map((columnId, idx) => (
              <ColumnRow
                key={columnId}
                columnId={columnId}
                checked={true}
                disabled={false}
                draggable={true}
                highlight={dragOverIdx === idx && dragIdx !== idx}
                onToggle={() => toggleColumn(columnId)}
                onDragStart={(e) => onDragStart(e, idx)}
                onDragOver={(e) => onDragOver(e, idx)}
                onDrop={(e) => onDrop(e, idx)}
                onDragEnd={onDragEnd}
              />
            ))}

          {/* Hidden columns */}
          {filteredColumns
            .filter((c) => c !== titleColumnId && !visibleSet.has(c))
            .map((columnId) => (
              <ColumnRow
                key={columnId}
                columnId={columnId}
                checked={false}
                disabled={false}
                draggable={false}
                onToggle={() => toggleColumn(columnId)}
              />
            ))}
        </Stack>
      </Box>
    </Portal>
  );
}

// ── Sub-components ──

function ColumnRow({
  columnId,
  checked,
  disabled,
  draggable,
  highlight,
  onToggle,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  columnId: string;
  checked: boolean;
  disabled: boolean;
  draggable: boolean;
  highlight?: boolean;
  onToggle: () => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
}) {
  return (
    <Box
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 4px',
        borderRadius: 6,
        borderTop: highlight ? '2px solid var(--mantine-color-blue-4)' : '2px solid transparent',
        cursor: draggable ? 'grab' : undefined,
      }}
    >
      <StyledLucideIcon Icon={GripVertical} size="xs" c={draggable ? 'var(--fg-muted)' : 'var(--fg-divider)'} />
      <Checkbox
        size="xs"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
        styles={{ input: { cursor: disabled ? 'default' : 'pointer' } }}
      />
      <Text12Regular c={disabled ? 'var(--fg-muted)' : 'var(--fg-primary)'} style={{ userSelect: 'none' }}>
        {columnId}
      </Text12Regular>
    </Box>
  );
}
