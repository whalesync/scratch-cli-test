import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { RoutineRun, WorkbookId } from '@spinner/shared-types';
import { useCallback } from 'react';
import useSWR from 'swr';

export interface UseRoutineRunsReturn {
  runs: RoutineRun[];
  isLoading: boolean;
  error: Error | undefined;
  refresh: () => Promise<void>;
}

/** A run that is still in flight — the list auto-revalidates while any run is in one of these states. */
const ACTIVE_RUN_STATUSES = new Set(['pending', 'running']);

/**
 * Loads a workbook's routine runs (newest first), optionally scoped to one routine file. While any
 * run is pending/running, the list polls every few seconds so per-step progress and the final result
 * surface without a manual refresh.
 */
export const useRoutineRuns = (workbookId: WorkbookId | null, routineFilePath?: string): UseRoutineRunsReturn => {
  const { data, error, isLoading, mutate } = useSWR<RoutineRun[], Error>(
    workbookId ? SWR_KEYS.routines.runs(workbookId, routineFilePath) : null,
    () => {
      if (!workbookId) {
        throw new Error('workbookId is required');
      }
      return scratchApiClient.routine.listRuns(workbookId, routineFilePath);
    },
    {
      revalidateOnFocus: false,
      refreshInterval: (latest) => ((latest ?? []).some((run) => ACTIVE_RUN_STATUSES.has(run.status)) ? 3000 : 0),
    },
  );

  const refresh = useCallback(async () => {
    await mutate();
  }, [mutate]);

  return {
    runs: data ?? [],
    isLoading,
    error,
    refresh,
  };
};

export interface UseRoutineRunReturn {
  run: RoutineRun | undefined;
  isLoading: boolean;
  error: Error | undefined;
  refresh: () => Promise<void>;
}

/**
 * Loads a single routine run WITH its per-step detail (the list endpoint omits steps). Polls while
 * the run is pending/running so step transitions surface live. Pass a null `runId` to disable. Pass
 * `includeJobs` to also load each step's job (progress + state), e.g. for the run-history detail view.
 */
export const useRoutineRun = (
  workbookId: WorkbookId | null,
  runId: string | null,
  includeJobs = false,
): UseRoutineRunReturn => {
  const { data, error, isLoading, mutate } = useSWR<RoutineRun, Error>(
    workbookId && runId ? SWR_KEYS.routines.run(workbookId, runId, includeJobs) : null,
    () => {
      if (!workbookId || !runId) {
        throw new Error('workbookId and runId are required');
      }
      return scratchApiClient.routine.getRun(workbookId, runId, includeJobs);
    },
    {
      revalidateOnFocus: false,
      refreshInterval: (latest) => (latest && ACTIVE_RUN_STATUSES.has(latest.status) ? 3000 : 0),
    },
  );

  const refresh = useCallback(async () => {
    await mutate();
  }, [mutate]);

  return { run: data, isLoading, error, refresh };
};
