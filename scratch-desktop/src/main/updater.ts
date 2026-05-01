import { app, BrowserWindow } from 'electron';
import electronLog from 'electron-log';
import { autoUpdater, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater';
import { UPDATER_EVENT_CHANNEL, UpdaterEvent } from '../shared/updater-events';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const INITIAL_CHECK_DELAY_MS = 5_000;

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

  let manualCheckInFlight = false;

  function emit(payload: UpdaterEvent): void {
    const win = opts.getMainWindow();
    if (!win || win.isDestroyed()) {
      return;
    }
    win.webContents.send(UPDATER_EVENT_CHANNEL, payload);
  }

  function endManualCycle(): void {
    manualCheckInFlight = false;
  }

  autoUpdater.on('checking-for-update', () => {
    emit({ type: 'checking-for-update', manual: manualCheckInFlight });
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    emit({
      type: 'update-available',
      manual: manualCheckInFlight,
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
    });
  });

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    emit({ type: 'update-not-available', manual: manualCheckInFlight, version: info.version });
    endManualCycle();
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
    emit({
      type: 'update-downloaded',
      manual: manualCheckInFlight,
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
    });
    endManualCycle();
  });

  autoUpdater.on('error', (error: Error) => {
    emit({ type: 'error', manual: manualCheckInFlight, message: error?.message ?? String(error) });
    endManualCycle();
  });

  async function runCheck(manual: boolean): Promise<void> {
    if (manual) {
      manualCheckInFlight = true;
    }
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      // electron-updater also fires its own 'error' event; this catches the
      // synchronous rejection path so the manual-check flag still resets.
      emit({
        type: 'error',
        manual,
        message: error instanceof Error ? error.message : String(error),
      });
      endManualCycle();
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
