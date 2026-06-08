/**
 * Unit tests for the review-stats notifier. It does no refresh work — it just
 * debounces "review stats may have changed" IPC events to the renderer, which
 * re-fetches `getReviewStats` (derived live from git, DEV-10327).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REVIEW_STATS_MAY_HAVE_CHANGED_CHANNEL } from '../../shared/review-stats-events';
import { reviewStatsNotifier } from '../review-stats-notifier';

interface MockWebContents {
  send: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
}

function createMockWebContents(): MockWebContents {
  return { send: vi.fn(), isDestroyed: () => false };
}

describe('reviewStatsNotifier', () => {
  beforeEach(() => {
    reviewStatsNotifier.clear();
    reviewStatsNotifier.setSubscriber(null);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    reviewStatsNotifier.clear();
  });

  it('collapses a burst into one debounced event per workspace', async () => {
    const wc = createMockWebContents();
    reviewStatsNotifier.setSubscriber(wc as unknown as Electron.WebContents);

    reviewStatsNotifier.notifyReviewStatsChanged('/ws-a');
    reviewStatsNotifier.notifyReviewStatsChanged('/ws-a');
    reviewStatsNotifier.notifyReviewStatsChanged('/ws-b');

    // Gated on the trailing 250 ms debounce timer.
    expect(wc.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);

    expect(wc.send).toHaveBeenCalledTimes(2);
    const sentWorkspacePaths = wc.send.mock.calls.map((c) => (c[1] as { workspacePath: string }).workspacePath).sort();
    expect(sentWorkspacePaths).toEqual(['/ws-a', '/ws-b']);
    expect(wc.send.mock.calls[0][0]).toBe(REVIEW_STATS_MAY_HAVE_CHANGED_CHANNEL);
  });

  it('starts a fresh debounce window after the timer fires', async () => {
    const wc = createMockWebContents();
    reviewStatsNotifier.setSubscriber(wc as unknown as Electron.WebContents);

    reviewStatsNotifier.notifyReviewStatsChanged('/ws');
    await vi.advanceTimersByTimeAsync(250);
    expect(wc.send).toHaveBeenCalledTimes(1);

    reviewStatsNotifier.notifyReviewStatsChanged('/ws');
    await vi.advanceTimersByTimeAsync(250);
    expect(wc.send).toHaveBeenCalledTimes(2);
  });

  it('does nothing when there is no subscriber', async () => {
    reviewStatsNotifier.notifyReviewStatsChanged('/ws');
    await vi.advanceTimersByTimeAsync(250);
    // No throw, nothing to assert beyond surviving the dispatch.
    expect(reviewStatsNotifier.pendingNotifyCountForTests).toBe(0);
  });

  it('drops the event when the subscriber WebContents is destroyed', async () => {
    const wc = { send: vi.fn(), isDestroyed: () => true };
    reviewStatsNotifier.setSubscriber(wc as unknown as Electron.WebContents);

    reviewStatsNotifier.notifyReviewStatsChanged('/ws');
    await vi.advanceTimersByTimeAsync(250);

    expect(wc.send).not.toHaveBeenCalled();
  });

  it('cancelWorkspace drops a pending notify for that workspace, leaving others', async () => {
    const wc = createMockWebContents();
    reviewStatsNotifier.setSubscriber(wc as unknown as Electron.WebContents);

    reviewStatsNotifier.notifyReviewStatsChanged('/ws-a');
    reviewStatsNotifier.notifyReviewStatsChanged('/ws-b');
    expect(reviewStatsNotifier.pendingNotifyCountForTests).toBe(2);

    reviewStatsNotifier.cancelWorkspace('/ws-a');
    expect(reviewStatsNotifier.pendingNotifyCountForTests).toBe(1);

    await vi.advanceTimersByTimeAsync(250);
    expect(wc.send).toHaveBeenCalledTimes(1);
    expect(wc.send.mock.calls[0][1]).toEqual({ workspacePath: '/ws-b' });
  });

  it('clear cancels the pending timer and drops queued notifications', async () => {
    const wc = createMockWebContents();
    reviewStatsNotifier.setSubscriber(wc as unknown as Electron.WebContents);

    reviewStatsNotifier.notifyReviewStatsChanged('/ws');
    reviewStatsNotifier.clear();
    await vi.advanceTimersByTimeAsync(250);

    expect(wc.send).not.toHaveBeenCalled();
    expect(reviewStatsNotifier.pendingNotifyCountForTests).toBe(0);
  });
});
