import type { Meta, StoryObj } from '@storybook/react-vite';
import { ButtonCompactDanger } from '../buttons';

const meta: Meta<typeof ButtonCompactDanger> = {
  title: 'Buttons/ButtonCompactDanger',
  component: ButtonCompactDanger,
};
export default meta;

type Story = StoryObj<typeof ButtonCompactDanger>;

export const Default: Story = {
  args: { children: 'Remove' },
};
