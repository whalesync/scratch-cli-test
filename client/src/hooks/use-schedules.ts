import { SWR_KEYS } from '@/lib/api/keys';
import { scheduleApi } from '@/lib/api/schedule';
import { Schedule, WorkbookId } from '@spinner/shared-types';
import { useCallback } from 'react';
import useSWR from 'swr';

export interface UseSchedulesReturn {
  schedules: Schedule[];
  isLoading: boolean;
  error: Error | undefined;
  refresh: () => Promise<void>;
}

export const useSchedules = (workbookId: WorkbookId | null): UseSchedulesReturn => {
  const { data, error, isLoading, mutate } = useSWR<Schedule[], Error>(
    workbookId ? SWR_KEYS.schedules.list(workbookId) : null,
    () => scheduleApi.list(workbookId!),
    {
      revalidateOnFocus: false,
    },
  );

  const refresh = useCallback(async () => {
    await mutate();
  }, [mutate]);

  return {
    schedules: data ?? [],
    isLoading,
    error,
    refresh,
  };
};
