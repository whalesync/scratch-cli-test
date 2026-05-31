/**
 * Unit tests for the review-refresh queue. Doesn't load the native binding —
 * mocks `refreshFolderForReviewStats` via the module-mock pattern so each
 * test can synchronize on a controllable promise per enqueued folder.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Module-level mock — must come before the import of the SUT.
vi.mock('../scratchmd', () => ({
  refreshFolderForReviewStats: vi.fn(),
}));

import { REVIEW_STATS_MAY_HAVE_CHANGED_CHANNEL } from '../../shared/review-stats-events';
import { reviewRefreshQueue } from '../review-refresh-queue';
import { refreshFolderForReviewStats } from '../scratchmd';

const refreshMock = vi.mocked(refreshFolderForReviewStats);

interface MockWebContents {
  send: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
}

function createMockWebContents(): MockWebContents {
  return { send: vi.fn(), isDestroyed: () => false };
}

/** Simple controlled-promise factory for awaiting between enqueues. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Drains pending microtasks compatibly with `vi.useFakeTimers()` (which would
 * intercept `setImmediate`). One `await` advances exactly one microtask
 * generation; multiple awaits drain a Promise chain of equal length.
 */
async function flushMicrotasks(generations = 8): Promise<void> {
  for (let i = 0; i < generations; i++) {
    await Promise.resolve();
  }
}

