import type { Meta, StoryObj } from '@storybook/react-vite';
import { ConnectionsPanel } from './ConnectionsPanel';

const meta: Meta<typeof ConnectionsPanel> = {
  title: 'Screens/ConnectionsPanel',
  component: ConnectionsPanel,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof ConnectionsPanel>;

export const Default: Story = {};
