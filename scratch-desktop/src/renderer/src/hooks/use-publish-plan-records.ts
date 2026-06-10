import type { PublishPlanRecordsResponse } from '@spinner/shared-types';
import useSWR from 'swr';
import { scratchApiClient } from '../lib/scratch-api-client';

/**
 * Returns the records page for a publish plan, paginated server-side, filtered
 * by folder, phase, and/or filename substring. Includes the aggregate filter
 * options the records UI uses to populate its dropdowns.
 */
export function usePublishPlanRecords(
  workbookId: string | undefined,
  planId: string | undefined,
  options: { page: number; pageSize?: number; dataFolderId?: string; phase?: string; filename?: string },
) {
  const { data, error, isLoading, isValidating, mutate } = useSWR<PublishPlanRecordsResponse, Error>(
    workbookId && planId
      ? [
          'publish-plan-records',
          workbookId,
          planId,
          options.page,
          options.dataFolderId ?? '',
          options.phase ?? '',
          options.filename ?? '',
        ]
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
        filename: options.filename,
      });
    },
    {
      // Keep the previous page's response visible during refetch so the
      // left-panel summary (Affected Records, Total Operations, the
      // breakdowns) doesn't flash to zero on every page/filter change.
      keepPreviousData: true,
    },
  );

  return { records: data, error, isLoading, isValidating, refresh: mutate };
}
