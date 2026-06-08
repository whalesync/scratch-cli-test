/**
 * Debounced notifier for the folder-tree review-state dots.
 *
 * The dots are derived live from git + `accepted-patches.json` on every
 * `getReviewStats` call (DEV-10327) — there is no persisted index to refresh.
 * So all this needs to do is tell the renderer "re-fetch your review stats"
 * after something that could have changed them:
 *
 *   - an external edit to a record file (Claude / vim / an external `scratchmd`
 *     run),
 *   - an internal accept / reject / discard / pull / publish IPC, or
 *   - any change to a connection's `accepted-patches.json`.
 *
 * A trailing-edge debounce collapses a burst of changes into one IPC event; the
 * renderer's `useReviewStats` hook re-fetches `getReviewStats` and the dots
 * update. No work runs in the main process beyond scheduling the event — the
 * actual `gix status` happens off-thread inside the napi `getReviewStats` worker
 * when the renderer re-fetches.
 *
 * Singleton: one Electron main process per app, one workspace shown at a time.
 * Notifications are keyed by `workspacePath` so a workspace switch mid-flight
 * can't cross-contaminate.
 *
 * This replaced the old `review-refresh-queue.ts` (DEV-10327): once the dots
 * stopped reading the persisted `folder_index` review bits, the cold-start
 * sweep, the serial drain, and the per-folder `refreshFolder` re-reads all
 * became dead work — the watcher only ever needed to nudge the renderer.
 */

import type { WebContents } from 'electron';
import {
  REVIEW_STATS_MAY_HAVE_CHANGED_CHANNEL,
  type ReviewStatsMayHaveChangedEvent,
} from '../shared/review-stats-events';

/** Trailing-edge debounce so a fast burst of changes emits one IPC event. */
const STATS_EVENT_DEBOUNCE_MS = 250;

class ReviewStatsNotifier {
  /** The active renderer subscriber. Single WebContents at a time. */
  private subscriber: WebContents | null = null;
  /** Workspace paths waiting to be notified — one IPC event per debounce window. */
  private pendingNotifyWorkspacePaths = new Set<string>();
  private notifyTimer: NodeJS.Timeout | null = null;

  /** Register the renderer that should receive `'review-stats-may-have-changed'` events. */
  setSubscriber(subscriber: WebContents | null): void {
    this.subscriber = subscriber;
  }

  /**
   * Tell the renderer that `workspacePath`'s review stats may have changed so it
   * re-fetches `getReviewStats`. Debounced — a burst collapses to one event per
   * workspace.
   */
  notifyReviewStatsChanged(workspacePath: string): void {
    this.pendingNotifyWorkspacePaths.add(workspacePath);
    if (this.notifyTimer != null) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      const workspacePaths = Array.from(this.pendingNotifyWorkspacePaths);
      this.pendingNotifyWorkspacePaths.clear();
      this.dispatchNotify(workspacePaths);
    }, STATS_EVENT_DEBOUNCE_MS);
  }

  /**
   * Drop any pending notification for a workspace being closed / switched away
   * from, so a stale event doesn't fire against a workspace the user has left.
   */
  cancelWorkspace(workspacePath: string): void {
    this.pendingNotifyWorkspacePaths.delete(workspacePath);
  }

  private dispatchNotify(workspacePaths: string[]): void {
    const subscriber = this.subscriber;
    if (subscriber == null || subscriber.isDestroyed()) return;
    for (const workspacePath of workspacePaths) {
      const payload: ReviewStatsMayHaveChangedEvent = { workspacePath };
      subscriber.send(REVIEW_STATS_MAY_HAVE_CHANGED_CHANNEL, payload);
    }
  }

  /** Cancel any in-flight debounce timer and drop every pending notification. */
  clear(): void {
    this.pendingNotifyWorkspacePaths.clear();
    if (this.notifyTimer != null) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
  }

  // Test-only inspection helper.
  get pendingNotifyCountForTests(): number {
    return this.pendingNotifyWorkspacePaths.size;
  }
}

/** Singleton instance — there's only one Electron main process per app. */
export const reviewStatsNotifier = new ReviewStatsNotifier();
