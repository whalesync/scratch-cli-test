import { TextInput } from '@mantine/core';
import type { Meta, StoryObj } from '@storybook/react-vite';

const meta: Meta<typeof TextInput> = {
  title: 'Inputs/TextInput',
  component: TextInput,
};
export default meta;

type Story = StoryObj<typeof TextInput>;

export const Default: Story = {
  args: { label: 'Workspace name', defaultValue: 'Marketing site' },
};
