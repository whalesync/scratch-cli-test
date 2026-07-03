import { Text12Medium } from '@/components/base/text';
import { Box, Group } from '@mantine/core';
import type { FilterKind, GridFilter, ReviewSurfaceViewMode } from '../../../stores/workspace-ui-store';

const VIEW_OPTIONS: { value: ReviewSurfaceViewMode; label: string }[] = [
  { value: 'table', label: 'Table' },
  { value: 'by-type', label: 'By type' },
];

/**
 * The v2 review surface's toolbar row: the Table / By-type view toggle on the left and the three
 * global filter pills — the live approved/pending/problems counters — right-aligned. All state is
 * the shared `workspace-ui-store` (view mode + `activeFilters`); the host wires the setters so both
 * surfaces drive the same filter state. Change-type chips join this row in Phase 9.
 */

interface ReviewSubbarProps {
  viewMode: ReviewSurfaceViewMode;
  onViewModeChange: (mode: ReviewSurfaceViewMode) => void;
  /** Folder-wide filter counts from the table diff (`diffData.filterCounts`). */
  filterCounts: { unreviewed: number; unpublished: number; errors: number } | undefined;
  activeFilters: GridFilter[];
  onToggleGlobalFilter: (kind: FilterKind) => void;
  /** Inline validation is on for this workbook — gates the Problems pill (matches FolderDataGrid). */
  validate: boolean;
  /** Disable the pills while a blocking load is in flight. */
  disabled: boolean;
}

/**
 * A global-filter toggle pill: a color bullet + label + live count. A v2-local copy of
 * `FolderDataGrid`'s private `FilterPill` (we never import from `FolderDataGrid` — the sibling
 * surface owns its own chrome); the tiny duplication is deleted when `FolderDataGrid` retires.
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
  count: number;
  active: boolean;
  bulletColor: string;
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
      <Box style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: bulletColor, flexShrink: 0 }} />
      <Text12Medium
        c={active ? 'var(--highlight-text)' : 'var(--fg-muted)'}
        fw={active ? 500 : undefined}
        component="span"
      >
        {label}
        {` (${count.toLocaleString()})`}
      </Text12Medium>
    </Box>
  );
}

/**
 * The Table / By-type view toggle, styled to match `FolderDataGrid`'s `ActionIcon.Group` view
 * selector: a bordered group of adjacent text buttons, the active one washed with the yellow
 * highlight (`--highlight-fill` fill + `--highlight-border` outline + `--highlight-text` text).
 */
function ViewToggle({
  viewMode,
  onViewModeChange,
}: {
  viewMode: ReviewSurfaceViewMode;
  onViewModeChange: (mode: ReviewSurfaceViewMode) => void;
}) {
  return (
    <Box style={{ display: 'inline-flex', gap: 2, border: '1px solid var(--fg-divider)', borderRadius: 4, padding: 1 }}>
      {VIEW_OPTIONS.map(({ value, label }) => {
        const active = viewMode === value;
        return (
          <Box
            key={value}
            component="button"
            aria-label={label}
            aria-pressed={active}
            onClick={() => onViewModeChange(value)}
            style={{
              padding: '2px 10px',
              border: 'none',
              borderRadius: 3,
              backgroundColor: active ? 'var(--highlight-fill)' : 'transparent',
              outline: active ? '1px solid var(--highlight-border)' : 'none',
              cursor: active ? 'default' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              lineHeight: 1,
            }}
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
  onToggleGlobalFilter,
  validate,
  disabled,
}: ReviewSubbarProps) {
  const hasGlobalFilter = (kind: FilterKind) =>
    activeFilters.some((filter) => filter.scope === 'global' && filter.kind === kind);

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
      <ViewToggle viewMode={viewMode} onViewModeChange={onViewModeChange} />

      <Group gap={6} align="center">
        <FilterPill
          label="Needs review"
          count={filterCounts?.unreviewed ?? 0}
          active={hasGlobalFilter('unreviewed')}
          bulletColor="var(--modified-needs-review-stroke)"
          disabled={disabled}
          onClick={() => onToggleGlobalFilter('unreviewed')}
        />
        <FilterPill
          label="Approved"
          count={filterCounts?.unpublished ?? 0}
          active={hasGlobalFilter('unpublished')}
          bulletColor="var(--modified-approved-stroke)"
          disabled={disabled}
          onClick={() => onToggleGlobalFilter('unpublished')}
        />
        {validate && (
          <FilterPill
            label="Problems"
            count={filterCounts?.errors ?? 0}
            active={hasGlobalFilter('has-problems')}
            bulletColor="var(--mantine-color-red-6)"
            disabled={disabled || (filterCounts?.errors ?? 0) === 0}
            onClick={() => onToggleGlobalFilter('has-problems')}
          />
        )}
      </Group>
    </Box>
  );
}
