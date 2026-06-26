import type { Meta, StoryObj } from '@storybook/react-vite';
import { ButtonWithDescription } from '../buttons';

const meta: Meta<typeof ButtonWithDescription> = {
  title: 'Buttons/ButtonWithDescription',
  component: ButtonWithDescription,
};
export default meta;

type Story = StoryObj<typeof ButtonWithDescription>;

export const Default: Story = {
  args: {
    title: 'Connect a service',
    description: "Pull a service's records into this workspace and keep them in sync.",
  },
};
