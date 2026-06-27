import type { Meta, StoryObj } from '@storybook/react-vite';
import { HomePage } from './HomePage';

const meta: Meta<typeof HomePage> = {
  title: 'Screens/HomePage',
  component: HomePage,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof HomePage>;

export const Default: Story = {};
