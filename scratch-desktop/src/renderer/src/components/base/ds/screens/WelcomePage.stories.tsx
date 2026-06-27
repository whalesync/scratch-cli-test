import type { Meta, StoryObj } from '@storybook/react-vite';
import { WelcomePage } from './WelcomePage';

const meta: Meta<typeof WelcomePage> = {
  title: 'Screens/WelcomePage',
  component: WelcomePage,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof WelcomePage>;

export const Default: Story = {};
