import type { Meta, StoryObj } from '@storybook/react-vite';
import { ByTypeView } from './ByTypeView';
import type { ByTypeGroupModel } from './build-by-type-group-model';

const fieldGroup = (
  columnId: string,
  title: string,
  rows: { filename: string; recordName: string; fromDisplay: string; toDisplay: string }[],
): ByTypeGroupModel => ({
  kind: 'field',
  columnId,
  effectivePath: columnId,
  title,
  dotColorVar: 'var(--modified-needs-review-stroke)',
  recordFilenames: rows.map((row) => row.filename),
  rows: rows.map((row) => ({ ...row, rowStatus: 'modified' })),
});

const recordGroup = (
  kind: 'created' | 'deleted' | 'invalidJson',
  title: string,
  dotColorVar: string,
  names: string[],
): ByTypeGroupModel => ({
  kind,
  title,
  dotColorVar,
  recordFilenames: names.map((name) => `${name}.json`),
  rows: names.map((name) => ({
    filename: `${name}.json`,
    recordName: name,
    fromDisplay: '',
    toDisplay: '',
    rowStatus: kind === 'created' ? 'added' : kind === 'deleted' ? 'deleted' : 'invalidJson',
  })),
});

const SAMPLE_GROUPS: ByTypeGroupModel[] = [
  fieldGroup('title', 'Title', [
    { filename: 'a.json', recordName: 'Aurora Lamp', fromDisplay: 'Aurora Lamp', toDisplay: 'Aurora Lamp (2024)' },
    { filename: 'b.json', recordName: 'Basalt Vase', fromDisplay: 'Basalt Vase', toDisplay: 'Basalt Stone Vase' },
  ]),
  fieldGroup('price', 'Price', [
    { filename: 'a.json', recordName: 'Aurora Lamp', fromDisplay: '$32.00', toDisplay: '$28.00' },
    { filename: 'c.json', recordName: 'Cedar Bowl', fromDisplay: '$44.00', toDisplay: '$39.00' },
  ]),
  recordGroup('created', 'New', 'var(--create-needs-review-stroke)', ['Driftwood Tray', 'Ember Candle']),
  recordGroup('deleted', 'Removed', 'var(--delete-needs-review-stroke)', ['Frost Mug']),
];

const meta: Meta<typeof ByTypeView> = {
  title: 'ReviewSurface/ByTypeView',
  component: ByTypeView,
  args: {
    groups: SAMPLE_GROUPS,
    isTruncated: false,
    loadedRecordCount: 5,
    totalPendingRecordCount: 5,
    approvingGroupKeys: new Set<string>(),
    onApproveAllForGroup: () => {},
    onOpenGroupRow: () => {},
  },
  parameters: { layout: 'fullscreen' },
};
export default meta;

type Story = StoryObj<typeof ByTypeView>;

export const Default: Story = {};

export const Truncated: Story = {
  args: { isTruncated: true, loadedRecordCount: 1000, totalPendingRecordCount: 2480 },
};

export const Empty: Story = {
  args: { groups: [] },
};

export const NeedsAttention: Story = {
  args: {
    groups: [recordGroup('invalidJson', 'Needs attention', 'var(--fg-muted)', ['corrupt-1', 'corrupt-2'])],
  },
};
