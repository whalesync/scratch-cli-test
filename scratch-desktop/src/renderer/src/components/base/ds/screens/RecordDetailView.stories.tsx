import type { Meta, StoryObj } from '@storybook/react-vite';
import { RecordDetailView } from './RecordDetailView';

const meta: Meta<typeof RecordDetailView> = {
  title: 'Screens/RecordDetailView',
  component: RecordDetailView,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof RecordDetailView>;

export const Default: Story = {};
