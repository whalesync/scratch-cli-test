/** Minimum allowed interval between schedule ticks: 5 minutes. */
export const SCHEDULE_MIN_INTERVAL_MINUTES = 1;

/** Default debounce window in milliseconds. If a job for the same entity was created within this window, skip. */
export const SCHEDULE_DEBOUNCE_WINDOW_MS = 30_000;

import { JobType } from '@spinner/shared-types';

const SCHEDULE_ACTION_TO_JOB_TYPE: Record<string, JobType> = {
  PULL: JobType.PullLinkedFolderFiles, // @deprecated — equivalent to FULL_PULL
  FULL_PULL: JobType.PullLinkedFolderFiles,
  INCREMENTAL_PULL: JobType.PullLinkedFolderFiles,
  PUBLISH: JobType.Publish,
  SYNC: JobType.SyncDataFolders,
};

/** Maps a ScheduleAction string to the corresponding BullMQ job type string. */
export function actionToJobType(action: string): JobType {
  const jobType = SCHEDULE_ACTION_TO_JOB_TYPE[action];
  if (!jobType) {
    throw new Error(`Unknown schedule action: ${action}`);
  }
  return jobType;
}

/**
 * True for the three pull-type schedule actions (`PULL`, `FULL_PULL`,
 * `INCREMENTAL_PULL`) which all target a linked DataFolder and enqueue a
 * `PullLinkedFolderFiles` job. Used by schedule CRUD to validate the entity.
 */
export function isPullAction(action: string): boolean {
  return action === 'PULL' || action === 'FULL_PULL' || action === 'INCREMENTAL_PULL';
}

/**
 * Resolves the pull mode for a pull-type schedule action. `PULL` and `FULL_PULL`
 * are equivalent at runtime (legacy `PULL` is kept for runtime tolerance until the
 * enum value is dropped); only `INCREMENTAL_PULL` requests an incremental pull.
 * Throws for non-pull actions — callers must only invoke this for pull schedules.
 */
export function scheduleActionToPullMode(action: string): 'full' | 'incremental' {
  switch (action) {
    case 'INCREMENTAL_PULL':
      return 'incremental';
    case 'FULL_PULL':
    case 'PULL':
      return 'full';
    default:
      throw new Error(`scheduleActionToPullMode called with non-pull action: ${action}`);
  }
}
