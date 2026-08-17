import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdaterEvent } from '../../shared/updater-events';
import { UPDATER_EVENT_CHANNEL } from '../../shared/updater-events';

const eventHandlers = new Map<string, (...args: unknown[]) => void>();
const autoUpdaterStub = {
  logger: null as unknown,
  autoDownload: false,
  autoInstallOnAppQuit: true,
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    eventHandlers.set(event, handler);
  }),
  removeAllListeners: vi.fn(() => eventHandlers.clear()),
  checkForUpdates: vi.fn(() => Promise.resolve({})),
  quitAndInstall: vi.fn(),
};

const electronAppStub = { isPackaged: true, getVersion: () => '1.0.0' };

vi.mock('electron-updater', () => ({
  autoUpdater: autoUpdaterStub,
}));

vi.mock('electron-log', () => ({
  default: { transports: { file: { level: 'silly' } }, info: vi.fn(), warn: vi.fn() },
}));

vi.mock('electron', () => ({
  app: electronAppStub,
  BrowserWindow: class {},
}));

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  electronAppStub.isPackaged = true;
  electronAppStub.getVersion = () => '1.0.0';
  setPlatform('linux');
  delete process.env.SCRATCH_DESKTOP_DISABLE_AUTO_UPDATE;
  eventHandlers.clear();
  autoUpdaterStub.on.mockClear();
  autoUpdaterStub.removeAllListeners.mockClear();
  autoUpdaterStub.checkForUpdates.mockClear();
  autoUpdaterStub.quitAndInstall.mockClear();
  autoUpdaterStub.logger = null;
  autoUpdaterStub.autoDownload = false;
  autoUpdaterStub.autoInstallOnAppQuit = true;
});

afterEach(() => {
  vi.useRealTimers();
  setPlatform(ORIGINAL_PLATFORM);
});

describe('initAutoUpdater guards', () => {
  it('returns null when the app is not packaged (dev build)', async () => {
    electronAppStub.isPackaged = false;
    const { initAutoUpdater } = await import('../updater');

    const controller = initAutoUpdater({ getMainWindow: () => null });

    expect(controller).toBeNull();
    expect(autoUpdaterStub.on).not.toHaveBeenCalled();
  });

  it('initializes on darwin now that builds are signed and notarized', async () => {
    setPlatform('darwin');
    const { initAutoUpdater } = await import('../updater');

    const controller = initAutoUpdater({ getMainWindow: () => null });

    expect(controller).not.toBeNull();
    expect(autoUpdaterStub.on).toHaveBeenCalled();

    controller?.dispose();
  });

  it('returns null when SCRATCH_DESKTOP_DISABLE_AUTO_UPDATE=1', async () => {
    process.env.SCRATCH_DESKTOP_DISABLE_AUTO_UPDATE = '1';
    const { initAutoUpdater } = await import('../updater');

    const controller = initAutoUpdater({ getMainWindow: () => null });

    expect(controller).toBeNull();
    expect(autoUpdaterStub.on).not.toHaveBeenCalled();
  });
});

