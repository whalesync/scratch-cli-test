import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { CronJobSummaryDto, ListCronJobsResponseDto } from '@spinner/shared-types';
import useSWR from 'swr';

interface UseCronDevToolsReturn {
  jobs: CronJobSummaryDto[];
  /** Whether this environment permits manually triggering a job (false in deployed environments). */
  canTrigger: boolean;
  /** GCP Cloud Logging deep link for the cron service, or null in local dev (deployed environments only). */
  cronServiceLogsUrl: string | null;
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
    canTrigger: data?.canTrigger ?? false,
    cronServiceLogsUrl: data?.cronServiceLogsUrl ?? null,
    isLoading,
    error,
    refresh: mutate,
  };
};
