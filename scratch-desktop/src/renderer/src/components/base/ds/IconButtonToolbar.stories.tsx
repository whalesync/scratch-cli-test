import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus } from 'lucide-react';
import { IconButtonToolbar } from '../buttons';

const meta: Meta<typeof IconButtonToolbar> = {
  title: 'Buttons/IconButtonToolbar',
  component: IconButtonToolbar,
};
export default meta;

type Story = StoryObj<typeof IconButtonToolbar>;

export const Default: Story = {
  args: { children: <Plus size={16} /> },
};
