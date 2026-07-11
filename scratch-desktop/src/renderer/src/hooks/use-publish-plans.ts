import type { PublishPlanListResponse } from '@spinner/shared-types';
import useSWR from 'swr';
import { scratchApiClient } from '../lib/scratch-api-client';

/**
 * Polls one page of the publish plans list for a workbook every 2 seconds while
 * the caller is mounted. Matches the web Publish History list polling cadence so
 * in-flight plans surface progress without a manual refresh.
 *
 * Pagination + connection filter are resolved server-side. `PublishHistoryPanel`
 * and `PublishPlansList` both call this hook and MUST pass identical `page` +
 * `connectorAccountId` so they share one SWR key — that's what lets the panel's
 * Refresh button re-fetch exactly the page the list is showing. `pageSize` is
 * defaulted server-side (not passed here) to keep those keys aligned.
 */
export function usePublishPlans(
  workbookId: string | undefined,
  options?: { page?: number; connectorAccountId?: string; refreshInterval?: number },
) {
  const page = options?.page ?? 1;
  const connectorAccountId = options?.connectorAccountId;
  const { data, error, isLoading, mutate } = useSWR<PublishPlanListResponse, Error>(
    workbookId ? ['publish-plans', workbookId, page, connectorAccountId ?? ''] : null,
    () => {
      if (!workbookId) throw new Error('workbookId is required');
      return scratchApiClient.publish.listPublishPlans(workbookId, { page, connectorAccountId });
    },
    {
      refreshInterval: options?.refreshInterval ?? 2000,
      // Keep the previous page visible during refetch so paging/filtering
      // doesn't flash an empty table (mirrors use-publish-plan-records).
      keepPreviousData: true,
    },
  );

  return {
    publishPlans: data?.data ?? [],
    total: data?.total ?? 0,
    // Fallback only until the first response (the server owns the real default).
    pageSize: data?.pageSize ?? 20,
    error,
    isLoading,
    refresh: mutate,
  };
}
