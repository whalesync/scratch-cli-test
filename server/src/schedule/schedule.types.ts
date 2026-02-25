/** Minimum allowed interval between schedule ticks: 5 minutes. */
export const SCHEDULE_MIN_INTERVAL_MINUTES = 1;

/** Default debounce window in milliseconds. If a job for the same entity was created within this window, skip. */
export const SCHEDULE_DEBOUNCE_WINDOW_MS = 30_000;

/** Maps a ScheduleAction string to the corresponding BullMQ job type string. */
export function actionToJobType(action: string): string {
  switch (action) {
    case 'PULL':
      return 'pull-linked-folder-files';
    case 'PUBLISH':
      return 'publish-data-folder';
    case 'SYNC':
      return 'sync-data-folders';
    default:
      throw new Error(`Unknown schedule action: ${action}`);
  }
}
