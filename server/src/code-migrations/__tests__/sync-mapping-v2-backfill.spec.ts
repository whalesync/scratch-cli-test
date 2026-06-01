import { Prisma } from '@prisma/client';
import { SyncId, SyncMappingV1, SyncMappingV2, transformV1ToV2 } from '@spinner/shared-types';
import {
  accumulateSyncMappingV2Backfill,
  backfillSyncMappingRow,
  emptySyncMappingV2BackfillSummary,
  SYNC_MAPPING_V2_BACKFILL_AUDIT_MARKER,
  SyncMappingV2BackfillAuditEntry,
  SyncMappingV2BackfillDeps,
  SyncRowToBackfill,
} from '../sync-mapping-v2-backfill';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_V1_MAPPINGS = {
  version: 1,
  tableMappings: [
    {
      sourceDataFolderId: 'dfd_src',
      destinationDataFolderId: 'dfd_dest',
      columnMappings: [{ sourceColumnId: 'title', destinationColumnId: 'name' }],
    },
  ],
};

const EXPECTED_V2 = transformV1ToV2(VALID_V1_MAPPINGS as unknown as SyncMappingV1);

// ---------------------------------------------------------------------------
// Test harness — collects every side effect so we can assert on the call graph.
// ---------------------------------------------------------------------------

interface Collected {
  writes: Array<{ syncId: SyncId; updatedAt: Date; mappingsV2: SyncMappingV2 }>;
  audits: SyncMappingV2BackfillAuditEntry[];
}

function makeDeps(opts: { rowsWritten?: number; dryRun?: boolean } = {}): {
  deps: SyncMappingV2BackfillDeps;
  collected: Collected;
} {
  const collected: Collected = { writes: [], audits: [] };
  const deps: SyncMappingV2BackfillDeps = {
    dryRun: opts.dryRun ?? false,
    writeMappingsV2IfUnchanged: (syncId, updatedAt, mappingsV2) => {
      collected.writes.push({ syncId, updatedAt, mappingsV2 });
      return Promise.resolve(opts.rowsWritten ?? 1);
    },
    logAudit: (entry) => {
      collected.audits.push(entry);
      return Promise.resolve();
    },
  };
  return { deps, collected };
}

function makeRow(overrides: Partial<SyncRowToBackfill> = {}): SyncRowToBackfill {
  return {
    id: 'syn_1' as SyncId,
    organizationId: 'org_1',
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    rawV1Mappings: VALID_V1_MAPPINGS as unknown as Prisma.JsonValue,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// backfillSyncMappingRow
// ---------------------------------------------------------------------------

describe('backfillSyncMappingRow', () => {
  it('transforms a valid v1 row, writes v2 via compare-and-set, and audits', async () => {
    const { deps, collected } = makeDeps();
    const row = makeRow();

    const result = await backfillSyncMappingRow(row, deps);

    expect(result).toEqual({ kind: 'transformed' });

    // Wrote exactly the transformV1ToV2 output, keyed on the row's id + the
    // updatedAt we read (the compare-and-set guard).
    expect(collected.writes).toHaveLength(1);
    expect(collected.writes[0].syncId).toBe('syn_1');
    expect(collected.writes[0].updatedAt).toEqual(new Date('2026-05-01T00:00:00.000Z'));
    expect(collected.writes[0].mappingsV2).toEqual(EXPECTED_V2);
    expect(collected.writes[0].mappingsV2.version).toBe(2);

    // One audit entry, marked for rollback discoverability.
    expect(collected.audits).toHaveLength(1);
    expect(collected.audits[0].entityId).toBe('syn_1');
    expect(collected.audits[0].organizationId).toBe('org_1');
    expect(collected.audits[0].context.marker).toBe(SYNC_MAPPING_V2_BACKFILL_AUDIT_MARKER);
  });

  it('reports skipped_concurrent_write and writes no audit when the compare-and-set affects 0 rows', async () => {
    // A concurrent save / parallel batch populated mappingsV2 between read and
    // write, so the conditional update touched nothing.
    const { deps, collected } = makeDeps({ rowsWritten: 0 });

    const result = await backfillSyncMappingRow(makeRow(), deps);

    expect(result).toEqual({ kind: 'skipped_concurrent_write' });
    expect(collected.writes).toHaveLength(1); // we attempted the CAS
    expect(collected.audits).toHaveLength(0); // but did not audit a no-op
  });

  it('reports errored on malformed v1 without attempting a write or audit', async () => {
    const { deps, collected } = makeDeps();
    const row = makeRow({ rawV1Mappings: { not: 'a valid mapping' } as unknown as Prisma.JsonValue });

    const result = await backfillSyncMappingRow(row, deps);

    expect(result.kind).toBe('errored');
    expect(collected.writes).toHaveLength(0);
    expect(collected.audits).toHaveLength(0);
  });

  it('does not write or audit in dry-run, but still reports transformed', async () => {
    const { deps, collected } = makeDeps({ dryRun: true });

    const result = await backfillSyncMappingRow(makeRow(), deps);

    expect(result).toEqual({ kind: 'transformed' });
    expect(collected.writes).toHaveLength(0);
    expect(collected.audits).toHaveLength(0);
  });

  it('backfills a workbook-less sync but skips the audit (no organization)', async () => {
    const { deps, collected } = makeDeps();

    const result = await backfillSyncMappingRow(makeRow({ organizationId: null }), deps);

    expect(result).toEqual({ kind: 'transformed' });
    expect(collected.writes).toHaveLength(1); // the row is still migrated
    expect(collected.audits).toHaveLength(0); // audit needs an org, so it is skipped
  });
});

// ---------------------------------------------------------------------------
// Summary aggregation
// ---------------------------------------------------------------------------

describe('accumulateSyncMappingV2Backfill', () => {
  it('tallies each result kind and records errored ids + messages', () => {
    const summary = emptySyncMappingV2BackfillSummary();

    accumulateSyncMappingV2Backfill(summary, 'syn_a', { kind: 'transformed' });
    accumulateSyncMappingV2Backfill(summary, 'syn_b', { kind: 'skipped_concurrent_write' });
    accumulateSyncMappingV2Backfill(summary, 'syn_c', { kind: 'errored', error: new Error('bad v1') });
    accumulateSyncMappingV2Backfill(summary, 'syn_d', { kind: 'errored', error: 'plain string error' });

    expect(summary.total).toBe(4);
    expect(summary.transformed).toBe(1);
    expect(summary.skipped_concurrent_write).toBe(1);
    expect(summary.errored).toBe(2);
    expect(summary.errors).toEqual([
      { syncId: 'syn_c', message: 'bad v1' },
      { syncId: 'syn_d', message: 'plain string error' },
    ]);
  });
});
