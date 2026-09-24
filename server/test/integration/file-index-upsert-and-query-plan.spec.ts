/**
 * FileIndex write path + the custom-query-plan helper, against real PostgreSQL.
 *
 * `FileIndexService.upsertBatch` is one multi-row `INSERT ... ON CONFLICT DO UPDATE ... WHERE`
 * per chunk. The WHERE guard is what keeps a re-pull of an unchanged folder write-free, so these
 * tests pin, row by row, when a conflicting row IS and IS NOT rewritten (a skipped row keeps its
 * tuple — same `xmin`).
 */
import { PrismaClient } from '@prisma/client';
import { createWorkbookId, WorkbookId } from '@spinner/shared-types';
import { runQueryWithCustomPlanForBoundParameterValues } from 'src/db/db.service';
import {
  FILE_INDEX_LAST_SEEN_AT_REFRESH_INTERVAL_HOURS,
  FileIndexEntry,
  FileIndexService,
} from 'src/publish-plan/file-index.service';
import { createIntegrationTestDbService } from './integration-db-service';

jest.setTimeout(60_000);

describe('FileIndex upsert + custom query plans (real Postgres)', () => {
  let prisma: PrismaClient;
  let fileIndexService: FileIndexService;
  let workbookId: WorkbookId;

  const FOLDER = 'Contacts';
  const CONNECTION = 'coa_file_index_upsert_test';

  const entry = (
    recordId: string,
    filename: string,
    connectorAccountId: string | null = CONNECTION,
  ): FileIndexEntry => ({ workbookId, folderPath: FOLDER, recordId, filename, connectorAccountId });

  const readRow = async (recordId: string) => {
    const rows = await prisma.$queryRaw<
      { filename: string; connectorAccountId: string | null; lastSeenAt: Date | null; tupleVersion: string }[]
    >`
      SELECT "filename", "connectorAccountId", "lastSeenAt", xmin::text AS "tupleVersion"
      FROM "FileIndex"
      WHERE "workbookId" = ${workbookId} AND "folderPath" = ${FOLDER} AND "recordId" = ${recordId}
    `;
    expect(rows).toHaveLength(1);
    return rows[0];
  };

  const setLastSeenAt = async (recordId: string, lastSeenAt: Date | null) => {
    await prisma.fileIndex.update({
      where: { workbookId_folderPath_recordId: { workbookId, folderPath: FOLDER, recordId } },
      data: { lastSeenAt },
    });
  };

  beforeAll(() => {
    prisma = new PrismaClient();
    fileIndexService = new FileIndexService(createIntegrationTestDbService(prisma));
  });

  beforeEach(() => {
    // FileIndex has no FK to Workbook, so a fresh id per test isolates the rows.
    workbookId = createWorkbookId();
  });

  afterEach(async () => {
    await prisma.fileIndex.deleteMany({ where: { workbookId } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('upsertBatch', () => {
    it('inserts new rows with a lastSeenAt', async () => {
      const before = Date.now();
      await fileIndexService.upsertBatch([entry('rec_1', 'a.json'), entry('rec_2', 'b.json', null)]);

      const first = await readRow('rec_1');
      expect(first.filename).toBe('a.json');
      expect(first.connectorAccountId).toBe(CONNECTION);
      expect(first.lastSeenAt).not.toBeNull();
      // Stamped as UTC wall-clock time, the convention Prisma reads DateTime columns back with.
      expect(Math.abs((first.lastSeenAt as Date).getTime() - before)).toBeLessThan(60_000);
      expect((await readRow('rec_2')).connectorAccountId).toBeNull();
    });

    it('rewrites a row whose filename changed (a rename)', async () => {
      await fileIndexService.upsertBatch([entry('rec_1', 'old.json')]);
      await fileIndexService.upsertBatch([entry('rec_1', 'new.json')]);

      expect((await readRow('rec_1')).filename).toBe('new.json');
    });

    it('backfills a missing connection but never clobbers a set one back to NULL', async () => {
      await fileIndexService.upsertBatch([entry('rec_legacy', 'a.json', null), entry('rec_scoped', 'b.json')]);

      await fileIndexService.upsertBatch([
        entry('rec_legacy', 'a.json', CONNECTION),
        entry('rec_scoped', 'b.json', null),
      ]);

      expect((await readRow('rec_legacy')).connectorAccountId).toBe(CONNECTION);
      expect((await readRow('rec_scoped')).connectorAccountId).toBe(CONNECTION);
    });

    it('keeps the LAST entry when one batch names the same key twice', async () => {
      await fileIndexService.upsertBatch([entry('rec_1', 'first.json'), entry('rec_1', 'second.json')]);

      expect((await readRow('rec_1')).filename).toBe('second.json');
    });

    it('leaves an unchanged, recently-seen row untouched — no new tuple', async () => {
      await fileIndexService.upsertBatch([entry('rec_1', 'a.json')]);
      const before = await readRow('rec_1');

      await fileIndexService.upsertBatch([entry('rec_1', 'a.json')]);

      const after = await readRow('rec_1');
      expect(after.tupleVersion).toBe(before.tupleVersion);
      expect(after.lastSeenAt).toEqual(before.lastSeenAt);
    });

    it(`refreshes an unchanged row once its lastSeenAt is older than ${FILE_INDEX_LAST_SEEN_AT_REFRESH_INTERVAL_HOURS}h`, async () => {
      await fileIndexService.upsertBatch([entry('rec_1', 'a.json')]);
      const staleLastSeenAt = new Date(Date.now() - (FILE_INDEX_LAST_SEEN_AT_REFRESH_INTERVAL_HOURS + 1) * 3_600_000);
      await setLastSeenAt('rec_1', staleLastSeenAt);

      await fileIndexService.upsertBatch([entry('rec_1', 'a.json')]);

      const after = await readRow('rec_1');
      expect((after.lastSeenAt as Date).getTime()).toBeGreaterThan(staleLastSeenAt.getTime() + 3_600_000);
    });

    it('does not refresh an unchanged row seen just inside the refresh window', async () => {
      await fileIndexService.upsertBatch([entry('rec_1', 'a.json')]);
      const recentLastSeenAt = new Date(Date.now() - (FILE_INDEX_LAST_SEEN_AT_REFRESH_INTERVAL_HOURS - 1) * 3_600_000);
      await setLastSeenAt('rec_1', recentLastSeenAt);

      await fileIndexService.upsertBatch([entry('rec_1', 'a.json')]);

      expect((await readRow('rec_1')).lastSeenAt).toEqual(recentLastSeenAt);
    });

    it('stamps an unchanged row whose lastSeenAt is NULL', async () => {
      await fileIndexService.upsertBatch([entry('rec_1', 'a.json')]);
      await setLastSeenAt('rec_1', null);

      await fileIndexService.upsertBatch([entry('rec_1', 'a.json')]);

      expect((await readRow('rec_1')).lastSeenAt).not.toBeNull();
    });

    it('handles more rows than one chunk', async () => {
      const entries = Array.from({ length: 2300 }, (_, i) => entry(`rec_${i}`, `f-${i}.json`));

      await fileIndexService.upsertBatch(entries);

      expect(await prisma.fileIndex.count({ where: { workbookId } })).toBe(2300);
      const filenameByRecordId = await fileIndexService.readRecordIdToFilenameMapForFolder(workbookId, FOLDER);
      expect(filenameByRecordId.get('rec_2299')).toBe('f-2299.json');
    });
  });

  describe('bulk lookups', () => {
    it('getFilenamesByRecordIds / getRecordIdsByFilenamesInFolder / getRecordIds resolve through the custom-plan path', async () => {
      await fileIndexService.upsertBatch([entry('rec_1', 'a.json'), entry('rec_2', 'b.json')]);

      expect(await fileIndexService.getFilenamesByRecordIds(workbookId, FOLDER, ['rec_1', 'rec_2', 'rec_x'])).toEqual(
        new Map([
          ['rec_1', 'a.json'],
          ['rec_2', 'b.json'],
        ]),
      );
      expect(await fileIndexService.getRecordIdsByFilenamesInFolder(workbookId, FOLDER, ['b.json', 'x.json'])).toEqual(
        new Map([['b.json', 'rec_2']]),
      );
      const recordIdByLookupKey = await fileIndexService.getRecordIds(workbookId, [
        { folderPath: FOLDER, filename: 'a.json', connectorAccountId: CONNECTION },
      ]);
      expect([...recordIdByLookupKey.values()]).toEqual(['rec_1']);
    });
  });

  describe('runQueryWithCustomPlanForBoundParameterValues', () => {
    it('forces custom plans inside the query’s transaction only', async () => {
      const [{ planCacheModeInside }] = await runQueryWithCustomPlanForBoundParameterValues(
        prisma,
        prisma.$queryRaw<
          { planCacheModeInside: string }[]
        >`SELECT current_setting('plan_cache_mode') AS "planCacheModeInside"`,
      );
      const [{ planCacheModeAfter }] = await prisma.$queryRaw<
        { planCacheModeAfter: string }[]
      >`SELECT current_setting('plan_cache_mode') AS "planCacheModeAfter"`;

      expect(planCacheModeInside).toBe('force_custom_plan');
      expect(planCacheModeAfter).not.toBe('force_custom_plan');
    });
  });
});
