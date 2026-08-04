/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { DbJob } from '@prisma/client';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';
import { JobService } from '../job.service';

// JobService only opens Redis lazily (cancel/queue paths); stub ioredis so constructing it never
// tries to connect. reconcileOrphanedJob itself touches only the Prisma client.
jest.mock('ioredis', () => jest.fn().mockImplementation(() => ({})));

function makeDbJob(overrides: Partial<DbJob> = {}): DbJob {
  return {
    id: 'job_1',
    userId: 'usr_1',
    workbookId: 'wkb_1',
    dataFolderId: 'df_1',
    type: 'pull-linked-folder-files',
    status: 'active',
    bullJobId: 'bull-1',
    data: {},
    progress: null,
    error: null,
    processedOn: null,
    finishedOn: null,
    cancelRequestedAt: null,
    runId: null,
    runContext: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  } as DbJob;
}

describe('JobService.reconcileOrphanedJob', () => {
  let service: JobService;
  let dbJobUpdateMany: jest.Mock;
  let dataFolderUpdateMany: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    dbJobUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    dataFolderUpdateMany = jest.fn().mockResolvedValue({ count: 1 });

    const db = {
      client: {
        dbJob: { updateMany: dbJobUpdateMany },
        dataFolder: { updateMany: dataFolderUpdateMany },
      },
    } as unknown as DbService;

    const config = {
      getRedisHost: () => 'localhost',
      getRedisPort: () => 6379,
      getRedisPassword: () => undefined,
    } as unknown as ScratchConfigService;

    service = new JobService(db, config);
  });

  it('flips a still-active job to failed, clears its folder lock, and returns true', async () => {
    const flipped = await service.reconcileOrphanedJob(makeDbJob(), 'failed', 'boom');

    expect(dbJobUpdateMany).toHaveBeenCalledWith({
      where: { id: 'job_1', status: { in: ['created', 'active'] } },
      data: { status: 'failed', error: 'boom', finishedOn: expect.any(Date) },
    });
    expect(dataFolderUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['df_1'] }, lock: { not: null } },
      data: { lock: null },
    });
    expect(flipped).toBe(true);
  });

  it('is a no-op when the row is already terminal (guard matches nothing)', async () => {
    dbJobUpdateMany.mockResolvedValue({ count: 0 });

    const flipped = await service.reconcileOrphanedJob(makeDbJob(), 'failed', 'boom');

    expect(flipped).toBe(false);
    expect(dataFolderUpdateMany).not.toHaveBeenCalled();
  });

  it('clears every folder of a multi-folder pull (data.dataFolderIds, dataFolderId null)', async () => {
    const multiFolderJob = makeDbJob({ dataFolderId: null, data: { dataFolderIds: ['df_a', 'df_b'] } });

    await service.reconcileOrphanedJob(multiFolderJob, 'failed', 'boom');

    expect(dataFolderUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['df_a', 'df_b'] }, lock: { not: null } },
      data: { lock: null },
    });
  });

  it('mirrors completed with no error and skips lock clearing when the job holds no folder', async () => {
    const noFolderJob = makeDbJob({ dataFolderId: null, data: {} });

    await service.reconcileOrphanedJob(noFolderJob, 'completed');

    expect(dbJobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'completed', error: undefined }) }),
    );
    expect(dataFolderUpdateMany).not.toHaveBeenCalled();
  });
});
