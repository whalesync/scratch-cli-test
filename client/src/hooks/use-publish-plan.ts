import { SWR_KEYS } from '@/lib/api/keys';
import { workbookApi } from '@/lib/api/workbook';
import { PublishPlanEntity, WorkbookId } from '@spinner/shared-types';
import useSWR from 'swr';

export function usePublishPlan(workbookId: WorkbookId | undefined, planId: string | undefined) {
  const { data, error, isLoading, mutate } = useSWR<PublishPlanEntity | null, Error>(
    workbookId && planId ? SWR_KEYS.publishPlans.detail(workbookId, planId) : null,
    () => {
      if (!workbookId || !planId) {
        throw new Error('workbookId and planId are required');
      }
      return workbookApi.getPublishPlan(workbookId, planId);
    },
  );

  return { publishPlan: data ?? null, error, isLoading, refresh: mutate };
}
