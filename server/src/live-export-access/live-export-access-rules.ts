import { Prisma } from '@prisma/client';
import {
  LiveExportCadence,
  liveExportCadenceSchema,
  WhalesyncLiveExportAccess,
  WhalesyncSubscriptionMetadata,
  WhalesyncSubscriptionPayload,
} from '@spinner/shared-types';
import { CronExpressionParser } from 'cron-parser';
import { days, Duration, minutes } from 'src/utils/duration';

/**
 * The least time a Live Export schedule may leave between runs at each speed. Whalesync's fastest schedule at each
 * speed runs every 10 minutes (`frequent`), every hour (`hourly`), or once a day at a set hour (`daily`). Each limit
 * sits a little under that, so those schedules always fit: a minute under for the first two, and an hour and a minute
 * under a day for `daily`, since a daily schedule in a timezone with daylight saving time can run 23 hours after the
 * last run on the day the clocks go forward.
 */
const LEAST_TIME_BETWEEN_SCHEDULED_LIVE_EXPORT_RUNS_BY_CADENCE: Record<LiveExportCadence, Duration> = {
  frequent: minutes(9),
  hourly: minutes(59),
  daily: minutes(24 * 60 - 61),
};

/** How each speed reads in a message: "runs Live Exports at most once an hour". */
const LIVE_EXPORT_CADENCE_DESCRIPTIONS: Record<LiveExportCadence, string> = {
  frequent: 'every 10 minutes',
  hourly: 'once an hour',
  daily: 'once a day',
};

/** How many upcoming runs of a schedule are compared when checking it against a speed. */
const UPCOMING_SCHEDULED_RUNS_COMPARED = 50;

/** Upcoming runs further out than this aren't compared. A schedule this slow fits every speed. */
const UPCOMING_SCHEDULED_RUNS_HORIZON = days(400);

/**
 * The Live Export access of a team Whalesync has sent none for: its Live Exports run, with no record limit and no
 * speed limit. A team is paused only once Whalesync says so (DEV-12983).
 */
export const LIVE_EXPORT_ACCESS_WITH_NO_LIMITS: WhalesyncLiveExportAccess = {
  paused: false,
  recordLimit: null,
  fastestCadence: null,
};

/**
 * The Live Export access stored in a `WHALESYNC_PLAN` row's `Subscription.metadata` (shape
 * `WhalesyncSubscriptionMetadata`). A missing value reads as no limit, and only a stored `true` reads as paused, so a
 * row written before DEV-12983 MR 3.1 keeps its Live Exports running.
 */
export function readLiveExportAccessFromWhalesyncPlanMetadata(
  metadata: Prisma.JsonValue | null,
): WhalesyncLiveExportAccess {
  return {
    paused: extractLiveExportsPaused(metadata),
    recordLimit: extractLiveExportRecordCountLimit(metadata) ?? null,
    fastestCadence: extractLiveExportCadence(metadata) ?? null,
  };
}

/** The `Subscription.metadata` that stores `liveExportAccess`, leaving out each limit that is null. */
export function buildWhalesyncPlanMetadataForLiveExportAccess(
  liveExportAccess: WhalesyncLiveExportAccess,
): WhalesyncSubscriptionMetadata {
  return {
    liveExportsPaused: liveExportAccess.paused,
    ...(liveExportAccess.recordLimit !== null && { liveExportRecordCountLimit: liveExportAccess.recordLimit }),
    ...(liveExportAccess.fastestCadence !== null && { liveExportCadence: liveExportAccess.fastestCadence }),
  };
}

/**
 * The Live Export access a subscription payload from a Whalesync backend before DEV-12983 MR 3.2 stands for: paused
 * unless its status is `active`, with its record limit and cadence. Its product type and expiry are ignored.
 */
export function liveExportAccessFromWhalesyncSubscriptionPayload(
  whalesyncSubscriptionPayload: WhalesyncSubscriptionPayload,
): WhalesyncLiveExportAccess {
  return {
    paused: whalesyncSubscriptionPayload.status !== 'active',
    recordLimit: whalesyncSubscriptionPayload.liveExportRecordCountLimit ?? null,
    fastestCadence: whalesyncSubscriptionPayload.liveExportCadence ?? null,
  };
}

