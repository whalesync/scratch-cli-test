import type { Meta, StoryObj } from '@storybook/react-vite';
import type { WorkspaceConnection } from '../../../types/local-files';
import { ReviewContextBanner } from './ReviewContextBanner';

const CONNECTIONS: WorkspaceConnection[] = [
  { id: '1', displayName: 'Salesforce (prod)', service: 'salesforce', dirName: 'salesforce-tables' },
  { id: '2', displayName: 'Marketing Site', service: 'webflow', dirName: 'webflow-cms' },
];

const meta: Meta<typeof ReviewContextBanner> = {
  title: 'ReviewSurface/ReviewContextBanner',
  component: ReviewContextBanner,
  args: {
    selectedFolderPath: '/salesforce-tables/deals',
    connections: CONNECTIONS,
    pendingCount: 12,
    approvedCount: 5,
    onApproveAll: () => {},
    approveDisabled: false,
    onDiscardAll: () => {},
    discardDisabled: false,
  },
  parameters: { layout: 'fullscreen' },
};
export default meta;

type Story = StoryObj<typeof ReviewContextBanner>;

export const Default: Story = {};

/** Folder whose first path segment matches no connection — the connector name is omitted. */
export const UnmatchedConnector: Story = {
  args: { selectedFolderPath: '/notion-pages/tasks' },
};

export const PendingOnly: Story = {
  args: { pendingCount: 12, approvedCount: 0 },
};

/** Everything approved but not yet published — nothing left to approve, so "Approve all" is disabled. */
export const ApprovedOnly: Story = {
  args: { pendingCount: 0, approvedCount: 8, approveDisabled: true },
};

/** Nothing left to review — counts are zero and both bulk actions are disabled. */
export const NothingToReview: Story = {
  args: { pendingCount: 0, approvedCount: 0, approveDisabled: true, discardDisabled: true },
};
