/**
 * Workspace file watcher.
 *
 * Uses Node's built-in `fs.watch` (backed by FSEvents on macOS) to monitor
 * exact data-folder directories and the per-connection
 * `accepted-patches.json` file. Each watched directory gets a single O(1)
 * OS-level watch — no per-file file descriptors, no recursive traversal, no
 * polling. This avoids the FD exhaustion that chokidar's awaitWriteFinish
 * polling caused when folders contained tens of thousands of files.
 *
 * ## Three watcher fleets
 *
 *   1. **Data folder watchers** (`watchers`) — one per data folder. Catch
 *      record-file edits. Drive the renderer's `WORKSPACE_FILE_WATCH_EVENT_CHANNEL`
 *      "files changed?" toast and the review-stats refresh queue.
 *
 *   2. **Connection-schema watchers** (`connectionWatchers`) — one per
 *      `.scratch/connections/scratch/<conn>/<folder>[/views]` directory.
 *      Drive the renderer's schema/views hot-reload via
 *      `CONNECTION_FILE_CHANGED_EVENT_CHANNEL`.
 *
 *   3. **Accepted-patches watchers** (`acceptedPatchesWatchers`) — one per
 *      connection's `.scratch/connections/<conn>/` directory, filtered to
 *      `accepted-patches.json` events. Drive the review-stats refresh on
 *      `approvedChanges` bit transitions (which `accept`, `discard`, and
 *      external `scratchmd` CLI runs all produce by modifying that file).
 *
 * ## Debouncing
 * `fs.watch` fires one event per file change. A bulk operation (e.g. a pull
 * writing 1 000 files) produces 1 000 callbacks. Each callback does two O(1)
 * things: add the path to a Set and reset a 500 ms timer. When the timer
 * fires, `flushPendingChanges` collapses everything into at most a handful of
 * unique folder paths and sends one IPC event to the renderer. The
 * accepted-patches and connection-schema flushes use their own shorter
 * debounce windows.
 *
 * ## Internal mutation guard
 * When the app writes files itself (pull, publish, accept, …) it calls
 * `beginInternalWorkspaceMutation`, which increments a per-workspace counter.
 * File events arriving while the counter is positive are tagged
 * `source: 'internal'`. A 1 500 ms grace period after the counter drops to
 * zero absorbs OS-delayed events. The renderer uses `source` to decide
 * whether to show a "files changed" refresh toast, and the review-stats
 * refresh queue uses it to decide whether to spend cycles re-running
 * `refreshFolder` (external) or just re-fetch the SQL aggregate (internal —
 * the index is already current because the CLI updated it on the way out).
 */
import type { WebContents } from 'electron';
import type { FSWatcher } from 'fs';
import { watch as fsWatch } from 'fs';
import { stat } from 'fs/promises';
import { basename, dirname, join, relative } from 'path';
import {
  CONNECTION_FILE_CHANGED_EVENT_CHANNEL,
  WORKSPACE_FILE_WATCH_EVENT_CHANNEL,
  type ConnectionFileChangedEvent,
  type WorkspaceFilesChangedEvent,
} from '../shared/workspace-file-watch';

const WATCH_DEBOUNCE_MS = 500;
// Accepted-patches edits are typically a single fs write per mutation. The
// debounce is just to absorb FSEvents' tendency to emit a duplicate
// ItemModified, so a short window is enough — keeping it tight makes the
// dot transition after "Accept all" feel near-instant.
const ACCEPTED_PATCHES_DEBOUNCE_MS = 150;
const INTERNAL_MUTATION_GRACE_MS = 1_500;
const ACCEPTED_PATCHES_FILENAME = 'accepted-patches.json';

type MutationSource = 'external' | 'internal';

/**
 * Callback for any debounced burst of data-folder file changes (both internal
 * Scratch-induced mutations and external edits). `source` distinguishes the
 * two so consumers (the review-stats refresh queue) can route correctly:
 * external bursts have stale index bits and must be re-read; internal bursts
 * already have current bits and just need a re-fetch notification.
 */
type MutationHandler = (workspacePath: string, source: MutationSource, absoluteFolderPaths: string[]) => void;

/**
 * Callback for a debounced burst of `accepted-patches.json` changes for one
 * connection. Same `source` semantics as `MutationHandler`. The handler
 * receives the connection's dir-name so it can fan out a refresh across
 * every folder under that connection (any folder's `approvedChanges` bits
 * may have flipped).
 */
