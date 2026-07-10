import { describe, expect, it } from 'vitest';
import type { DiffGridResult, DiffRow, RowStatus } from '../../diff-grid-types';
import type { ByTypeGroupModel, ByTypeGroupRowModel } from '../build-by-type-group-model';
import { buildChangeTypeChips, buildChangeTypeFilteredDiffData, findChangeTypeGroup } from '../change-type-chips';

function groupRow(filename: string): ByTypeGroupRowModel {
  return { filename, recordName: filename, fromDisplay: '', toDisplay: '', rowStatus: 'modified', approved: false };
}

function fieldGroup(columnId: string, title: string, filenames: string[]): ByTypeGroupModel {
  return {
    kind: 'field',
    columnId,
    effectivePath: columnId,
    title,
    dotColorVar: 'var(--modified-needs-review-stroke)',
    recordFilenames: filenames,
    rows: filenames.map(groupRow),
  };
}

function recordLevelGroup(
  kind: 'created' | 'deleted' | 'invalidJson',
  title: string,
  dotColorVar: string,
  filenames: string[],
): ByTypeGroupModel {
  return { kind, title, dotColorVar, recordFilenames: filenames, rows: filenames.map(groupRow) };
}

function diffRow(filename: string, status: RowStatus = 'modified'): DiffRow {
  return {
    __rowStatus: status,
    __changedFields: [],
    __fromFields: {},
    __unpublishedFields: [],
    __masterFields: {},
    __filename: filename,
    __raw: {},
  };
}

function makeDiffGridResult(rows: DiffRow[]): DiffGridResult {
  return {
    rows,
    columns: [],
    total: rows.length,
    summary: {
      total: rows.length,
      added: 0,
      addedApproved: 0,
      modified: rows.length,
      unpublished: 0,
      deleted: 0,
      deletedApproved: 0,
      invalidJson: 0,
    },
    filterCounts: { unreviewed: rows.length, unpublished: 0, pending: rows.length, errors: 0 },
    focusColumnIds: { unreviewed: [], unpublished: [], errors: [] },
    invalidJsonFiles: [],
    referenceLabels: { price: { r1: 'Widget' } },
    staleCount: 0,
    validationByCell: {},
    totalErrorCount: 0,
    totalProblemsStaleCount: 0,
  };
}

describe('buildChangeTypeChips', () => {
  it('returns no chips for no groups', () => {
    expect(buildChangeTypeChips([])).toEqual([]);
  });

  it('maps each By-type group to a chip, preserving order, count, key, and dot color', () => {
    const chips = buildChangeTypeChips([
      fieldGroup('price', 'Price', ['a.json', 'b.json']),
      fieldGroup('desc', 'Description', ['a.json']),
      recordLevelGroup('created', 'New', 'var(--create-needs-review-stroke)', ['c.json']),
      recordLevelGroup('deleted', 'Removed', 'var(--delete-needs-review-stroke)', ['d.json', 'e.json']),
      recordLevelGroup('invalidJson', 'Needs attention', 'var(--fg-muted)', ['f.json']),
    ]);

    expect(chips).toEqual([
      {
        changeTypeGroupKey: 'field:price',
        label: 'Price',
        count: 2,
        dotColorVar: 'var(--modified-needs-review-stroke)',
      },
      {
        changeTypeGroupKey: 'field:desc',
        label: 'Description',
        count: 1,
        dotColorVar: 'var(--modified-needs-review-stroke)',
      },
      { changeTypeGroupKey: 'created', label: 'New', count: 1, dotColorVar: 'var(--create-needs-review-stroke)' },
      { changeTypeGroupKey: 'deleted', label: 'Removed', count: 2, dotColorVar: 'var(--delete-needs-review-stroke)' },
      { changeTypeGroupKey: 'invalidJson', label: 'Needs attention', count: 1, dotColorVar: 'var(--fg-muted)' },
    ]);
  });
});

describe('findChangeTypeGroup', () => {
  const groups = [
    fieldGroup('price', 'Price', ['a.json']),
    recordLevelGroup('created', 'New', 'var(--create-needs-review-stroke)', ['c.json']),
  ];

  it('returns null for the "All" chip (null key)', () => {
    expect(findChangeTypeGroup(groups, null)).toBeNull();
  });

  it('returns null for an unknown key', () => {
    expect(findChangeTypeGroup(groups, 'field:missing')).toBeNull();
  });

  it('finds a field group by its field:<columnId> key', () => {
    expect(findChangeTypeGroup(groups, 'field:price')?.columnId).toBe('price');
  });

  it('finds a record-level group by its kind key', () => {
    expect(findChangeTypeGroup(groups, 'created')?.kind).toBe('created');
  });
});

describe('buildChangeTypeFilteredDiffData', () => {
  it("keeps only the group's records and updates total, preserving the other result fields", () => {
    const source = makeDiffGridResult([diffRow('a.json'), diffRow('b.json'), diffRow('c.json')]);
    const group = fieldGroup('price', 'Price', ['a.json', 'c.json']);

    const filtered = buildChangeTypeFilteredDiffData(source, group);

    expect(filtered.rows.map((r) => r.__filename)).toEqual(['a.json', 'c.json']);
    expect(filtered.total).toBe(2);
    // Untouched carry-through fields the grid still needs.
    expect(filtered.columns).toBe(source.columns);
    expect(filtered.referenceLabels).toBe(source.referenceLabels);
    expect(filtered.validationByCell).toBe(source.validationByCell);
    // The source is not mutated.
    expect(source.rows).toHaveLength(3);
  });

  it('ignores group filenames absent from the loaded (capped) set', () => {
    const source = makeDiffGridResult([diffRow('a.json')]);
    const group = fieldGroup('price', 'Price', ['a.json', 'beyond-cap.json']);

    expect(buildChangeTypeFilteredDiffData(source, group).rows.map((r) => r.__filename)).toEqual(['a.json']);
  });
});
