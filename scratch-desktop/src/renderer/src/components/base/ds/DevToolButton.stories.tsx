import type { Meta, StoryObj } from '@storybook/react-vite';
import { DevToolButton } from '../buttons';

const meta: Meta<typeof DevToolButton> = {
  title: 'Buttons/DevToolButton',
  component: DevToolButton,
};
export default meta;

type Story = StoryObj<typeof DevToolButton>;

export const Default: Story = {
  args: { children: 'Re-index workbook' },
};
