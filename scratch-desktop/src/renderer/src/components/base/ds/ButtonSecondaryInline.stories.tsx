import type { Meta, StoryObj } from '@storybook/react-vite';
import { ButtonSecondaryInline } from '../buttons';

const meta: Meta<typeof ButtonSecondaryInline> = {
  title: 'Buttons/ButtonSecondaryInline',
  component: ButtonSecondaryInline,
};
export default meta;

type Story = StoryObj<typeof ButtonSecondaryInline>;

export const Default: Story = {
  args: { children: 'Edit' },
};
