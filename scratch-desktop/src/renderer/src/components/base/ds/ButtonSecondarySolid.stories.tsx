import type { Meta, StoryObj } from '@storybook/react-vite';
import { ButtonSecondarySolid } from '../buttons';

const meta: Meta<typeof ButtonSecondarySolid> = {
  title: 'Buttons/ButtonSecondarySolid',
  component: ButtonSecondarySolid,
};
export default meta;

type Story = StoryObj<typeof ButtonSecondarySolid>;

export const Default: Story = {
  args: { children: 'Accept all' },
};
