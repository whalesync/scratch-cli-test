import type { Meta, StoryObj } from '@storybook/react-vite';
import { ByTypeGroupRow } from './ByTypeGroupRow';

const meta: Meta<typeof ByTypeGroupRow> = {
  title: 'ReviewSurface/ByTypeGroupRow',
  component: ByTypeGroupRow,
  args: {
    isLastRow: true,
    onOpen: () => {},
  },
};
export default meta;

type Story = StoryObj<typeof ByTypeGroupRow>;

export const ModifiedField: Story = {
  args: {
    groupKind: 'field',
    row: {
      filename: 'a.json',
      recordName: 'Aurora Lamp',
      fromDisplay: '$32.00',
      toDisplay: '$28.00',
      rowStatus: 'modified',
      approved: false,
    },
  },
};

export const ApprovedField: Story = {
  args: {
    groupKind: 'field',
    row: {
      filename: 'a.json',
      recordName: 'Aurora Lamp',
      fromDisplay: '$32.00',
      toDisplay: '$28.00',
      rowStatus: 'unpublished',
      approved: true,
    },
  },
};

export const LongTextField: Story = {
  args: {
    groupKind: 'field',
    row: {
      filename: 'b.json',
      recordName: 'Basalt Vase with a very long product name that should truncate',
      fromDisplay: 'A handcrafted stoneware vase, glazed in matte charcoal, made by local artisans everywhere.',
      toDisplay: 'A handcrafted stoneware vase, glazed in matte slate, made by local artisans everywhere.',
      rowStatus: 'modified',
      approved: false,
    },
  },
};

export const CreatedRecord: Story = {
  args: {
    groupKind: 'created',
    row: {
      filename: 'c.json',
      recordName: 'Driftwood Tray',
      fromDisplay: '',
      toDisplay: '',
      rowStatus: 'added',
      approved: false,
    },
  },
};

export const RemovedRecord: Story = {
  args: {
    groupKind: 'deleted',
    row: {
      filename: 'd.json',
      recordName: 'Frost Mug',
      fromDisplay: '',
      toDisplay: '',
      rowStatus: 'deleted',
      approved: false,
    },
  },
};
