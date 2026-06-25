import { JobType, RunType } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { RunCountService, monthStartUtc, runTypeForJobType } from '../run-count.service';

describe('runTypeForJobType', () => {
  it('maps both pull job types to PULL', () => {
    expect(runTypeForJobType(JobType.PullLinkedFolderFiles)).toBe(RunType.PULL);
    expect(runTypeForJobType(JobType.RefreshRecords)).toBe(RunType.PULL);
  });

  it('maps publish and sync to their buckets', () => {
    expect(runTypeForJobType(JobType.Publish)).toBe(RunType.PUBLISH);
    expect(runTypeForJobType(JobType.SyncDataFolders)).toBe(RunType.SYNC);
  });

  it('returns undefined for job types that are not counted', () => {
    expect(runTypeForJobType(JobType.ApplyPatches)).toBeUndefined();
    expect(runTypeForJobType(JobType.RehostAssets)).toBeUndefined();
    expect(runTypeForJobType(JobType.DeleteWorkbook)).toBeUndefined();
    expect(runTypeForJobType(JobType.TemporarySyncWithPull)).toBeUndefined();
  });
});

describe('monthStartUtc', () => {
  it('truncates to the first instant of the month in UTC', () => {
    expect(monthStartUtc(new Date('2026-06-24T18:30:00.000Z')).toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('places the last instant of a month and the first of the next in different buckets', () => {
    const jan = monthStartUtc(new Date('2026-01-31T23:59:59.999Z')).toISOString();
    const feb = monthStartUtc(new Date('2026-02-01T00:00:00.000Z')).toISOString();
    expect(jan).toBe('2026-01-01T00:00:00.000Z');
    expect(feb).toBe('2026-02-01T00:00:00.000Z');
    expect(jan).not.toBe(feb);
  });
});

describe('RunCountService', () => {
  const executeRaw = jest.fn();
  const findUniqueWorkbook = jest.fn();
  const findManyCounts = jest.fn();

  const mockDbService = {
    client: {
      $executeRaw: executeRaw,
      workbook: { findUnique: findUniqueWorkbook },
      organizationMonthlyRunCount: { findMany: findManyCounts },
    },
  } as unknown as jest.Mocked<DbService>;

  let service: RunCountService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(WSLogger, 'info').mockImplementation(() => {});
    jest.spyOn(WSLogger, 'warn').mockImplementation(() => {});
    jest.spyOn(WSLogger, 'error').mockImplementation(() => {});
    service = new RunCountService(mockDbService);
  });

  describe('recordJobRun', () => {
    it('increments using the organizationId from the job data without a workbook lookup', async () => {
      await service.recordJobRun({
        jobType: JobType.PullLinkedFolderFiles,
        workbookId: 'wkb_1',
        organizationId: 'org_1',
      });

      expect(findUniqueWorkbook).not.toHaveBeenCalled();
      expect(executeRaw).toHaveBeenCalledTimes(1);
    });

    it('resolves the organization from the workbook when the job data lacks one (publish)', async () => {
      findUniqueWorkbook.mockResolvedValue({ organizationId: 'org_2' });

      await service.recordJobRun({ jobType: JobType.Publish, workbookId: 'wkb_2' });

      expect(findUniqueWorkbook).toHaveBeenCalledWith({ where: { id: 'wkb_2' }, select: { organizationId: true } });
      expect(executeRaw).toHaveBeenCalledTimes(1);
    });

    it('does not touch the database for job types that are not counted', async () => {
      await service.recordJobRun({ jobType: JobType.RehostAssets, workbookId: 'wkb_3', organizationId: 'org_3' });

      expect(findUniqueWorkbook).not.toHaveBeenCalled();
      expect(executeRaw).not.toHaveBeenCalled();
    });

    it('skips (no throw) when the organization cannot be resolved', async () => {
      findUniqueWorkbook.mockResolvedValue(null);

      await expect(
        service.recordJobRun({ jobType: JobType.Publish, workbookId: 'wkb_missing' }),
      ).resolves.toBeUndefined();
      expect(executeRaw).not.toHaveBeenCalled();
    });

    it('never throws when the increment fails (non-fatal)', async () => {
      executeRaw.mockRejectedValue(new Error('db down'));

      await expect(
        service.recordJobRun({ jobType: JobType.SyncDataFolders, workbookId: 'wkb_4', organizationId: 'org_4' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('recordRoutineRun', () => {
    it('resolves the org from the workbook and increments the routine bucket', async () => {
      findUniqueWorkbook.mockResolvedValue({ organizationId: 'org_5' });

      await service.recordRoutineRun({ workbookId: 'wkb_5' });

      expect(findUniqueWorkbook).toHaveBeenCalledWith({ where: { id: 'wkb_5' }, select: { organizationId: true } });
      expect(executeRaw).toHaveBeenCalledTimes(1);
    });
  });

  describe('getCurrentMonthRunCounts', () => {
    it('folds the per-type rows into the typed shape with total = sum and missing types = 0', async () => {
      findManyCounts.mockResolvedValue([
        { runType: RunType.PULL, count: 5 },
        { runType: RunType.PUBLISH, count: 2 },
        { runType: RunType.ROUTINE, count: 3 },
      ]);

      const counts = await service.getCurrentMonthRunCounts('org_6');

      expect(counts).toEqual({ total: 10, pull: 5, publish: 2, sync: 0, routine: 3 });
    });

    it('returns all zeros when the org has no runs this month', async () => {
      findManyCounts.mockResolvedValue([]);

      const counts = await service.getCurrentMonthRunCounts('org_7');

      expect(counts).toEqual({ total: 0, pull: 0, publish: 0, sync: 0, routine: 0 });
    });
  });
});
