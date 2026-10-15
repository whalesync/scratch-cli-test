import { CronExpression } from '@nestjs/schedule';
import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';
import type { WhalesyncRunNotification } from '@prisma/client';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import {
  MAX_WHALESYNC_RUN_NOTIFICATION_DELIVERY_ATTEMPTS,
  WhalesyncRunNotificationDeliveryStatus,
  WhalesyncRunNotifierService,
} from 'src/routine/whalesync-run-notifier.service';
import { WhalesyncRunNotificationSweeperService } from '../whalesync-run-notification-sweeper.service';

const MINUTE_MS = 60_000;

function dueNotification(id: string): WhalesyncRunNotification {
  return {
    id,
    createdAt: new Date(),
    routineRunId: `rrn_${id}`,
    workbookId: 'wkb_test1234',
    payload: {},
    attempts: 0,
    nextAttemptAt: new Date(),
    deliveredAt: null,
    lastError: null,
  };
}

function makeSweeper(
  deps: {
    deliveryEnabled?: boolean;
    backfillCandidateRunIds?: string[];
    runIdsTheHookAlreadyQueued?: string[];
    dueNotifications?: WhalesyncRunNotification[];
  } = {},
) {
  const routineRunFindMany = jest
    .fn()
    .mockResolvedValue((deps.backfillCandidateRunIds ?? []).map((runId) => ({ id: runId })));
  const notificationFindMany = jest.fn().mockResolvedValue(deps.dueNotifications ?? []);
  const db = {
    client: {
      routineRun: { findMany: routineRunFindMany },
      whalesyncRunNotification: { findMany: notificationFindMany },
    },
  } as unknown as DbService;

  const isNotificationDeliveryEnabled = jest.fn().mockResolvedValue(deps.deliveryEnabled ?? true);
  const enqueueNotificationIfRunIsEligible = jest.fn((runId: string) =>
    Promise.resolve(!(deps.runIdsTheHookAlreadyQueued ?? []).includes(runId)),
  );
  const deliverNotificationToWhalesync = jest
    .fn<Promise<WhalesyncRunNotificationDeliveryStatus>, [WhalesyncRunNotification]>()
    .mockResolvedValue('delivered');
  const notifier = {
    isNotificationDeliveryEnabled,
    enqueueNotificationIfRunIsEligible,
    deliverNotificationToWhalesync,
  } as unknown as WhalesyncRunNotifierService;

  const logValue = jest.fn();
  const sweeper = new WhalesyncRunNotificationSweeperService(db, notifier, {
    logValue,
  } as unknown as CustomMetricsService);
  return {
    sweeper,
    routineRunFindMany,
    notificationFindMany,
    enqueueNotificationIfRunIsEligible,
    deliverNotificationToWhalesync,
    logValue,
  };
}

