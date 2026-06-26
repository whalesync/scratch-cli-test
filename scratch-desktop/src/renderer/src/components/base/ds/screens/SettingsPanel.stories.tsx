import type { Meta, StoryObj } from '@storybook/react-vite';
import { SettingsPanel } from './SettingsPanel';

const meta: Meta<typeof SettingsPanel> = {
  title: 'Screens/SettingsPanel',
  component: SettingsPanel,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof SettingsPanel>;

export const Default: Story = {};
