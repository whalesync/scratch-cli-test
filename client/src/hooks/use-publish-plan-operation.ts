import { SWR_KEYS } from '@/lib/api/keys';
import { workbookApi } from '@/lib/api/workbook';
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
  const enabled = !!workbookId && !!planId && !!filePath && !!phase;
  const { data, error, isLoading } = useSWR<
    { data: PublishPlanOperationEntity[]; total: number; page: number; pageSize: number },
    Error
  >(enabled ? SWR_KEYS.publishPlans.operation(workbookId!, planId!, filePath!, phase!) : null, () =>
    workbookApi.listPublishPlanOperations(workbookId!, planId!, { filePath, phase, pageSize: 1 }),
  );

  return { operation: data?.data?.[0] ?? null, error, isLoading };
}
