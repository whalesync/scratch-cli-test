import type { Meta, StoryObj } from '@storybook/react-vite';
import { ButtonCompactSecondary } from '../buttons';

const meta: Meta<typeof ButtonCompactSecondary> = {
  title: 'Buttons/ButtonCompactSecondary',
  component: ButtonCompactSecondary,
};
export default meta;

type Story = StoryObj<typeof ButtonCompactSecondary>;

export const Default: Story = {
  args: { children: 'Reset' },
};
