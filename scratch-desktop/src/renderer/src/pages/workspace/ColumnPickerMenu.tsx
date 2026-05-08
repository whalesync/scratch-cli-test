import { Box, Checkbox, Divider, Group, NativeSelect, Stack, TextInput } from '@mantine/core';
import { GripVertical } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
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
}: ColumnPickerMenuProps) {
  const { isDevToolsEnabled } = useDevTools();
  const [search, setSearch] = useState('');
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const hasGroups = (columnGroups?.length ?? 0) > 0;

  /** Set of all column IDs that belong to any group. */
  const groupedColumnSet = useMemo(() => {
    const set = new Set<string>();
    for (const g of columnGroups ?? []) {
      for (const id of g.columnIds) set.add(id);
    }
    return set;
  }, [columnGroups]);

  /** Map from column ID → group it belongs to. */
  const columnToGroup = useMemo(() => {
    const map = new Map<string, ColumnGroup>();
    for (const g of columnGroups ?? []) {
      for (const id of g.columnIds) map.set(id, g);
    }
    return map;
  }, [columnGroups]);

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

  const filteredSet = useMemo(() => new Set(filteredColumns), [filteredColumns]);

  /**
   * Build display items from the visible reorderable columns.
   * Consecutive columns that belong to the same group are collapsed into a single group item.
   */
  const displayItems: DisplayItem[] = useMemo(() => {
    if (!hasGroups) {
      return reorderableColumns.filter((c) => filteredSet.has(c)).map((c) => ({ kind: 'column', columnId: c }));
    }

    const items: DisplayItem[] = [];
    const seenGroups = new Set<string>();

    for (const colId of reorderableColumns) {
      if (!filteredSet.has(colId)) continue;
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
  }, [columnToGroup, filteredSet, hasGroups, reorderableColumns]);

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

  const toggleGroup = useCallback(
    (group: ColumnGroup) => {
      const allVisible = group.columnIds.every((id) => visibleSet.has(id));
      if (allVisible) {
        const toHide = new Set(group.columnIds.filter((id) => id !== titleColumnId));
        onChangeVisible(visibleColumns.filter((c) => !toHide.has(c)));
      } else {
        const toAdd = group.columnIds.filter((id) => !visibleSet.has(id));
        onChangeVisible([...visibleColumns, ...toAdd]);
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
      onChangeVisible(titleColumnId ? [titleColumnId, ...flat] : flat);
      setDragIdx(null);
      setDragOverIdx(null);
    },
    [displayItems, dragIdx, titleColumnId, onChangeVisible],
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
      />
    ) : null;

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
        {titleRow}

        {/* Visible items (reorderable) */}
        {displayItems.map((item, idx) => {
          if (item.kind === 'column') {
            return (
              <ColumnRow
                key={item.columnId}
                columnId={item.columnId}
                label={columnLabels?.get(item.columnId)}
                checked={true}
                disabled={false}
                draggable={true}
                highlight={dragOverIdx === idx && dragIdx !== idx}
                onToggle={() => toggleColumn(item.columnId)}
                onDragStart={(e) => onDragStart(e, idx)}
                onDragOver={(e) => onDragOver(e, idx)}
                onDrop={(e) => onDrop(e, idx)}
                onDragEnd={onDragEnd}
              />
            );
          }

          // Group item: group header row (draggable) + indented children (not individually draggable)
          const group = item.group;
          const allVisible = group.columnIds.every((id) => visibleSet.has(id));
          const someVisible = group.columnIds.some((id) => visibleSet.has(id));
          return (
            <Box key={`group:${group.name}`}>
              <ColumnRow
                columnId={group.name}
                label={group.name}
                checked={allVisible}
                indeterminate={someVisible && !allVisible}
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
                  />
                ))}
            </Box>
          );
        })}

        {/* Hidden items (not currently visible) */}
        {hasGroups
          ? // Render hidden ungrouped columns, then hidden groups
            (() => {
              const elements: React.ReactNode[] = [];

              // Hidden ungrouped columns
              filteredColumns
                .filter((c) => c !== titleColumnId && !visibleSet.has(c) && !groupedColumnSet.has(c))
                .forEach((columnId) => {
                  elements.push(
                    <ColumnRow
                      key={columnId}
                      columnId={columnId}
                      label={columnLabels?.get(columnId)}
                      checked={false}
                      disabled={false}
                      draggable={false}
                      onToggle={() => toggleColumn(columnId)}
                    />,
                  );
                });

              // Hidden groups (groups where no column is visible and not already in displayItems)
              for (const group of columnGroups ?? []) {
                const anyVisible = group.columnIds.some((id) => visibleSet.has(id));
                if (anyVisible) continue; // Already in displayItems
                const groupColsFiltered = group.columnIds.filter((id) => filteredSet.has(id));
                if (groupColsFiltered.length === 0) continue;
                elements.push(
                  <Box key={`group:${group.name}`}>
                    <ColumnRow
                      columnId={group.name}
                      label={group.name}
                      checked={false}
                      disabled={false}
                      draggable={false}
                      onToggle={() => toggleGroup(group)}
                    />
                    {groupColsFiltered.map((columnId) => (
                      <ColumnRow
                        key={columnId}
                        columnId={columnId}
                        label={columnLabels?.get(columnId)}
                        checked={false}
                        disabled={false}
                        draggable={false}
                        indented={true}
                        onToggle={() => toggleColumn(columnId)}
                      />
                    ))}
                  </Box>,
                );
              }

              return <>{elements}</>;
            })()
          : // No groups — flat hidden list
            filteredColumns
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
      <Text12Regular c={disabled ? 'var(--fg-muted)' : 'var(--fg-primary)'} style={{ userSelect: 'none' }}>
        {label ?? columnId}
      </Text12Regular>
    </Box>
  );
}
