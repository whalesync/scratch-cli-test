/**
 * Workspace file watcher.
 *
 * ## What chokidar does
 * Chokidar wraps OS-native file system events (FSEvents on macOS, inotify on Linux) and fires
 * one callback per file with the absolute path. It also handles `awaitWriteFinish`: it polls a
 * file for 200 ms of write stability before firing, so a file written in chunks only produces
 * one event. That's all it does — it has no concept of batching, debouncing, or folder-level
 * events.
 *
 * ## What we do on top
 *
 * **Watch roots** — we only watch connection directories (e.g. `workspace/my-connection/`).
 * `.scratch/` and `.git/` are siblings and are never watched.
 *
 * **Filtering** — `shouldIgnoreWorkspaceWatchPath` discards hidden dirs, `.git/`, `.scratch/`,
 * swap files, temp files, `.DS_Store`, etc. before anything else happens.
 *
 * **Debouncing** — chokidar fires one event per file, so a bulk operation (e.g. a pull that
 * writes 1 000 files) produces 1 000 callbacks. Each callback does two O(1) things: add the
 * path to a Set and reset a 500 ms timer. No IPC, no CLI, no disk IO. When the timer finally
 * fires after 500 ms of silence, `flushPendingChanges` runs once and collapses everything into
 * at most a handful of unique folder paths. The renderer never sees the 1 000 individual events.
 *
 * **Internal mutation guard** — when the app writes files itself (pull, publish) it calls
 * `beginInternalWorkspaceMutation`, which increments a per-workspace counter. File events
 * arriving while the counter is positive are tagged `source: 'internal'` rather than
 * `source: 'external'`. A 1 500 ms grace period after the counter drops to zero absorbs any
 * OS-delayed events from the write. The renderer uses `source` to decide whether to trigger a
 * visible "files changed" refresh.
 *
 * **Shape** — at flush time the raw Set of file paths is reduced to either `singleFile` (exactly
 * one path changed) or `changedFolderPaths` (unique parent directories). Callers pass these
 * directly to the CLI as `--path` or `--folder` without any re-expansion.
 *
 * ## Current refresh flow (file-system based)
 * 1. Watcher detects a change and sends a `WorkspaceFilesChangedEvent` to the renderer.
 * 2. The renderer calls `scratch:refresh-paths` via IPC, which runs
 *    `scratchmd refresh-record-index` for the affected file or folders.
 * 3. The CLI reindexes and revalidates the changed records, writing results to SQLite.
 * 4. Once the CLI exits, the renderer reloads the grid view (reads files from disk) and
 *    reloads validation results (reads from the SQLite DB).
 *
 * The view and validations are always reloaded together after the CLI finishes — the CLI is the
 * synchronisation point.
 *
 * ## Future refresh flow (database-indexed records)
 * When record field values are indexed in the database, the desktop will no longer need to read
 * raw files from disk to populate the grid. Instead, on a change event:
 * 1. The renderer queries the database immediately — it gets the current indexed values plus a
 *    boolean indicating whether reindexing is still in progress.
 * 2. If reindexing is in progress, the renderer re-queries once per second until the flag clears,
 *    then stops polling.
 * 3. There is no blocking "wait for CLI" step — the UI shows whatever is in the DB right now and
 *    updates incrementally as the index catches up.
 */
import chokidar, { type FSWatcher } from 'chokidar';
import type { WebContents } from 'electron';
import { stat } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { WORKSPACE_FILE_WATCH_EVENT_CHANNEL, type WorkspaceFilesChangedEvent } from '../shared/workspace-file-watch';
import { runScratchmd } from './scratchmd';

const WATCH_DEBOUNCE_MS = 500;
const INTERNAL_MUTATION_GRACE_MS = 1_500;

export interface WorkspaceConnectionWatchInput {
  dirName: string;
}

/** Returns true for paths that should never trigger a refresh: hidden dirs, .git, .scratch, editor temp files. */
export function shouldIgnoreWorkspaceWatchPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const name = basename(filePath);

  if (parts.some((part) => part === '.git' || part === '.scratch' || (part.startsWith('.') && part.length > 1))) {
    return true;
  }

  return (
    name === '.DS_Store' ||
    name.endsWith('~') ||
    name.startsWith('~$') ||
    name.endsWith('.swp') ||
    name.endsWith('.swx') ||
    name.endsWith('.tmp')
  );
}

/**
 * Resolves the list of connection directories to watch.
 * Skips any that don't exist on disk yet (e.g. a connection that hasn't been downloaded).
 * Returns a stable sorted list so `sameRoots` comparisons are reliable.
 */
export async function resolveWorkspaceWatchRoots(
  workspacePath: string,
  connections: WorkspaceConnectionWatchInput[],
): Promise<string[]> {
  const roots = Array.from(
    new Set(
      connections
        .map((connection) => connection.dirName.trim())
        .filter(Boolean)
        .map((dirName) => join(workspacePath, dirName)),
    ),
  );

  const existingRoots = await Promise.all(
    roots.map(async (root) => {
      try {
        const rootStat = await stat(root);
        return rootStat.isDirectory() ? root : null;
      } catch {
        return null;
      }
    }),
  );

  return existingRoots.filter((root): root is string => root !== null).sort((a, b) => a.localeCompare(b));
}

