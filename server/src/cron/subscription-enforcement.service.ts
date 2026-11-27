import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DbService } from 'src/db/db.service';
import { ExperimentsService } from 'src/experiments/experiments.service';
import { SystemFeatureFlag } from 'src/experiments/flags';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { hours } from 'src/utils/duration';

const LOG_SOURCE = 'SubscriptionEnforcementService';

// @nestjs/schedule has no EVERY_15_MINUTES member, so spell the 6-field (seconds-first) expression out.
const EVERY_15_MINUTES_CRON = '0 */15 * * * *';

// A subscription counts as "lapsed" when its Stripe status is one of these, written verbatim from Stripe webhooks.
// The internal WHALESYNC plan never lapses (DEV-12983): Whalesync pauses a team's Live Exports instead, which keeps
// their schedules, so this cron never acts on a Whalesync shadow organization. A row an older Scratch lapsed comes
// back active on its team's next session or Live Export access change.
const LAPSED_STRIPE_STATUSES = ['expired', 'past_due', 'canceled'];

// An organization is spared enforcement if ANY of its subscriptions is still healthy. This is a stricter
// check than `getActiveSubscriptions`, which only excludes `'canceled'` and so treats `'past_due'` as
// active — but a past_due org is exactly one we want to enforce, so we key on the positive statuses instead.
const HEALTHY_STRIPE_STATUSES = ['active', 'trialing'];

// Only act on subscriptions whose status changed recently, so the sweep stays cheap and acts near the lapse
// event rather than re-processing ancient cancellations forever (and so a user's manual re-enable of a
// schedule sticks once their subscription falls out of this window).
const ENFORCEMENT_LOOKBACK = hours(12);

/**
 * Every 15 minutes, enforce lapsed subscriptions by disabling an organization's scheduled work.
 *
 * Finds organizations whose subscription lapsed in the last 12 hours (Stripe status expired / past_due /
 * canceled) and, for any that no longer hold a healthy subscription, disables ALL of their scheduled actions
 * — routines, pulls, publishes, and syncs. The `Schedule` table denormalizes `organizationId` onto every
 * row, so a single org-scoped `updateMany` covers every workbook's schedules. Enforcement is one-way and
 * terminal: a user whose subscription lapsed rebuilds their schedules manually after re-subscribing, so no
 * provenance marker is stamped and nothing is auto-restored.
 *
 * Idempotent (only still-enabled schedules are touched) and non-fatal (catch + `WSLogger.warn`) per the cron
 * conventions in this dir's CLAUDE.md. Runs only on the cron service / local monolith (see `CronModule`).
 */
@Injectable()
export class SubscriptionEnforcementService {
  constructor(
    private readonly db: DbService,
    @Inject(CustomMetricsService) private readonly metricsService: CustomMetricsService,
    private readonly experimentsService: ExperimentsService,
  ) {}

  @Cron(EVERY_15_MINUTES_CRON)
  async enforceLapsedSubscriptions(): Promise<void> {
    WSLogger.info({ source: LOG_SOURCE, message: 'Waking up, starting subscription-enforcement sweep' });

    try {
      // Opt-in gate / kill switch: enforcement is OFF by default (fail-closed) and runs only when the
      // SUBSCRIPTION_ENFORCEMENT_ENABLED flag is explicitly enabled. Flip the flag off to halt it without a
      // redeploy; an absent flag or a PostHog outage leaves enforcement off (never disables schedules blindly).
      const enforcementEnabled = await this.experimentsService.getBooleanFlag(
        SystemFeatureFlag.SUBSCRIPTION_ENFORCEMENT_ENABLED,
        false,
      );
      if (!enforcementEnabled) {
        WSLogger.info({
          source: LOG_SOURCE,
          message: 'Subscription-enforcement sweep skipped: SUBSCRIPTION_ENFORCEMENT_ENABLED flag is off',
        });
        return;
      }

      const organizationsWithRecentlyLapsedSubscriptions = await this.db.client.subscription.findMany({
        where: {
          stripeStatus: { in: LAPSED_STRIPE_STATUSES },
          updatedAt: { gte: ENFORCEMENT_LOOKBACK.inPast() },
        },
        select: { organizationId: true },
        distinct: ['organizationId'],
      });

      let organizationsEnforced = 0;
      let totalSchedulesDisabled = 0;

      for (const { organizationId } of organizationsWithRecentlyLapsedSubscriptions) {
        // Spare an org that still holds a healthy subscription (e.g. a lapsed trial alongside a genuinely
        // active paid plan) — its scheduled work must keep running.
        const organizationSubscriptions = await this.db.client.subscription.findMany({
          where: { organizationId },
          select: { stripeStatus: true, expiration: true },
        });
        const now = new Date();
        const hasHealthySubscription = organizationSubscriptions.some(
          (subscription) =>
            subscription.stripeStatus !== null &&
            HEALTHY_STRIPE_STATUSES.includes(subscription.stripeStatus) &&
            subscription.expiration >= now,
        );
        if (hasHealthySubscription) {
          continue;
        }

        const { count: schedulesDisabled } = await this.db.client.schedule.updateMany({
          where: { organizationId, enabled: true },
          data: { enabled: false },
        });
        if (schedulesDisabled > 0) {
          organizationsEnforced += 1;
          totalSchedulesDisabled += schedulesDisabled;
          this.metricsService.logValue(CustomMetric.SUBSCRIPTION_LAPSE_SCHEDULES_DISABLED, schedulesDisabled);
          WSLogger.info({
            source: LOG_SOURCE,
            message: 'Disabled scheduled actions for organization with a lapsed subscription',
            organizationId,
            schedulesDisabled,
          });
        }
      }

      WSLogger.info({
        source: LOG_SOURCE,
        message: `Subscription-enforcement sweep complete (${organizationsWithRecentlyLapsedSubscriptions.length} lapsed orgs scanned, ${organizationsEnforced} enforced, ${totalSchedulesDisabled} schedules disabled).`,
        lapsedOrgsScanned: organizationsWithRecentlyLapsedSubscriptions.length,
        organizationsEnforced,
        totalSchedulesDisabled,
      });
    } catch (error) {
      WSLogger.warn({ source: LOG_SOURCE, message: 'Subscription-enforcement sweep failed', error });
    }
  }
}
