import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus } from 'lucide-react';
import { IconButtonGhost } from '../buttons';

const meta: Meta<typeof IconButtonGhost> = {
  title: 'Buttons/IconButtonGhost',
  component: IconButtonGhost,
};
export default meta;

type Story = StoryObj<typeof IconButtonGhost>;

export const Default: Story = {
  args: { children: <Plus size={16} /> },
};
