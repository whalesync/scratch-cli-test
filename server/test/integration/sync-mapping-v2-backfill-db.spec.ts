/**
 * DB-backed round-trip + compare-and-set tests for the Phase 3 sync-mapping
 * v1 → v2 backfill (DEV-10008).
 *
 * The unit spec (`server/src/code-migrations/__tests__/sync-mapping-v2-backfill.spec.ts`)
 * exercises `backfillSyncMappingRow`'s decision tree against in-memory stubs.
 * This spec runs the same core against a REAL Postgres `Sync` row with the REAL
 * compare-and-set write the controller uses, so the CAS semantics — "write
 * `mappingsV2` only when `updatedAt` is unchanged AND `mappingsV2 IS NULL`" —
 * are validated against actual Prisma/Postgres behavior rather than a mock that
 * merely returns a row count.
 *
 * The injected `writeMappingsV2IfUnchanged` mirrors
 * `CodeMigrationsController.buildSyncMappingV2BackfillDeps` exactly.
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { createDataFolderId, createSyncId, SyncId, SyncMappingV1, transformV1ToV2 } from '@spinner/shared-types';
import {
  backfillSyncMappingRow,
  SYNC_MAPPING_V2_BACKFILL_AUDIT_MARKER,
  SyncMappingV2BackfillAuditEntry,
  SyncMappingV2BackfillDeps,
} from 'src/code-migrations/sync-mapping-v2-backfill';

describe('sync-mapping-v2 backfill (DB-backed compare-and-set)', () => {
  let prisma: PrismaClient;
  const createdSyncIds: SyncId[] = [];
  let auditEntries: SyncMappingV2BackfillAuditEntry[];
  let deps: SyncMappingV2BackfillDeps;

  const v1Fixture = (): SyncMappingV1 => ({
    version: 1,
    tableMappings: [
      {
        sourceDataFolderId: createDataFolderId(),
        destinationDataFolderId: createDataFolderId(),
        columnMappings: [{ sourceColumnId: 'email', destinationColumnId: 'email' }],
        recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email' },
      },
    ],
  });

  const createSyncRow = async (
    mappings: Prisma.InputJsonValue,
  ): Promise<{ id: SyncId; updatedAt: Date; mappings: Prisma.JsonValue }> => {
    const id = createSyncId();
    const row = await prisma.sync.create({ data: { id, displayName: 'backfill-db-test', mappings } });
    createdSyncIds.push(id);
    return { id, updatedAt: row.updatedAt, mappings: row.mappings };
  };

  const readSyncRow = (id: SyncId) =>
    prisma.sync.findUniqueOrThrow({ where: { id }, select: { mappings: true, mappingsV2: true, updatedAt: true } });

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  beforeEach(() => {
    auditEntries = [];
    deps = {
      dryRun: false,
      // Identical to CodeMigrationsController.buildSyncMappingV2BackfillDeps.
      writeMappingsV2IfUnchanged: async (syncId, previouslyReadUpdatedAt, mappingsV2) => {
        const result = await prisma.sync.updateMany({
          where: { id: syncId, updatedAt: previouslyReadUpdatedAt, mappingsV2: { equals: Prisma.DbNull } },
          data: { mappingsV2: mappingsV2 as unknown as Prisma.InputJsonValue },
        });
        return result.count;
      },
      logAudit: async (entry) => {
        auditEntries.push(entry);
      },
    };
  });

  afterEach(async () => {
    if (createdSyncIds.length > 0) {
      await prisma.sync.deleteMany({ where: { id: { in: createdSyncIds } } });
      createdSyncIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('transforms v1 → v2 into mappingsV2 and leaves the frozen v1 mappings untouched', async () => {
    const v1 = v1Fixture();
    const { id, updatedAt, mappings } = await createSyncRow(v1 as unknown as Prisma.InputJsonValue);

    const result = await backfillSyncMappingRow({ id, organizationId: null, updatedAt, rawV1Mappings: mappings }, deps);

    expect(result.kind).toBe('transformed');
    const row = await readSyncRow(id);
    expect(row.mappingsV2).toEqual(transformV1ToV2(v1));
    expect(row.mappings).toEqual(v1); // v1 column frozen, never modified
    expect(auditEntries).toHaveLength(0); // no organization → no audit
  });

  it('writes one audit entry tagged with the backfill marker when an organization is known', async () => {
    const v1 = v1Fixture();
    const { id, updatedAt, mappings } = await createSyncRow(v1 as unknown as Prisma.InputJsonValue);

    const result = await backfillSyncMappingRow(
      { id, organizationId: 'org_backfill_test', updatedAt, rawV1Mappings: mappings },
      deps,
    );

    expect(result.kind).toBe('transformed');
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].entityId).toBe(id);
    expect(auditEntries[0].organizationId).toBe('org_backfill_test');
    expect(auditEntries[0].context.marker).toBe(SYNC_MAPPING_V2_BACKFILL_AUDIT_MARKER);
  });

  it('skips a row already migrated to v2 (compare-and-set sees mappingsV2 not null)', async () => {
    const v1 = v1Fixture();
    const { id } = await createSyncRow(v1 as unknown as Prisma.InputJsonValue);
    const preExistingV2 = transformV1ToV2(v1);
    await prisma.sync.update({
      where: { id },
      data: { mappingsV2: preExistingV2 as unknown as Prisma.InputJsonValue },
    });

    const row = await readSyncRow(id);
    const result = await backfillSyncMappingRow(
      { id, organizationId: null, updatedAt: row.updatedAt, rawV1Mappings: row.mappings },
      deps,
    );

    expect(result.kind).toBe('skipped_concurrent_write');
    const after = await readSyncRow(id);
    expect(after.mappingsV2).toEqual(preExistingV2); // untouched
    expect(auditEntries).toHaveLength(0);
  });

  it('skips when a concurrent edit bumped updatedAt between read and write (CAS conflict)', async () => {
    const v1 = v1Fixture();
    const { id, updatedAt: staleUpdatedAt, mappings } = await createSyncRow(v1 as unknown as Prisma.InputJsonValue);

    // Simulate a concurrent user PATCH that advances updatedAt after we read it.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await prisma.sync.update({ where: { id }, data: { displayName: 'concurrent edit' } });
    const afterPatch = await readSyncRow(id);
    expect(afterPatch.updatedAt.getTime()).toBeGreaterThan(staleUpdatedAt.getTime());

    const result = await backfillSyncMappingRow(
      { id, organizationId: null, updatedAt: staleUpdatedAt, rawV1Mappings: mappings },
      deps,
    );

    expect(result.kind).toBe('skipped_concurrent_write');
    const after = await readSyncRow(id);
    expect(after.mappingsV2).toBeNull(); // CAS wrote nothing; row stays on v1
  });

  it('reports a malformed v1 row as errored without throwing or mutating the row', async () => {
    const garbage = { not: 'a valid v1 mapping' };
    const { id, updatedAt, mappings } = await createSyncRow(garbage);

    const result = await backfillSyncMappingRow({ id, organizationId: null, updatedAt, rawV1Mappings: mappings }, deps);

    expect(result.kind).toBe('errored');
    const row = await readSyncRow(id);
    expect(row.mappingsV2).toBeNull();
    expect(row.mappings).toEqual(garbage);
    expect(auditEntries).toHaveLength(0);
  });

  it('is idempotent — a second backfill of an already-migrated row is a no-op', async () => {
    const v1 = v1Fixture();
    const { id, updatedAt, mappings } = await createSyncRow(v1 as unknown as Prisma.InputJsonValue);

    const first = await backfillSyncMappingRow({ id, organizationId: null, updatedAt, rawV1Mappings: mappings }, deps);
    expect(first.kind).toBe('transformed');

    // Re-read so the second attempt uses the fresh updatedAt; only the
    // `mappingsV2 IS NULL` clause should now make the CAS a no-op.
    const row = await readSyncRow(id);
    const second = await backfillSyncMappingRow(
      { id, organizationId: null, updatedAt: row.updatedAt, rawV1Mappings: row.mappings },
      deps,
    );

    expect(second.kind).toBe('skipped_concurrent_write');
    const after = await readSyncRow(id);
    expect(after.mappingsV2).toEqual(transformV1ToV2(v1)); // the first write survives
  });
});
