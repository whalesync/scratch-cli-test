import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus } from 'lucide-react';
import { IconButtonOutline } from '../buttons';

const meta: Meta<typeof IconButtonOutline> = {
  title: 'Buttons/IconButtonOutline',
  component: IconButtonOutline,
};
export default meta;

type Story = StoryObj<typeof IconButtonOutline>;

export const Default: Story = {
  args: { children: <Plus size={16} /> },
};
