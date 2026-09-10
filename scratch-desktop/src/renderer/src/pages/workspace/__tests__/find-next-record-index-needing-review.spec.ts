import { describe, expect, it } from 'vitest';
import { findNextRecordIndexNeedingReview, type DiffRowStatus } from '../record-diff-helpers';

// Auto-advance after approving a record in RecordDetailView: pick the next record on the page
// that still needs review, forward first, wrapping to the start, never the record just approved.

function row(status: DiffRowStatus, changedFields: string[] = []) {
  return { __rowStatus: status, __changedFields: changedFields, __filename: `${status}.json`, __raw: {} };
}

describe('findNextRecordIndexNeedingReview', () => {
  it('returns the next record forward that still needs review', () => {
    const rows = [row('modified', ['a']), row('unchanged'), row('added'), row('modified', ['b'])];
    expect(findNextRecordIndexNeedingReview(rows, 0)).toBe(2);
  });

  it('skips approved (unpublished) and unchanged records', () => {
    const rows = [row('modified', ['a']), row('unpublished'), row('addedUnpublished'), row('deleted')];
    expect(findNextRecordIndexNeedingReview(rows, 0)).toBe(3);
  });

  it('wraps to the start when nothing after the current record needs review', () => {
    const rows = [row('unchanged'), row('modified', ['a']), row('modified', ['b']), row('unchanged')];
    expect(findNextRecordIndexNeedingReview(rows, 2)).toBe(1);
  });

  it('never returns the current record even if its row has not flipped yet', () => {
    const rows = [row('unchanged'), row('modified', ['a']), row('unchanged')];
    expect(findNextRecordIndexNeedingReview(rows, 1)).toBeNull();
  });

  it('treats invalid-json and baseline-unavailable rows as needing review', () => {
    expect(findNextRecordIndexNeedingReview([row('modified', ['a']), row('invalidJson')], 0)).toBe(1);
    expect(findNextRecordIndexNeedingReview([row('modified', ['a']), row('baselineUnavailable')], 0)).toBe(1);
  });

  it('returns null for an empty page or a single-record page', () => {
    expect(findNextRecordIndexNeedingReview([], 0)).toBeNull();
    expect(findNextRecordIndexNeedingReview([row('modified', ['a'])], 0)).toBeNull();
  });
});
