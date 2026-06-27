import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChooseTablesModal } from './ChooseTablesModal';

const meta: Meta<typeof ChooseTablesModal> = {
  title: 'Screens/ChooseTablesModal',
  component: ChooseTablesModal,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof ChooseTablesModal>;

export const Default: Story = {};
