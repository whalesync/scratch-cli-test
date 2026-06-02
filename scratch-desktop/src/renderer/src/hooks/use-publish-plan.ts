import type { PublishPlanEntity } from '@spinner/shared-types';
import useSWR from 'swr';
import { publishApi } from '../lib/publish-api';

/**
 * Fetches a single publish plan with its author + connector account relations.
 * Returns null when the plan is missing or hasn't loaded yet.
 */
export function usePublishPlan(workbookId: string | undefined, planId: string | undefined) {
  const { data, error, isLoading, mutate } = useSWR<PublishPlanEntity | null, Error>(
    workbookId && planId ? ['publish-plan', workbookId, planId] : null,
    () => {
      if (!workbookId || !planId) {
        throw new Error('workbookId and planId are required');
      }
      return publishApi.getPublishPlan(workbookId, planId);
    },
  );

  return { publishPlan: data ?? null, error, isLoading, refresh: mutate };
}
