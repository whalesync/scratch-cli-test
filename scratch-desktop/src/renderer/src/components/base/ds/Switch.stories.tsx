import { Switch } from '@mantine/core';
import type { Meta, StoryObj } from '@storybook/react-vite';

const meta: Meta<typeof Switch> = {
  title: 'Inputs/Switch',
  component: Switch,
};
export default meta;

type Story = StoryObj<typeof Switch>;

export const Default: Story = {
  args: { label: 'Auto re-download daily', defaultChecked: true },
};
