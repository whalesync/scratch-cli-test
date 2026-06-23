import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { PendingOAuthInstallInfo } from '@spinner/shared-types';
import useSWR from 'swr';

export interface UsePendingOAuthInstallReturn {
  pendingInstall: PendingOAuthInstallInfo | undefined;
  isLoading: boolean;
  error: Error | undefined;
}

/**
 * Fetches the public metadata for a marketplace-initiated ("inbound") OAuth install that is awaiting
 * claim, by its single-use `installId`. Connector-agnostic — powers the generic `/connect/[service]`
 * claim page. Returns no data (and no request is made) when `installId` is null.
 *
 * Does not retry on error: an invalid/expired/already-claimed install is a terminal state the page
 * surfaces directly, not a transient failure worth re-fetching.
 */
export const usePendingOAuthInstall = (installId: string | null): UsePendingOAuthInstallReturn => {
  const { data, error, isLoading } = useSWR<PendingOAuthInstallInfo, Error>(
    installId ? SWR_KEYS.oauthInstall.pending(installId) : null,
    () => {
      if (!installId) {
        throw new Error('installId is required');
      }
      return scratchApiClient.oauth.getPendingInstall(installId);
    },
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  );

  return { pendingInstall: data, isLoading, error };
};
