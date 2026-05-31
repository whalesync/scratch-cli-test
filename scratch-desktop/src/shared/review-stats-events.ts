/**
 * IPC channel + payload contract for "the persisted review-state bits for one
 * or more folders may have changed; consumers should re-fetch
 * `getReviewStats`."
 *
 * Fired by the main-process refresh queue (`review-refresh-queue.ts`) after a
 * `refreshFolder` napi call completes. The renderer's `useReviewStats` hook
 * subscribes via `window.scratchDesktop.onReviewStatsMayHaveChanged` and
 * debounces re-fetches.
 *
 * Why a separate channel from `WORKSPACE_FILE_WATCH_EVENT_CHANNEL`: the file
 * watcher fires once per file-change burst with `changedFolderPaths`; this
 * event fires once per *completed* refresh and signals "the SQLite bits are
 * now current." Renderer consumers want the latter, not the former — they
 * want the dots to update *after* the index catches up, not *before*.
 */

export const REVIEW_STATS_MAY_HAVE_CHANGED_CHANNEL = 'scratch:review-stats-may-have-changed';

export interface ReviewStatsMayHaveChangedEvent {
  workspacePath: string;
}
