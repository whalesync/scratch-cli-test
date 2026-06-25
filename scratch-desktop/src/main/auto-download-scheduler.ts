import { BrowserWindow } from 'electron';
import { AUTO_DOWNLOAD_COMPLETED_CHANNEL, type AutoDownloadCompletedEvent } from '../shared/auto-download-events';
import type { DownloadWorkspaceResult } from './scratchmd';

/**
 * DEV-10470 — scheduled local re-download.
 *
 * William re-downloads his workspace manually every morning so he starts the
 * day with fresh data. This scheduler does it for him: it pulls the latest
 * server `main` into every locally-registered workspace whose per-workbook
 * setting leaves auto-download enabled (the default), once shortly after app
 * open and then once an hour. It reuses the exact same download path as the
 * manual "Re-download files" button (`files download --on-delete keep`), so it
 * goes through the same per-workspace mutation lock, folder reindex, and
 * validator reseed — and never deletes local files for a removed connection
 * (the non-destructive `keep` policy fits an unattended background job).
 */

/** "On app open": first run fires a few seconds after launch, after the window is up. */
const INITIAL_RUN_DELAY_MS = 5_000;
/** "Every hour": the steady-state cadence. */
const RUN_INTERVAL_MS = 60 * 60 * 1000;

interface LocalWorkspaceRef {
  /** Workbook (server) id. */
  id: string;
  /** Absolute local path of the checkout. */
  path: string;
}

interface AutoDownloadSchedulerOptions {
  /** Returns the current main window (may be null between window cycles). */
  getMainWindow: () => BrowserWindow | null;
  /** Lists the locally-registered workspaces (already pruned of stale entries). */
  listWorkspaces: () => Promise<LocalWorkspaceRef[]>;
  /** Whether scheduled auto-download is enabled for a workbook (default ON). */
  isEnabledForWorkbook: (workbookId: string) => boolean;
  /** True when there is a present, non-expired API token to talk to the server. */
  hasValidCredentials: () => boolean;
  /** Runs the actual download for one workspace via the shared mutation path. */
  performDownload: (workspacePath: string) => Promise<DownloadWorkspaceResult>;
  /** Test seam for the run delay (defaults to {@link INITIAL_RUN_DELAY_MS}). */
  initialRunDelayMs?: number;
  /** Test seam for the interval (defaults to {@link RUN_INTERVAL_MS}). */
  runIntervalMs?: number;
}

export interface AutoDownloadSchedulerController {
  /** Runs a sweep now (used by tests; the timers call the same internal sweep). */
  runNow: () => Promise<void>;
  /** Disposes the timers (used by tests / teardown). */
  dispose: () => void;
}

/** Maps a download result to the compact renderer event payload. */
function summarizeDownloadResult(
  workbookId: string,
  workspacePath: string,
  result: DownloadWorkspaceResult,
): AutoDownloadCompletedEvent {
  if (result.status === 'blocked_conflict') {
    return {
      workbookId,
      workspacePath,
      status: 'blocked_conflict',
      filesChanged: 0,
      conflictCount: result.conflictCount,
    };
  }
  return {
    workbookId,
    workspacePath,
    status: result.status,
    filesChanged: result.filesCreated + result.filesUpdated + result.filesDeleted + result.filesMerged,
    conflictCount: result.stashedConflictPaths?.length ?? 0,
  };
}

/**
 * Wires the scheduled auto-download into the app lifecycle. Returns null when
 * intentionally disabled via `SCRATCH_DESKTOP_DISABLE_AUTO_DOWNLOAD=1` (QA boxes
 * and E2E runs that must not mutate workspaces under the test).
 */
export function initAutoDownloadScheduler(opts: AutoDownloadSchedulerOptions): AutoDownloadSchedulerController | null {
  if (process.env.SCRATCH_DESKTOP_DISABLE_AUTO_DOWNLOAD === '1') {
    console.debug('[auto-download] skipped: SCRATCH_DESKTOP_DISABLE_AUTO_DOWNLOAD=1');
    return null;
  }

  const initialRunDelayMs = opts.initialRunDelayMs ?? INITIAL_RUN_DELAY_MS;
  const runIntervalMs = opts.runIntervalMs ?? RUN_INTERVAL_MS;

  // Guards against overlapping sweeps: a slow hourly sweep must not race the next
  // interval tick (or a manual runNow). Dropping a redundant sweep is harmless —
  // the in-flight one is already pulling everything, and the next tick re-checks.
  let sweepInFlight = false;

  function emit(payload: AutoDownloadCompletedEvent): void {
    const win = opts.getMainWindow();
    if (!win || win.isDestroyed()) {
      return;
    }
    win.webContents.send(AUTO_DOWNLOAD_COMPLETED_CHANNEL, payload);
  }

  async function runSweep(): Promise<void> {
    if (sweepInFlight) {
      console.debug('[auto-download] sweep already in flight; skipping');
      return;
    }
    // Not logged in (or token expired) — the CLI download would just fail. Skip
    // quietly; the next tick (or the post-login launch) picks it up.
    if (!opts.hasValidCredentials()) {
      console.debug('[auto-download] skipped: no valid credentials');
      return;
    }
    sweepInFlight = true;
    try {
      const workspaces = await opts.listWorkspaces();
      for (const workspace of workspaces) {
        if (!opts.isEnabledForWorkbook(workspace.id)) {
          continue;
        }
        try {
          const result = await opts.performDownload(workspace.path);
          emit(summarizeDownloadResult(workspace.id, workspace.path, result));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.debug(`[auto-download] failed for ${workspace.path}:`, message);
          emit({
            workbookId: workspace.id,
            workspacePath: workspace.path,
            status: 'error',
            filesChanged: 0,
            conflictCount: 0,
            message,
          });
        }
      }
    } catch (error) {
      console.debug('[auto-download] sweep failed to enumerate workspaces:', error);
    } finally {
      sweepInFlight = false;
    }
  }

  const initialRunTimer = setTimeout(() => {
    void runSweep();
  }, initialRunDelayMs);

  const intervalTimer = setInterval(() => {
    void runSweep();
  }, runIntervalMs);

  return {
    runNow: () => runSweep(),
    dispose: () => {
      clearTimeout(initialRunTimer);
      clearInterval(intervalTimer);
    },
  };
}
