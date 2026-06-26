import type { Meta, StoryObj } from '@storybook/react-vite';
import { ButtonDangerLight } from '../buttons';

const meta: Meta<typeof ButtonDangerLight> = {
  title: 'Buttons/ButtonDangerLight',
  component: ButtonDangerLight,
};
export default meta;

type Story = StoryObj<typeof ButtonDangerLight>;

export const Default: Story = {
  args: { children: 'Discard edits' },
};
