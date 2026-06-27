import type { Meta, StoryObj } from '@storybook/react-vite';
import { CreateConnectionModal } from './CreateConnectionModal';

const meta: Meta<typeof CreateConnectionModal> = {
  title: 'Screens/CreateConnectionModal',
  component: CreateConnectionModal,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof CreateConnectionModal>;

export const Default: Story = {};
