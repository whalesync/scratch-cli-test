import { desktopReleaseApi } from '@/lib/api/desktop-release';
import { SWR_KEYS } from '@/lib/api/keys';
import { DesktopReleaseResponse } from '@spinner/shared-types';
import { useCallback } from 'react';
import useSWR from 'swr';

export interface UseCliReleaseReturn {
  release: DesktopReleaseResponse | undefined;
  isLoading: boolean;
  error: Error | undefined;
  refresh: () => Promise<void>;
}

/**
 * Hook for fetching the latest Scratch CLI (`scratchmd`) release for the current environment.
 * Uses SWR for caching — the upstream Scratch API additionally caches results in Redis.
 */
export const useCliRelease = (): UseCliReleaseReturn => {
  const { data, error, isLoading, mutate } = useSWR<DesktopReleaseResponse, Error>(
    SWR_KEYS.cliRelease.latest(),
    () => desktopReleaseApi.getLatestCli(),
    {
      revalidateOnFocus: false,
    },
  );

  const refresh = useCallback(async () => {
    await mutate();
  }, [mutate]);

  return {
    release: data,
    isLoading,
    error,
    refresh,
  };
};
