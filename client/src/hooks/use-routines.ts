import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { Routine, WorkbookId } from '@spinner/shared-types';
import { useCallback } from 'react';
import useSWR from 'swr';

export interface UseRoutinesReturn {
  routines: Routine[];
  isLoading: boolean;
  error: Error | undefined;
  refresh: () => Promise<void>;
}

/**
 * Loads the workbook's routines (parsed YAML joined with schedule + latest-run state). Read-only;
 * mutations go through `scratchApiClient.routine.*` and should call `refresh()` afterwards.
 */
export const useRoutines = (workbookId: WorkbookId | null): UseRoutinesReturn => {
  const { data, error, isLoading, mutate } = useSWR<Routine[], Error>(
    workbookId ? SWR_KEYS.routines.list(workbookId) : null,
    () => {
      if (!workbookId) {
        throw new Error('workbookId is required');
      }
      return scratchApiClient.routine.list(workbookId);
    },
    {
      revalidateOnFocus: false,
    },
  );

  const refresh = useCallback(async () => {
    await mutate();
  }, [mutate]);

  return {
    routines: data ?? [],
    isLoading,
    error,
    refresh,
  };
};
