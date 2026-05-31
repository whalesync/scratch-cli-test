import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReviewStat } from '../../../shared/review-types';

// ---------------------------------------------------------------------------
// Hook return type
// ---------------------------------------------------------------------------

export interface UseReviewStatsReturn {
  /** Per-folder counts of `{ unreviewed, approved }` across the workspace. */
  stats: ReviewStat[];
  /** True while the initial / refresh fetch is in flight. */
  statsLoading: boolean;
  /** Imperatively re-fetch the stats. */
  refreshStats: () => void;
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

/**
 * Subscribes to the per-folder review-state counts that power the sidebar's
 * "Needs review" (blue) and "Approved" (gray) folder-tree dots.
 *
 * Modelled on the stats half of `useValidation`:
 * - Generation counter discards stale responses when a newer load is in flight.
 * - Auto-refreshes on workspacePath change AND when the externally-supplied
 *   `refreshKey` (= `workspaceLevelDataInvalidationCounter`) changes.
 * - Additionally subscribes to the main-process
 *   `'review-stats-may-have-changed'` IPC event so the dots update
 *   progressively as the refresh queue drains. A short trailing debounce
 *   coalesces a burst of completed-refresh notifications into one fetch.
 *
 * Like `useValidation`, errors are swallowed: a failed fetch resets the
 * stats to `[]` and the UI degrades to "no dots". The hook never throws.
 */
const NOTIFY_DEBOUNCE_MS = 250;

export function useReviewStats(workspacePath: string | null, refreshKey?: number): UseReviewStatsReturn {
  const [stats, setStats] = useState<ReviewStat[]>([]);
  const [statsLoading, setStatsLoading] = useState(false);
  const statsGenRef = useRef(0);

  const loadStats = useCallback(async () => {
    if (!workspacePath) {
      setStats([]);
      return;
    }
    const gen = ++statsGenRef.current;
    setStatsLoading(true);
    try {
      const result = await window.scratchFiles.getReviewStats(workspacePath);
      if (gen === statsGenRef.current) {
        setStats(result);
      }
    } catch (err) {
      console.debug('[useReviewStats] failed to load stats:', err);
      if (gen === statsGenRef.current) {
        setStats([]);
      }
    } finally {
      if (gen === statsGenRef.current) {
        setStatsLoading(false);
      }
    }
  }, [workspacePath]);

  useEffect(() => {
    void loadStats();
  }, [loadStats, refreshKey]);

  // Trailing-edge debounced re-fetch on watcher/refresh-queue completions.
  // The main process emits one event per workspace per debounce window, but
  // we add a renderer-side coalesce in case multiple workspaces are open or
  // the user is rapidly switching workspaces.
  useEffect(() => {
    if (!workspacePath) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = window.scratchDesktop.onReviewStatsMayHaveChanged((event) => {
      if (event.workspacePath !== workspacePath) return;
      if (timer != null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void loadStats();
      }, NOTIFY_DEBOUNCE_MS);
    });
    return () => {
      if (timer != null) clearTimeout(timer);
      unsubscribe();
    };
  }, [loadStats, workspacePath]);

  return useMemo(
    () => ({
      stats,
      statsLoading,
      refreshStats: () => void loadStats(),
    }),
    [stats, statsLoading, loadStats],
  );
}
