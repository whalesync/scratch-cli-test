import { app, BrowserWindow } from 'electron';
import electronLog from 'electron-log';
import { autoUpdater, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater';
import { UPDATER_EVENT_CHANNEL, UpdaterEvent } from '../shared/updater-events';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const INITIAL_CHECK_DELAY_MS = 5_000;

/**
 * Normalizes a version string for an "is this the version we're already
 * running?" comparison: drops surrounding whitespace, a leading "v", and any
 * "+build" metadata (build metadata carries no precedence per semver). We do
 * NOT attempt full semver ordering here — we only need to recognize when an
 * offered version is the exact one already installed.
 */
function normalizeVersionForComparison(rawVersion: string): string {
  return rawVersion.trim().replace(/^v/i, '').replace(/\+.*$/, '');
}

/**
 * True when electron-updater is offering the version we are already running.
 *
 * electron-updater gates `update-available` behind its own semver check, but
 * its cached-download path can re-surface a previously downloaded artifact for
 * a version that is already installed (electron-builder #6269 / #7356), and a
 * Squirrel.Mac apply that silently no-ops leaves that artifact behind. Either
 * way the renderer would show a perpetual "Restart & install" prompt for a
 * version the user already has. We only ever suppress on equality, so a genuine
 * upgrade (including a real prerelease → stable bump) is never hidden.
 */
function offeredVersionIsAlreadyInstalled(offeredVersion: string, runningVersion: string): boolean {
  return normalizeVersionForComparison(offeredVersion) === normalizeVersionForComparison(runningVersion);
}

interface InitOptions {
  /** Returns the current main window (may be null between window cycles). */
  getMainWindow: () => BrowserWindow | null;
}

interface UpdaterController {
  /** Triggers a manual check; events fired during the cycle carry `manual: true`. */
  checkForUpdates: () => Promise<void>;
  /** Quits the app and installs the staged update. No-op if nothing is downloaded. */
  quitAndInstall: () => void;
  /** Disposes timers and listeners (used by tests; no-op in production). */
  dispose: () => void;
}

/**
 * Wires `electron-updater` into the app lifecycle and forwards a compact
 * UpdaterEvent stream to the renderer. Returns null when the updater is
 * intentionally skipped (dev / unsupported platform / disabled via env).
 */
export function initAutoUpdater(opts: InitOptions): UpdaterController | null {
  if (!app.isPackaged) {
    console.debug('[updater] skipped: not a packaged build (use dev-app-update.yml to test locally)');
    return null;
  }

  if (process.env.SCRATCH_DESKTOP_DISABLE_AUTO_UPDATE === '1') {
    console.debug('[updater] skipped: SCRATCH_DESKTOP_DISABLE_AUTO_UPDATE=1');
    return null;
  }

  electronLog.transports.file.level = 'info';
  autoUpdater.logger = electronLog;
  autoUpdater.autoDownload = true;
  // Workspace state lives in unsaved IPC sessions, so quitting without an
  // explicit "Restart & install" must not silently swap the app underneath.
  autoUpdater.autoInstallOnAppQuit = false;

  // Captured once at init. In a packaged build this is the bundled
  // CFBundleShortVersionString (the same value the "About" panel and
  // electron-updater's own currentVersion read), so it is the authoritative
  // "what am I running right now" for the suppression guard below.
  const runningVersion = app.getVersion();
  electronLog.info(`[updater] init: runningVersion=${runningVersion} channel=${autoUpdater.channel ?? 'default'}`);

  // Serializes update cycles: electron-updater's checkForUpdates() is not safely
  // re-entrant, and overlapping cycles (the 5s initial check vs. a manual check,
  // or the 4h interval vs. a manual check) would let one cycle's terminal event
  // reset the other's flags and mis-tag events. Dropping a redundant check is
  // harmless — the in-flight one emits its terminal event shortly.
  let checkInFlight = false;
  let manualCheckInFlight = false;
  // True between `update-available` and the next terminal event. Used to tag
  // `error` events with phase='download' so the renderer can surface them even
  // on background checks — a failed download is meaningful regardless of how
  // the check started.
  let downloadInFlight = false;

  function emit(payload: UpdaterEvent): void {
    const win = opts.getMainWindow();
    if (!win || win.isDestroyed()) {
      return;
    }
    win.webContents.send(UPDATER_EVENT_CHANNEL, payload);
  }

  function endCycle(): void {
    manualCheckInFlight = false;
    downloadInFlight = false;
    checkInFlight = false;
  }

  autoUpdater.on('checking-for-update', () => {
    emit({ type: 'checking-for-update', manual: manualCheckInFlight });
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    if (offeredVersionIsAlreadyInstalled(info.version, runningVersion)) {
      electronLog.warn(
        `[updater] update-available offered=${info.version} running=${runningVersion} decision=SUPPRESS (already installed)`,
      );
      // Tell the renderer there's nothing to install so it clears any stale
      // "Restart & install" prompt instead of surfacing a re-offer.
      emit({ type: 'update-not-available', manual: manualCheckInFlight, version: info.version });
      endCycle();
      return;
    }
    electronLog.info(`[updater] update-available offered=${info.version} running=${runningVersion} decision=forward`);
    downloadInFlight = true;
    emit({
      type: 'update-available',
      manual: manualCheckInFlight,
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
    });
  });

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    electronLog.info(`[updater] update-not-available manifest=${info.version} running=${runningVersion}`);
    emit({ type: 'update-not-available', manual: manualCheckInFlight, version: info.version });
    endCycle();
  });

  autoUpdater.on('download-progress', (progress) => {
    emit({
      type: 'download-progress',
      manual: manualCheckInFlight,
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    });
  });

  autoUpdater.on('update-downloaded', (info: UpdateDownloadedEvent) => {
    if (offeredVersionIsAlreadyInstalled(info.version, runningVersion)) {
      // This is the load-bearing guard: electron-updater's cached-download path
      // can re-emit `update-downloaded` for an already-installed version without
      // re-checking semver, which is what produces the perpetual prompt that
      // survives restarts and reinstall clicks. Suppress it and clear the prompt.
      electronLog.warn(
        `[updater] update-downloaded offered=${info.version} running=${runningVersion} decision=SUPPRESS (already installed; likely a stale cached download)`,
      );
      emit({ type: 'update-not-available', manual: manualCheckInFlight, version: info.version });
      endCycle();
      return;
    }
    electronLog.info(`[updater] update-downloaded offered=${info.version} running=${runningVersion} decision=forward`);
    emit({
      type: 'update-downloaded',
      manual: manualCheckInFlight,
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
    });
    endCycle();
  });

  autoUpdater.on('error', (error: Error) => {
    emit({
      type: 'error',
      manual: manualCheckInFlight,
      phase: downloadInFlight ? 'download' : 'check',
      message: error?.message ?? String(error),
    });
    endCycle();
  });

  async function runCheck(manual: boolean): Promise<void> {
    if (checkInFlight) {
      electronLog.info(`[updater] check already in flight; ignoring ${manual ? 'manual' : 'auto'} request`);
      return;
    }
    checkInFlight = true;
    if (manual) {
      manualCheckInFlight = true;
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      // electron-updater also fires its own 'error' event; this catches the
      // synchronous rejection path so the cycle flags still reset. A rejection
      // from checkForUpdates() means we never got to update-available, so this
      // is always a check-phase failure.
      emit({
        type: 'error',
        manual,
        phase: 'check',
        message: error instanceof Error ? error.message : String(error),
      });
      endCycle();
    }
  }

  const initialCheckTimer = setTimeout(() => {
    void runCheck(false);
  }, INITIAL_CHECK_DELAY_MS);

  const intervalTimer = setInterval(() => {
    void runCheck(false);
  }, CHECK_INTERVAL_MS);

  return {
    checkForUpdates: () => runCheck(true),
    quitAndInstall: () => {
      // Logged so a repeated "quitAndInstall invoked" across restarts with no
      // version bump afterward fingerprints a Squirrel.Mac apply that silently
      // refuses the staged update (signing/notarization/permission mismatch).
      electronLog.info(`[updater] quitAndInstall invoked (runningVersion=${runningVersion})`);
      // (isSilent=false, isForceRunAfter=true): show the installer UI on Windows
      // and relaunch after install on all platforms.
      autoUpdater.quitAndInstall(false, true);
    },
    dispose: () => {
      clearTimeout(initialCheckTimer);
      clearInterval(intervalTimer);
      autoUpdater.removeAllListeners();
    },
  };
}
