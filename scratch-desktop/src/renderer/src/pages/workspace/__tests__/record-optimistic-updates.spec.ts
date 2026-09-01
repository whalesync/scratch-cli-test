import { describe, expect, it } from 'vitest';
import {
  applyAcceptedRecordChangeToFolderDiffData,
  applyDiscardedRecordChangeToFolderDiffData,
  applyRejectedRecordChangeToFolderDiffData,
  type DiffGridResult,
  type DiffRow,
  type RowStatus,
} from '../diff-grid-types';
import {
  applyAcceptedRecordChangeToOpenRecordData,
  applyDiscardedRecordChangeToOpenRecordData,
  applyRejectedRecordChangeToOpenRecordData,
  type DiffRecordData,
} from '../record-diff-helpers';

// DEV-10610: whole-record optimistic review-state flips used by the desktop detail-view
// Approve / Reject / Discard buttons. These assert the review-state transition (status +
// changed/unpublished sets) and the recomputed grid summary/filter counts. Field *values*
// are reconciled from disk by the caller, so they are not asserted here.

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

function makeResult(
  row: DiffRow,
  summary: Partial<DiffGridResult['summary']>,
  filterCounts: Partial<DiffGridResult['filterCounts']>,
): DiffGridResult {
  return {
    rows: [row],
    columns: [],
    total: 1,
    summary: {
      total: 1,
      added: 0,
      addedApproved: 0,
      modified: 0,
      unpublished: 0,
      deleted: 0,
      deletedApproved: 0,
      invalidJson: 0,
      ...summary,
    },
    filterCounts: { unreviewed: 0, unpublished: 0, pending: 0, errors: 0, ...filterCounts },
    focusColumnIds: { unreviewed: [], unpublished: [], errors: [] },
    invalidJsonFiles: [],
    staleCount: 0,
    validationByCell: {},
    totalErrorCount: 0,
    totalProblemsStaleCount: 0,
  };
}

function makeRecordData(over: Partial<DiffRecordData['row']> & { __rowStatus: RowStatus }): DiffRecordData {
  return {
    row: {
      __changedFields: [],
      __fromFields: {},
      __unpublishedFields: [],
      __masterFields: {},
      __filename: 'r.json',
      __raw: {},
      ...over,
    },
    columns: [],
    workingData: null,
    dirtyData: null,
    masterData: null,
    displayData: null,
  };
}

describe('applyAcceptedRecordChangeToFolderDiffData', () => {
  it('promotes a modified row to unpublished when the working value differs from published', () => {
    const row = makeRow({
      __rowStatus: 'modified',
      __changedFields: ['title'],
      __fromFields: { title: 'old' },
      __masterFields: { title: 'published' },
      __raw: { title: 'new' },
    });
    const result = makeResult(row, { modified: 1 }, { unreviewed: 1, pending: 1 });

    const next = applyAcceptedRecordChangeToFolderDiffData(result, 'r.json');

    expect(next.rows[0].__rowStatus).toBe('unpublished');
    expect(next.rows[0].__changedFields).toEqual([]);
    expect(next.rows[0].__unpublishedFields).toEqual(['title']);
    expect(next.summary.modified).toBe(0);
    expect(next.summary.unpublished).toBe(1);
    expect(next.filterCounts.unreviewed).toBe(0);
    expect(next.filterCounts.unpublished).toBe(1);
    expect(next.filterCounts.pending).toBe(1);
  });

  it('collapses a modified row to unchanged when the working value already matches published', () => {
    const row = makeRow({
      __rowStatus: 'modified',
      __changedFields: ['title'],
      __fromFields: { title: 'old' },
      __masterFields: { title: 'same' },
      __raw: { title: 'same' },
    });
    const result = makeResult(row, { modified: 1 }, { unreviewed: 1, pending: 1 });

    const next = applyAcceptedRecordChangeToFolderDiffData(result, 'r.json');

    expect(next.rows[0].__rowStatus).toBe('unchanged');
    expect(next.rows[0].__unpublishedFields).toEqual([]);
    expect(next.filterCounts.unreviewed).toBe(0);
    expect(next.filterCounts.unpublished).toBe(0);
    expect(next.filterCounts.pending).toBe(0);
  });

  it('flips an added row to addedUnpublished', () => {
    const row = makeRow({ __rowStatus: 'added' });
    const result = makeResult(row, { added: 1 }, { unreviewed: 1, pending: 1 });

    const next = applyAcceptedRecordChangeToFolderDiffData(result, 'r.json');

    expect(next.rows[0].__rowStatus).toBe('addedUnpublished');
    expect(next.summary.addedApproved).toBe(1);
    expect(next.filterCounts.unreviewed).toBe(0);
    expect(next.filterCounts.unpublished).toBe(1);
    expect(next.filterCounts.pending).toBe(1);
  });

  it('flips a deleted row to deletedUnpublished', () => {
    const row = makeRow({ __rowStatus: 'deleted' });
    const result = makeResult(row, { deleted: 1 }, { unreviewed: 1, pending: 1 });

    const next = applyAcceptedRecordChangeToFolderDiffData(result, 'r.json');

    expect(next.rows[0].__rowStatus).toBe('deletedUnpublished');
    expect(next.summary.deletedApproved).toBe(1);
    expect(next.filterCounts.unreviewed).toBe(0);
    expect(next.filterCounts.unpublished).toBe(1);
  });

  it('returns the input unchanged when the filename is absent', () => {
    const result = makeResult(makeRow({ __rowStatus: 'modified', __changedFields: ['t'] }), { modified: 1 }, {});
    expect(applyAcceptedRecordChangeToFolderDiffData(result, 'missing.json')).toBe(result);
  });
});

