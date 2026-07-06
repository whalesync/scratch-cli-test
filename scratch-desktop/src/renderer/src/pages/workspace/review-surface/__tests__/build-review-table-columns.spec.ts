import type { GridColumn } from '@glideapps/glide-data-grid';
import type { TableView } from '@spinner/shared-types';
import { describe, expect, it } from 'vitest';
import type { ColumnDefinition } from '../../../../types/local-files';
import type { DiffGridResult, DiffRow, RowStatus } from '../../diff-grid-types';
import {
  buildReviewTableColumns,
  DIFF_COLUMN_WIDTH_MULTIPLIER,
  STATUS_COL_ID,
  STATUS_COL_WIDTH,
} from '../build-review-table-columns';

function makeResult(over: Partial<DiffGridResult> = {}): DiffGridResult {
  return {
    rows: [],
    columns: [],
    total: 0,
    summary: {
      total: 0,
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

function makeRow(over: Partial<DiffRow> & { __rowStatus: RowStatus }): DiffRow {
  return {
    __changedFields: [],
    __fromFields: {},
    __unpublishedFields: [],
    __masterFields: {},
    __filename: 'r.json',
    __raw: {},
    ...over,
  };
}

const VIEW: TableView = {
  name: 'v',
  cols: [
    { kind: 'col', path: 'title', name: 'Title', type: 'string' },
    { kind: 'col', path: 'price', name: 'Price', type: 'number' },
    { kind: 'col', path: 'when', name: 'When', type: 'date' },
    { kind: 'col', path: 'notes', name: 'Notes', type: 'string' },
    { kind: 'col', path: 'hiddenCol', name: 'Hidden', type: 'string', hidden: true },
    {
      kind: 'col',
      path: 'addr',
      name: 'Address',
      subfields: [{ relativePath: 'city', type: 'string' }],
      selectedSubfield: 0,
    },
  ],
};

function widthOf(columns: readonly GridColumn[], id: string): number | undefined {
  const col = columns.find((c) => c.id === id);
  return col && 'width' in col ? col.width : undefined;
}

describe('buildReviewTableColumns', () => {
  it('prepends the status column and drops hidden columns', () => {
    const { columns, titleColumnId } = buildReviewTableColumns(VIEW, makeResult(), {}, null);
    expect(columns[0]).toMatchObject({ id: STATUS_COL_ID, width: STATUS_COL_WIDTH, hasMenu: false });
    expect(titleColumnId).toBe('title');
    expect(columns.map((c) => c.id)).not.toContain('hiddenCol');
    expect(columns.map((c) => c.id)).toEqual([STATUS_COL_ID, 'title', 'price', 'when', 'notes', 'addr']);
  });

  it('computes default widths: title doubled, date widened, base clamped', () => {
    const { columns } = buildReviewTableColumns(VIEW, makeResult(), {}, null);
    expect(widthOf(columns, 'title')).toBe(240); // base 120 * 2
    expect(widthOf(columns, 'price')).toBe(120); // clamped base
    expect(widthOf(columns, 'when')).toBe(186); // round(120 * 1.3) + 30
  });

  it('widens diff-carrying columns via focusColumnIds, a row changed field, and an effective (subfield) path', () => {
    const result = makeResult({
      focusColumnIds: { unreviewed: ['price'], unpublished: [], errors: [] },
      rows: [makeRow({ __rowStatus: 'modified', __changedFields: ['notes', 'addr.city'] })],
    });
    const { columns } = buildReviewTableColumns(VIEW, result, {}, null);
    expect(widthOf(columns, 'price')).toBe(Math.round(120 * DIFF_COLUMN_WIDTH_MULTIPLIER)); // focus hint
    expect(widthOf(columns, 'notes')).toBe(Math.round(120 * DIFF_COLUMN_WIDTH_MULTIPLIER)); // row changed field
    expect(widthOf(columns, 'addr')).toBe(Math.round(120 * DIFF_COLUMN_WIDTH_MULTIPLIER)); // matched via effective path
    expect(widthOf(columns, 'when')).toBe(186); // untouched
  });

  it('lets a user column-width override beat both the default and the diff multiplier', () => {
    const result = makeResult({ focusColumnIds: { unreviewed: ['price'], unpublished: [], errors: [] } });
    const { columns } = buildReviewTableColumns(VIEW, result, { price: 500 }, null);
    expect(widthOf(columns, 'price')).toBe(500);
  });

  it('builds the label and effective-path maps (drilling into subfields)', () => {
    const { columnLabels, columnEffectivePaths } = buildReviewTableColumns(VIEW, makeResult(), {}, null);
    expect(columnLabels.get('title')).toBe('Title');
    expect(columnEffectivePaths.get('title')).toBe('title');
    expect(columnEffectivePaths.get('addr')).toBe('addr.city');
  });

  it('narrows to visibleColumnIds (always keeping the title/status columns) and null shows all', () => {
    // Narrowed: only the title + explicitly-visible columns survive; hidden stays gone.
    const narrowed = buildReviewTableColumns(VIEW, makeResult(), {}, ['price']);
    expect(narrowed.columns.map((c) => c.id)).toEqual([STATUS_COL_ID, 'title', 'price']);

    // The title column is kept even when not listed in visibleColumnIds.
    const withoutTitle = buildReviewTableColumns(VIEW, makeResult(), {}, ['notes']);
    expect(withoutTitle.columns.map((c) => c.id)).toEqual([STATUS_COL_ID, 'title', 'notes']);

    // null = every non-hidden column.
    const all = buildReviewTableColumns(VIEW, makeResult(), {}, null);
    expect(all.columns.map((c) => c.id)).toEqual([STATUS_COL_ID, 'title', 'price', 'when', 'notes', 'addr']);
  });

  it('falls back to the diff columns when there is no view, and yields only the status column when empty', () => {
    const empty = buildReviewTableColumns(null, makeResult(), {}, null);
    expect(empty.columns.map((c) => c.id)).toEqual([STATUS_COL_ID]);
    expect(empty.titleColumnId).toBeNull();

    const colDef: ColumnDefinition = {
      id: 'name',
      displayName: 'Name',
      dataType: 'string',
      attributes: { readOnly: false, writeOnce: false, required: false, nested: false },
    };
    const withCols = buildReviewTableColumns(null, makeResult({ columns: [colDef] }), {}, null);
    expect(withCols.columns.length).toBeGreaterThan(1);
    expect(withCols.titleColumnId).not.toBeNull();
  });
});
