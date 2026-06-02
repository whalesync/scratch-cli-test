/**
 * Sequential refresh queue for the folder-tree review-state dots.
 *
 * Two callers feed this queue:
 *
 *   1. **Cold-start sweep** (Pass A) — when a workspace is opened, the
 *      `scratch:watch-workspace-files` IPC handler calls
 *      `enqueueAllFolders(workspacePath, folderRelPaths)`. Picks up any
 *      external edits made while Scratch was closed.
 *
 *   2. **Watcher-driven refresh** (Pass B) — when the file watcher fires an
 *      `external` event, `WorkspaceFileWatchService` calls into
 *      `enqueueAbsoluteFolderPaths` so the bits catch up after edits made by
 *      other processes (Claude, manual `vim`, etc.) while Scratch is open.
 *
 * Both feed into a single FIFO that drains serially via the napi binding
 * `refreshFolderViaNative`. Sequential, not parallel: keeps disk/CPU
 * predictable on cold start, and the folders the user is most likely to look
 * at first get refreshed first (Pass A enqueues in `listFolders` order, which
 * matches the sidebar order).
 *
 * Each completed `refreshFolder` triggers a debounced
 * `REVIEW_STATS_MAY_HAVE_CHANGED_CHANNEL` IPC event to the renderer; the
 * `useReviewStats` hook re-fetches `getReviewStats` and the dots update
 * progressively.
 *
 * The queue is intentionally global / singleton: there is one Electron main
 * process per app instance, and the desktop only ever shows one workspace at
 * a time, but the queue is keyed by `workspacePath` so a workspace switch
 * mid-flight does not cross-contaminate.
 *
 * ## Dedup model
 *
 * `pendingMembership` tracks items in the FIFO so a duplicate enqueue is a
 * no-op while the item is still waiting. Once an item moves into the worker
 * (`runOne` shifts it off `pending`), it's tracked separately by
 * `inFlight`: re-enqueueing the same folder during the in-flight window
 * does NOT drop the new request — instead it sets `dirtyWhileInFlight` so
 * the queue re-runs the folder after the current refresh finishes. This is
 * what makes a fast-running external editor (Claude pumping writes every
 * few hundred ms) keep the dots fresh even when one refresh is mid-flight.
 *
 * ## Why no internal-mutation guard
 *
 * `refreshFolder` writes only to `<workspace>/.repos/<conn>.db` — a path the
 * file watcher does NOT cover (`WorkspaceFileWatchService.watchWorkspaceFiles`
 * watches data folders + `.scratch/connections/scratch/<conn>/`). Reads of
 * working files don't update mtime on macOS/Linux with default mount options.
 * So wrapping `runOne` in `beginInternalWorkspaceMutation` would defend
 * against a non-existent feedback loop while creating a real
 * mis-classification bug: external edits arriving inside the guard's
 * 1500 ms grace window would be silently labelled internal, dropped by the
 * renderer's `external`-only handler, and not re-enqueued here.
 */

import type { WebContents } from 'electron';
import { relative } from 'node:path';
import {
  REVIEW_STATS_MAY_HAVE_CHANGED_CHANNEL,
  type ReviewStatsMayHaveChangedEvent,
} from '../shared/review-stats-events';
import { refreshFolderForReviewStats } from './scratchmd';

/** Trailing-edge debounce so a fast burst of completions emits one IPC event. */
const STATS_EVENT_DEBOUNCE_MS = 250;

interface PendingItem {
  workspacePath: string;
  /** Workspace-relative `<connection>/<sub_path>` shape. */
  folderRelPath: string;
}

class ReviewRefreshQueue {
  /** FIFO of pending refresh items. Iterated in insertion order. */
  private pending: PendingItem[] = [];
  /** Items currently queued in `pending` — dedup gate for new enqueues. */
  private pendingMembership = new Set<string>();
  /** The single item currently running in `runOne`, if any. */
  private inFlight: PendingItem | null = null;
  /** Keys for in-flight items that received a new enqueue while running. */
  private dirtyWhileInFlight = new Set<string>();
  /** Whether the worker loop is currently running. */
  private draining = false;
  /** The active renderer subscriber. Single WebContents at a time, like `WorkspaceFileWatchService`. */
  private subscriber: WebContents | null = null;
  /** Workspace paths waiting to be notified — one IPC event per debounce window. */
  private pendingNotifyWorkspacePaths = new Set<string>();
  private notifyTimer: NodeJS.Timeout | null = null;

  /** Register the renderer that should receive `'review-stats-may-have-changed'` events. */
  setSubscriber(subscriber: WebContents | null): void {
    this.subscriber = subscriber;
  }

  /** Append every folder in `folderRelPaths` to the queue (deduped). Order is preserved. */
  enqueueAllFolders(workspacePath: string, folderRelPaths: string[]): void {
    for (const folderRelPath of folderRelPaths) {
      this.appendItem(workspacePath, folderRelPath);
    }
    void this.drain();
  }

  /** Append one or more affected folders (deduped). */
  enqueueFolderRefresh(workspacePath: string, folderRelPaths: string[]): void {
    for (const folderRelPath of folderRelPaths) {
      this.appendItem(workspacePath, folderRelPath);
    }
    void this.drain();
  }

