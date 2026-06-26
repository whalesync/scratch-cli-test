import type { Meta, StoryObj } from '@storybook/react-vite';
import { ButtonSecondaryOutline } from '../buttons';

const meta: Meta<typeof ButtonSecondaryOutline> = {
  title: 'Buttons/ButtonSecondaryOutline',
  component: ButtonSecondaryOutline,
};
export default meta;

type Story = StoryObj<typeof ButtonSecondaryOutline>;

export const Default: Story = {
  args: { children: 'Connect a service' },
};
