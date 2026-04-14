import { desktopReleaseApi } from '@/lib/api/desktop-release';
import { SWR_KEYS } from '@/lib/api/keys';
import { DesktopReleaseResponse } from '@spinner/shared-types';
import { useCallback } from 'react';
import useSWR from 'swr';

export interface UseDesktopReleaseReturn {
  release: DesktopReleaseResponse | undefined;
  isLoading: boolean;
  error: Error | undefined;
  refresh: () => Promise<void>;
}

/**
 * Hook for fetching the latest Scratch Desktop release matching the current environment.
 * Uses SWR for caching — the upstream Scratch API additionally caches results in Redis.
 */
export const useDesktopRelease = (): UseDesktopReleaseReturn => {
  const { data, error, isLoading, mutate } = useSWR<DesktopReleaseResponse, Error>(
    SWR_KEYS.desktopRelease.latest(),
    () => desktopReleaseApi.getLatest(),
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