/** Whether two Live Export accesses pause the same way and set the same limits. */
export function isSameLiveExportAccess(
  firstLiveExportAccess: WhalesyncLiveExportAccess,
  secondLiveExportAccess: WhalesyncLiveExportAccess,
): boolean {
  return (
    firstLiveExportAccess.paused === secondLiveExportAccess.paused &&
    firstLiveExportAccess.recordLimit === secondLiveExportAccess.recordLimit &&
    firstLiveExportAccess.fastestCadence === secondLiveExportAccess.fastestCadence
  );
}

/** The least time a Live Export schedule may leave between runs at `cadence`. */
export function leastTimeBetweenScheduledLiveExportRuns(cadence: LiveExportCadence): Duration {
  return LEAST_TIME_BETWEEN_SCHEDULED_LIVE_EXPORT_RUNS_BY_CADENCE[cadence];
}

/** How `cadence` reads in a message, such as "once an hour". */
export function describeLiveExportCadence(cadence: LiveExportCadence): string {
  return LIVE_EXPORT_CADENCE_DESCRIPTIONS[cadence];
}

/**
 * Whether a cron schedule, read in its timezone, would ever run sooner after its previous run than `cadence` allows.
 * Compares its next {@link UPCOMING_SCHEDULED_RUNS_COMPARED} runs, and stops at the first run more than
 * {@link UPCOMING_SCHEDULED_RUNS_HORIZON} away. Null when cron-parser can't read the schedule, so each caller decides
 * what an unreadable schedule means.
 */
export function isCronScheduleFasterThanLiveExportCadence(
  cronExpression: string,
  timezone: string | null,
  cadence: LiveExportCadence,
  now: Date,
): boolean | null {
  const leastMillisecondsBetweenScheduledRuns = leastTimeBetweenScheduledLiveExportRuns(cadence).ms();
  const lastComparedRunAt = UPCOMING_SCHEDULED_RUNS_HORIZON.after(now);
  try {
    const upcomingScheduledRuns = CronExpressionParser.parse(cronExpression, {
      tz: timezone ?? undefined,
      currentDate: now,
    });
    let previousScheduledRunAt = upcomingScheduledRuns.next().toDate();
    for (let comparedRunCount = 1; comparedRunCount < UPCOMING_SCHEDULED_RUNS_COMPARED; comparedRunCount++) {
      if (previousScheduledRunAt > lastComparedRunAt) {
        return false;
      }
      const nextScheduledRunAt = upcomingScheduledRuns.next().toDate();
      if (nextScheduledRunAt.getTime() - previousScheduledRunAt.getTime() < leastMillisecondsBetweenScheduledRuns) {
        return true;
      }
      previousScheduledRunAt = nextScheduledRunAt;
    }
    return false;
  } catch {
    return null;
  }
}

/** Whether a `WHALESYNC_PLAN` row's metadata pauses the team's Live Exports: only when it stores `true`. */
export function extractLiveExportsPaused(metadata: Prisma.JsonValue | null): boolean {
  return readWhalesyncPlanMetadataField(metadata, 'liveExportsPaused') === true;
}

/**
 * The Live Export record limit in a `WHALESYNC_PLAN` row's metadata, or undefined when the metadata doesn't carry it
 * as a number. A limit of `0` is returned as-is and enforced literally.
 */
export function extractLiveExportRecordCountLimit(metadata: Prisma.JsonValue | null): number | undefined {
  const rawRecordCountLimit = readWhalesyncPlanMetadataField(metadata, 'liveExportRecordCountLimit');
  return typeof rawRecordCountLimit === 'number' ? rawRecordCountLimit : undefined;
}

/** The speed in a `WHALESYNC_PLAN` row's metadata, or undefined when the metadata doesn't carry a known one. */
export function extractLiveExportCadence(metadata: Prisma.JsonValue | null): LiveExportCadence | undefined {
  const parsedCadence = liveExportCadenceSchema.safeParse(
    readWhalesyncPlanMetadataField(metadata, 'liveExportCadence'),
  );
  return parsedCadence.success ? parsedCadence.data : undefined;
}

function readWhalesyncPlanMetadataField(
  metadata: Prisma.JsonValue | null,
  field: keyof WhalesyncSubscriptionMetadata,
): unknown {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }
  return (metadata as Record<string, unknown>)[field];
}