type AcceptedPatchesHandler = (workspacePath: string, source: MutationSource, connectionDirName: string) => void;

function sameRoots(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export class WorkspaceFileWatchService {
  private watchers: FSWatcher[] = [];
  private watchedFolders: string[] = [];
  private connectionWatchers: FSWatcher[] = [];
  private connectionFlushTimer: NodeJS.Timeout | null = null;
  private pendingConnectionPath: string | null = null;
  private acceptedPatchesWatchers: FSWatcher[] = [];
  private acceptedPatchesFlushTimer: NodeJS.Timeout | null = null;
  /** Map of connection-dir-name → whether at least one external event landed in the current debounce burst. */
  private pendingAcceptedPatchesConnections = new Map<string, boolean>();
  private activeWorkspacePath: string | null = null;
  private activeRoots: string[] = [];
  private subscriber: WebContents | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private pendingPaths = new Set<string>();
  private pendingHasExternal = false;
  private internalMutationCounts = new Map<string, number>();
  private internalMutationUntil = new Map<string, number>();
  private mutationHandler: MutationHandler | null = null;
  private acceptedPatchesHandler: AcceptedPatchesHandler | null = null;

  /**
   * Register a callback that fires whenever a debounced burst of data-folder
   * changes flushes — for BOTH internal Scratch-induced mutations and
   * external edits. Used by `review-refresh-queue.ts` to keep the
   * folder-tree review-state dots fresh.
   *
   * Called BEFORE the renderer IPC dispatch so a handler exception cannot
   * break the renderer's "files changed?" notification path.
   */
  setMutationHandler(handler: MutationHandler | null): void {
    this.mutationHandler = handler;
  }

  /**
   * Register a callback that fires whenever `accepted-patches.json` changes
   * for a connection (debounced per-connection). Same source semantics as
   * `setMutationHandler`.
   */
  setAcceptedPatchesHandler(handler: AcceptedPatchesHandler | null): void {
    this.acceptedPatchesHandler = handler;
  }

  /**
   * (Re-)starts watching the given folder paths plus each unique
   * connection's `.scratch/connections/<conn>/` directory (for
   * `accepted-patches.json` events). Each path gets its own non-recursive
   * `fs.watch` call — O(1) FDs per folder regardless of how many files
   * are inside. Returns the list of folders actually watched (skips any
   * that don't exist on disk).
   *
   * If the folder list hasn't changed since the last call, this is a no-op
   * and returns the current watched-folder list.
   */
  async watchWorkspaceFiles(subscriber: WebContents, workspacePath: string, folderPaths: string[]): Promise<string[]> {
    const sortedFolders = [...folderPaths].sort((a, b) => a.localeCompare(b));

    this.subscriber = subscriber;

    if (
      this.activeWorkspacePath === workspacePath &&
      sameRoots(this.activeRoots, sortedFolders) &&
      this.watchers.length > 0
    ) {
      return this.watchedFolders;
    }

    this.closeWatcher();
    this.activeWorkspacePath = workspacePath;
    this.activeRoots = sortedFolders;

    const watched: string[] = [];
    for (const folder of sortedFolders) {
      try {
        const s = await stat(folder);
        if (!s.isDirectory()) continue;
        const watcher = fsWatch(folder, (_eventType, filename) => {
          if (filename) {
            this.enqueueChange(workspacePath, join(folder, filename));
          }
        });
        this.watchers.push(watcher);
        watched.push(folder);
      } catch {
        // folder doesn't exist yet — skip silently
      }
    }

    this.watchedFolders = watched;

    // Schema/views watchers — separate channel, separate debounce. Drives the
    // renderer's hot-reload for connection schema + views.
    const scratchConnectionsDir = join(workspacePath, '.scratch', 'connections', 'scratch');
    const seenSchemaDirs = new Set<string>();
    const connectionSchemaDirsToWatch: string[] = [];
    for (const folder of sortedFolders) {
      const rel = relative(workspacePath, folder);
      for (const candidate of [join(scratchConnectionsDir, rel), join(scratchConnectionsDir, rel, 'views')]) {
        if (!seenSchemaDirs.has(candidate)) {
          seenSchemaDirs.add(candidate);
          connectionSchemaDirsToWatch.push(candidate);
        }
      }
    }
    for (const dir of connectionSchemaDirsToWatch) {
      try {
        const s = await stat(dir);
        if (!s.isDirectory()) continue;
        const watcher = fsWatch(dir, (_eventType, filename) => {
          if (filename && filename.endsWith('.DS_Store')) return;
          this.enqueueConnectionChange(workspacePath, filename ? join(dir, filename) : dir);
        });
        this.connectionWatchers.push(watcher);
      } catch {
        // Directory doesn't exist yet — skip silently.
      }
    }

    // Accepted-patches watchers — one per unique connection (derived from the
    // first path-segment of each watched folder's workspace-relative path).
    // The watcher dir is `<workspace>/.scratch/connections/<conn>/`; the
    // callback filters for events whose filename is `accepted-patches.json`
    // since that directory also holds materialised worktrees and other state
    // we don't care about here.
    const connectionDirNames = Array.from(
      new Set(
        sortedFolders
          .map((folder) => relative(workspacePath, folder).split(/[\\/]/)[0])
          .filter((name) => name && name !== '..' && name !== '.'),
      ),
    );
    const acceptedPatchesRoot = join(workspacePath, '.scratch', 'connections');
    for (const connectionDirName of connectionDirNames) {
      const dir = join(acceptedPatchesRoot, connectionDirName);
      try {
        const s = await stat(dir);
        if (!s.isDirectory()) continue;
        const watcher = fsWatch(dir, (_eventType, filename) => {
          if (!filename) return;
          if (basename(filename) !== ACCEPTED_PATCHES_FILENAME) return;
          this.enqueueAcceptedPatchesChange(workspacePath, connectionDirName);
        });
        this.acceptedPatchesWatchers.push(watcher);
      } catch {
        // Connection's .scratch dir doesn't exist yet — accepted-patches.json
        // is created lazily on first accept; the watcher reconciliation on the
        // next `watchWorkspaceFiles` call will pick it up.
      }
    }

    return watched;
  }

  getWatchedFolders(): string[] {
    return this.watchedFolders;
  }

  clearWorkspaceFileWatch(): void {
    this.closeWatcher();
    this.subscriber = null;
  }

  /**
   * Call this before any app-triggered write to the workspace (pull, publish, etc.).
   * Returns a cleanup function — call it when the write is done.
   */
  beginInternalWorkspaceMutation(workspacePath: string): () => void {
    const current = this.internalMutationCounts.get(workspacePath) ?? 0;
    this.internalMutationCounts.set(workspacePath, current + 1);
    this.internalMutationUntil.delete(workspacePath);

    let ended = false;
    return () => {
      if (ended) return;
      ended = true;

      const next = (this.internalMutationCounts.get(workspacePath) ?? 1) - 1;
      if (next <= 0) {
        this.internalMutationCounts.delete(workspacePath);
        this.internalMutationUntil.set(workspacePath, Date.now() + INTERNAL_MUTATION_GRACE_MS);
      } else {
        this.internalMutationCounts.set(workspacePath, next);
      }
    };
  }

  private enqueueConnectionChange(workspacePath: string, changedPath: string): void {
    if (!this.activeWorkspacePath || this.activeWorkspacePath !== workspacePath) return;

    this.pendingConnectionPath = changedPath;

    if (this.connectionFlushTimer) clearTimeout(this.connectionFlushTimer);
    this.connectionFlushTimer = setTimeout(() => {
      this.flushConnectionChange();
    }, 300);
  }

  private flushConnectionChange(): void {
    this.connectionFlushTimer = null;

    if (!this.activeWorkspacePath || !this.pendingConnectionPath) return;
    if (!this.subscriber || this.subscriber.isDestroyed()) {
      this.pendingConnectionPath = null;
      return;
    }

    const payload: ConnectionFileChangedEvent = {
      workspacePath: this.activeWorkspacePath,
      filePath: this.pendingConnectionPath,
    };
    this.pendingConnectionPath = null;
    this.subscriber.send(CONNECTION_FILE_CHANGED_EVENT_CHANNEL, payload);
  }

  private enqueueAcceptedPatchesChange(workspacePath: string, connectionDirName: string): void {
    if (!this.activeWorkspacePath || this.activeWorkspacePath !== workspacePath) return;

    const isExternal = !this.isWorkspaceMutationInternal(workspacePath);
    const previous = this.pendingAcceptedPatchesConnections.get(connectionDirName) ?? false;
    this.pendingAcceptedPatchesConnections.set(connectionDirName, previous || isExternal);

    if (this.acceptedPatchesFlushTimer) clearTimeout(this.acceptedPatchesFlushTimer);
    this.acceptedPatchesFlushTimer = setTimeout(() => {
      this.flushAcceptedPatchesChanges();
    }, ACCEPTED_PATCHES_DEBOUNCE_MS);
  }

  private flushAcceptedPatchesChanges(): void {
    this.acceptedPatchesFlushTimer = null;

    if (!this.activeWorkspacePath || this.pendingAcceptedPatchesConnections.size === 0) {
      this.pendingAcceptedPatchesConnections.clear();
      return;
    }

    const workspacePath = this.activeWorkspacePath;
    const handler = this.acceptedPatchesHandler;
    const snapshot = Array.from(this.pendingAcceptedPatchesConnections.entries());
    this.pendingAcceptedPatchesConnections.clear();

    if (!handler) return;
    for (const [connectionDirName, hasExternal] of snapshot) {
      try {
        handler(workspacePath, hasExternal ? 'external' : 'internal', connectionDirName);
      } catch (err) {
        console.debug('[workspace-file-watch] accepted-patches handler threw', err);
      }
    }
  }

  private enqueueChange(workspacePath: string, changedPath: string): void {
    if (!this.activeWorkspacePath || this.activeWorkspacePath !== workspacePath) {
      return;
    }

    this.pendingPaths.add(changedPath);
    if (!this.isWorkspaceMutationInternal(workspacePath)) {
      this.pendingHasExternal = true;
    }

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushPendingChanges();
    }, WATCH_DEBOUNCE_MS);
  }

  private flushPendingChanges(): void {
    this.flushTimer = null;

    if (!this.activeWorkspacePath || this.pendingPaths.size === 0) {
      this.pendingPaths.clear();
      this.pendingHasExternal = false;
      return;
    }

    if (!this.subscriber || this.subscriber.isDestroyed()) {
      this.pendingPaths.clear();
      this.pendingHasExternal = false;
      return;
    }

    const changedPaths = Array.from(this.pendingPaths);
    const singleFile = changedPaths.length === 1 ? changedPaths[0] : undefined;
    const changedFolderPaths = Array.from(new Set(changedPaths.map((p) => dirname(p)))).sort();

    const payload: WorkspaceFilesChangedEvent = {
      workspacePath: this.activeWorkspacePath,
      source: this.pendingHasExternal ? 'external' : 'internal',
      singleFile,
      changedFolderPaths,
    };

    this.pendingPaths.clear();
    this.pendingHasExternal = false;

    // Fire the mutation handler BEFORE the renderer IPC dispatch so a
    // handler exception cannot break the "files changed?" notification path.
    // Fires for BOTH internal and external bursts — consumers route on
    // `source`: external bursts need a refresh-folder re-read because the
    // SQLite index hasn't observed the changes yet; internal bursts only
    // need a re-fetch of the aggregate stats because the CLI already
    // updated the bits before returning.
    if (this.mutationHandler) {
      try {
        this.mutationHandler(payload.workspacePath, payload.source, payload.changedFolderPaths);
      } catch (err) {
        console.debug('[workspace-file-watch] mutation handler threw', err);
      }
    }

    this.subscriber.send(WORKSPACE_FILE_WATCH_EVENT_CHANNEL, payload);
  }

  private isWorkspaceMutationInternal(workspacePath: string): boolean {
    if ((this.internalMutationCounts.get(workspacePath) ?? 0) > 0) {
      return true;
    }
    return (this.internalMutationUntil.get(workspacePath) ?? 0) > Date.now();
  }

  private closeWatcher(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.connectionFlushTimer) {
      clearTimeout(this.connectionFlushTimer);
      this.connectionFlushTimer = null;
    }
    if (this.acceptedPatchesFlushTimer) {
      clearTimeout(this.acceptedPatchesFlushTimer);
      this.acceptedPatchesFlushTimer = null;
    }

    this.pendingPaths.clear();
    this.pendingHasExternal = false;
    this.pendingConnectionPath = null;
    this.pendingAcceptedPatchesConnections.clear();
    this.activeWorkspacePath = null;
    this.activeRoots = [];
    this.watchedFolders = [];

    for (const w of this.watchers) {
      w.close();
    }
    this.watchers = [];

    for (const w of this.connectionWatchers) {
      w.close();
    }
    this.connectionWatchers = [];

    for (const w of this.acceptedPatchesWatchers) {
      w.close();
    }
    this.acceptedPatchesWatchers = [];
  }
}
