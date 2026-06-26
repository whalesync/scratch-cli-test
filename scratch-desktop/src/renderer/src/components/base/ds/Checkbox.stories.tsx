import { Checkbox } from '@mantine/core';
import type { Meta, StoryObj } from '@storybook/react-vite';

const meta: Meta<typeof Checkbox> = {
  title: 'Inputs/Checkbox',
  component: Checkbox,
};
export default meta;

type Story = StoryObj<typeof Checkbox>;

export const Default: Story = {
  args: { label: 'Include schema files in publish', defaultChecked: true },
};
