import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { Job } from '@spinner/shared-types';
import { useCallback } from 'react';
import useSWR from 'swr';

export const useJobs = (
  limit?: number,
  offset?: number,
  workbookId?: string,
  filter?: { type?: string; syncId?: string; dataFolderId?: string },
) => {
  const { data, error, isLoading, mutate } = useSWR<Job[], Error>(
    `jobs-${limit}-${offset}-${workbookId || 'all'}-${filter?.type || 'all'}-${filter?.syncId || 'all'}-${filter?.dataFolderId || 'all'}`,
    () => scratchApiClient.job.getJobs(limit, offset, workbookId, filter),
    {
      refreshInterval: 5000, // Poll every 5 seconds
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    },
  );

  const cancelJob = useCallback(
    async (jobId: string) => {
      await scratchApiClient.job.cancelJob(jobId);
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
