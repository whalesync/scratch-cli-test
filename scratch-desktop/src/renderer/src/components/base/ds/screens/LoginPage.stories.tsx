import type { Meta, StoryObj } from '@storybook/react-vite';
import { LoginPage } from './LoginPage';

const meta: Meta<typeof LoginPage> = {
  title: 'Screens/LoginPage',
  component: LoginPage,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof LoginPage>;

export const Default: Story = {};