function sameRoots(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export class WorkspaceFileWatchService {
  private watcher: FSWatcher | null = null;
  private activeWorkspacePath: string | null = null;
  private activeRoots: string[] = [];
  private subscriber: WebContents | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  // Accumulates raw file paths during the debounce window. Collapsed to folder paths on flush.
  private pendingPaths = new Set<string>();
  // True if at least one pending path arrived outside an internal mutation window.
  private pendingHasExternal = false;
  // Per-workspace counter incremented by beginInternalWorkspaceMutation.
  private internalMutationCounts = new Map<string, number>();
  // Per-workspace deadline: treat events as internal until this timestamp (grace period).
  private internalMutationUntil = new Map<string, number>();
  private validationState: 'idle' | 'running' = 'idle';
  private pendingValidationPaths = new Set<string>();

  /**
   * (Re-)starts watching the given workspace. If the roots haven't changed, this is a no-op.
   * Called on workspace open and whenever the connection list changes.
   */
  async watchWorkspaceFiles(
    subscriber: WebContents,
    workspacePath: string,
    connections: WorkspaceConnectionWatchInput[],
  ): Promise<void> {
    const nextRoots = await resolveWorkspaceWatchRoots(workspacePath, connections);

    this.subscriber = subscriber;

    if (this.activeWorkspacePath === workspacePath && sameRoots(this.activeRoots, nextRoots) && this.watcher) {
      return;
    }

    await this.closeWatcher();
    this.activeWorkspacePath = workspacePath;
    this.activeRoots = nextRoots;

    if (nextRoots.length === 0) {
      return;
    }

    const watcher = chokidar.watch(nextRoots, {
      ignoreInitial: true, // don't fire for files that already exist when watching starts
      persistent: true,
      ignored: shouldIgnoreWorkspaceWatchPath,
      awaitWriteFinish: {
        stabilityThreshold: 200, // file must be unchanged for 200 ms before firing
        pollInterval: 50,
      },
    });

    // Single entry point for all chokidar events (add, change, unlink, etc.)
    watcher.on('all', (_eventName, changedPath) => {
      this.enqueueChange(workspacePath, changedPath);
    });

    this.watcher = watcher;
  }

  async clearWorkspaceFileWatch(): Promise<void> {
    await this.closeWatcher();
    this.subscriber = null;
  }

  /**
   * Call this before any app-triggered write to the workspace (pull, publish, etc.).
   * Returns a cleanup function — call it when the write is done.
   *
   * While the counter is > 0, or within INTERNAL_MUTATION_GRACE_MS after it drops to zero,
   * file events are tagged `source: 'internal'` so the renderer knows not to treat them as
   * external changes. The grace period absorbs OS-delayed events that arrive after the write
   * has logically completed.
   *
   * Supports nesting: multiple concurrent mutations each hold a count and the guard only lifts
   * when the last one ends.
   */
  beginInternalWorkspaceMutation(workspacePath: string): () => void {
    const current = this.internalMutationCounts.get(workspacePath) ?? 0;
    this.internalMutationCounts.set(workspacePath, current + 1);
    this.internalMutationUntil.delete(workspacePath);

    let ended = false;
    return () => {
      if (ended) {
        return;
      }
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

  /**
   * Runs `refresh-record-index` for the given paths, serialising concurrent calls.
   * If a run is already in progress, paths are queued and processed in the next run.
   * This prevents overlapping CLI processes if file events arrive faster than reindex completes.
   */
  async runValidationForPaths(workspacePath: string, paths: string[]): Promise<void> {
    if (this.validationState === 'running') {
      paths.forEach((p) => this.pendingValidationPaths.add(p));
      return;
    }
    this.validationState = 'running';
    try {
      await this.doValidation(workspacePath, paths);
    } finally {
      if (this.pendingValidationPaths.size > 0) {
        const next = Array.from(this.pendingValidationPaths);
        this.pendingValidationPaths.clear();
        this.validationState = 'idle';
        await this.runValidationForPaths(workspacePath, next);
      } else {
        this.validationState = 'idle';
      }
    }
  }

  private async doValidation(workspacePath: string, paths: string[]): Promise<void> {
    const endMutation = this.beginInternalWorkspaceMutation(workspacePath);
    try {
      const args = ['refresh-record-index'];
      for (const p of paths) args.push('--path', p);
      await runScratchmd(args, workspacePath);
    } finally {
      endMutation();
    }
  }

  /**
   * Called on every raw chokidar event. Does the minimum work possible:
   * - add path to the pending Set (O(1), deduplicates automatically)
   * - record whether this is an external change
   * - reset the debounce timer
   *
   * No IPC or CLI work happens here — that's deferred to flushPendingChanges.
   */
  private enqueueChange(workspacePath: string, changedPath: string): void {
    if (!this.activeWorkspacePath || this.activeWorkspacePath !== workspacePath) {
      return;
    }
    if (shouldIgnoreWorkspaceWatchPath(changedPath)) {
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

  /**
   * Fires once after WATCH_DEBOUNCE_MS of silence. Collapses the accumulated file paths into
   * either a single file path (if only one file changed) or a deduplicated list of parent
   * folders, then sends one IPC event to the renderer.
   */
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

  /** True while an internal mutation is active or within the grace period after it ends. */
  private isWorkspaceMutationInternal(workspacePath: string): boolean {
    if ((this.internalMutationCounts.get(workspacePath) ?? 0) > 0) {
      return true;
    }

    return (this.internalMutationUntil.get(workspacePath) ?? 0) > Date.now();
  }

  private async closeWatcher(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    this.pendingPaths.clear();
    this.pendingHasExternal = false;
    this.activeWorkspacePath = null;
    this.activeRoots = [];

    if (this.watcher) {
      const watcher = this.watcher;
      this.watcher = null;
      await watcher.close();
    }
  }
}
