import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { GetAllJobsResponseDto } from '@spinner/shared-types';
import useSWR from 'swr';

const DEFAULT_REFRESH_INTERVAL = 5000;

/**
 * @returns A hook with dev tools for viewing jobs across all users and workbooks
 */
export const useJobsDevTools = (params?: {
  limit?: number;
  offset?: number;
  statuses?: string[];
  userId?: string;
  autoRefresh?: boolean;
}) => {
  const { data, error, isLoading, mutate } = useSWR<GetAllJobsResponseDto, Error>(
    SWR_KEYS.jobs.allJobs(params?.limit, params?.offset, params?.statuses, params?.userId),
    () => scratchApiClient.devTools.getAllJobs(params),
    {
      refreshInterval: params?.autoRefresh ? DEFAULT_REFRESH_INTERVAL : 0,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    },
  );

  return {
    jobs: data?.jobs ?? [],
    total: data?.total ?? 0,
    limit: data?.limit ?? 50,
    offset: data?.offset ?? 0,
    isLoading,
    error,
    mutate,
  };
};