describe('applyRejectedRecordChangeToFolderDiffData', () => {
  it('reverts a modified row with no approved edits to unchanged', () => {
    const row = makeRow({
      __rowStatus: 'modified',
      __changedFields: ['title'],
      __fromFields: { title: 'old' },
      __raw: { title: 'new' },
    });
    const result = makeResult(row, { modified: 1 }, { unreviewed: 1, pending: 1 });

    const next = applyRejectedRecordChangeToFolderDiffData(result, 'r.json');

    expect(next.rows[0].__rowStatus).toBe('unchanged');
    expect(next.rows[0].__changedFields).toEqual([]);
    expect(next.filterCounts.unreviewed).toBe(0);
    expect(next.filterCounts.pending).toBe(0);
  });

  it('keeps a modified row that still has approved edits as unpublished', () => {
    const row = makeRow({
      __rowStatus: 'modified',
      __changedFields: ['title'],
      __fromFields: { title: 'old' },
      __unpublishedFields: ['body'],
    });
    const result = makeResult(row, { modified: 1 }, { unreviewed: 1, unpublished: 1, pending: 1 });

    const next = applyRejectedRecordChangeToFolderDiffData(result, 'r.json');

    expect(next.rows[0].__rowStatus).toBe('unpublished');
    expect(next.rows[0].__unpublishedFields).toEqual(['body']);
    expect(next.filterCounts.unreviewed).toBe(0);
    expect(next.filterCounts.unpublished).toBe(1);
    expect(next.filterCounts.pending).toBe(1);
  });

  it('restores a deleted row to unchanged', () => {
    const row = makeRow({ __rowStatus: 'deleted' });
    const result = makeResult(row, { deleted: 1 }, { unreviewed: 1, pending: 1 });

    const next = applyRejectedRecordChangeToFolderDiffData(result, 'r.json');

    expect(next.rows[0].__rowStatus).toBe('unchanged');
    expect(next.filterCounts.unreviewed).toBe(0);
    expect(next.filterCounts.pending).toBe(0);
  });

  it('leaves an added row untouched (row removal is reconciled by the background refresh)', () => {
    const row = makeRow({ __rowStatus: 'added' });
    const result = makeResult(row, { added: 1 }, { unreviewed: 1, pending: 1 });
    expect(applyRejectedRecordChangeToFolderDiffData(result, 'r.json')).toBe(result);
  });
});

