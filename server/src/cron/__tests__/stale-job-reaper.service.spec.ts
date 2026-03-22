/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/unbound-method */
import { DbJob } from '@prisma/client';
import { Job } from 'bullmq';
import { DbService } from 'src/db/db.service';
import { JobService } from 'src/job/job.service';
import { WSLogger } from 'src/logger';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { StaleJobReaperService } from '../stale-job-reaper.service';

function makeStaleJob(overrides: Partial<DbJob> = {}): DbJob {
  return {
    id: 'job_stale-1',
    userId: 'usr_1',
    workbookId: 'wb_1',
    dataFolderId: 'df_1',
    type: 'pull-linked-folder-files',
    status: 'created',
    bullJobId: 'bull-job-1',
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

describe('StaleJobReaperService', () => {
  let service: StaleJobReaperService;
  let dbService: jest.Mocked<DbService>;
  let jobService: jest.Mocked<JobService>;
  let bullEnqueuerService: jest.Mocked<BullEnqueuerService>;

  beforeEach(() => {
    jest.spyOn(WSLogger, 'info').mockImplementation();
    jest.spyOn(WSLogger, 'error').mockImplementation();

    dbService = {
      client: {
        dbJob: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        dataFolder: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      },
    } as unknown as jest.Mocked<DbService>;

    jobService = {
      updateJobStatus: jest.fn().mockResolvedValue({}),
    } as unknown as jest.Mocked<JobService>;

    bullEnqueuerService = {
      getJob: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<BullEnqueuerService>;

    service = new StaleJobReaperService(dbService, jobService, bullEnqueuerService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('marks a stale created job as failed when BullMQ job is missing', async () => {
    const staleJob = makeStaleJob();
    (dbService.client.dbJob.findMany as jest.Mock).mockResolvedValue([staleJob]);
    bullEnqueuerService.getJob.mockResolvedValue(undefined);

    await service.reapStaleCreatedJobs();

    expect(jobService.updateJobStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        id: staleJob.id,
        status: 'failed',
        error: expect.stringContaining('Reaped'),
      }),
    );
  });

  it('clears DataFolder lock for affected folders', async () => {
    const staleJob = makeStaleJob({ dataFolderId: 'df_locked' });
    (dbService.client.dbJob.findMany as jest.Mock).mockResolvedValue([staleJob]);
    bullEnqueuerService.getJob.mockResolvedValue(undefined);

    await service.reapStaleCreatedJobs();

    expect(dbService.client.dataFolder.updateMany).toHaveBeenCalledWith({
      where: { id: 'df_locked', lock: { not: null } },
      data: { lock: null },
    });
  });

  it('skips jobs that are less than 5 minutes old', async () => {
    // The service queries with createdAt < cutoff, so recent jobs won't be returned
    (dbService.client.dbJob.findMany as jest.Mock).mockResolvedValue([]);

    await service.reapStaleCreatedJobs();

    expect(jobService.updateJobStatus).not.toHaveBeenCalled();
  });

  it('skips jobs that have a valid BullMQ job still waiting', async () => {
    const staleJob = makeStaleJob();
    (dbService.client.dbJob.findMany as jest.Mock).mockResolvedValue([staleJob]);
    bullEnqueuerService.getJob.mockResolvedValue({
      getState: jest.fn().mockResolvedValue('waiting'),
    } as unknown as Job);

    await service.reapStaleCreatedJobs();

    expect(jobService.updateJobStatus).not.toHaveBeenCalled();
  });
});
