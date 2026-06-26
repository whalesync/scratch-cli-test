import type { Meta, StoryObj } from '@storybook/react-vite';
import { ButtonPrimaryLight } from '../buttons';

const meta: Meta<typeof ButtonPrimaryLight> = {
  title: 'Buttons/ButtonPrimaryLight',
  component: ButtonPrimaryLight,
};
export default meta;

type Story = StoryObj<typeof ButtonPrimaryLight>;

export const Default: Story = {
  args: { children: 'Publish changes' },
};
