import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus } from 'lucide-react';
import { IconButtonPrimaryOutline } from '../buttons';

const meta: Meta<typeof IconButtonPrimaryOutline> = {
  title: 'Buttons/IconButtonPrimaryOutline',
  component: IconButtonPrimaryOutline,
};
export default meta;

type Story = StoryObj<typeof IconButtonPrimaryOutline>;

export const Default: Story = {
  args: { children: <Plus size={16} /> },
};
