/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/unbound-method */
import { DbJob } from '@prisma/client';
import { Job } from 'bullmq';
import { DbService } from 'src/db/db.service';
import { JobService } from 'src/job/job.service';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
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
  let metricsService: { logValue: jest.Mock };

  beforeEach(() => {
    jest.spyOn(WSLogger, 'info').mockImplementation();
    jest.spyOn(WSLogger, 'error').mockImplementation();

    dbService = {
      client: {
        dbJob: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      },
    } as unknown as jest.Mocked<DbService>;

    jobService = {
      reconcileOrphanedJob: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<JobService>;

    bullEnqueuerService = {
      getJob: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<BullEnqueuerService>;

    metricsService = { logValue: jest.fn() };

    service = new StaleJobReaperService(
      dbService,
      jobService,
      bullEnqueuerService,
      metricsService as unknown as CustomMetricsService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  describe('reapStaleCreatedJobs', () => {
    it('reconciles a stale created job to failed when the BullMQ job is missing, and counts it', async () => {
      const staleJob = makeStaleJob();
      (dbService.client.dbJob.findMany as jest.Mock).mockResolvedValue([staleJob]);
      bullEnqueuerService.getJob.mockResolvedValue(undefined);

      await service.reapStaleCreatedJobs();

      expect(jobService.reconcileOrphanedJob).toHaveBeenCalledWith(
        staleJob,
        'failed',
        expect.stringContaining('Reaped'),
      );
      expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.JOB_REAPED_STALE_CREATED, 1);
    });

    it('skips a created job whose BullMQ job is still waiting', async () => {
      const staleJob = makeStaleJob();
      (dbService.client.dbJob.findMany as jest.Mock).mockResolvedValue([staleJob]);
      bullEnqueuerService.getJob.mockResolvedValue({
        getState: jest.fn().mockResolvedValue('waiting'),
      } as unknown as Job);

      await service.reapStaleCreatedJobs();

      expect(jobService.reconcileOrphanedJob).not.toHaveBeenCalled();
      expect(metricsService.logValue).not.toHaveBeenCalled();
    });

    it('does nothing when there are no stale created jobs', async () => {
      (dbService.client.dbJob.findMany as jest.Mock).mockResolvedValue([]);

      await service.reapStaleCreatedJobs();

      expect(jobService.reconcileOrphanedJob).not.toHaveBeenCalled();
    });
  });

  describe('reapStaleActiveJobs', () => {
    it('queries only active jobs older than the stale threshold', async () => {
      await service.reapStaleActiveJobs();

      expect(dbService.client.dbJob.findMany).toHaveBeenCalledWith({
        where: { status: 'active', processedOn: { lt: expect.any(Date) } },
      });
    });

    it('reconciles a stale active job to failed when the BullMQ job is missing, and counts it', async () => {
      const staleJob = makeStaleJob({ status: 'active', processedOn: new Date('2025-01-01T00:00:00Z') });
      (dbService.client.dbJob.findMany as jest.Mock).mockResolvedValue([staleJob]);
      bullEnqueuerService.getJob.mockResolvedValue(undefined);

      await service.reapStaleActiveJobs();

      expect(jobService.reconcileOrphanedJob).toHaveBeenCalledWith(
        staleJob,
        'failed',
        expect.stringContaining('Reaped'),
      );
      expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.JOB_REAPED_STALE_ACTIVE, 1);
    });

    it('leaves an active job alone when a worker still owns its BullMQ job', async () => {
      const staleJob = makeStaleJob({ status: 'active', processedOn: new Date('2025-01-01T00:00:00Z') });
      (dbService.client.dbJob.findMany as jest.Mock).mockResolvedValue([staleJob]);
      bullEnqueuerService.getJob.mockResolvedValue({
        getState: jest.fn().mockResolvedValue('active'),
      } as unknown as Job);

      await service.reapStaleActiveJobs();

      expect(jobService.reconcileOrphanedJob).not.toHaveBeenCalled();
      expect(metricsService.logValue).not.toHaveBeenCalled();
    });

    it('mirrors completed when the BullMQ job finished but the DbJob was left active', async () => {
      const staleJob = makeStaleJob({ status: 'active', processedOn: new Date('2025-01-01T00:00:00Z') });
      (dbService.client.dbJob.findMany as jest.Mock).mockResolvedValue([staleJob]);
      bullEnqueuerService.getJob.mockResolvedValue({
        getState: jest.fn().mockResolvedValue('completed'),
      } as unknown as Job);

      await service.reapStaleActiveJobs();

      expect(jobService.reconcileOrphanedJob).toHaveBeenCalledWith(staleJob, 'completed', undefined);
      expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.JOB_REAPED_STALE_ACTIVE, 1);
    });

    it('does not emit a metric when the reconcile did not flip the row (lost the race)', async () => {
      const staleJob = makeStaleJob({ status: 'active', processedOn: new Date('2025-01-01T00:00:00Z') });
      (dbService.client.dbJob.findMany as jest.Mock).mockResolvedValue([staleJob]);
      bullEnqueuerService.getJob.mockResolvedValue(undefined);
      jobService.reconcileOrphanedJob.mockResolvedValue(false);

      await service.reapStaleActiveJobs();

      expect(metricsService.logValue).not.toHaveBeenCalled();
    });
  });
});
