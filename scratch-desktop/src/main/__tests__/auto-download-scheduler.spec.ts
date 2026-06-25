import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_DOWNLOAD_COMPLETED_CHANNEL } from '../../shared/auto-download-events';
import type { DownloadWorkspaceResult } from '../scratchmd';

vi.mock('electron', () => ({ BrowserWindow: class {} }));

interface FakeWindow {
  isDestroyed: () => boolean;
  webContents: { send: ReturnType<typeof vi.fn> };
}

function makeWindow(): FakeWindow {
  return { isDestroyed: () => false, webContents: { send: vi.fn() } };
}

function downloadedResult(overrides: Partial<DownloadWorkspaceResult> = {}): DownloadWorkspaceResult {
  return {
    status: 'downloaded',
    filesCreated: 1,
    filesUpdated: 2,
    filesDeleted: 0,
    filesMerged: 0,
    conflictsAutoResolved: 0,
    unreviewedConflictsAutoResolved: 0,
    messages: [],
    elapsedMs: 5,
    ...overrides,
  } as DownloadWorkspaceResult;
}

const INITIAL_DELAY = 5_000;
const INTERVAL = 60 * 60 * 1000;

function baseOptions(overrides: Record<string, unknown> = {}) {
  const window = makeWindow();
  return {
    window,
    options: {
      getMainWindow: () => window as unknown as import('electron').BrowserWindow,
      listWorkspaces: vi.fn(() =>
        Promise.resolve([
          { id: 'wb-1', path: '/ws/one' },
          { id: 'wb-2', path: '/ws/two' },
        ]),
      ),
      isEnabledForWorkbook: vi.fn(() => true),
      hasValidCredentials: vi.fn(() => true),
      performDownload: vi.fn(() => Promise.resolve(downloadedResult())),
      initialRunDelayMs: INITIAL_DELAY,
      runIntervalMs: INTERVAL,
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  delete process.env.SCRATCH_DESKTOP_DISABLE_AUTO_DOWNLOAD;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('initAutoDownloadScheduler', () => {
  it('returns null and never schedules when disabled via env', async () => {
    process.env.SCRATCH_DESKTOP_DISABLE_AUTO_DOWNLOAD = '1';
    const { initAutoDownloadScheduler } = await import('../auto-download-scheduler');
    const { options } = baseOptions();

    const controller = initAutoDownloadScheduler(options);

    expect(controller).toBeNull();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY + INTERVAL);
    expect(options.performDownload).not.toHaveBeenCalled();
  });

  it('downloads every enabled workspace on app open (after the initial delay)', async () => {
    const { initAutoDownloadScheduler } = await import('../auto-download-scheduler');
    const { window, options } = baseOptions();

    const controller = initAutoDownloadScheduler(options);
    expect(options.performDownload).not.toHaveBeenCalled(); // not until the delay elapses

    await vi.advanceTimersByTimeAsync(INITIAL_DELAY);

    expect(options.performDownload).toHaveBeenCalledTimes(2);
    expect(options.performDownload).toHaveBeenCalledWith('/ws/one');
    expect(options.performDownload).toHaveBeenCalledWith('/ws/two');
    expect(window.webContents.send).toHaveBeenCalledWith(
      AUTO_DOWNLOAD_COMPLETED_CHANNEL,
      expect.objectContaining({ workbookId: 'wb-1', status: 'downloaded', filesChanged: 3 }),
    );
    controller?.dispose();
  });

  it('runs again every hour', async () => {
    const { initAutoDownloadScheduler } = await import('../auto-download-scheduler');
    const { options } = baseOptions();

    const controller = initAutoDownloadScheduler(options);
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY); // first sweep
    expect(options.performDownload).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(INTERVAL); // second sweep an hour later
    expect(options.performDownload).toHaveBeenCalledTimes(4);
    controller?.dispose();
  });

  it('skips workspaces whose per-workbook setting is disabled', async () => {
    const { initAutoDownloadScheduler } = await import('../auto-download-scheduler');
    const { options } = baseOptions({ isEnabledForWorkbook: vi.fn((id: string) => id === 'wb-2') });

    const controller = initAutoDownloadScheduler(options);
    await controller?.runNow();

    expect(options.performDownload).toHaveBeenCalledTimes(1);
    expect(options.performDownload).toHaveBeenCalledWith('/ws/two');
    controller?.dispose();
  });

  it('does nothing when there are no valid credentials', async () => {
    const { initAutoDownloadScheduler } = await import('../auto-download-scheduler');
    const { options } = baseOptions({ hasValidCredentials: vi.fn(() => false) });

    const controller = initAutoDownloadScheduler(options);
    await controller?.runNow();

    expect(options.listWorkspaces).not.toHaveBeenCalled();
    expect(options.performDownload).not.toHaveBeenCalled();
    controller?.dispose();
  });

  it('emits an error event when a workspace download throws, and continues to the next', async () => {
    const { initAutoDownloadScheduler } = await import('../auto-download-scheduler');
    const { window, options } = baseOptions({
      performDownload: vi.fn((path: string) =>
        path === '/ws/one' ? Promise.reject(new Error('network down')) : Promise.resolve(downloadedResult()),
      ),
    });

    const controller = initAutoDownloadScheduler(options);
    await controller?.runNow();

    expect(options.performDownload).toHaveBeenCalledTimes(2); // didn't abort the sweep
    expect(window.webContents.send).toHaveBeenCalledWith(
      AUTO_DOWNLOAD_COMPLETED_CHANNEL,
      expect.objectContaining({ workbookId: 'wb-1', status: 'error', message: 'network down' }),
    );
    controller?.dispose();
  });

  it('reports stashed conflicts in the completion event', async () => {
    const { initAutoDownloadScheduler } = await import('../auto-download-scheduler');
    const { window, options } = baseOptions({
      listWorkspaces: vi.fn(() => Promise.resolve([{ id: 'wb-1', path: '/ws/one' }])),
      performDownload: vi.fn(() =>
        Promise.resolve(
          downloadedResult({ status: 'downloaded_with_stashed_conflicts', stashedConflictPaths: ['a.json', 'b.json'] }),
        ),
      ),
    });

    const controller = initAutoDownloadScheduler(options);
    await controller?.runNow();

    expect(window.webContents.send).toHaveBeenCalledWith(
      AUTO_DOWNLOAD_COMPLETED_CHANNEL,
      expect.objectContaining({ status: 'downloaded_with_stashed_conflicts', conflictCount: 2 }),
    );
    controller?.dispose();
  });

  it('does not run overlapping sweeps', async () => {
    const { initAutoDownloadScheduler } = await import('../auto-download-scheduler');
    let resolveDownload: (r: DownloadWorkspaceResult) => void = () => {};
    const pending = new Promise<DownloadWorkspaceResult>((resolve) => {
      resolveDownload = resolve;
    });
    const { options } = baseOptions({
      listWorkspaces: vi.fn(() => Promise.resolve([{ id: 'wb-1', path: '/ws/one' }])),
      performDownload: vi.fn(() => pending),
    });

    const controller = initAutoDownloadScheduler(options);
    const first = controller?.runNow(); // enters the sweep, blocks on the pending download
    await Promise.resolve();
    await controller?.runNow(); // should early-return: a sweep is already in flight

    expect(options.listWorkspaces).toHaveBeenCalledTimes(1);

    resolveDownload(downloadedResult());
    await first;
    controller?.dispose();
  });
});
