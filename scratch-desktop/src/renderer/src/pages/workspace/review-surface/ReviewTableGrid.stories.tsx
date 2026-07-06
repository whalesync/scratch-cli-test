import type { TableView } from '@spinner/shared-types';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { DiffGridResult, DiffRow, RowStatus } from '../diff-grid-types';
import { ReviewTableGrid } from './ReviewTableGrid';

/**
 * Fixture-driven stories for every cell state the review grid must paint. The grid is a canvas
 * component, so these are the primary visual review surface (there is no jsdom snapshot — the
 * pure drawing/column logic is covered by the `__tests__` specs). Each story boxes the grid in a
 * real height so its ResizeObserver produces non-zero dimensions and the canvas actually paints.
 */

const BASE_RAW: Record<string, unknown> = {
  title: 'Aurora Lamp',
  price: 32,
  when: '2024-01-01',
  owner: '17',
  description: 'A warm ambient lamp with a hand-blown glass shade.',
  sku: 'SKU-1001',
  source: 'google-sheet',
};

const SAMPLE_TABLE_VIEW: TableView = {
  name: 'Products',
  cols: [
    { kind: 'col', path: 'title', name: 'Product', type: 'string' },
    { kind: 'col', path: 'price', name: 'Price', type: 'number' },
    { kind: 'col', path: 'when', name: 'Updated', type: 'date' },
    { kind: 'col', path: 'owner', name: 'Owner', type: 'string' },
    { kind: 'col', path: 'description', name: 'Description', type: 'string' },
    { kind: 'col', path: 'sku', name: 'SKU', type: 'string', writeOnce: true },
    { kind: 'col', path: 'source', name: 'Source', type: 'string', readonly: true },
  ],
};

function row(over: Partial<DiffRow> & { __rowStatus: RowStatus; __filename: string }): DiffRow {
  const { __raw, ...rest } = over;
  return {
    __changedFields: [],
    __fromFields: {},
    __unpublishedFields: [],
    __masterFields: {},
    ...rest,
    __raw: { ...BASE_RAW, ...(__raw ?? {}) },
  };
}

function result(rows: DiffRow[], over: Partial<DiffGridResult> = {}): DiffGridResult {
  return {
    rows,
    columns: [],
    total: rows.length,
    summary: {
      total: rows.length,
      added: 0,
      addedApproved: 0,
      modified: 0,
      unpublished: 0,
      deleted: 0,
      deletedApproved: 0,
      invalidJson: 0,
    },
    filterCounts: { unreviewed: 0, unpublished: 0, pending: 0, errors: 0 },
    focusColumnIds: { unreviewed: [], unpublished: [], errors: [] },
    invalidJsonFiles: [],
    staleCount: 0,
    validationByCell: {},
    totalErrorCount: 0,
    totalProblemsStaleCount: 0,
    ...over,
  };
}

function validation(filename: string, level: 'error' | 'warning', field = 'price'): DiffGridResult['validationByCell'] {
  return {
    [filename]: [{ field_path: field, validator_kind: 'demo', level, message: `Sample ${level}`, fixable: false }],
  };
}

const LONG_FROM =
  'A warm ambient lamp with a hand-blown glass shade, brass base, and a dimmable three-way switch for cozy evenings.';
const LONG_TO =
  'A warm ambient lamp with a hand-blown frosted glass shade, brushed-brass base, and a dimmable three-way switch for cozy evenings.';

