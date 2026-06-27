import type { Meta, StoryObj } from '@storybook/react-vite';
import { PublishReviewModal } from './PublishReviewModal';

const meta: Meta<typeof PublishReviewModal> = {
  title: 'Screens/PublishReviewModal',
  component: PublishReviewModal,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof PublishReviewModal>;

export const Default: Story = {};
