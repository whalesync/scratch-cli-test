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
  private pendingPaths = new Set<string>();
  private pendingHasExternal = false;
  private internalMutationCounts = new Map<string, number>();
  private internalMutationUntil = new Map<string, number>();
  private validationState: 'idle' | 'running' = 'idle';
  private pendingValidationPaths = new Set<string>();

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
      ignoreInitial: true,
      persistent: true,
      ignored: shouldIgnoreWorkspaceWatchPath,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 50,
      },
    });

    watcher.on('all', (_eventName, changedPath) => {
      this.enqueueChange(workspacePath, changedPath);
    });

    this.watcher = watcher;
  }

  async clearWorkspaceFileWatch(): Promise<void> {
    await this.closeWatcher();
    this.subscriber = null;
  }

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
