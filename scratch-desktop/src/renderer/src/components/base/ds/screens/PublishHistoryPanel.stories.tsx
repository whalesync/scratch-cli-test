import type { Meta, StoryObj } from '@storybook/react-vite';
import { PublishHistoryPanel } from './PublishHistoryPanel';

const meta: Meta<typeof PublishHistoryPanel> = {
  title: 'Screens/PublishHistoryPanel',
  component: PublishHistoryPanel,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof PublishHistoryPanel>;

export const Default: Story = {};
