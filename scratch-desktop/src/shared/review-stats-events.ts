/**
 * IPC channel + payload contract for "the review state of a workspace may have
 * changed; consumers should re-fetch `getReviewStats`."
 *
 * Fired (debounced) by the main-process review-stats notifier
 * (`review-stats-notifier.ts`) whenever a record-file edit or an
 * `accepted-patches.json` change lands. The renderer's `useReviewStats` hook
 * subscribes via `window.scratchDesktop.onReviewStatsMayHaveChanged` and
 * re-fetches; `getReviewStats` derives the dots live from git +
 * `accepted-patches.json` (DEV-10327), so there is nothing to "catch up" — the
 * re-fetch reflects the current working tree.
 *
 * Separate from `WORKSPACE_FILE_WATCH_EVENT_CHANNEL` (which carries
 * `changedFolderPaths` for the file tree) so the review-dots consumer can stay
 * a workspace-keyed, debounced signal rather than a per-burst file list.
 */

export const REVIEW_STATS_MAY_HAVE_CHANGED_CHANNEL = 'scratch:review-stats-may-have-changed';

export interface ReviewStatsMayHaveChangedEvent {
  workspacePath: string;
}
