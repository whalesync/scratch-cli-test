import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { PublishPlanOperationEntity, WorkbookId } from '@spinner/shared-types';
import useSWR from 'swr';

/**
 * Fetches the single operation that matches `(planId, filePath, phase)`.
 * Each record has at most one operation per phase, so the array returned by the
 * server endpoint will contain zero or one entry.
 */
export function usePublishPlanOperation(
  workbookId: WorkbookId | undefined,
  planId: string | undefined,
  filePath: string | undefined,
  phase: string | undefined,
) {
  const { data, error, isLoading } = useSWR<
    { data: PublishPlanOperationEntity[]; total: number; page: number; pageSize: number },
    Error
  >(
    workbookId && planId && filePath && phase
      ? SWR_KEYS.publishPlans.operation(workbookId, planId, filePath, phase)
      : null,
    () => {
      if (!workbookId || !planId || !filePath || !phase) {
        throw new Error('workbookId, planId, filePath, and phase are required');
      }
      return scratchApiClient.publish.listPublishPlanOperations(workbookId, planId, { filePath, phase, pageSize: 1 });
    },
  );

  return { operation: data?.data?.[0] ?? null, error, isLoading };
}
