import { Box, Checkbox, Divider, Group, NativeSelect, Stack, TextInput } from '@mantine/core';
import { GripVertical, Pencil } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ButtonSecondaryOutline } from '../../components/base/buttons';
import { Text12Regular } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import { useDevTools } from '../../hooks/use-dev-tools';

type ColumnPreset = 'all' | 'none' | 'needs-review' | 'approved';

interface ColumnGroup {
  name: string;
  columnIds: string[];
}

/** A top-level item in the reorderable list: either a standalone column or a group of columns. */
type DisplayItem = { kind: 'column'; columnId: string } | { kind: 'group'; group: ColumnGroup };

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
  /** Banner groups from the view — columns within groups are rendered together. */
  columnGroups?: ColumnGroup[];
  onChangeVisible: (columnIds: string[]) => void;
  /** Name of the active view (for dev widget). */
  activeViewName?: string;
  /** Names of on-disk view files (for dev widget). */
  availableViewNames?: string[];
  /** Callback to switch to a different view source (for dev widget). */
  onSwitchView?: (viewName: string) => void;
  /** Callback to open the Edit Property dialog for a column. */
  onEditProperty?: (columnId: string) => void;
}

/** Flatten display items back into a column ID array. */
function flattenItems(items: DisplayItem[]): string[] {
  const result: string[] = [];
  for (const item of items) {
    if (item.kind === 'column') {
      result.push(item.columnId);
    } else {
      result.push(...item.group.columnIds);
    }
  }
  return result;
}

