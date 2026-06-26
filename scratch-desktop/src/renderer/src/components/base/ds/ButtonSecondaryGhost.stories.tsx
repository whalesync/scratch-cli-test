import type { Meta, StoryObj } from '@storybook/react-vite';
import { ButtonSecondaryGhost } from '../buttons';

const meta: Meta<typeof ButtonSecondaryGhost> = {
  title: 'Buttons/ButtonSecondaryGhost',
  component: ButtonSecondaryGhost,
};
export default meta;

type Story = StoryObj<typeof ButtonSecondaryGhost>;

export const Default: Story = {
  args: { children: 'Cancel' },
};
