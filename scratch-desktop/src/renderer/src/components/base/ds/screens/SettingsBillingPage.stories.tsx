import type { Meta, StoryObj } from '@storybook/react-vite';
import { SettingsBillingPage } from './SettingsBillingPage';

const meta: Meta<typeof SettingsBillingPage> = {
  title: 'Screens/SettingsBillingPage',
  component: SettingsBillingPage,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof SettingsBillingPage>;

export const Default: Story = {};
