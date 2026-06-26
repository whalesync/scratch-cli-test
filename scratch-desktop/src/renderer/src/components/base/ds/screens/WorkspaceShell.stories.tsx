import type { Meta, StoryObj } from '@storybook/react-vite';
import { WorkspaceShell } from './WorkspaceShell';

// Composed *screen* story — the title's last segment must equal the export name so /design-sync's
// converter matches the story to the component.
const meta: Meta<typeof WorkspaceShell> = {
  title: 'Screens/WorkspaceShell',
  component: WorkspaceShell,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof WorkspaceShell>;

export const Default: Story = {};
