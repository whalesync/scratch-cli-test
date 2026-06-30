import { describe, expect, it } from 'vitest';
import {
  groupPendingChangesByChangeType,
  type ChangeRowStatus,
  type PendingChangeColumn,
  type PendingChangeRow,
} from '../group-pending-changes-by-change-type';

function row(status: ChangeRowStatus, changedFields: string[] = [], filename = 'r.json'): PendingChangeRow {
  return { __rowStatus: status, __changedFields: changedFields, __filename: filename };
}

function col(id: string, displayName: string = id): PendingChangeColumn {
  return { id, displayName };
}

describe('groupPendingChangesByChangeType', () => {
  it('returns a fully-zeroed grouping for empty input', () => {
    expect(groupPendingChangesByChangeType([], [])).toEqual({
      fieldModifiedByColumn: [],
      createdRecordCount: 0,
      deletedRecordCount: 0,
      invalidJsonRecordCount: 0,
      unmatchedFieldKeys: [],
      scannedRowCount: 0,
    });
  });

  it('buckets one modified row per changed column and omits unchanged columns', () => {
    const grouping = groupPendingChangesByChangeType(
      [row('modified', ['name', 'status'])],
      [col('name'), col('status'), col('notes')],
    );

    // Input order preserved; `notes` (zero edits) omitted.
    expect(grouping.fieldModifiedByColumn).toEqual([
      { columnId: 'name', columnDisplayName: 'name', unreviewedFieldEditCount: 1 },
      { columnId: 'status', columnDisplayName: 'status', unreviewedFieldEditCount: 1 },
    ]);
  });

  it('accumulates per field-occurrence across rows', () => {
    const grouping = groupPendingChangesByChangeType(
      [row('modified', ['name'], 'a.json'), row('modified', ['name'], 'b.json')],
      [col('name')],
    );

    expect(grouping.fieldModifiedByColumn).toEqual([
      { columnId: 'name', columnDisplayName: 'name', unreviewedFieldEditCount: 2 },
    ]);
  });

  it('counts added / deleted / invalidJson rows at the row level without touching field buckets', () => {
    const grouping = groupPendingChangesByChangeType([row('added'), row('deleted'), row('invalidJson')], [col('name')]);

    expect(grouping.createdRecordCount).toBe(1);
    expect(grouping.deletedRecordCount).toBe(1);
    expect(grouping.invalidJsonRecordCount).toBe(1);
    expect(grouping.fieldModifiedByColumn).toEqual([]);
  });

  it('counts an addedUnpublished row carrying local edits as field edits, not as a new creation', () => {
    const grouping = groupPendingChangesByChangeType([row('addedUnpublished', ['name'])], [col('name')]);

    // The fresh edit counts toward the column bucket...
    expect(grouping.fieldModifiedByColumn).toEqual([
      { columnId: 'name', columnDisplayName: 'name', unreviewedFieldEditCount: 1 },
    ]);
    // ...but the creation is already approved, so it is NOT an unreviewed creation.
    expect(grouping.createdRecordCount).toBe(0);
  });

  it('ignores unchanged and approved-but-unpublished rows', () => {
    const grouping = groupPendingChangesByChangeType(
      [row('unchanged'), row('unpublished'), row('addedUnpublished'), row('deletedUnpublished')],
      [col('name')],
    );

    expect(grouping.fieldModifiedByColumn).toEqual([]);
    expect(grouping.createdRecordCount).toBe(0);
    expect(grouping.deletedRecordCount).toBe(0);
    expect(grouping.invalidJsonRecordCount).toBe(0);
    expect(grouping.scannedRowCount).toBe(4);
  });

  it('surfaces a changed field with no matching column instead of dropping it', () => {
    const grouping = groupPendingChangesByChangeType([row('modified', ['ghostField'])], [col('name')]);

    expect(grouping.fieldModifiedByColumn).toEqual([]);
    expect(grouping.unmatchedFieldKeys).toEqual(['ghostField']);
  });

  it('de-duplicates unmatched field keys across rows', () => {
    const grouping = groupPendingChangesByChangeType(
      [row('modified', ['ghostField'], 'a.json'), row('modified', ['ghostField'], 'b.json')],
      [col('name')],
    );

    expect(grouping.unmatchedFieldKeys).toEqual(['ghostField']);
  });

  it('enriches buckets with the column displayName', () => {
    const grouping = groupPendingChangesByChangeType([row('modified', ['status'])], [col('status', 'Status')]);

    expect(grouping.fieldModifiedByColumn).toEqual([
      { columnId: 'status', columnDisplayName: 'Status', unreviewedFieldEditCount: 1 },
    ]);
  });

  it('orders buckets by input-column order, not alphabetically', () => {
    const grouping = groupPendingChangesByChangeType([row('modified', ['zzz', 'aaa'])], [col('zzz'), col('aaa')]);

    expect(grouping.fieldModifiedByColumn.map((group) => group.columnId)).toEqual(['zzz', 'aaa']);
  });

  it('reports the number of rows scanned', () => {
    const grouping = groupPendingChangesByChangeType(
      [row('modified', ['name']), row('added'), row('unchanged')],
      [col('name')],
    );

    expect(grouping.scannedRowCount).toBe(3);
  });
});
