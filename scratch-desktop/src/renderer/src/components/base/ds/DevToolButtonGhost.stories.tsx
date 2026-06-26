import type { Meta, StoryObj } from '@storybook/react-vite';
import { DevToolButtonGhost } from '../buttons';

const meta: Meta<typeof DevToolButtonGhost> = {
  title: 'Buttons/DevToolButtonGhost',
  component: DevToolButtonGhost,
};
export default meta;

type Story = StoryObj<typeof DevToolButtonGhost>;

export const Default: Story = {
  args: { children: 'Dump state' },
};
