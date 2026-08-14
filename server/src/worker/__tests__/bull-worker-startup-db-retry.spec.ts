import { Prisma, type DbJob } from '@prisma/client';
import { Job } from 'bullmq';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { JobService } from 'src/job/job.service';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { RunCountService } from 'src/run-count/run-count.service';
import { QueueService } from '../bull-worker.service';
import { JobHandlerService } from '../job-handler.service';
import { JobData } from '../jobs/union-types';

/**
 * Tests the transient-DB-connection retry around the startup `getJobByBullJobId` lookup in
 * processJob (DEV-11312). We drive the real QueueService with casted stubs for its deps (following
 * the sibling bull-worker-shutdown.spec convention) so no BullMQ/Redis/Prisma infrastructure is
 * needed. The retry *mechanics* are covered in db/__tests__/prisma-transient-retry.spec.ts; here we
 * assert only that processJob wires the retry to the right log + metric on each outcome.
 */

function makeKnownRequestError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`simulated ${code}`, { code, clientVersion: 'test' });
}

function makeFakeJob(): Job {
  return {
    id: 'bull-job-1',
    data: { type: 'RefreshRecords', userId: 'user-1' } as unknown as JobData,
    progress: {},
  } as unknown as Job;
}

function makeDbJob(): DbJob {
  return { id: 'db-job-1', runId: null, runContext: null } as unknown as DbJob;
}

function createServiceUnderTest() {
  const logValue = jest.fn();
  const metricsService = { logValue } as unknown as CustomMetricsService;

  const getJobByBullJobId = jest.fn();
  const updateJobStatus = jest.fn().mockResolvedValue(undefined);
  const createJob = jest.fn();
  const jobService = { getJobByBullJobId, updateJobStatus, createJob } as unknown as JobService;

  const run = jest.fn().mockResolvedValue({});
  const getHandler = jest.fn().mockReturnValue({ run });
  const jobHandlerService = { getHandler } as unknown as JobHandlerService;

  const service = new QueueService(
    jobHandlerService,
    jobService,
    {} as unknown as ScratchConfigService,
    metricsService,
    {} as unknown as RunCountService,
  );

  return { service, logValue, getJobByBullJobId, run };
}

describe('QueueService.processJob — transient DB-connection retry on the startup lookup', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(WSLogger, 'info').mockImplementation();
    warnSpy = jest.spyOn(WSLogger, 'warn').mockImplementation();
    errorSpy = jest.spyOn(WSLogger, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('retries a transient lookup error, recovers, runs the job, and records JOB_STARTUP_DB_RETRY', async () => {
    jest.useFakeTimers();
    const { service, logValue, getJobByBullJobId, run } = createServiceUnderTest();
    getJobByBullJobId.mockRejectedValueOnce(makeKnownRequestError('P2024')).mockResolvedValueOnce(makeDbJob());

    const promise = service.processJob(makeFakeJob());
    await jest.advanceTimersByTimeAsync(1_000);
    await promise;

    expect(getJobByBullJobId).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(1); // the job proceeded after recovery
    expect(logValue).toHaveBeenCalledWith(CustomMetric.JOB_STARTUP_DB_RETRY, 1);
    expect(logValue).not.toHaveBeenCalledWith(CustomMetric.JOB_STARTUP_DB_RETRY_EXHAUSTED, 1);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('records JOB_STARTUP_DB_RETRY_EXHAUSTED and fails the job when the transient error never clears', async () => {
    jest.useFakeTimers();
    const { service, logValue, getJobByBullJobId, run } = createServiceUnderTest();
    getJobByBullJobId.mockRejectedValue(makeKnownRequestError('P1001'));

    const promise = service.processJob(makeFakeJob());
    const assertion = expect(promise).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    await jest.advanceTimersByTimeAsync(30_000);
    await assertion;

    expect(logValue).toHaveBeenCalledWith(CustomMetric.JOB_STARTUP_DB_RETRY, 1); // fired on each retry
    expect(logValue).toHaveBeenCalledWith(CustomMetric.JOB_STARTUP_DB_RETRY_EXHAUSTED, 1);
    expect(run).not.toHaveBeenCalled(); // the job never started
    expect(errorSpy).toHaveBeenCalled();
  });

  it('fails fast on a non-transient lookup error without retrying or recording either retry metric', async () => {
    const { service, logValue, getJobByBullJobId, run } = createServiceUnderTest();
    getJobByBullJobId.mockRejectedValue(makeKnownRequestError('P2002'));

    await expect(service.processJob(makeFakeJob())).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);

    expect(getJobByBullJobId).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(logValue).not.toHaveBeenCalledWith(CustomMetric.JOB_STARTUP_DB_RETRY, 1);
    expect(logValue).not.toHaveBeenCalledWith(CustomMetric.JOB_STARTUP_DB_RETRY_EXHAUSTED, 1);
  });
});
