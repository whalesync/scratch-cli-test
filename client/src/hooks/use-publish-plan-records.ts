import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { PublishPlanRecordsResponse, WorkbookId } from '@spinner/shared-types';
import useSWR from 'swr';

export function usePublishPlanRecords(
  workbookId: WorkbookId | undefined,
  planId: string | undefined,
  options: { page: number; pageSize?: number; dataFolderId?: string; phase?: string },
) {
  const { data, error, isLoading, mutate } = useSWR<PublishPlanRecordsResponse, Error>(
    workbookId && planId
      ? SWR_KEYS.publishPlans.records(workbookId, planId, options.page, options.dataFolderId, options.phase)
      : null,
    () => {
      if (!workbookId || !planId) {
        throw new Error('workbookId and planId are required');
      }
      return scratchApiClient.publish.listPublishPlanRecords(workbookId, planId, {
        page: options.page,
        pageSize: options.pageSize,
        dataFolderId: options.dataFolderId,
        phase: options.phase,
      });
    },
  );

  return { records: data, error, isLoading, refresh: mutate };
}