const meta: Meta<typeof ReviewTableGrid> = {
  title: 'ReviewSurface/ReviewTableGrid',
  component: ReviewTableGrid,
  args: {
    tableView: SAMPLE_TABLE_VIEW,
    schema: {},
    diffData: result([]),
    visibleColumnIds: null,
    onOpenRecordDrawer: () => {},
    onCellEdited: () => {},
  },
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div style={{ height: '80vh', display: 'flex' }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof ReviewTableGrid>;

export const ModifiedNeedsReview_WordLevel: Story = {
  args: {
    diffData: result(
      [
        row({
          __filename: 'a.json',
          __rowStatus: 'modified',
          __changedFields: ['title'],
          __fromFields: { title: 'Aurora Lamp' },
          __raw: { title: 'Aurora Table Lamp' },
        }),
      ],
      { focusColumnIds: { unreviewed: ['title'], unpublished: [], errors: [] } },
    ),
  },
};

export const ModifiedApproved_WordLevel: Story = {
  args: {
    diffData: result(
      [
        row({
          __filename: 'a.json',
          __rowStatus: 'unpublished',
          __unpublishedFields: ['title'],
          __masterFields: { title: 'Aurora Lamp' },
          __raw: { title: 'Aurora Table Lamp' },
        }),
      ],
      { focusColumnIds: { unreviewed: [], unpublished: ['title'], errors: [] } },
    ),
  },
};

export const ModifiedNeedsReview_WholeValue_Number: Story = {
  args: {
    diffData: result([
      row({
        __filename: 'a.json',
        __rowStatus: 'modified',
        __changedFields: ['price'],
        __fromFields: { price: 32 },
        __raw: { price: 28 },
      }),
    ]),
  },
};

export const ModifiedNeedsReview_WholeValue_Date: Story = {
  args: {
    diffData: result([
      row({
        __filename: 'a.json',
        __rowStatus: 'modified',
        __changedFields: ['when'],
        __fromFields: { when: '2024-01-01' },
        __raw: { when: '2024-06-15' },
      }),
    ]),
  },
};

export const Created_NeedsReview: Story = {
  args: {
    diffData: result([
      row({ __filename: 'new.json', __rowStatus: 'added', __raw: { title: 'Driftwood Tray', price: 19 } }),
    ]),
  },
};

export const Created_Approved: Story = {
  args: {
    diffData: result([
      row({ __filename: 'new.json', __rowStatus: 'addedUnpublished', __raw: { title: 'Driftwood Tray', price: 19 } }),
    ]),
  },
};

export const Removed_NeedsReview: Story = {
  args: {
    diffData: result([row({ __filename: 'gone.json', __rowStatus: 'deleted', __raw: { title: 'Frost Mug' } })]),
  },
};

export const Removed_Approved: Story = {
  args: {
    diffData: result([
      row({ __filename: 'gone.json', __rowStatus: 'deletedUnpublished', __raw: { title: 'Frost Mug' } }),
    ]),
  },
};

export const ForeignKeyLabels: Story = {
  args: {
    diffData: result(
      // The owner cell is unchanged so it renders its resolved label; the row is still a review
      // row via a changed title.
      [
        row({
          __filename: 'a.json',
          __rowStatus: 'modified',
          __changedFields: ['title'],
          __fromFields: { title: 'Aurora Lamp' },
          __raw: { title: 'Aurora Table Lamp', owner: '17' },
        }),
      ],
      { referenceLabels: { owner: { '17': 'Ada Lovelace', '9': 'Alan Turing' } } },
    ),
  },
};

export const ReadonlyAndWriteOnce: Story = {
  args: {
    diffData: result([
      // Existing modified row: SKU (write-once) + Source (readonly) both lock and render muted.
      row({
        __filename: 'a.json',
        __rowStatus: 'modified',
        __changedFields: ['title'],
        __fromFields: { title: 'Aurora Lamp' },
        __raw: { title: 'Aurora Table Lamp' },
      }),
      // New row: SKU (write-once) is still editable.
      row({ __filename: 'new.json', __rowStatus: 'added', __raw: { title: 'Driftwood Tray' } }),
    ]),
  },
};

export const InvalidJson: Story = {
  args: {
    diffData: result([
      {
        __rowStatus: 'invalidJson',
        __changedFields: [],
        __fromFields: {},
        __unpublishedFields: [],
        __masterFields: {},
        __filename: 'broken.json',
        __parseError: 'Unexpected token',
        __raw: {},
      },
    ]),
  },
};

export const LongFormTruncatedDiff: Story = {
  args: {
    diffData: result(
      [
        row({
          __filename: 'a.json',
          __rowStatus: 'modified',
          __changedFields: ['description'],
          __fromFields: { description: LONG_FROM },
          __raw: { description: LONG_TO },
        }),
      ],
      { focusColumnIds: { unreviewed: ['description'], unpublished: [], errors: [] } },
    ),
  },
};

export const MixedGrid_AllStatuses: Story = {
  args: {
    diffData: result(
      [
        row({
          __filename: 'm.json',
          __rowStatus: 'modified',
          __changedFields: ['title', 'price'],
          __fromFields: { title: 'Aurora Lamp', price: 32 },
          __raw: { title: 'Aurora Table Lamp', price: 28 },
        }),
        row({
          __filename: 'u.json',
          __rowStatus: 'unpublished',
          __unpublishedFields: ['description'],
          __masterFields: { description: LONG_FROM },
          __raw: { description: LONG_TO },
        }),
        row({ __filename: 'c.json', __rowStatus: 'added', __raw: { title: 'Driftwood Tray', price: 19 } }),
        row({ __filename: 'd.json', __rowStatus: 'deleted', __raw: { title: 'Frost Mug' } }),
        {
          __rowStatus: 'invalidJson',
          __changedFields: [],
          __fromFields: {},
          __unpublishedFields: [],
          __masterFields: {},
          __filename: 'broken.json',
          __parseError: 'boom',
          __raw: {},
        },
      ],
      {
        focusColumnIds: { unreviewed: ['title', 'price'], unpublished: ['description'], errors: [] },
        referenceLabels: { owner: { '17': 'Ada Lovelace' } },
        // m.json (modified) also fails validation → blue dot + red warning together; u.json
        // (approved) carries a warning → muted dot + orange warning.
        validationByCell: { ...validation('m.json', 'error'), ...validation('u.json', 'warning', 'description') },
      },
    ),
  },
};

// A modified record (blue dot) that ALSO fails validation (red warning) — both indicators show
// at once, independent of each other.
export const ModifiedWithValidationError: Story = {
  args: {
    diffData: result(
      [
        row({
          __filename: 'a.json',
          __rowStatus: 'modified',
          __changedFields: ['price'],
          __fromFields: { price: 32 },
          __raw: { price: 28 },
        }),
      ],
      { validationByCell: validation('a.json', 'error') },
    ),
  },
};

export const Empty: Story = {
  args: { diffData: result([]) },
};
