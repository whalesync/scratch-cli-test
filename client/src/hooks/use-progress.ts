import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { Job } from '@spinner/shared-types';
import { useState } from 'react';
import useSWR from 'swr';

type JobResult<TPublicProgress extends object = object> = {
  job?: Job<TPublicProgress>;
  error?: Error;
  isLoading: boolean;
  mutate: () => unknown;
};

export const useJob = <TPublicProgress extends object>(
  jobId: string | null,
  continuePolling = false,
): JobResult<TPublicProgress> => {
  const { data, error, isLoading, mutate } = useSWR<Job<TPublicProgress>, Error>(
    jobId ? `progress-${jobId}` : null,
    () => {
      if (!jobId) {
        throw new Error('jobId is required');
      }
      return scratchApiClient.progress.getJobProgress<TPublicProgress>(jobId);
    },
    {
      refreshInterval: continuePolling ? 1000 : 0, // Poll every second if continuePolling is true
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 0, // Always fetch fresh data, don't dedupe requests
    },
  );

  return {
    job: data,
    error,
    isLoading,
    mutate,
  };
};

export type JobWithCancellationResult<TPublicProgress extends object> = {
  jobResult: JobResult<TPublicProgress>;
  cancellationRequested: boolean;
  isCancelling: boolean;
  cancelJob: () => void;
};
export const useJobWithCancellation = <TPublicProgress extends object>(
  jobId: string | null,
): JobWithCancellationResult<TPublicProgress> => {
  const [cancellationRequested, setCancellationRequested] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  // Always poll initially - we'll control stopping based on state
  const jobResult = useJob<TPublicProgress>(jobId, true);
  const { job, error, isLoading, mutate } = jobResult;

  const cancelJob = async () => {
    if (isCancelling || cancellationRequested || !jobId) return;

    setIsCancelling(true);
    try {
      const result = await scratchApiClient.progress.cancelJob(jobId);
      if (result.success) {
        setCancellationRequested(true);
        // Continue polling to see when the job actually stops
        mutate();
      }
    } catch (error) {
      console.error('Failed to cancel job:', error);
    } finally {
      setIsCancelling(false);
    }
  };

  return {
    jobResult: {
      job,
      error,
      isLoading,
      mutate,
    },
    cancellationRequested,
    isCancelling,
    cancelJob,
  };
};
