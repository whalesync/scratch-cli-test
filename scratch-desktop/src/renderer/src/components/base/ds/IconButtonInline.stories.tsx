import type { Meta, StoryObj } from '@storybook/react-vite';
import { Plus } from 'lucide-react';
import { IconButtonInline } from '../buttons';

const meta: Meta<typeof IconButtonInline> = {
  title: 'Buttons/IconButtonInline',
  component: IconButtonInline,
};
export default meta;

type Story = StoryObj<typeof IconButtonInline>;

export const Default: Story = {
  args: { children: <Plus size={16} /> },
};
