import { Textarea } from '@mantine/core';
import type { Meta, StoryObj } from '@storybook/react-vite';

const meta: Meta<typeof Textarea> = {
  title: 'Inputs/Textarea',
  component: Textarea,
};
export default meta;

type Story = StoryObj<typeof Textarea>;

export const Default: Story = {
  args: {
    label: 'Notes',
    autosize: true,
    minRows: 3,
    defaultValue: 'Records are stored as the verbatim response from the external service.',
  },
};