describe('reviewRefreshQueue', () => {
  beforeEach(() => {
    reviewRefreshQueue.clear();
    reviewRefreshQueue.setSubscriber(null);
    refreshMock.mockReset();
    refreshMock.mockResolvedValue({ base_refreshed: 0, columns_refreshed: 0 });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    reviewRefreshQueue.clear();
  });

  it('runs enqueued folders sequentially in insertion order', async () => {
    const callOrder: string[] = [];
    const gates = [deferred(), deferred(), deferred()];
    refreshMock.mockImplementation(async (_workspacePath: string, folder: string) => {
      callOrder.push(folder);
      await gates[callOrder.length - 1].promise;
      return { base_refreshed: 0, columns_refreshed: 0 };
    });

    reviewRefreshQueue.enqueueAllFolders('/ws', ['alpha/posts', 'alpha/tags', 'beta/notes']);

    await flushMicrotasks();
    expect(callOrder).toEqual(['alpha/posts']);

    gates[0].resolve();
    await flushMicrotasks();
    expect(callOrder).toEqual(['alpha/posts', 'alpha/tags']);

    gates[1].resolve();
    await flushMicrotasks();
    expect(callOrder).toEqual(['alpha/posts', 'alpha/tags', 'beta/notes']);

    gates[2].resolve();
    await flushMicrotasks();
    expect(reviewRefreshQueue.pendingCountForTests).toBe(0);
  });

  it('deduplicates folders queued in the FIFO before they start', async () => {
    const gate = deferred();
    refreshMock.mockImplementation(async () => {
      await gate.promise;
      return { base_refreshed: 0, columns_refreshed: 0 };
    });

    reviewRefreshQueue.enqueueFolderRefresh('/ws', ['alpha/posts']);
    reviewRefreshQueue.enqueueFolderRefresh('/ws', ['alpha/posts', 'alpha/posts']);
    reviewRefreshQueue.enqueueFolderRefresh('/ws', ['alpha/tags']);
    reviewRefreshQueue.enqueueFolderRefresh('/ws', ['alpha/posts']); // already in flight

    await flushMicrotasks();
    // alpha/posts is in flight; alpha/tags is pending. The two duplicate
    // alpha/posts enqueues collapse: one against the pending entry (before
    // it started), one as a dirty-while-running flag on the in-flight item.
    expect(reviewRefreshQueue.pendingCountForTests).toBe(1);

    gate.resolve();
    await flushMicrotasks();
    // alpha/tags runs after alpha/posts completes, and alpha/posts is
    // re-enqueued because at least one new enqueue arrived while in flight.
    expect(refreshMock).toHaveBeenCalledTimes(3);
    const folders = refreshMock.mock.calls.map((c) => c[1]);
    expect(folders).toContain('alpha/posts');
    expect(folders).toContain('alpha/tags');
    expect(folders.filter((f) => f === 'alpha/posts').length).toBe(2);
  });

  it('emits a debounced "review-stats-may-have-changed" event after refreshes complete', async () => {
    refreshMock.mockResolvedValue({ base_refreshed: 0, columns_refreshed: 0 });
    const wc = createMockWebContents();
    reviewRefreshQueue.setSubscriber(wc as unknown as Electron.WebContents);

    reviewRefreshQueue.enqueueAllFolders('/ws', ['a', 'b', 'c']);

    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    // Refreshes all complete synchronously since the mock resolves immediately,
    // but the IPC event is gated on the 250 ms trailing debounce timer.
    expect(wc.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);

    expect(wc.send).toHaveBeenCalledTimes(1);
    expect(wc.send).toHaveBeenCalledWith(REVIEW_STATS_MAY_HAVE_CHANGED_CHANNEL, { workspacePath: '/ws' });
  });

  it('swallows refresh errors and continues with the next item', async () => {
    refreshMock
      .mockImplementationOnce(() => Promise.reject(new Error('boom')))
      .mockResolvedValueOnce({ base_refreshed: 0, columns_refreshed: 0 });

    const wc = createMockWebContents();
    reviewRefreshQueue.setSubscriber(wc as unknown as Electron.WebContents);

    reviewRefreshQueue.enqueueAllFolders('/ws', ['bad', 'good']);

    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(refreshMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250);
    // Even though one folder failed, the successful one still triggers a notify.
    expect(wc.send).toHaveBeenCalledTimes(1);
  });

  it('converts absolute folder paths to workspace-relative form when enqueuing', async () => {
    refreshMock.mockResolvedValue({ base_refreshed: 0, columns_refreshed: 0 });

    reviewRefreshQueue.enqueueAbsoluteFolderPaths('/ws', ['/ws/HubSpot/Posts', '/ws/Airtable/Tags']);

    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(refreshMock.mock.calls.map((c) => c[1])).toEqual(['HubSpot/Posts', 'Airtable/Tags']);
  });

  it('drops absolute paths outside the workspace', async () => {
    refreshMock.mockResolvedValue({ base_refreshed: 0, columns_refreshed: 0 });

    reviewRefreshQueue.enqueueAbsoluteFolderPaths('/ws', ['/elsewhere/foo', '/ws/HubSpot/Posts']);

    await flushMicrotasks();
    await flushMicrotasks();

    expect(refreshMock.mock.calls.map((c) => c[1])).toEqual(['HubSpot/Posts']);
  });

  it('drops the notify when the subscriber WebContents is destroyed', async () => {
    refreshMock.mockResolvedValue({ base_refreshed: 0, columns_refreshed: 0 });
    const wc = { send: vi.fn(), isDestroyed: () => true };
    reviewRefreshQueue.setSubscriber(wc as unknown as Electron.WebContents);

    reviewRefreshQueue.enqueueFolderRefresh('/ws', ['a']);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(250);

    expect(wc.send).not.toHaveBeenCalled();
  });

  it('notifyReviewStatsChanged emits a debounced IPC event without running any refresh', async () => {
    refreshMock.mockResolvedValue({ base_refreshed: 0, columns_refreshed: 0 });
    const wc = createMockWebContents();
    reviewRefreshQueue.setSubscriber(wc as unknown as Electron.WebContents);

    // Hint that bits changed for two workspaces — no enqueue needed.
    reviewRefreshQueue.notifyReviewStatsChanged('/ws-a');
    reviewRefreshQueue.notifyReviewStatsChanged('/ws-a');
    reviewRefreshQueue.notifyReviewStatsChanged('/ws-b');

    expect(refreshMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);

    expect(wc.send).toHaveBeenCalledTimes(2);
    const sentWorkspacePaths = wc.send.mock.calls.map((c) => (c[1] as { workspacePath: string }).workspacePath).sort();
    expect(sentWorkspacePaths).toEqual(['/ws-a', '/ws-b']);
  });

  it('cancelWorkspace drops pending items for that workspace and leaves others alone', async () => {
    const gate = deferred();
    refreshMock.mockImplementation(async () => {
      await gate.promise;
      return { base_refreshed: 0, columns_refreshed: 0 };
    });

    reviewRefreshQueue.enqueueAllFolders('/ws-a', ['a1', 'a2', 'a3']);
    reviewRefreshQueue.enqueueAllFolders('/ws-b', ['b1']);
    await flushMicrotasks();

    // Three pending (a2, a3 + b1) plus a1 in flight.
    expect(reviewRefreshQueue.pendingCountForTests).toBe(3);
    reviewRefreshQueue.cancelWorkspace('/ws-a');
    expect(reviewRefreshQueue.pendingCountForTests).toBe(1);

    gate.resolve();
    await flushMicrotasks();
    // a1 already ran; only b1 ran after it. a2, a3 cancelled.
    const folders = refreshMock.mock.calls.map((c) => c[1]);
    expect(folders).toEqual(['a1', 'b1']);
  });
});
