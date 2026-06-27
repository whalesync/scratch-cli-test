import type { Meta, StoryObj } from '@storybook/react-vite';
import { PullProgressModal } from './PullProgressModal';

const meta: Meta<typeof PullProgressModal> = {
  title: 'Screens/PullProgressModal',
  component: PullProgressModal,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof PullProgressModal>;

export const Default: Story = {};
