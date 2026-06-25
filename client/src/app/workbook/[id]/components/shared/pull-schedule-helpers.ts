import { scratchApiClient } from '@/lib/api/scratch-api-client';
import type { Schedule } from '@spinner/shared-types';
import { isTimeBasedCron, ScheduleAction } from '@spinner/shared-types';

/** Cron value for the "Manual only" option — an empty string means "no schedule". */
export const MANUAL_ONLY = '';

/**
 * The IANA timezone to store for a schedule with the given cron. Time-based frequencies
 * (daily/weekly/monthly) are stored in the user's current browser timezone so the cron's
 * wall-clock time tracks their local time (and DST); interval and manual schedules are
 * timezone-invariant and store null.
 */
export function getScheduleTimezone(cron: string): string | null {
  if (!isTimeBasedCron(cron)) {
    return null;
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

/**
 * Reconciles a single schedule "row" (one action on one entity) to the chosen cron
 * value: deletes the schedule when set to "Manual only", updates the cron + timezone when
 * the cron changed, or creates a new schedule. Shared by the per-table and per-connection
 * pull-schedule modals so both stay byte-for-byte consistent.
 *
 * The timezone is derived from the cron (browser tz for time-based, null otherwise). A
 * cron-unchanged save is a no-op so it never reassigns the stored timezone — there is no
 * independent timezone control, so the only way the timezone moves is by editing the cron.
 */
export async function applyScheduleRow(params: {
  workbookId: string;
  existing: Schedule | null;
  value: string;
  action: ScheduleAction;
  entityId: string;
  name: string;
}): Promise<void> {
  const { workbookId, existing, value, action, entityId, name } = params;
  if (value === MANUAL_ONLY) {
    if (existing) {
      await scratchApiClient.schedule.delete(workbookId, existing.id);
    }
    return;
  }
  const timezone = getScheduleTimezone(value);
  if (existing) {
    if (existing.cronExpression !== value) {
      await scratchApiClient.schedule.update(workbookId, existing.id, { cronExpression: value, timezone });
    }
    return;
  }
  await scratchApiClient.schedule.create(workbookId, { name, action, entityId, cronExpression: value, timezone });
}
