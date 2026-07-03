import { GridCellKind } from '@glideapps/glide-data-grid';
import type { TableViewCol } from '@spinner/shared-types';
import { describe, expect, it } from 'vitest';
import type { DiffRow, RowStatus } from '../../diff-grid-types';
import {
  editableCellToString,
  formatReferenceDisplay,
  getCellDiffState,
  inferCellKind,
  isCellReadonly,
  resolveEffectivePath,
  resolveEffectiveType,
} from '../../grid-cell-diff-state';

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

const subfieldCol: TableViewCol = {
  kind: 'col',
  path: 'title',
  subfields: [{ relativePath: 'raw', type: 'string' }],
  selectedSubfield: 0,
};

describe('getCellDiffState', () => {
  it('reports an unreviewed field with its from-value', () => {
    const row = makeRow({
      __rowStatus: 'modified',
      __changedFields: ['title'],
      __fromFields: { title: 'old' },
      __raw: { title: 'new' },
    });
    const state = getCellDiffState(row, 'title', undefined);
    expect(state.diffKind).toBe('unreviewed');
    expect(state.fromValue).toBe('old');
    expect(state.classification).not.toBeNull();
  });

  it('reports an unpublished field with the published master as its from-value', () => {
    const row = makeRow({
      __rowStatus: 'unpublished',
      __unpublishedFields: ['title'],
      __masterFields: { title: 'published' },
      __raw: { title: 'approved' },
    });
    const state = getCellDiffState(row, 'title', undefined);
    expect(state.diffKind).toBe('unpublished');
    expect(state.fromValue).toBe('published');
  });

  it('returns no per-cell diff for added / deleted / invalidJson rows', () => {
    for (const status of ['added', 'deleted', 'deletedUnpublished', 'invalidJson'] as const) {
      expect(getCellDiffState(makeRow({ __rowStatus: status }), 'title', undefined).diffKind).toBeNull();
    }
  });

  it('still surfaces per-cell diffs for an approved-create row that has edited fields', () => {
    const row = makeRow({
      __rowStatus: 'addedUnpublished',
      __changedFields: ['title'],
      __fromFields: { title: 'old' },
      __raw: { title: 'new' },
    });
    expect(getCellDiffState(row, 'title', undefined).diffKind).toBe('unreviewed');
  });

  it('matches changed fields at the effective (subfield) path', () => {
    const row = makeRow({
      __rowStatus: 'modified',
      __changedFields: ['title.raw'],
      __fromFields: { 'title.raw': 'old' },
      __raw: { title: { raw: 'new' } },
    });
    const state = getCellDiffState(row, 'title', subfieldCol);
    expect(state.diffKind).toBe('unreviewed');
    expect(state.fromValue).toBe('old');
  });
});

describe('isCellReadonly', () => {
  it('locks a readonly column regardless of row state', () => {
    const col: TableViewCol = { kind: 'col', path: 'x', readonly: true };
    expect(isCellReadonly(col, makeRow({ __rowStatus: 'added' }))).toBe(true);
  });

  it('locks a write-once column on an existing record but not on a new one', () => {
    const col: TableViewCol = { kind: 'col', path: 'x', writeOnce: true };
    expect(isCellReadonly(col, makeRow({ __rowStatus: 'modified' }))).toBe(true);
    expect(isCellReadonly(col, makeRow({ __rowStatus: 'added' }))).toBe(false);
    expect(isCellReadonly(col, makeRow({ __rowStatus: 'addedUnpublished' }))).toBe(false);
  });
});

describe('resolveEffectivePath / resolveEffectiveType', () => {
  it('returns the root path/type when no subfield is selected', () => {
    const col: TableViewCol = { kind: 'col', path: 'title', type: 'string' };
    expect(resolveEffectivePath('title', col)).toBe('title');
    expect(resolveEffectiveType(col)).toBe('string');
  });

  it('drills into the selected subfield', () => {
    expect(resolveEffectivePath('title', subfieldCol)).toBe('title.raw');
    expect(resolveEffectiveType(subfieldCol)).toBe('string');
  });
});

describe('inferCellKind', () => {
  it('maps declared property types', () => {
    expect(inferCellKind('x', 'checkbox')).toBe(GridCellKind.Boolean);
    expect(inferCellKind('x', 'number')).toBe(GridCellKind.Number);
    expect(inferCellKind('x', 'url')).toBe(GridCellKind.Uri);
  });

  it('falls back to the runtime value type when the property type is generic', () => {
    expect(inferCellKind(true, undefined)).toBe(GridCellKind.Boolean);
    expect(inferCellKind(42, 'string')).toBe(GridCellKind.Number);
    expect(inferCellKind('hi', undefined)).toBe(GridCellKind.Text);
  });
});

describe('editableCellToString', () => {
  it('extracts the raw string across editable cell kinds', () => {
    expect(editableCellToString({ kind: GridCellKind.Text, data: 'hi', allowOverlay: true, displayData: 'hi' })).toBe(
      'hi',
    );
    expect(editableCellToString({ kind: GridCellKind.Number, data: 12, allowOverlay: true, displayData: '12' })).toBe(
      '12',
    );
    expect(editableCellToString({ kind: GridCellKind.Boolean, data: true, allowOverlay: false })).toBe('true');
  });
});

describe('formatReferenceDisplay', () => {
  const labels = { '17': 'Ada Lovelace', '9': 'Alan Turing' };
  it('swaps a single id for its label, falling back to the raw id', () => {
    expect(formatReferenceDisplay('17', labels)).toBe('Ada Lovelace');
    expect(formatReferenceDisplay('404', labels)).toBe('404');
  });
  it('joins a multi-reference array of ids', () => {
    expect(formatReferenceDisplay(['17', '9'], labels)).toBe('Ada Lovelace, Alan Turing');
  });
});
