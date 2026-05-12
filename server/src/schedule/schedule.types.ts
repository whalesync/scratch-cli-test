/** Minimum allowed interval between schedule ticks: 5 minutes. */
export const SCHEDULE_MIN_INTERVAL_MINUTES = 1;

/** Default debounce window in milliseconds. If a job for the same entity was created within this window, skip. */
export const SCHEDULE_DEBOUNCE_WINDOW_MS = 30_000;

import { JobType } from '@spinner/shared-types';

const SCHEDULE_ACTION_TO_JOB_TYPE: Record<string, JobType> = {
  PULL: JobType.PullLinkedFolderFiles,
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
