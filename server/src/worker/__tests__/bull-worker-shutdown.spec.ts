import { ScratchConfigService } from 'src/config/scratch-config.service';
import { JobService } from 'src/job/job.service';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { RunCountService } from 'src/run-count/run-count.service';
import { QueueService } from '../bull-worker.service';
import { JobHandlerService } from '../job-handler.service';

/**
 * Tests for QueueService's two-phase graceful shutdown (DEV-11184), mirroring the sibling bottlenose
 * convention: onModuleDestroy pauses the BullMQ worker (stop new-job intake + drain the in-flight
 * job(s), bounded by a budget), then onApplicationShutdown force-closes the worker and quits the
 * Redis/Queue clients it owns — as late as possible, after HTTP has drained. We drive the real
 * QueueService with the worker / Redis clients replaced by fakes injected into its private fields, so
 * no BullMQ or Redis infrastructure is needed.
 */

jest.mock('src/logger', () => ({
  WSLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

type FakeWorker = { pause: jest.Mock; close: jest.Mock };
type FakeQueue = { close: jest.Mock };
type FakeRedis = { quit: jest.Mock };

/** The subset of QueueService's private fields the shutdown path touches. */
type QueueServiceShutdownInternals = {
  worker: FakeWorker | null;
  queue: FakeQueue | null;
  redis: FakeRedis | null;
  pubSubRedis: FakeRedis | null;
};

function makeFakeWorker(pause: jest.Mock): FakeWorker {
  return { pause, close: jest.fn().mockResolvedValue(undefined) };
}

function makeFakeQueue(): FakeQueue {
  return { close: jest.fn().mockResolvedValue(undefined) };
}

function makeFakeRedis(): FakeRedis {
  return { quit: jest.fn().mockResolvedValue(undefined) };
}

function createServiceUnderTest(params: {
  shutdownBudgetMs: number;
  worker: FakeWorker | null;
  queue: FakeQueue;
  redis: FakeRedis;
  pubSubRedis: FakeRedis;
}): { service: QueueService; logValue: jest.Mock } {
  const logValue = jest.fn();
  const configService = {
    getWorkerShutdownTimeoutMs: () => params.shutdownBudgetMs,
  } as unknown as ScratchConfigService;
  const metricsService = { logValue } as unknown as CustomMetricsService;

  const service = new QueueService(
    {} as unknown as JobHandlerService,
    {} as unknown as JobService,
    configService,
    metricsService,
    {} as unknown as RunCountService,
  );

  const internals = service as unknown as QueueServiceShutdownInternals;
  internals.worker = params.worker;
  internals.queue = params.queue;
  internals.redis = params.redis;
  internals.pubSubRedis = params.pubSubRedis;

  return { service, logValue };
}

describe('QueueService two-phase graceful shutdown', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('phase 1 (onModuleDestroy) pauses within budget and records DRAINED without disconnecting yet', async () => {
    const worker = makeFakeWorker(jest.fn().mockResolvedValue(undefined));
    const queue = makeFakeQueue();
    const redis = makeFakeRedis();
    const pubSubRedis = makeFakeRedis();

    const { service, logValue } = createServiceUnderTest({
      shutdownBudgetMs: 10_000,
      worker,
      queue,
      redis,
      pubSubRedis,
    });

    await service.onModuleDestroy();

    expect(worker.pause).toHaveBeenCalledTimes(1);
    expect(logValue).toHaveBeenCalledWith(CustomMetric.WORKER_SHUTDOWN_DRAINED, 1);
    expect(logValue).not.toHaveBeenCalledWith(CustomMetric.WORKER_SHUTDOWN_TIMED_OUT, 1);
    // Disconnection is deferred to onApplicationShutdown.
    expect(worker.close).not.toHaveBeenCalled();
    expect(queue.close).not.toHaveBeenCalled();
    expect(redis.quit).not.toHaveBeenCalled();
    expect(pubSubRedis.quit).not.toHaveBeenCalled();
  });

  it('phase 2 (onApplicationShutdown) force-closes the worker and quits owned connections', async () => {
    const worker = makeFakeWorker(jest.fn().mockResolvedValue(undefined));
    const queue = makeFakeQueue();
    const redis = makeFakeRedis();
    const pubSubRedis = makeFakeRedis();

    const { service } = createServiceUnderTest({ shutdownBudgetMs: 10_000, worker, queue, redis, pubSubRedis });

    await service.onModuleDestroy();
    await service.onApplicationShutdown();

    // Force-close (true) — never re-wait for jobs, since the pause already drained them.
    expect(worker.close).toHaveBeenCalledTimes(1);
    expect(worker.close).toHaveBeenCalledWith(true);
    expect(queue.close).toHaveBeenCalledTimes(1);
    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(pubSubRedis.quit).toHaveBeenCalledTimes(1);
  });

  it('gives up after the budget when the worker will not drain, records TIMED_OUT, then still force-closes', async () => {
    // A worker.pause() that never resolves simulates a long-running in-flight job.
    const worker = makeFakeWorker(jest.fn().mockReturnValue(new Promise<void>(() => undefined)));
    const queue = makeFakeQueue();
    const redis = makeFakeRedis();
    const pubSubRedis = makeFakeRedis();

    const { service, logValue } = createServiceUnderTest({
      shutdownBudgetMs: 20,
      worker,
      queue,
      redis,
      pubSubRedis,
    });

    await service.onModuleDestroy();

    expect(logValue).toHaveBeenCalledWith(CustomMetric.WORKER_SHUTDOWN_TIMED_OUT, 1);
    expect(logValue).not.toHaveBeenCalledWith(CustomMetric.WORKER_SHUTDOWN_DRAINED, 1);

    await service.onApplicationShutdown();

    // Force-close must not re-wait for the still-running job.
    expect(worker.close).toHaveBeenCalledWith(true);
    expect(queue.close).toHaveBeenCalledTimes(1);
    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(pubSubRedis.quit).toHaveBeenCalledTimes(1);
  });

  it('records no drain metric when there is no worker but still disconnects owned connections', async () => {
    const queue = makeFakeQueue();
    const redis = makeFakeRedis();
    const pubSubRedis = makeFakeRedis();

    const { service, logValue } = createServiceUnderTest({
      shutdownBudgetMs: 10_000,
      worker: null,
      queue,
      redis,
      pubSubRedis,
    });

    await service.onModuleDestroy();
    await service.onApplicationShutdown();

    expect(logValue).not.toHaveBeenCalled();
    expect(queue.close).toHaveBeenCalledTimes(1);
    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(pubSubRedis.quit).toHaveBeenCalledTimes(1);
  });

  it('swallows a connection-close failure during onApplicationShutdown and continues closing the rest', async () => {
    const worker = makeFakeWorker(jest.fn().mockResolvedValue(undefined));
    const queue = makeFakeQueue();
    const redis: FakeRedis = { quit: jest.fn().mockRejectedValue(new Error('redis quit failed')) };
    const pubSubRedis = makeFakeRedis();

    const { service } = createServiceUnderTest({ shutdownBudgetMs: 10_000, worker, queue, redis, pubSubRedis });

    await service.onModuleDestroy();
    await expect(service.onApplicationShutdown()).resolves.toBeUndefined();

    expect(redis.quit).toHaveBeenCalledTimes(1);
    // The loop must continue past the failed redis close and still quit the pub/sub client.
    expect(pubSubRedis.quit).toHaveBeenCalledTimes(1);
  });
});