describe('initAutoUpdater event forwarding', () => {
  it('forwards autoUpdater events to the main window with manual:false during the auto cycle', async () => {
    const sentEvents: UpdaterEvent[] = [];
    const fakeWindow = {
      isDestroyed: () => false,
      webContents: {
        send: vi.fn((channel: string, payload: UpdaterEvent) => {
          expect(channel).toBe(UPDATER_EVENT_CHANNEL);
          sentEvents.push(payload);
        }),
      },
    };

    const { initAutoUpdater } = await import('../updater');
    const controller = initAutoUpdater({ getMainWindow: () => fakeWindow as never });
    expect(controller).not.toBeNull();

    eventHandlers.get('checking-for-update')?.();
    eventHandlers.get('update-available')?.({ version: '1.2.3', releaseDate: '2026-04-24' });
    eventHandlers.get('update-not-available')?.({ version: '1.2.3' });

    expect(sentEvents).toEqual([
      { type: 'checking-for-update', manual: false },
      {
        type: 'update-available',
        manual: false,
        version: '1.2.3',
        releaseDate: '2026-04-24',
        releaseNotes: null,
      },
      { type: 'update-not-available', manual: false, version: '1.2.3', runningVersion: '1.0.0' },
    ]);

    controller?.dispose();
  });

  it('reports the running version, not the feed version, on update-not-available (the 1.0.104/0.1.1 wedge)', async () => {
    // Regression for the 2026-08-17 incident: a wedged stable channel offered an
    // OLDER feed version (0.1.1) than the running build (1.0.104). The emitted event
    // must carry runningVersion = app.getVersion(), independent of the feed version,
    // so the "You're up to date" toast shows what the user is actually running.
    electronAppStub.getVersion = () => '1.0.104';
    const sentEvents: UpdaterEvent[] = [];
    const fakeWindow = {
      isDestroyed: () => false,
      webContents: {
        send: vi.fn((_channel: string, payload: UpdaterEvent) => {
          sentEvents.push(payload);
        }),
      },
    };

    const { initAutoUpdater } = await import('../updater');
    const controller = initAutoUpdater({ getMainWindow: () => fakeWindow as never });

    eventHandlers.get('update-not-available')?.({ version: '0.1.1' });

    expect(sentEvents).toEqual([
      { type: 'update-not-available', manual: false, version: '0.1.1', runningVersion: '1.0.104' },
    ]);

    controller?.dispose();
  });

  it('marks events as manual:true while a manual check is in flight, then resets', async () => {
    const sentEvents: UpdaterEvent[] = [];
    const fakeWindow = {
      isDestroyed: () => false,
      webContents: {
        send: vi.fn((_channel: string, payload: UpdaterEvent) => {
          sentEvents.push(payload);
        }),
      },
    };

    const { initAutoUpdater } = await import('../updater');
    const controller = initAutoUpdater({ getMainWindow: () => fakeWindow as never });
    expect(controller).not.toBeNull();

    // Manual check cycle: events should carry manual:true until terminal event.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    void controller!.checkForUpdates();
    eventHandlers.get('checking-for-update')?.();
    eventHandlers.get('update-not-available')?.({ version: '1.0.0' });

    // Subsequent auto event should be marked manual:false again.
    eventHandlers.get('checking-for-update')?.();

    expect(sentEvents).toEqual([
      { type: 'checking-for-update', manual: true },
      { type: 'update-not-available', manual: true, version: '1.0.0', runningVersion: '1.0.0' },
      { type: 'checking-for-update', manual: false },
    ]);

    controller?.dispose();
  });

  it('skips sends when the main window is null or destroyed', async () => {
    const { initAutoUpdater } = await import('../updater');
    const controller = initAutoUpdater({ getMainWindow: () => null });
    expect(controller).not.toBeNull();

    expect(() => eventHandlers.get('checking-for-update')?.()).not.toThrow();

    controller?.dispose();
  });

  it('tags errors before update-available as phase=check', async () => {
    const sentEvents: UpdaterEvent[] = [];
    const fakeWindow = {
      isDestroyed: () => false,
      webContents: {
        send: vi.fn((_channel: string, payload: UpdaterEvent) => {
          sentEvents.push(payload);
        }),
      },
    };

    const { initAutoUpdater } = await import('../updater');
    const controller = initAutoUpdater({ getMainWindow: () => fakeWindow as never });

    eventHandlers.get('checking-for-update')?.();
    eventHandlers.get('error')?.(new Error('net::ERR_NAME_NOT_RESOLVED'));

    expect(sentEvents).toEqual([
      { type: 'checking-for-update', manual: false },
      { type: 'error', manual: false, phase: 'check', message: 'net::ERR_NAME_NOT_RESOLVED' },
    ]);

    controller?.dispose();
  });

  it('tags errors after update-available as phase=download', async () => {
    const sentEvents: UpdaterEvent[] = [];
    const fakeWindow = {
      isDestroyed: () => false,
      webContents: {
        send: vi.fn((_channel: string, payload: UpdaterEvent) => {
          sentEvents.push(payload);
        }),
      },
    };

    const { initAutoUpdater } = await import('../updater');
    const controller = initAutoUpdater({ getMainWindow: () => fakeWindow as never });

    eventHandlers.get('update-available')?.({ version: '1.2.3' });
    eventHandlers.get('error')?.(new Error('net::ERR_NETWORK_CHANGED'));

    expect(sentEvents).toEqual([
      {
        type: 'update-available',
        manual: false,
        version: '1.2.3',
        releaseDate: undefined,
        releaseNotes: null,
      },
      { type: 'error', manual: false, phase: 'download', message: 'net::ERR_NETWORK_CHANGED' },
    ]);

    controller?.dispose();
  });

  it('resets download-phase tracking between cycles so the next check-error is phase=check', async () => {
    const sentEvents: UpdaterEvent[] = [];
    const fakeWindow = {
      isDestroyed: () => false,
      webContents: {
        send: vi.fn((_channel: string, payload: UpdaterEvent) => {
          sentEvents.push(payload);
        }),
      },
    };

    const { initAutoUpdater } = await import('../updater');
    const controller = initAutoUpdater({ getMainWindow: () => fakeWindow as never });

    // First cycle: download starts, then errors out. Both flags reset.
    eventHandlers.get('update-available')?.({ version: '1.2.3' });
    eventHandlers.get('error')?.(new Error('boom'));

    // Clear so we can assert just the second cycle's events.
    sentEvents.length = 0;

    // Second cycle: error before update-available should be phase=check, not
    // a leftover phase=download from the previous cycle.
    eventHandlers.get('checking-for-update')?.();
    eventHandlers.get('error')?.(new Error('still boom'));

    expect(sentEvents).toEqual([
      { type: 'checking-for-update', manual: false },
      { type: 'error', manual: false, phase: 'check', message: 'still boom' },
    ]);

    controller?.dispose();
  });

  it('tags errors after quitAndInstall as phase=install (the deferred install handoff)', async () => {
    const sentEvents: UpdaterEvent[] = [];
    const fakeWindow = {
      isDestroyed: () => false,
      webContents: {
        send: vi.fn((_channel: string, payload: UpdaterEvent) => {
          sentEvents.push(payload);
        }),
      },
    };

    const { initAutoUpdater } = await import('../updater');
    const controller = initAutoUpdater({ getMainWindow: () => fakeWindow as never });

    // A completed download ends the cycle (downloadInFlight resets); the user then clicks
    // "Restart & install". A failure applying the update must be phase=install, not check.
    eventHandlers.get('update-downloaded')?.({ version: '1.5.0' });
    controller?.quitAndInstall();
    eventHandlers.get('error')?.(new Error('-1022 ATS blocked the loopback install'));

    expect(sentEvents).toContainEqual({
      type: 'error',
      manual: false,
      phase: 'install',
      message: '-1022 ATS blocked the loopback install',
    });

    controller?.dispose();
  });

  it('runs the initial check after the 5s delay', async () => {
    const { initAutoUpdater } = await import('../updater');
    const controller = initAutoUpdater({ getMainWindow: () => null });
    expect(controller).not.toBeNull();

    expect(autoUpdaterStub.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(autoUpdaterStub.checkForUpdates).toHaveBeenCalledTimes(1);

    controller?.dispose();
  });
});

describe('initAutoUpdater version-already-installed guard', () => {
  function makeRecordingWindow(sink: UpdaterEvent[]) {
    return {
      isDestroyed: () => false,
      webContents: {
        send: vi.fn((_channel: string, payload: UpdaterEvent) => {
          sink.push(payload);
        }),
      },
    };
  }

  it('suppresses update-available when the offered version is already running', async () => {
    electronAppStub.getVersion = () => '1.4.0';
    const sentEvents: UpdaterEvent[] = [];

    const { initAutoUpdater } = await import('../updater');
    const controller = initAutoUpdater({ getMainWindow: () => makeRecordingWindow(sentEvents) as never });

    eventHandlers.get('update-available')?.({ version: '1.4.0', releaseDate: '2026-04-24' });

    expect(sentEvents).toEqual([
      { type: 'update-not-available', manual: false, version: '1.4.0', runningVersion: '1.4.0' },
    ]);

    controller?.dispose();
  });

  it('suppresses a re-offered update-downloaded for the already-installed version (cache replay)', async () => {
    electronAppStub.getVersion = () => '2.0.0';
    const sentEvents: UpdaterEvent[] = [];

    const { initAutoUpdater } = await import('../updater');
    const controller = initAutoUpdater({ getMainWindow: () => makeRecordingWindow(sentEvents) as never });

    eventHandlers.get('update-downloaded')?.({ version: '2.0.0', releaseDate: '2026-04-24' });

    expect(sentEvents).toEqual([
      { type: 'update-not-available', manual: false, version: '2.0.0', runningVersion: '2.0.0' },
    ]);

    controller?.dispose();
  });

  it('suppresses when the offered version differs only by build metadata or a leading v', async () => {
    electronAppStub.getVersion = () => '1.4.0';
    const sentEvents: UpdaterEvent[] = [];

    const { initAutoUpdater } = await import('../updater');
    const controller = initAutoUpdater({ getMainWindow: () => makeRecordingWindow(sentEvents) as never });

    eventHandlers.get('update-downloaded')?.({ version: ' v1.4.0+build.9 ' });

    expect(sentEvents).toEqual([
      { type: 'update-not-available', manual: false, version: ' v1.4.0+build.9 ', runningVersion: '1.4.0' },
    ]);

    controller?.dispose();
  });

  it('forwards update-downloaded when the offered version is strictly newer', async () => {
    electronAppStub.getVersion = () => '1.4.0';
    const sentEvents: UpdaterEvent[] = [];

    const { initAutoUpdater } = await import('../updater');
    const controller = initAutoUpdater({ getMainWindow: () => makeRecordingWindow(sentEvents) as never });

    eventHandlers.get('update-downloaded')?.({ version: '1.5.0', releaseDate: '2026-04-24' });

    expect(sentEvents).toEqual([
      {
        type: 'update-downloaded',
        manual: false,
        version: '1.5.0',
        releaseDate: '2026-04-24',
        releaseNotes: null,
      },
    ]);

    controller?.dispose();
  });
});

describe('initAutoUpdater concurrency guard', () => {
  it('ignores a second check while one is already in flight', async () => {
    const { initAutoUpdater } = await import('../updater');
    const controller = initAutoUpdater({ getMainWindow: () => null });
    expect(controller).not.toBeNull();

    void controller?.checkForUpdates();
    void controller?.checkForUpdates();

    expect(autoUpdaterStub.checkForUpdates).toHaveBeenCalledTimes(1);

    controller?.dispose();
  });

  it('allows the next check after the in-flight cycle ends with a terminal event', async () => {
    const { initAutoUpdater } = await import('../updater');
    const controller = initAutoUpdater({ getMainWindow: () => null });
    expect(controller).not.toBeNull();

    void controller?.checkForUpdates();
    eventHandlers.get('update-not-available')?.({ version: '1.0.0' });
    void controller?.checkForUpdates();

    expect(autoUpdaterStub.checkForUpdates).toHaveBeenCalledTimes(2);

    controller?.dispose();
  });
});
