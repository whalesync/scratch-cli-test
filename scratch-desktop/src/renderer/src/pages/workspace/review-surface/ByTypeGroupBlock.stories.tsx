import type { Meta, StoryObj } from '@storybook/react-vite';
import { ByTypeGroupBlock } from './ByTypeGroupBlock';
import type { ByTypeGroupModel } from './build-by-type-group-model';

const FIELD_GROUP: ByTypeGroupModel = {
  kind: 'field',
  columnId: 'price',
  effectivePath: 'price',
  title: 'Price',
  dotColorVar: 'var(--modified-needs-review-stroke)',
  recordFilenames: ['a.json', 'b.json', 'c.json'],
  rows: [
    {
      filename: 'a.json',
      recordName: 'Aurora Lamp',
      fromDisplay: '$32.00',
      toDisplay: '$28.00',
      rowStatus: 'modified',
    },
    {
      filename: 'b.json',
      recordName: 'Basalt Vase',
      fromDisplay: '$48.00',
      toDisplay: '$52.00',
      rowStatus: 'modified',
    },
    { filename: 'c.json', recordName: 'Cedar Bowl', fromDisplay: '$44.00', toDisplay: '$39.00', rowStatus: 'modified' },
  ],
};

const CREATED_GROUP: ByTypeGroupModel = {
  kind: 'created',
  title: 'New',
  dotColorVar: 'var(--create-needs-review-stroke)',
  recordFilenames: ['d.json', 'e.json'],
  rows: [
    { filename: 'd.json', recordName: 'Driftwood Tray', fromDisplay: '', toDisplay: '', rowStatus: 'added' },
    { filename: 'e.json', recordName: 'Ember Candle', fromDisplay: '', toDisplay: '', rowStatus: 'added' },
  ],
};

const meta: Meta<typeof ByTypeGroupBlock> = {
  title: 'ReviewSurface/ByTypeGroupBlock',
  component: ByTypeGroupBlock,
  args: {
    group: FIELD_GROUP,
    isApproving: false,
    isBulkApproveDisabled: false,
    onApproveAll: () => {},
    onOpenRow: () => {},
  },
};
export default meta;

type Story = StoryObj<typeof ByTypeGroupBlock>;

export const FieldGroup: Story = {};

export const CreatedGroup: Story = {
  args: { group: CREATED_GROUP },
};

export const Approving: Story = {
  args: { isApproving: true },
};

export const BulkDisabledByTruncation: Story = {
  args: { isBulkApproveDisabled: true },
};
