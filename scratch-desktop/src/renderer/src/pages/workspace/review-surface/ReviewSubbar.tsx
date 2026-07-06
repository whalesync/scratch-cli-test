import { ButtonSecondaryGhost } from '@/components/base/buttons';
import { Text12Medium } from '@/components/base/text';
import { StyledLucideIcon } from '@/components/icons/StyledLucideIcon';
import { Box, Divider, Group, Popover } from '@mantine/core';
import { Columns3 } from 'lucide-react';
import type { GridFilter, ReviewSurfaceViewMode } from '../../../stores/workspace-ui-store';
import { ColumnPickerMenu } from '../ColumnPickerMenu';

const VIEW_OPTIONS: { value: ReviewSurfaceViewMode; label: string }[] = [
  { value: 'table', label: 'Table' },
  // Internal enum stays 'by-type'; the user-facing label is "By field" (DEV-10667).
  { value: 'by-type', label: 'By field' },
];

/** The global filters this subbar can set exclusively — `null` selects the "All" (unfiltered) view. */
export type ReviewGlobalFilter = 'pending' | 'has-problems' | null;

/** Everything `ColumnPickerMenu` needs, gathered so the subbar's prop list stays readable. */
export interface ReviewColumnPickerModel {
  /** All pickable (non-hidden view) column ids, in display order. */
  allColumns: string[];
  /** Currently visible column ids (the effective set — narrowed default or user override). */
  visibleColumns: string[];
  titleColumnId: string | null;
  /** Column ids carrying an unreviewed change (for the picker's "Needs review" preset). */
  unreviewedColumnIds: string[];
  /** Column ids carrying an approved-unpublished change (for the picker's "Approved" preset). */
  approvedColumnIds: string[];
  columnLabels?: Map<string, string>;
  columnGroups?: { name: string; columnIds: string[] }[];
  onChangeVisible: (columnIds: string[]) => void;
}

/**
 * The v2 review surface's toolbar row: the Table / By field view toggle + sort indicator on the
 * left; the All / Pending / Problems filter pills and the column picker on the right. All state is
 * the shared `workspace-ui-store` (view mode + `activeFilters` + `sort` + `visibleColumnIds`); the
 * host wires the setters so both surfaces drive the same state.
 */
interface ReviewSubbarProps {
  viewMode: ReviewSurfaceViewMode;
  onViewModeChange: (mode: ReviewSurfaceViewMode) => void;
  /** Folder-wide filter counts from the table diff (`diffData.filterCounts`). */
  filterCounts: { unreviewed: number; unpublished: number; pending: number; errors: number } | undefined;
  activeFilters: GridFilter[];
  /** Set the single global filter exclusively; `null` = All (clear). */
  onSelectGlobalFilter: (kind: ReviewGlobalFilter) => void;
  /** Inline validation is on for this workbook — gates the Problems pill (matches FolderDataGrid). */
  validate: boolean;
  /** Disable the pills while a blocking load is in flight. */
  disabled: boolean;
  /** Column picker inputs, ported from `FolderDataGrid`. */
  columnPicker: ReviewColumnPickerModel;
}

/**
 * A global-filter toggle pill: an optional color bullet + label + optional live count. A v2-local
 * copy of `FolderDataGrid`'s private `FilterPill` (we never import from `FolderDataGrid` — the
 * sibling surface owns its own chrome); the tiny duplication is deleted when `FolderDataGrid` retires.
 */
function FilterPill({
  label,
  count,
  active,
  bulletColor,
  disabled = false,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  bulletColor?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Box
      component="button"
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 10,
        border: active ? '1.5px solid var(--highlight-border)' : '0.5px solid var(--fg-divider)',
        backgroundColor: active ? 'var(--highlight-fill)' : 'transparent',
        cursor: disabled ? 'default' : 'pointer',
        lineHeight: 1,
        opacity: disabled ? 0.55 : 1,
      }}
    >
      {bulletColor && (
        <Box style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: bulletColor, flexShrink: 0 }} />
      )}
      <Text12Medium
        c={active ? 'var(--highlight-text)' : 'var(--fg-muted)'}
        fw={active ? 500 : undefined}
        component="span"
      >
        {label}
        {count !== undefined ? ` (${count.toLocaleString()})` : ''}
      </Text12Medium>
    </Box>
  );
}

/**
 * The Table / By field view toggle, styled to match `FolderDataGrid`'s `ActionIcon.Group` view
 * selector. The `By field` option is disabled (muted, non-interactive) when nothing is pending.
 */
