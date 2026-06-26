import type { Meta, StoryObj } from '@storybook/react-vite';
import { ValidationPanel } from './ValidationPanel';

const meta: Meta<typeof ValidationPanel> = {
  title: 'Screens/ValidationPanel',
  component: ValidationPanel,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof ValidationPanel>;

export const Default: Story = {};