describe('applyDiscardedRecordChangeToFolderDiffData', () => {
  it('resets a modified+unpublished row to unchanged', () => {
    const row = makeRow({
      __rowStatus: 'modified',
      __changedFields: ['title'],
      __fromFields: { title: 'old' },
      __unpublishedFields: ['body'],
    });
    const result = makeResult(row, { modified: 1 }, { unreviewed: 1, unpublished: 1, pending: 1 });

    const next = applyDiscardedRecordChangeToFolderDiffData(result, 'r.json');

    expect(next.rows[0].__rowStatus).toBe('unchanged');
    expect(next.rows[0].__changedFields).toEqual([]);
    expect(next.rows[0].__unpublishedFields).toEqual([]);
    expect(next.filterCounts.unreviewed).toBe(0);
    expect(next.filterCounts.unpublished).toBe(0);
    expect(next.filterCounts.pending).toBe(0);
  });

  it('resets an unpublished-only row to unchanged', () => {
    const row = makeRow({ __rowStatus: 'unpublished', __unpublishedFields: ['body'] });
    const result = makeResult(row, { unpublished: 1 }, { unpublished: 1, pending: 1 });

    const next = applyDiscardedRecordChangeToFolderDiffData(result, 'r.json');

    expect(next.rows[0].__rowStatus).toBe('unchanged');
    expect(next.summary.unpublished).toBe(0);
    expect(next.filterCounts.unpublished).toBe(0);
    expect(next.filterCounts.pending).toBe(0);
  });

  it('leaves an added row untouched', () => {
    const row = makeRow({ __rowStatus: 'added' });
    const result = makeResult(row, { added: 1 }, { unreviewed: 1, pending: 1 });
    expect(applyDiscardedRecordChangeToFolderDiffData(result, 'r.json')).toBe(result);
  });
});

describe('open-record whole-record helpers', () => {
  it('accept promotes a modified record to unpublished', () => {
    const prev = makeRecordData({
      __rowStatus: 'modified',
      __changedFields: ['title'],
      __masterFields: { title: 'published' },
      __raw: { title: 'new' },
    });
    const next = applyAcceptedRecordChangeToOpenRecordData(prev);
    expect(next?.row.__rowStatus).toBe('unpublished');
    expect(next?.row.__changedFields).toEqual([]);
    expect(next?.row.__unpublishedFields).toEqual(['title']);
  });

  it('accept flips added/deleted records to their approved variant', () => {
    expect(applyAcceptedRecordChangeToOpenRecordData(makeRecordData({ __rowStatus: 'added' }))?.row.__rowStatus).toBe(
      'addedUnpublished',
    );
    expect(applyAcceptedRecordChangeToOpenRecordData(makeRecordData({ __rowStatus: 'deleted' }))?.row.__rowStatus).toBe(
      'deletedUnpublished',
    );
  });

  it('accept returns null when there is nothing to accept', () => {
    expect(applyAcceptedRecordChangeToOpenRecordData(makeRecordData({ __rowStatus: 'unpublished' }))).toBeNull();
  });

  it('reject reverts a modified record and returns null for a newly-added record', () => {
    const next = applyRejectedRecordChangeToOpenRecordData(
      makeRecordData({ __rowStatus: 'modified', __changedFields: ['title'], __fromFields: { title: 'old' } }),
    );
    expect(next?.row.__rowStatus).toBe('unchanged');
    expect(next?.row.__changedFields).toEqual([]);

    expect(applyRejectedRecordChangeToOpenRecordData(makeRecordData({ __rowStatus: 'added' }))).toBeNull();
    expect(applyRejectedRecordChangeToOpenRecordData(makeRecordData({ __rowStatus: 'deleted' }))?.row.__rowStatus).toBe(
      'unchanged',
    );
  });

  it('discard resets a modified record and returns null for added/deleted', () => {
    const next = applyDiscardedRecordChangeToOpenRecordData(
      makeRecordData({ __rowStatus: 'modified', __changedFields: ['title'], __unpublishedFields: ['body'] }),
    );
    expect(next?.row.__rowStatus).toBe('unchanged');
    expect(next?.row.__changedFields).toEqual([]);
    expect(next?.row.__unpublishedFields).toEqual([]);

    expect(applyDiscardedRecordChangeToOpenRecordData(makeRecordData({ __rowStatus: 'added' }))).toBeNull();
    expect(applyDiscardedRecordChangeToOpenRecordData(makeRecordData({ __rowStatus: 'deleted' }))).toBeNull();
  });
});