  /**
   * Convert each absolute folder path to the workspace-relative
   * `<connection>/<sub_path>` shape and enqueue. Used by the file watcher
   * (`WorkspaceFileWatchService.setExternalChangeHandler`), whose payload
   * contains absolute paths on disk.
   *
   * Absolute paths outside `workspacePath` (e.g. a watcher event on a stale
   * folder that's since moved) are silently dropped — `refreshFolder` would
   * just error on them anyway.
   */
  enqueueAbsoluteFolderPaths(workspacePath: string, absoluteFolderPaths: string[]): void {
    for (const absolutePath of absoluteFolderPaths) {
      const rel = relative(workspacePath, absolutePath);
      if (rel === '' || rel.startsWith('..')) continue;
      const folderRelPath = rel.split(/[\\/]/).join('/');
      this.appendItem(workspacePath, folderRelPath);
    }
    void this.drain();
  }

  /**
   * Drop every queued item for `workspacePath`. Called from the workspace
   * watch teardown path so a workspace switch does not bleed Pass-A work
   * for the previous workspace into the new one.
   *
   * Does NOT cancel an in-flight refresh (the napi worker has already
   * spawned); the result will arrive and `runOne` will harmlessly emit a
   * notify for the now-unwatched workspace, which the renderer's
   * `workspacePath`-matching filter ignores. A subsequent in-flight refresh
   * for `workspacePath` is also marked as no-rerun so it doesn't loop.
   */
  cancelWorkspace(workspacePath: string): void {
    this.pending = this.pending.filter((item) => {
      if (item.workspacePath === workspacePath) {
        this.pendingMembership.delete(this.itemKey(item.workspacePath, item.folderRelPath));
        return false;
      }
      return true;
    });
    if (this.inFlight?.workspacePath === workspacePath) {
      this.dirtyWhileInFlight.delete(this.itemKey(this.inFlight.workspacePath, this.inFlight.folderRelPath));
    }
    this.pendingNotifyWorkspacePaths.delete(workspacePath);
  }

  private appendItem(workspacePath: string, folderRelPath: string): void {
    const key = this.itemKey(workspacePath, folderRelPath);
    // If the item is in flight, mark it dirty so the worker will re-enqueue
    // after the current refresh completes. The new edit cannot have been
    // observed by the in-flight read (it had already started).
    if (this.inFlight && this.itemKey(this.inFlight.workspacePath, this.inFlight.folderRelPath) === key) {
      this.dirtyWhileInFlight.add(key);
      return;
    }
    if (this.pendingMembership.has(key)) return;
    this.pendingMembership.add(key);
    this.pending.push({ workspacePath, folderRelPath });
  }

  private itemKey(workspacePath: string, folderRelPath: string): string {
    // \0 is impossible in either a POSIX path or a connection/sub_path
    // string, so the join is unambiguous regardless of how either segment
    // is formed.
    return `${workspacePath}\0${folderRelPath}`;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const item = this.pending.shift();
        if (!item) break;
        const key = this.itemKey(item.workspacePath, item.folderRelPath);
        // Drop from pendingMembership *before* the run so a new enqueue for
        // the same key while we're in flight goes through the in-flight
        // dirty-tracking path instead of being silently dropped.
        this.pendingMembership.delete(key);
        this.inFlight = item;
        try {
          await this.runOne(item);
        } finally {
          this.inFlight = null;
        }
        if (this.dirtyWhileInFlight.delete(key)) {
          // Edits arrived during the in-flight window — schedule another
          // pass so the dots reflect the latest state.
          this.appendItem(item.workspacePath, item.folderRelPath);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async runOne(item: PendingItem): Promise<void> {
    const { workspacePath, folderRelPath } = item;
    try {
      await refreshFolderForReviewStats(workspacePath, folderRelPath);
      this.scheduleNotify(workspacePath);
    } catch (err) {
      // Quiet: stats reads degrade to "no dots" if refresh fails. The next
      // watcher event for the same folder will retry, and the SQL aggregate
      // will pick up whatever bits the index has from prior runs.
      console.debug('[review-refresh-queue] refresh failed', { workspacePath, folderRelPath, err });
    }
  }

  /**
   * Hint that the persisted bits for `workspacePath` may have just changed
   * via a path that did NOT go through the queue (e.g. an internal mutation
   * like `files accept-all`, where the CLI updates the index before
   * returning, so a refresh would be redundant).
   *
   * Shares the trailing-edge debounce timer with `scheduleNotify` so a
   * burst of mutations collapses to one IPC event in the renderer.
   */
  notifyReviewStatsChanged(workspacePath: string): void {
    this.scheduleNotify(workspacePath);
  }

  private scheduleNotify(workspacePath: string): void {
    this.pendingNotifyWorkspacePaths.add(workspacePath);
    if (this.notifyTimer != null) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      const workspacePaths = Array.from(this.pendingNotifyWorkspacePaths);
      this.pendingNotifyWorkspacePaths.clear();
      this.dispatchNotify(workspacePaths);
    }, STATS_EVENT_DEBOUNCE_MS);
  }

  private dispatchNotify(workspacePaths: string[]): void {
    const subscriber = this.subscriber;
    if (subscriber == null || subscriber.isDestroyed()) return;
    for (const workspacePath of workspacePaths) {
      const payload: ReviewStatsMayHaveChangedEvent = { workspacePath };
      subscriber.send(REVIEW_STATS_MAY_HAVE_CHANGED_CHANNEL, payload);
    }
  }

  /** Cancel any in-flight debounce timer and drop every queued/dirty item. */
  clear(): void {
    this.pending.length = 0;
    this.pendingMembership.clear();
    this.dirtyWhileInFlight.clear();
    this.pendingNotifyWorkspacePaths.clear();
    if (this.notifyTimer != null) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
  }

  // Test-only inspection helpers.
  get pendingCountForTests(): number {
    return this.pending.length;
  }
  get isDrainingForTests(): boolean {
    return this.draining;
  }
}

/** Singleton instance — there's only one Electron main process per app. */
export const reviewRefreshQueue = new ReviewRefreshQueue();
