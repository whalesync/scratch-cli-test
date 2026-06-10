import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { ApiQuotaResponse } from '@spinner/shared-types';
import { useCallback } from 'react';
import useSWR from 'swr';

export interface UseConnectionQuotaReturn {
  data: ApiQuotaResponse | undefined;
  isLoading: boolean;
  error: Error | undefined;
  refresh: () => Promise<void>;
}

/**
 * Fetch the API quota / rate-limit state for a connection. Pass `enabled=false`
 * to keep the request idle — the dialog uses this to fetch only when opened.
 *
 * Quota numbers are time-sensitive (per-minute and monthly buckets), so we
 * disable focus/reconnect revalidation. The user can hit "Refresh" in the
 * dialog if they want a newer snapshot.
 */
export const useConnectionQuota = (
  workbookId: string | null | undefined,
  connectionId: string | null | undefined,
  enabled: boolean,
): UseConnectionQuotaReturn => {
  const { data, error, isLoading, mutate } = useSWR<ApiQuotaResponse, Error>(
    enabled && workbookId && connectionId ? SWR_KEYS.connectorAccounts.quota(workbookId, connectionId) : null,
    () => {
      if (!workbookId || !connectionId) {
        throw new Error('workbookId and connectionId are required');
      }
      return scratchApiClient.connectorAccounts.getQuota(workbookId, connectionId);
    },
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    },
  );

  const refresh = useCallback(async () => {
    await mutate();
  }, [mutate]);

  return { data, isLoading, error, refresh };
};
