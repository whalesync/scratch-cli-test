import type { Meta, StoryObj } from '@storybook/react-vite';
import type { GridFilter } from '../../../stores/workspace-ui-store';
import { ReviewSubbar } from './ReviewSubbar';

const meta: Meta<typeof ReviewSubbar> = {
  title: 'ReviewSurface/ReviewSubbar',
  component: ReviewSubbar,
  args: {
    viewMode: 'table',
    onViewModeChange: () => {},
    filterCounts: { unreviewed: 12, unpublished: 5, pending: 15, errors: 2 },
    activeFilters: [],
    onSelectGlobalFilter: () => {},
    validate: true,
    disabled: false,
    columnPicker: {
      allColumns: ['title', 'status', 'owner', 'notes'],
      visibleColumns: ['title', 'status', 'owner', 'notes'],
      titleColumnId: 'title',
      unreviewedColumnIds: ['status'],
      approvedColumnIds: ['owner'],
      columnLabels: new Map([
        ['title', 'Title'],
        ['status', 'Status'],
        ['owner', 'Owner'],
        ['notes', 'Notes'],
      ]),
      columnGroups: [],
      onChangeVisible: () => {},
    },
    changeTypeChips: [
      {
        changeTypeGroupKey: 'field:status',
        label: 'Status',
        count: 8,
        dotColorVar: 'var(--modified-needs-review-stroke)',
      },
      {
        changeTypeGroupKey: 'field:owner',
        label: 'Owner',
        count: 3,
        dotColorVar: 'var(--modified-needs-review-stroke)',
      },
      { changeTypeGroupKey: 'created', label: 'New', count: 4, dotColorVar: 'var(--create-needs-review-stroke)' },
      { changeTypeGroupKey: 'deleted', label: 'Removed', count: 2, dotColorVar: 'var(--delete-needs-review-stroke)' },
    ],
    activeChangeTypeGroupKey: null,
    onSelectChangeTypeChip: () => {},
  },
  parameters: { layout: 'fullscreen' },
};
export default meta;

type Story = StoryObj<typeof ReviewSubbar>;

export const Default: Story = {};

export const ByFieldSelected: Story = {
  args: { viewMode: 'by-type' },
};

export const PendingFilterActive: Story = {
  args: { activeFilters: [{ scope: 'global', kind: 'pending' }] as GridFilter[] },
};

/** A change-type chip is active — the table would be narrowed to that group's records. */
export const ChangeTypeChipActive: Story = {
  args: { activeChangeTypeGroupKey: 'field:status' },
};

/** No pending or approved changes — the "By field" toggle option is disabled and no chips render. */
export const NothingPending: Story = {
  args: { filterCounts: { unreviewed: 0, unpublished: 0, pending: 0, errors: 0 }, changeTypeChips: [] },
};

/** Validation off for the workbook — the Problems pill is hidden entirely. */
export const ValidationOff: Story = {
  args: { validate: false },
};

/** Validation on but no problems — the Problems pill shows but is disabled. */
export const NoProblems: Story = {
  args: { filterCounts: { unreviewed: 12, unpublished: 5, pending: 15, errors: 0 } },
};
