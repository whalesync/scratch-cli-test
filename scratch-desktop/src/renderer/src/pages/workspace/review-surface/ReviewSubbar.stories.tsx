import type { Meta, StoryObj } from '@storybook/react-vite';
import type { GridFilter } from '../../../stores/workspace-ui-store';
import { ReviewSubbar } from './ReviewSubbar';

const meta: Meta<typeof ReviewSubbar> = {
  title: 'ReviewSurface/ReviewSubbar',
  component: ReviewSubbar,
  args: {
    viewMode: 'table',
    onViewModeChange: () => {},
    filterCounts: { unreviewed: 12, unpublished: 5, errors: 2 },
    activeFilters: [],
    onToggleGlobalFilter: () => {},
    validate: true,
    disabled: false,
  },
  parameters: { layout: 'fullscreen' },
};
export default meta;

type Story = StoryObj<typeof ReviewSubbar>;

export const Default: Story = {};

export const ByTypeSelected: Story = {
  args: { viewMode: 'by-type' },
};

export const NeedsReviewFilterActive: Story = {
  args: { activeFilters: [{ scope: 'global', kind: 'unreviewed' }] as GridFilter[] },
};

export const ApprovedFilterActive: Story = {
  args: { activeFilters: [{ scope: 'global', kind: 'unpublished' }] as GridFilter[] },
};

/** Validation off for the workbook — the Problems pill is hidden entirely. */
export const ValidationOff: Story = {
  args: { validate: false },
};

/** Validation on but no problems — the Problems pill shows but is disabled. */
export const NoProblems: Story = {
  args: { filterCounts: { unreviewed: 12, unpublished: 5, errors: 0 } },
};
