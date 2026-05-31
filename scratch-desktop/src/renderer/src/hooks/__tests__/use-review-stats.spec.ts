/**
 * useReviewStats — pure-logic tests.
 *
 * Full hook tests (mounting the hook, asserting it subscribes and re-renders)
 * require @testing-library/react + a jsdom/happy-dom environment, neither of
 * which is installed for scratch-desktop — the vitest environment is `node`
 * (see vitest.config.ts and WorkspacePage.watcher.spec.ts, which documents the
 * same constraint). These tests instead mirror the two pieces of non-trivial
 * logic the hook embeds in its effects:
 *
 *   1. The generation-counter staleness guard inside `loadStats`, which
 *      discards an older in-flight fetch's result once a newer fetch starts.
 *   2. The trailing-edge debounce on the `review-stats-may-have-changed`
 *      subscription, which coalesces a burst of completed-refresh
 *      notifications into a single re-fetch and filters out events for other
 *      workspaces.
 *
 * If the hook's behaviour changes, update both the hook and the mirrors below.
 *
 * To run: yarn test (picked up via the vitest.config.ts include glob).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewStat } from '../../../../shared/review-types';

// Mirrors NOTIFY_DEBOUNCE_MS in use-review-stats.ts.
const NOTIFY_DEBOUNCE_MS = 250;

interface ReviewStatsMayHaveChangedEvent {
  workspacePath: string;
}

// ─── 1. Generation-counter staleness guard ──────────────────────────────────
//
// Mirrors the `statsGenRef` logic in `loadStats`: each call bumps a shared
// generation counter and only applies its result if it's still the latest
// call when it resolves. This prevents a slow earlier fetch from clobbering a
// faster later one (workspace switch, rapid refreshKey changes).

function createStaleGuardedLoader(fetchStats: () => Promise<ReviewStat[]>, applyStats: (stats: ReviewStat[]) => void) {
  let generation = 0;
  return async function loadStats(): Promise<void> {
    const thisGeneration = ++generation;
    try {
      const result = await fetchStats();
      if (thisGeneration === generation) applyStats(result);
    } catch {
      if (thisGeneration === generation) applyStats([]);
    }
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const STAT_A: ReviewStat = { connection: 'HubSpot', folder_path: 'Posts', unreviewed: 1, approved: 0 };
const STAT_B: ReviewStat = { connection: 'HubSpot', folder_path: 'Posts', unreviewed: 0, approved: 3 };

describe('useReviewStats — staleness guard', () => {
  it('applies the result of a single load', async () => {
    const applied: ReviewStat[][] = [];
    const loadStats = createStaleGuardedLoader(
      () => Promise.resolve([STAT_A]),
      (s) => applied.push(s),
    );
    await loadStats();
    expect(applied).toEqual([[STAT_A]]);
  });

  it('discards an earlier load that resolves after a later one', async () => {
    const applied: ReviewStat[][] = [];
    const first = deferred<ReviewStat[]>();
    const second = deferred<ReviewStat[]>();
    const sources = [first, second];
    let call = 0;
    const loadStats = createStaleGuardedLoader(
      () => sources[call++].promise,
      (s) => applied.push(s),
    );

    const firstRun = loadStats(); // generation 1
    const secondRun = loadStats(); // generation 2

    // The later load resolves first and wins.
    second.resolve([STAT_B]);
    await secondRun;
    // The earlier load resolves last and must be ignored (stale generation).
    first.resolve([STAT_A]);
    await firstRun;

    expect(applied).toEqual([[STAT_B]]);
  });

  it('resets stats to empty when the latest load throws', async () => {
    const applied: ReviewStat[][] = [];
    const loadStats = createStaleGuardedLoader(
      () => Promise.reject(new Error('ipc failure')),
      (s) => applied.push(s),
    );
    await loadStats();
    expect(applied).toEqual([[]]);
  });
});

// ─── 2. Trailing-edge debounce on the change subscription ────────────────────
//
// Mirrors the subscription effect: each event for the matching workspace
// resets a timer; `loadStats` only fires once the events stop for
// NOTIFY_DEBOUNCE_MS. Events for other workspaces are ignored. `cleanup`
// clears any pending timer (the effect's teardown on unmount / workspace
// switch).

function createDebouncedReloader(workspacePath: string, loadStats: () => void, debounceMs = NOTIFY_DEBOUNCE_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  function onEvent(event: ReviewStatsMayHaveChangedEvent): void {
    if (event.workspacePath !== workspacePath) return;
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      loadStats();
    }, debounceMs);
  }
  function cleanup(): void {
    if (timer != null) clearTimeout(timer);
  }
  return { onEvent, cleanup };
}

describe('useReviewStats — debounced reload on event burst', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces a burst of events into a single reload after the quiet window', () => {
    const loadStats = vi.fn();
    const { onEvent } = createDebouncedReloader('/ws', loadStats);

    for (let i = 0; i < 5; i++) onEvent({ workspacePath: '/ws' });

    // Still within the debounce window — nothing fired yet.
    vi.advanceTimersByTime(NOTIFY_DEBOUNCE_MS - 1);
    expect(loadStats).not.toHaveBeenCalled();

    // Quiet window elapses → exactly one reload.
    vi.advanceTimersByTime(1);
    expect(loadStats).toHaveBeenCalledTimes(1);
  });

  it('fires once per quiet window, so well-spaced events each reload', () => {
    const loadStats = vi.fn();
    const { onEvent } = createDebouncedReloader('/ws', loadStats);

    onEvent({ workspacePath: '/ws' });
    vi.advanceTimersByTime(NOTIFY_DEBOUNCE_MS);
    expect(loadStats).toHaveBeenCalledTimes(1);

    onEvent({ workspacePath: '/ws' });
    vi.advanceTimersByTime(NOTIFY_DEBOUNCE_MS);
    expect(loadStats).toHaveBeenCalledTimes(2);
  });

  it('ignores events for a different workspace', () => {
    const loadStats = vi.fn();
    const { onEvent } = createDebouncedReloader('/ws', loadStats);

    onEvent({ workspacePath: '/other-ws' });
    vi.advanceTimersByTime(NOTIFY_DEBOUNCE_MS * 2);
    expect(loadStats).not.toHaveBeenCalled();
  });

  it('does not reload after cleanup clears a pending timer', () => {
    const loadStats = vi.fn();
    const { onEvent, cleanup } = createDebouncedReloader('/ws', loadStats);

    onEvent({ workspacePath: '/ws' });
    cleanup();
    vi.advanceTimersByTime(NOTIFY_DEBOUNCE_MS * 2);
    expect(loadStats).not.toHaveBeenCalled();
  });
});
