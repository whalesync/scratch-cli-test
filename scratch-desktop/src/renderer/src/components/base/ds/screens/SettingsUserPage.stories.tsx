import type { Meta, StoryObj } from '@storybook/react-vite';
import { SettingsUserPage } from './SettingsUserPage';

const meta: Meta<typeof SettingsUserPage> = {
  title: 'Screens/SettingsUserPage',
  component: SettingsUserPage,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof SettingsUserPage>;

export const Default: Story = {};
