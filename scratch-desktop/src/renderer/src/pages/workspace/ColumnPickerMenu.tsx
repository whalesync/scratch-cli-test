import { Box, Checkbox, Divider, Group, NativeSelect, Stack, TextInput } from '@mantine/core';
import { GripVertical } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { ButtonSecondaryOutline } from '../../components/base/buttons';
import { Text12Regular } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import { useDevTools } from '../../hooks/use-dev-tools';

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
  /** Map from column ID to display label. Falls back to the raw ID when missing. */
  columnLabels?: Map<string, string>;
  onChangeVisible: (columnIds: string[]) => void;
  /** Name of the active view (for dev widget). */
  activeViewName?: string;
  /** Names of on-disk view files (for dev widget). */
  availableViewNames?: string[];
  /** Callback to switch to a different view source (for dev widget). */
  onSwitchView?: (viewName: string) => void;
}

export function ColumnPickerMenu({
  allColumns,
  visibleColumns,
  titleColumnId,
  unreviewedColumnIds,
  approvedColumnIds,
  columnLabels,
  onChangeVisible,
  activeViewName,
  availableViewNames,
  onSwitchView,
}: ColumnPickerMenuProps) {
  const { isDevToolsEnabled } = useDevTools();
  const [search, setSearch] = useState('');
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  // Reorderable columns = visible minus title column
  const reorderableColumns = useMemo(
    () => visibleColumns.filter((c) => c !== titleColumnId),
    [visibleColumns, titleColumnId],
  );

  const visibleSet = useMemo(() => new Set(visibleColumns), [visibleColumns]);

  const filteredColumns = useMemo(() => {
    if (!search.trim()) return allColumns;
    const q = search.trim().toLowerCase();
    return allColumns.filter((c) => {
      const label = columnLabels?.get(c) ?? c;
      return label.toLowerCase().includes(q) || c.toLowerCase().includes(q);
    });
  }, [allColumns, columnLabels, search]);

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

  return (
    <Stack gap="xs">
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
          maxHeight: 'calc(80vh - 120px)',
          overflowY: 'auto',
          overflowX: 'hidden',
        }}
      >
        {/* Title column — always first, not toggleable (only show if it's a real data column) */}
        {titleColumnId &&
          allColumns.includes(titleColumnId) &&
          (!search.trim() ||
            (columnLabels?.get(titleColumnId) ?? titleColumnId).toLowerCase().includes(search.trim().toLowerCase()) ||
            titleColumnId.toLowerCase().includes(search.trim().toLowerCase())) && (
            <ColumnRow
              columnId={titleColumnId}
              label={columnLabels?.get(titleColumnId)}
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
              label={columnLabels?.get(columnId)}
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
              label={columnLabels?.get(columnId)}
              checked={false}
              disabled={false}
              draggable={false}
              onToggle={() => toggleColumn(columnId)}
            />
          ))}
      </Stack>

      {isDevToolsEnabled && onSwitchView && (
        <>
          <Divider my={4} />
          <Box px={4} pb={4}>
            <Text12Regular c="var(--mantine-color-devTool-9)" mb={4}>
              View source
            </Text12Regular>
            <NativeSelect
              size="xs"
              value={activeViewName ?? 'Generated'}
              onChange={(e) => onSwitchView(e.currentTarget.value)}
              data={viewSourceOptions(availableViewNames)}
              styles={{
                input: {
                  borderColor: 'var(--mantine-color-devTool-9)',
                  color: 'var(--mantine-color-devTool-9)',
                },
              }}
            />
          </Box>
        </>
      )}
    </Stack>
  );
}

function viewSourceOptions(availableViewNames?: string[]): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = [{ value: 'Generated', label: 'Generated' }];
  for (const name of availableViewNames ?? []) {
    options.push({ value: name, label: name });
  }
  return options;
}

// ── Sub-components ──

function ColumnRow({
  columnId,
  label,
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
  label?: string;
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
        {label ?? columnId}
      </Text12Regular>
    </Box>
  );
}