describe('WhalesyncRunNotificationSweeperService', () => {
  let infoLog: jest.SpyInstance;
  let warnLog: jest.SpyInstance;

  beforeEach(() => {
    infoLog = jest.spyOn(WSLogger, 'info').mockImplementation(() => {});
    warnLog = jest.spyOn(WSLogger, 'warn').mockImplementation(() => {});
    jest.spyOn(WSLogger, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('runs every minute and never overlaps itself', () => {
    const cronOptions = Reflect.getMetadata(
      SCHEDULE_CRON_OPTIONS,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      WhalesyncRunNotificationSweeperService.prototype.sweepWhalesyncRunNotifications,
    ) as { cronTime: string; waitForCompletion?: boolean };
    expect(cronOptions.cronTime).toBe(CronExpression.EVERY_MINUTE);
    expect(cronOptions.waitForCompletion).toBe(true);
  });

  it('does nothing while delivery is disabled (kill switch off or Whalesync unconfigured)', async () => {
    const { sweeper, routineRunFindMany, notificationFindMany, deliverNotificationToWhalesync } = makeSweeper({
      deliveryEnabled: false,
      backfillCandidateRunIds: ['rrn_a'],
      dueNotifications: [dueNotification('a')],
    });
    await sweeper.sweepWhalesyncRunNotifications();
    expect(routineRunFindMany).not.toHaveBeenCalled();
    expect(notificationFindMany).not.toHaveBeenCalled();
    expect(deliverNotificationToWhalesync).not.toHaveBeenCalled();
  });

  it('backfills failed Live Export runs from the last hour that have no notification', async () => {
    const sweepStartedAtMs = Date.now();
    const { sweeper, routineRunFindMany, enqueueNotificationIfRunIsEligible, logValue } = makeSweeper({
      backfillCandidateRunIds: ['rrn_missed', 'rrn_raced'],
      // The hook (or another sweep) queued this one between the query and the insert.
      runIdsTheHookAlreadyQueued: ['rrn_raced'],
    });
    await sweeper.sweepWhalesyncRunNotifications();

    expect(routineRunFindMany).toHaveBeenCalledWith({
      where: {
        status: 'failed',
        finishedAt: { gt: expect.any(Date) as unknown, lt: expect.any(Date) as unknown },
        workbook: { managedBy: 'ws_export', isPendingDelete: false, user: { whalesyncUserId: { not: null } } },
        whalesyncRunNotification: { is: null },
      },
      select: { id: true },
      orderBy: { finishedAt: 'asc' },
      take: 100,
    });
    const [[{ where }]] = routineRunFindMany.mock.calls as [[{ where: { finishedAt: { gt: Date; lt: Date } } }]];
    // Between an hour ago and a couple of minutes ago (the hook's grace period).
    expect(where.finishedAt.gt.getTime()).toBeGreaterThanOrEqual(sweepStartedAtMs - 60 * MINUTE_MS);
    expect(where.finishedAt.gt.getTime()).toBeLessThanOrEqual(Date.now() - 60 * MINUTE_MS);
    expect(where.finishedAt.lt.getTime()).toBeGreaterThanOrEqual(sweepStartedAtMs - 2 * MINUTE_MS);
    expect(where.finishedAt.lt.getTime()).toBeLessThanOrEqual(Date.now() - 2 * MINUTE_MS);

    expect(enqueueNotificationIfRunIsEligible).toHaveBeenCalledWith('rrn_missed');
    expect(enqueueNotificationIfRunIsEligible).toHaveBeenCalledWith('rrn_raced');
    // Only the run this sweep actually queued counts as a backfill.
    expect(logValue).toHaveBeenCalledTimes(1);
    expect(logValue).toHaveBeenCalledWith(CustomMetric.WHALESYNC_RUN_NOTIFY_BACKFILLED, 1);
    expect(warnLog).toHaveBeenCalledWith(expect.objectContaining({ routineRunId: 'rrn_missed' }));
  });

  it('delivers every due notification from the last day that has attempts left', async () => {
    const sweepStartedAtMs = Date.now();
    const notifications = [dueNotification('a'), dueNotification('b')];
    const { sweeper, notificationFindMany, deliverNotificationToWhalesync } = makeSweeper({
      dueNotifications: notifications,
    });
    await sweeper.sweepWhalesyncRunNotifications();

    expect(notificationFindMany).toHaveBeenCalledWith({
      where: {
        deliveredAt: null,
        attempts: { lt: MAX_WHALESYNC_RUN_NOTIFICATION_DELIVERY_ATTEMPTS },
        nextAttemptAt: { lte: expect.any(Date) as unknown },
        createdAt: { gt: expect.any(Date) as unknown },
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: 100,
    });
    const [[{ where }]] = notificationFindMany.mock.calls as [[{ where: { createdAt: { gt: Date } } }]];
    expect(where.createdAt.gt.getTime()).toBeGreaterThanOrEqual(sweepStartedAtMs - 24 * 60 * MINUTE_MS);
    expect(where.createdAt.gt.getTime()).toBeLessThanOrEqual(Date.now() - 24 * 60 * MINUTE_MS);

    expect(deliverNotificationToWhalesync.mock.calls).toEqual([[notifications[0]], [notifications[1]]]);
    expect(infoLog).toHaveBeenCalledWith(expect.objectContaining({ backfilledCount: 0, dueCount: 2, delivered: 2 }));
  });

  it('sends one notification at a time, so Whalesync throttles a second failure for the same owner', async () => {
    let finishFirstDelivery: (status: WhalesyncRunNotificationDeliveryStatus) => void = () => {};
    const { sweeper, deliverNotificationToWhalesync } = makeSweeper({
      dueNotifications: [dueNotification('a'), dueNotification('b')],
    });
    deliverNotificationToWhalesync.mockImplementationOnce(
      () =>
        new Promise<WhalesyncRunNotificationDeliveryStatus>((resolve) => {
          finishFirstDelivery = resolve;
        }),
    );

    const sweep = sweeper.sweepWhalesyncRunNotifications();
    await new Promise((resolve) => setImmediate(resolve));
    expect(deliverNotificationToWhalesync).toHaveBeenCalledTimes(1);

    finishFirstDelivery('delivered');
    await sweep;
    expect(deliverNotificationToWhalesync).toHaveBeenCalledTimes(2);
  });

  it('backfills before delivering, so a backfilled run is sent in the same sweep', async () => {
    const { sweeper, enqueueNotificationIfRunIsEligible, notificationFindMany } = makeSweeper({
      backfillCandidateRunIds: ['rrn_missed'],
    });
    await sweeper.sweepWhalesyncRunNotifications();
    expect(enqueueNotificationIfRunIsEligible.mock.invocationCallOrder[0]).toBeLessThan(
      notificationFindMany.mock.invocationCallOrder[0],
    );
  });

  it('stays quiet when there is nothing to do', async () => {
    const { sweeper } = makeSweeper();
    await sweeper.sweepWhalesyncRunNotifications();
    expect(infoLog).not.toHaveBeenCalled();
    expect(warnLog).not.toHaveBeenCalled();
  });

  it('is non-fatal: a failing query is logged, not thrown', async () => {
    const { sweeper, notificationFindMany } = makeSweeper();
    notificationFindMany.mockRejectedValue(new Error('db down'));
    await expect(sweeper.sweepWhalesyncRunNotifications()).resolves.toBeUndefined();
    expect(warnLog).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Whalesync run notification sweep failed' }),
    );
  });
});
