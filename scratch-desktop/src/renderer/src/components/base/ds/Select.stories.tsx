import { Select } from '@mantine/core';
import type { Meta, StoryObj } from '@storybook/react-vite';

const meta: Meta<typeof Select> = {
  title: 'Inputs/Select',
  component: Select,
};
export default meta;

type Story = StoryObj<typeof Select>;

export const Default: Story = {
  args: { label: 'Connection', data: ['Airtable', 'Webflow', 'Notion'], defaultValue: 'Airtable' },
};
