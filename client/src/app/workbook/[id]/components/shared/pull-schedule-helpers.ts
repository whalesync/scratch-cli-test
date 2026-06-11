import { scratchApiClient } from '@/lib/api/scratch-api-client';
import type { Schedule } from '@spinner/shared-types';
import { ScheduleAction } from '@spinner/shared-types';

/** Cron value for the "Manual only" option — an empty string means "no schedule". */
export const MANUAL_ONLY = '';
/** Cron value for the dev-only "Every minute" option. */
export const EVERY_MINUTE = '* * * * *';

/** Frequency options shared by the per-table and per-connection pull-schedule modals. */
export const PULL_SCHEDULE_OPTIONS = [
  { value: MANUAL_ONLY, label: 'Manual only' },
  { value: '*/5 * * * *', label: 'Every 5 minutes' },
  { value: '*/30 * * * *', label: 'Every 30 minutes' },
  { value: '0 * * * *', label: 'Hourly' },
  { value: '0 0 * * *', label: 'Daily' },
];

/** Extra frequency option exposed only when dev tools are enabled. */
export const DEV_ONLY_OPTION = { value: EVERY_MINUTE, label: 'Every minute (internal use only)' };

/**
 * Reconciles a single schedule "row" (one action on one entity) to the chosen cron
 * value: deletes the schedule when set to "Manual only", updates the cron when it
 * changed, or creates a new schedule. Shared by the per-table and per-connection
 * pull-schedule modals so both stay byte-for-byte consistent.
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
  if (existing) {
    if (existing.cronExpression !== value) {
      await scratchApiClient.schedule.update(workbookId, existing.id, { cronExpression: value });
    }
    return;
  }
  await scratchApiClient.schedule.create(workbookId, { name, action, entityId, cronExpression: value });
}
