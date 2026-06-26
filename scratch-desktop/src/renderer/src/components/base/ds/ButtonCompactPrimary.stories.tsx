import type { Meta, StoryObj } from '@storybook/react-vite';
import { ButtonCompactPrimary } from '../buttons';

const meta: Meta<typeof ButtonCompactPrimary> = {
  title: 'Buttons/ButtonCompactPrimary',
  component: ButtonCompactPrimary,
};
export default meta;

type Story = StoryObj<typeof ButtonCompactPrimary>;

export const Default: Story = {
  args: { children: 'Pull' },
};
