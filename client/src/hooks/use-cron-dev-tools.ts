import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { CronJobSummaryDto, ListCronJobsResponseDto } from '@spinner/shared-types';
import useSWR from 'swr';

interface UseCronDevToolsReturn {
  jobs: CronJobSummaryDto[];
  isLoading: boolean;
  error: Error | undefined;
  refresh: () => Promise<unknown>;
}

/**
 * Loads the list of manually-triggerable cron jobs for the admin dev tool. Triggering a job
 * is a one-off action (`scratchApiClient.devTools.triggerCronJob`) and is not cached here.
 */
export const useCronDevTools = (): UseCronDevToolsReturn => {
  const { data, error, isLoading, mutate } = useSWR<ListCronJobsResponseDto, Error>(
    SWR_KEYS.cron.jobs(),
    () => scratchApiClient.devTools.listCronJobs(),
    { revalidateOnFocus: false },
  );

  return {
    jobs: data?.jobs ?? [],
    isLoading,
    error,
    refresh: mutate,
  };
};
