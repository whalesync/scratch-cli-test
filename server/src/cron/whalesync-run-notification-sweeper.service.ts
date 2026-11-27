import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WorkbookManager } from '@prisma/client';
import { RoutineRunId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import {
  MAX_WHALESYNC_RUN_NOTIFICATION_DELIVERY_ATTEMPTS,
  WHALESYNC_RUN_NOTIFICATION_RETRY_HORIZON,
  WhalesyncRunNotifierService,
} from 'src/routine/whalesync-run-notifier.service';
import { hours, minutes } from 'src/utils/duration';

const LOG_SOURCE = 'WhalesyncRunNotificationSweeperService';

/** At most this many runs backfilled, and this many notifications sent, per sweep. */
const WHALESYNC_RUN_NOTIFICATION_SWEEP_BATCH_SIZE = 100;

/** The backfill looks for failed Live Export runs that finished within this window and were never queued. */
const WHALESYNC_RUN_NOTIFICATION_BACKFILL_LOOKBACK = hours(1);

/**
 * The backfill leaves runs that failed in the last couple of minutes to the executor's own hook, so it only queues
 * runs the hook really missed (and the BACKFILLED metric stays a true count of misses).
 */
const WHALESYNC_RUN_NOTIFICATION_BACKFILL_GRACE = minutes(2);

/**
 * Delivers queued Whalesync run notifications (DEV-12330); see {@link WhalesyncRunNotifierService} for the design.
 *
 * Every minute, while the `LIVE_EXPORT_RUN_NOTIFY_WHALESYNC_ENABLED` flag is on and Whalesync is configured:
 * 1. Backfill: queue failed Live Export runs from the last hour that have no notification, which happens when the
 *    process died between failing the run and queuing it.
 * 2. Deliver: send every notification that is due, one at a time, rescheduling failures with backoff.
 *
 * `waitForCompletion` stops a slow sweep (each POST may take up to its 10s timeout) from overlapping the next one.
 * Idempotent and non-fatal per this dir's CLAUDE.md. Runs only on the cron service / local monolith.
 */
@Injectable()
export class WhalesyncRunNotificationSweeperService {
  constructor(
    private readonly db: DbService,
    private readonly whalesyncRunNotifier: WhalesyncRunNotifierService,
    @Inject(CustomMetricsService) private readonly metricsService: CustomMetricsService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { waitForCompletion: true })
  async sweepWhalesyncRunNotifications(): Promise<void> {
    try {
      // The kill switch stops retries as well as new notifications. Not logged: this runs every minute.
      if (!(await this.whalesyncRunNotifier.isNotificationDeliveryEnabled())) {
        return;
      }

      const backfilledRunIds = await this.backfillFailedLiveExportRunsMissingANotification();

      const now = new Date();
      const dueNotifications = await this.db.client.whalesyncRunNotification.findMany({
        where: {
          deliveredAt: null,
          attempts: { lt: MAX_WHALESYNC_RUN_NOTIFICATION_DELIVERY_ATTEMPTS },
          nextAttemptAt: { lte: now },
          createdAt: { gt: WHALESYNC_RUN_NOTIFICATION_RETRY_HORIZON.before(now) },
        },
        orderBy: { nextAttemptAt: 'asc' },
        take: WHALESYNC_RUN_NOTIFICATION_SWEEP_BATCH_SIZE,
      });

      const deliveryStatusCounts = { delivered: 0, will_retry: 0, gave_up: 0, not_attempted: 0 };
      // One at a time on purpose: Whalesync throttles failure emails per user per day, and it can only see the first
      // email when deciding the second if the two requests don't overlap.
      for (const notification of dueNotifications) {
        const deliveryStatus = await this.whalesyncRunNotifier.deliverNotificationToWhalesync(notification);
        deliveryStatusCounts[deliveryStatus] += 1;
      }

      if (backfilledRunIds.length > 0 || dueNotifications.length > 0) {
        WSLogger.info({
          source: LOG_SOURCE,
          message: `Whalesync run notification sweep complete (${backfilledRunIds.length} backfilled, ${dueNotifications.length} due: ${deliveryStatusCounts.delivered} delivered, ${deliveryStatusCounts.will_retry} will retry, ${deliveryStatusCounts.gave_up} gave up).`,
          backfilledCount: backfilledRunIds.length,
          dueCount: dueNotifications.length,
          ...deliveryStatusCounts,
        });
      }
    } catch (error) {
      WSLogger.warn({ source: LOG_SOURCE, message: 'Whalesync run notification sweep failed', error });
    }
  }

  private async backfillFailedLiveExportRunsMissingANotification(): Promise<RoutineRunId[]> {
    const candidateRunIds = await findRecentlyFailedLiveExportRunIdsWithoutWhalesyncNotification(this.db, new Date());
    const backfilledRunIds: RoutineRunId[] = [];
    for (const runId of candidateRunIds) {
      if (await this.whalesyncRunNotifier.enqueueNotificationIfRunIsEligible(runId)) {
        backfilledRunIds.push(runId);
        this.metricsService.logValue(CustomMetric.WHALESYNC_RUN_NOTIFY_BACKFILLED, 1);
        WSLogger.warn({
          source: LOG_SOURCE,
          message: `Backfilled the Whalesync notification for failed Live Export run ${runId}; the executor's hook never queued it`,
          routineRunId: runId,
        });
      }
    }
    return backfilledRunIds;
  }
}

/**
 * Failed Live Export runs that finished between an hour and a couple of minutes before `now`, belong to a workbook
 * whose user belongs to a Whalesync team, isn't being deleted, and have no `WhalesyncRunNotification`: the runs the executor's
 * hook never queued.
 */
export async function findRecentlyFailedLiveExportRunIdsWithoutWhalesyncNotification(
  db: DbService,
  now: Date,
): Promise<RoutineRunId[]> {
  const runs = await db.client.routineRun.findMany({
    where: {
      status: 'failed',
      finishedAt: {
        gt: WHALESYNC_RUN_NOTIFICATION_BACKFILL_LOOKBACK.before(now),
        lt: WHALESYNC_RUN_NOTIFICATION_BACKFILL_GRACE.before(now),
      },
      workbook: {
        managedBy: WorkbookManager.ws_export,
        isPendingDelete: false,
        user: { whalesyncTeamId: { not: null } },
      },
      whalesyncRunNotification: { is: null },
    },
    select: { id: true },
    orderBy: { finishedAt: 'asc' },
    take: WHALESYNC_RUN_NOTIFICATION_SWEEP_BATCH_SIZE,
  });
  return runs.map((run) => run.id as RoutineRunId);
}
