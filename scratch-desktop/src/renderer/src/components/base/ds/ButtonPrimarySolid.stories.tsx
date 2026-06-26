import type { Meta, StoryObj } from '@storybook/react-vite';
import { ButtonPrimarySolid } from '../buttons';

const meta: Meta<typeof ButtonPrimarySolid> = {
  title: 'Buttons/ButtonPrimarySolid',
  component: ButtonPrimarySolid,
};
export default meta;

type Story = StoryObj<typeof ButtonPrimarySolid>;

export const Default: Story = {
  args: { children: 'Publish changes' },
};
