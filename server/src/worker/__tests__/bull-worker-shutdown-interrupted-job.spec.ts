import { type DbJob } from '@prisma/client';
import { Job } from 'bullmq';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { JobService } from 'src/job/job.service';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { RunCountService } from 'src/run-count/run-count.service';
import { QueueService } from '../bull-worker.service';
import { JobCanceledError } from '../job-errors';
import { JobHandlerService } from '../job-handler.service';
import { JobData } from '../jobs/union-types';
import { LiveExportRecordLimitEnforcer } from '../live-export-record-limit-enforcer.service';
import {
  clearWorkerProcessShutdownStarted,
  isWorkerProcessShuttingDown,
  markWorkerProcessShutdownStarted,
} from '../worker-process-shutdown-state';

/**
 * DEV-12428: a job that throws after its worker began shutting down (Cloud Run deploy / scale-in) is left
 * for stall recovery — never recorded failed — because the error is the shutdown closing the job's clients
 * under it, not a real failure. Recording it failed made BullMQ end the job for good (attempts: 1) and failed
 * the Live Export run waiting on it. We drive the real QueueService.processJob with casted stubs, following
 * the sibling bull-worker-startup-db-retry.spec convention, so no BullMQ/Redis/Prisma is needed.
 */

const CONNECTION_CLOSED_BY_SHUTDOWN_ERROR_MESSAGE = 'Connection is closed.';

function makeFakeBullJob(): Job {
  return {
    id: 'bull-job-1',
    data: { type: 'Publish', userId: 'user-1' } as unknown as JobData,
    progress: {},
  } as unknown as Job;
}

function createServiceUnderTest(handlerRunImplementation: () => Promise<unknown>) {
  const logValue = jest.fn();
  const metricsService = { logValue } as unknown as CustomMetricsService;

  const updateJobStatus = jest.fn().mockResolvedValue(undefined);
  const jobService = {
    getJobByBullJobId: jest
      .fn()
      .mockResolvedValue({ id: 'db-job-1', runId: null, runContext: null } as unknown as DbJob),
    updateJobStatus,
  } as unknown as JobService;

  const handlerRun = jest.fn(handlerRunImplementation);
  const jobHandlerService = {
    getHandler: jest.fn().mockReturnValue({ run: handlerRun }),
  } as unknown as JobHandlerService;

  const service = new QueueService(
    jobHandlerService,
    jobService,
    { getWorkerShutdownTimeoutMs: () => 10_000 } as unknown as ScratchConfigService,
    metricsService,
    {} as unknown as RunCountService,
    {
      assertLiveExportJobAllowedOrThrow: jest.fn().mockResolvedValue(undefined),
    } as unknown as LiveExportRecordLimitEnforcer,
  );

  return { service, logValue, updateJobStatus, handlerRun };
}

/** Resolves to whether `promise` settled (either way) within a few macrotask turns. */
async function didPromiseSettleSoon(promise: Promise<unknown>): Promise<boolean> {
  let promiseSettled = false;
  promise.then(
    () => {
      promiseSettled = true;
    },
    () => {
      promiseSettled = true;
    },
  );
  for (let macrotaskTurn = 0; macrotaskTurn < 5; macrotaskTurn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return promiseSettled;
}

function wasJobRecordedWithStatus(updateJobStatus: jest.Mock, status: string): boolean {
  return updateJobStatus.mock.calls.some(([update]: [{ status?: string }]) => update.status === status);
}

describe('QueueService.processJob — a job interrupted by the worker shutting down (DEV-12428)', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(WSLogger, 'info').mockImplementation();
    jest.spyOn(WSLogger, 'error').mockImplementation();
    warnSpy = jest.spyOn(WSLogger, 'warn').mockImplementation();
  });

  afterEach(() => {
    clearWorkerProcessShutdownStarted();
    jest.restoreAllMocks();
  });

  it('leaves the job active for stall recovery — neither settling nor recording it failed — when it throws mid-shutdown', async () => {
    const { service, logValue, updateJobStatus } = createServiceUnderTest(() => {
      markWorkerProcessShutdownStarted();
      return Promise.reject(new Error(CONNECTION_CLOSED_BY_SHUTDOWN_ERROR_MESSAGE));
    });

    const processJobPromise = service.processJob(makeFakeBullJob());

    expect(await didPromiseSettleSoon(processJobPromise)).toBe(false);
    expect(wasJobRecordedWithStatus(updateJobStatus, 'active')).toBe(true);
    expect(wasJobRecordedWithStatus(updateJobStatus, 'failed')).toBe(false);
    expect(logValue).toHaveBeenCalledWith(CustomMetric.JOB_LEFT_FOR_STALL_RECOVERY_ON_SHUTDOWN, 1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'bull-job-1', error: CONNECTION_CLOSED_BY_SHUTDOWN_ERROR_MESSAGE }),
    );
  });

  it('still records a user cancellation as canceled when it lands mid-shutdown', async () => {
    const { service, logValue, updateJobStatus } = createServiceUnderTest(() => {
      markWorkerProcessShutdownStarted();
      return Promise.reject(new JobCanceledError('bull-job-1'));
    });

    await expect(service.processJob(makeFakeBullJob())).rejects.toBeInstanceOf(JobCanceledError);

    expect(wasJobRecordedWithStatus(updateJobStatus, 'canceled')).toBe(true);
    expect(logValue).not.toHaveBeenCalledWith(CustomMetric.JOB_LEFT_FOR_STALL_RECOVERY_ON_SHUTDOWN, 1);
  });

  it('records the job failed, as before, when it throws while the worker is not shutting down', async () => {
    const { service, logValue, updateJobStatus } = createServiceUnderTest(() =>
      Promise.reject(new Error('A real connector failure')),
    );

    await expect(service.processJob(makeFakeBullJob())).rejects.toThrow('A real connector failure');

    expect(wasJobRecordedWithStatus(updateJobStatus, 'failed')).toBe(true);
    expect(logValue).not.toHaveBeenCalledWith(CustomMetric.JOB_LEFT_FOR_STALL_RECOVERY_ON_SHUTDOWN, 1);
  });

  it('still completes a job that finishes normally during the shutdown drain', async () => {
    const { service, updateJobStatus } = createServiceUnderTest(() => {
      markWorkerProcessShutdownStarted();
      return Promise.resolve({});
    });

    await expect(service.processJob(makeFakeBullJob())).resolves.toEqual({});

    expect(wasJobRecordedWithStatus(updateJobStatus, 'completed')).toBe(true);
  });

  it('onModuleDestroy marks the worker process as shutting down before it drains', async () => {
    const { service } = createServiceUnderTest(() => Promise.resolve({}));
    let shuttingDownWhenTheDrainStarted: boolean | undefined;
    (service as unknown as { worker: { pause: () => Promise<void> } }).worker = {
      pause: () => {
        shuttingDownWhenTheDrainStarted = isWorkerProcessShuttingDown();
        return Promise.resolve();
      },
    };

    expect(isWorkerProcessShuttingDown()).toBe(false);
    await service.onModuleDestroy();

    expect(shuttingDownWhenTheDrainStarted).toBe(true);
    expect(isWorkerProcessShuttingDown()).toBe(true);
  });
});
