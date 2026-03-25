import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { useCallback } from 'react';
import useSWR from 'swr';
import { jobApi } from '../lib/api/job';
import { JobEntity } from '../types/server-entities/job';

export const useJobs = (
  limit?: number,
  offset?: number,
  workbookId?: string,
  filter?: { type?: string; syncId?: string; dataFolderId?: string },
) => {
  const { data, error, isLoading, mutate } = useSWR<JobEntity[], Error>(
    `jobs-${limit}-${offset}-${workbookId || 'all'}-${filter?.type || 'all'}-${filter?.syncId || 'all'}-${filter?.dataFolderId || 'all'}`,
    () => jobApi.getJobs(limit, offset, workbookId, filter),
    {
      refreshInterval: 5000, // Poll every 5 seconds
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    },
  );

  const cancelJob = useCallback(
    async (jobId: string) => {
      await jobApi.cancelJob(jobId);
      await mutate();
      ScratchpadNotifications.success({ message: 'Cancel request sent' });
    },
    [mutate],
  );

  return {
    jobs: data || [],
    error,
    isLoading,
    mutate,
    cancelJob,
  };
};
