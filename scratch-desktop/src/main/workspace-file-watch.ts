/**
 * Workspace file watcher.
 *
 * Uses Node's built-in `fs.watch` (backed by FSEvents on macOS) to monitor
 * exact data-folder directories. Each watched directory gets a single O(1)
 * OS-level watch — no per-file file descriptors, no recursive traversal, no
 * polling. This avoids the FD exhaustion that chokidar's awaitWriteFinish
 * polling caused when folders contained tens of thousands of files.
 *
 * ## Debouncing
 * `fs.watch` fires one event per file change. A bulk operation (e.g. a pull
 * writing 1 000 files) produces 1 000 callbacks. Each callback does two O(1)
 * things: add the path to a Set and reset a 500 ms timer. When the timer
 * fires, `flushPendingChanges` collapses everything into at most a handful of
 * unique folder paths and sends one IPC event to the renderer.
 *
 * ## Internal mutation guard
 * When the app writes files itself (pull, publish) it calls
 * `beginInternalWorkspaceMutation`, which increments a per-workspace counter.
 * File events arriving while the counter is positive are tagged
 * `source: 'internal'`. A 1 500 ms grace period after the counter drops to
 * zero absorbs OS-delayed events. The renderer uses `source` to decide
 * whether to show a "files changed" refresh.
 */
import type { WebContents } from 'electron';
import type { FSWatcher } from 'fs';
import { watch as fsWatch } from 'fs';
import { stat } from 'fs/promises';
import { dirname, join } from 'path';
import {
  CONNECTION_FILE_CHANGED_EVENT_CHANNEL,
  WORKSPACE_FILE_WATCH_EVENT_CHANNEL,
  type ConnectionFileChangedEvent,
  type WorkspaceFilesChangedEvent,
} from '../shared/workspace-file-watch';

const WATCH_DEBOUNCE_MS = 500;
const INTERNAL_MUTATION_GRACE_MS = 1_500;

function sameRoots(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export class WorkspaceFileWatchService {
  private watchers: FSWatcher[] = [];
  private watchedFolders: string[] = [];
  private connectionWatcher: FSWatcher | null = null;
  private connectionFlushTimer: NodeJS.Timeout | null = null;
  private pendingConnectionPath: string | null = null;
  private activeWorkspacePath: string | null = null;
  private activeRoots: string[] = [];
  private subscriber: WebContents | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private pendingPaths = new Set<string>();
  private pendingHasExternal = false;
  private internalMutationCounts = new Map<string, number>();
  private internalMutationUntil = new Map<string, number>();

  /**
   * (Re-)starts watching the given folder paths. Each path gets its own
   * non-recursive `fs.watch` call — O(1) FDs per folder regardless of
   * how many files are inside. Returns the list of folders actually watched
   * (skips any that don't exist on disk).
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

    // Watch .scratch/connections/scratch/ for schema and view file changes (dev-time hot reload).
    const scratchConnectionsDir = join(workspacePath, '.scratch', 'connections', 'scratch');
    try {
      const s = await stat(scratchConnectionsDir);
      if (s.isDirectory()) {
        this.connectionWatcher = fsWatch(scratchConnectionsDir, { recursive: true }, (_eventType, filename) => {
          if (filename && !filename.endsWith('.DS_Store')) {
            this.enqueueConnectionChange(workspacePath, join(scratchConnectionsDir, filename));
          }
        });
      }
    } catch {
      // .scratch/connections/scratch/ doesn't exist — skip silently.
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

    this.pendingPaths.clear();
    this.pendingHasExternal = false;
    this.pendingConnectionPath = null;
    this.activeWorkspacePath = null;
    this.activeRoots = [];
    this.watchedFolders = [];

    for (const w of this.watchers) {
      w.close();
    }
    this.watchers = [];

    if (this.connectionWatcher) {
      this.connectionWatcher.close();
      this.connectionWatcher = null;
    }
  }
}
