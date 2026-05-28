import type { PublishPlanEntity } from '@spinner/shared-types';
import useSWR from 'swr';
import { publishApi } from '../lib/publish-api';

/**
 * Polls the publish plans list for a workbook every 2 seconds while the
 * caller is mounted. Matches the web Publish History list polling cadence
 * so in-flight plans surface progress without a manual refresh.
 */
export function usePublishPlans(workbookId: string | undefined, options?: { refreshInterval?: number }) {
  const { data, error, isLoading, mutate } = useSWR<PublishPlanEntity[], Error>(
    workbookId ? ['publish-plans', workbookId] : null,
    () => publishApi.listPublishPlans(workbookId!),
    { refreshInterval: options?.refreshInterval ?? 2000 },
  );

  return { publishPlans: data ?? [], error, isLoading, refresh: mutate };
}
