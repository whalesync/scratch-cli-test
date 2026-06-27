import type { Meta, StoryObj } from '@storybook/react-vite';
import { PublishProgressModal } from './PublishProgressModal';

const meta: Meta<typeof PublishProgressModal> = {
  title: 'Screens/PublishProgressModal',
  component: PublishProgressModal,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof PublishProgressModal>;

export const Default: Story = {};