function ViewToggle({
  viewMode,
  onViewModeChange,
  byFieldDisabled,
}: {
  viewMode: ReviewSurfaceViewMode;
  onViewModeChange: (mode: ReviewSurfaceViewMode) => void;
  byFieldDisabled: boolean;
}) {
  return (
    <Box style={{ display: 'inline-flex', gap: 2, border: '1px solid var(--fg-divider)', borderRadius: 4, padding: 1 }}>
      {VIEW_OPTIONS.map(({ value, label }) => {
        const active = viewMode === value;
        const optionDisabled = value === 'by-type' && byFieldDisabled;
        return (
          <Box
            key={value}
            component="button"
            aria-label={label}
            aria-pressed={active}
            disabled={optionDisabled}
            onClick={() => {
              if (optionDisabled) return;
              onViewModeChange(value);
            }}
            style={{
              padding: '2px 10px',
              border: 'none',
              borderRadius: 3,
              backgroundColor: active ? 'var(--highlight-fill)' : 'transparent',
              outline: active ? '1px solid var(--highlight-border)' : 'none',
              cursor: optionDisabled ? 'default' : active ? 'default' : 'pointer',
              opacity: optionDisabled ? 0.45 : 1,
              display: 'inline-flex',
              alignItems: 'center',
              lineHeight: 1,
            }}
            title={optionDisabled ? 'No pending or approved changes to review' : undefined}
          >
            <Text12Medium
              c={active ? 'var(--highlight-text)' : 'var(--fg-muted)'}
              fw={active ? 500 : undefined}
              component="span"
            >
              {label}
            </Text12Medium>
          </Box>
        );
      })}
    </Box>
  );
}

export function ReviewSubbar({
  viewMode,
  onViewModeChange,
  filterCounts,
  activeFilters,
  onSelectGlobalFilter,
  validate,
  disabled,
  columnPicker,
}: ReviewSubbarProps) {
  const globalKind = activeFilters.find((filter) => filter.scope === 'global')?.kind ?? null;
  const allActive = globalKind === null;
  // Treat an externally-activated `unreviewed`/`unpublished` global filter (e.g. the app header's
  // "N need review" pill) as Pending, since Pending is their superset.
  const pendingActive = globalKind === 'pending' || globalKind === 'unreviewed' || globalKind === 'unpublished';
  const problemsActive = globalKind === 'has-problems';

  const pendingCount = filterCounts?.pending ?? 0;
  const byFieldDisabled = pendingCount === 0;

  const visibleCount = columnPicker.visibleColumns.length;
  const columnsNarrowed = visibleCount > 0 && visibleCount < columnPicker.allColumns.length;

  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '6px 16px',
        borderBottom: '0.5px solid var(--fg-divider)',
      }}
    >
      <ViewToggle viewMode={viewMode} onViewModeChange={onViewModeChange} byFieldDisabled={byFieldDisabled} />

      <Group gap={6} align="center" wrap="nowrap">
        <FilterPill label="All" active={allActive} disabled={disabled} onClick={() => onSelectGlobalFilter(null)} />
        <FilterPill
          label="Pending"
          count={pendingCount}
          active={pendingActive}
          bulletColor="var(--modified-needs-review-stroke)"
          disabled={disabled}
          onClick={() => onSelectGlobalFilter('pending')}
        />
        {validate && (
          <FilterPill
            label="Problems"
            count={filterCounts?.errors ?? 0}
            active={problemsActive}
            bulletColor="var(--mantine-color-red-6)"
            disabled={disabled || (filterCounts?.errors ?? 0) === 0}
            onClick={() => onSelectGlobalFilter('has-problems')}
          />
        )}

        {viewMode === 'table' && (
          <>
            <Divider orientation="vertical" />
            <Popover position="bottom-end" withinPortal>
              <Popover.Target>
                <ButtonSecondaryGhost size="compact-xs" leftSection={<StyledLucideIcon Icon={Columns3} size="sm" />}>
                  Columns{columnsNarrowed ? ` (${visibleCount.toLocaleString()})` : ''}
                </ButtonSecondaryGhost>
              </Popover.Target>
              <Popover.Dropdown w={420}>
                <ColumnPickerMenu
                  allColumns={columnPicker.allColumns}
                  visibleColumns={columnPicker.visibleColumns}
                  titleColumnId={columnPicker.titleColumnId}
                  unreviewedColumnIds={columnPicker.unreviewedColumnIds}
                  approvedColumnIds={columnPicker.approvedColumnIds}
                  columnLabels={columnPicker.columnLabels}
                  columnGroups={columnPicker.columnGroups}
                  onChangeVisible={columnPicker.onChangeVisible}
                />
              </Popover.Dropdown>
            </Popover>
          </>
        )}
      </Group>
    </Box>
  );
}
