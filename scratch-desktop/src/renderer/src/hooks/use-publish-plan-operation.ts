import type { PublishPlanOperationEntity } from '@spinner/shared-types';
import useSWR from 'swr';
import { scratchApiClient } from '../lib/scratch-api-client';

/**
 * Fetches the single operation that matches `(planId, filePath, phase)`. The
 * server endpoint returns a page of operations; we filter to one with
 * `pageSize: 1` and pull `.data[0]`. Each record has at most one operation
 * per phase, so this is well-defined.
 */
export function usePublishPlanOperation(
  workbookId: string | undefined,
  planId: string | undefined,
  filePath: string | undefined,
  phase: string | undefined,
) {
  const canFetch = !!workbookId && !!planId && !!filePath && !!phase;
  const { data, error, isLoading } = useSWR<
    { data: PublishPlanOperationEntity[]; total: number; page: number; pageSize: number },
    Error
  >(canFetch ? ['publish-plan-operation', workbookId, planId, filePath, phase] : null, () => {
    if (!workbookId || !planId) {
      throw new Error('workbookId and planId are required');
    }
    return scratchApiClient.publish.listPublishPlanOperations(workbookId, planId, { filePath, phase, pageSize: 1 });
  });

  return { operation: data?.data?.[0] ?? null, error, isLoading };
}