export function ColumnPickerMenu({
  allColumns,
  visibleColumns,
  titleColumnId,
  unreviewedColumnIds,
  approvedColumnIds,
  columnLabels,
  columnGroups,
  onChangeVisible,
  activeViewName,
  availableViewNames,
  onSwitchView,
  onEditProperty,
}: ColumnPickerMenuProps) {
  const { isDevToolsEnabled } = useDevTools();
  const [search, setSearch] = useState('');
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const hasGroups = (columnGroups?.length ?? 0) > 0;

  /** Map from column ID → group it belongs to. */
  const columnToGroup = useMemo(() => {
    const map = new Map<string, ColumnGroup>();
    for (const g of columnGroups ?? []) {
      for (const id of g.columnIds) map.set(id, g);
    }
    return map;
  }, [columnGroups]);

  /**
   * Stable display order for all non-title columns.
   * Initialized from allColumns; only mutated by drag-reorder.
   * When the set of columns changes (allColumns identity), we reset to allColumns order.
   */
  const columnSetKey = useMemo(() => {
    const nonTitle = allColumns.filter((c) => c !== titleColumnId);
    return nonTitle.join('\0');
  }, [allColumns, titleColumnId]);

  const [displayOrder, setDisplayOrder] = useState<string[]>(() => allColumns.filter((c) => c !== titleColumnId));
  const prevColumnSetKeyRef = useRef(columnSetKey);

  useEffect(() => {
    if (prevColumnSetKeyRef.current !== columnSetKey) {
      prevColumnSetKeyRef.current = columnSetKey;
      setDisplayOrder(allColumns.filter((c) => c !== titleColumnId));
    }
  }, [columnSetKey, allColumns, titleColumnId]);

  const visibleSet = useMemo(() => new Set(visibleColumns), [visibleColumns]);

  const filteredSet = useMemo(() => {
    if (!search.trim()) return new Set(allColumns);
    const q = search.trim().toLowerCase();
    return new Set(
      allColumns.filter((c) => {
        const label = columnLabels?.get(c) ?? c;
        return label.toLowerCase().includes(q) || c.toLowerCase().includes(q);
      }),
    );
  }, [allColumns, columnLabels, search]);

  /**
   * Build display items from all columns (visible and hidden) in stable display order.
   * Consecutive columns that belong to the same group are collapsed into a single group item.
   */
  const displayItems: DisplayItem[] = useMemo(() => {
    const cols = displayOrder.filter((c) => filteredSet.has(c));

    if (!hasGroups) {
      return cols.map((c) => ({ kind: 'column', columnId: c }));
    }

    const items: DisplayItem[] = [];
    const seenGroups = new Set<string>();

    for (const colId of cols) {
      const group = columnToGroup.get(colId);
      if (group) {
        if (!seenGroups.has(group.name)) {
          seenGroups.add(group.name);
          items.push({ kind: 'group', group });
        }
      } else {
        items.push({ kind: 'column', columnId: colId });
      }
    }
    return items;
  }, [columnToGroup, filteredSet, hasGroups, displayOrder]);

  const toggleColumn = useCallback(
    (columnId: string) => {
      if (columnId === titleColumnId) return;
      if (visibleSet.has(columnId)) {
        onChangeVisible(visibleColumns.filter((c) => c !== columnId));
      } else {
        // Insert into visibleColumns at the position that preserves displayOrder.
        const orderIndex = displayOrder.indexOf(columnId);
        const next = [...visibleColumns];
        // Find the right insertion point: after the last visible column that precedes this one in displayOrder.
        let insertAt = next.length;
        for (let i = next.length - 1; i >= 0; i--) {
          const existingIdx = displayOrder.indexOf(next[i]);
          if (existingIdx < orderIndex) {
            insertAt = i + 1;
            break;
          }
          if (i === 0) insertAt = 0;
        }
        next.splice(insertAt, 0, columnId);
        onChangeVisible(next);
      }
    },
    [titleColumnId, visibleSet, visibleColumns, displayOrder, onChangeVisible],
  );

  const toggleGroup = useCallback(
    (group: ColumnGroup) => {
      const allGroupVisible = group.columnIds.every((id) => visibleSet.has(id));
      if (allGroupVisible) {
        const toHide = new Set(group.columnIds.filter((id) => id !== titleColumnId));
        onChangeVisible(visibleColumns.filter((c) => !toHide.has(c)));
      } else {
        // Add missing group columns at their displayOrder positions.
        const toAdd = group.columnIds.filter((id) => !visibleSet.has(id));
        const next = [...visibleColumns];
        for (const columnId of toAdd) {
          const orderIndex = displayOrder.indexOf(columnId);
          let insertAt = next.length;
          for (let i = next.length - 1; i >= 0; i--) {
            const existingIdx = displayOrder.indexOf(next[i]);
            if (existingIdx < orderIndex) {
              insertAt = i + 1;
              break;
            }
            if (i === 0) insertAt = 0;
          }
          next.splice(insertAt, 0, columnId);
        }
        onChangeVisible(next);
      }
    },
    [titleColumnId, visibleSet, visibleColumns, displayOrder, onChangeVisible],
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

  // ── Drag-and-drop on display items ──

  const onDragStart = useCallback((e: React.DragEvent, idx: number) => {
    setDragIdx(idx);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

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
      const next = [...displayItems];
      const [moved] = next.splice(dragIdx, 1);
      next.splice(dropIdx, 0, moved);
      const flat = flattenItems(next);
      // Persist the new display order so it doesn't snap back.
      setDisplayOrder(flat);
      // Emit only visible columns in the new order.
      const visibleInOrder = flat.filter((c) => visibleSet.has(c));
      onChangeVisible(titleColumnId ? [titleColumnId, ...visibleInOrder] : visibleInOrder);
      setDragIdx(null);
      setDragOverIdx(null);
    },
    [displayItems, dragIdx, titleColumnId, visibleSet, onChangeVisible],
  );

  const onDragEnd = useCallback(() => {
    setDragIdx(null);
    setDragOverIdx(null);
  }, []);

  // ── Render ──

  const titleRow =
    titleColumnId && allColumns.includes(titleColumnId) && filteredSet.has(titleColumnId) ? (
      <ColumnRow
        key={titleColumnId}
        columnId={titleColumnId}
        label={columnLabels?.get(titleColumnId)}
        checked={true}
        disabled={true}
        draggable={false}
        onToggle={() => {}}
        onEditProperty={onEditProperty ? () => onEditProperty(titleColumnId) : undefined}
      />
    ) : null;

  return (
    <Stack gap="xs">
      <style>{'.column-picker-row:hover .column-picker-edit-icon { opacity: 1 !important; }'}</style>
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
        {titleRow}

        {/* All columns in order (visible and hidden together) */}
        {displayItems.map((item, idx) => {
          if (item.kind === 'column') {
            const isVisible = visibleSet.has(item.columnId);
            return (
              <ColumnRow
                key={item.columnId}
                columnId={item.columnId}
                label={columnLabels?.get(item.columnId)}
                checked={isVisible}
                disabled={false}
                draggable={true}
                highlight={dragOverIdx === idx && dragIdx !== idx}
                onToggle={() => toggleColumn(item.columnId)}
                onDragStart={(e) => onDragStart(e, idx)}
                onDragOver={(e) => onDragOver(e, idx)}
                onDrop={(e) => onDrop(e, idx)}
                onDragEnd={onDragEnd}
                onEditProperty={onEditProperty ? () => onEditProperty(item.columnId) : undefined}
              />
            );
          }

          // Group item: group header row (draggable) + indented children (not individually draggable)
          const group = item.group;
          const allGroupVisible = group.columnIds.every((id) => visibleSet.has(id));
          const someVisible = group.columnIds.some((id) => visibleSet.has(id));
          return (
            <Box key={`group:${group.name}`}>
              <ColumnRow
                columnId={group.name}
                label={group.name}
                checked={allGroupVisible}
                indeterminate={someVisible && !allGroupVisible}
                disabled={false}
                draggable={true}
                highlight={dragOverIdx === idx && dragIdx !== idx}
                onToggle={() => toggleGroup(group)}
                onDragStart={(e) => onDragStart(e, idx)}
                onDragOver={(e) => onDragOver(e, idx)}
                onDrop={(e) => onDrop(e, idx)}
                onDragEnd={onDragEnd}
              />
              {group.columnIds
                .filter((id) => filteredSet.has(id))
                .map((columnId) => (
                  <ColumnRow
                    key={columnId}
                    columnId={columnId}
                    label={columnLabels?.get(columnId)}
                    checked={visibleSet.has(columnId)}
                    disabled={false}
                    draggable={false}
                    indented={true}
                    onToggle={() => toggleColumn(columnId)}
                    onEditProperty={onEditProperty ? () => onEditProperty(columnId) : undefined}
                  />
                ))}
            </Box>
          );
        })}
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
              value={activeViewName ?? 'Generated (legacy)'}
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
  indeterminate,
  disabled,
  draggable,
  indented,
  highlight,
  onToggle,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onEditProperty,
}: {
  columnId: string;
  label?: string;
  checked: boolean;
  indeterminate?: boolean;
  disabled: boolean;
  draggable: boolean;
  indented?: boolean;
  highlight?: boolean;
  onToggle: () => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  onEditProperty?: () => void;
}) {
  return (
    <Box
      className="column-picker-row"
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
        paddingLeft: indented ? 20 : 4,
        borderRadius: 6,
        borderTop: highlight ? '2px solid var(--mantine-color-blue-4)' : '2px solid transparent',
        cursor: draggable ? 'grab' : undefined,
      }}
    >
      <StyledLucideIcon Icon={GripVertical} size="xs" c={draggable ? 'var(--fg-muted)' : 'var(--fg-divider)'} />
      <Checkbox
        size="xs"
        checked={checked}
        indeterminate={indeterminate}
        disabled={disabled}
        onChange={onToggle}
        styles={{ input: { cursor: disabled ? 'default' : 'pointer' } }}
      />
      <Text12Regular
        c={disabled ? 'var(--fg-muted)' : 'var(--fg-primary)'}
        style={{ userSelect: 'none', flex: 1, minWidth: 0 }}
      >
        {label ?? columnId}
      </Text12Regular>
      {onEditProperty && (
        <Box
          className="column-picker-edit-icon"
          onClick={(e) => {
            e.stopPropagation();
            onEditProperty();
          }}
          style={{ cursor: 'pointer', opacity: 0, flexShrink: 0, display: 'flex', alignItems: 'center' }}
        >
          <StyledLucideIcon Icon={Pencil} size="sm" c="var(--fg-muted)" />
        </Box>
      )}
    </Box>
  );
}
