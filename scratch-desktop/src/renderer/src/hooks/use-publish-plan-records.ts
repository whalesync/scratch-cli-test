import type { PublishPlanRecordsResponse } from '@spinner/shared-types';
import useSWR from 'swr';
import { publishApi } from '../lib/publish-api';

/**
 * Returns the records page for a publish plan, paginated server-side, filtered
 * by folder and/or phase. Includes the aggregate filter options the records
 * UI uses to populate its dropdowns.
 */
export function usePublishPlanRecords(
  workbookId: string | undefined,
  planId: string | undefined,
  options: { page: number; pageSize?: number; dataFolderId?: string; phase?: string },
) {
  const { data, error, isLoading, mutate } = useSWR<PublishPlanRecordsResponse, Error>(
    workbookId && planId
      ? ['publish-plan-records', workbookId, planId, options.page, options.dataFolderId ?? '', options.phase ?? '']
      : null,
    () =>
      publishApi.listPublishPlanRecords(workbookId!, planId!, {
        page: options.page,
        pageSize: options.pageSize,
        dataFolderId: options.dataFolderId,
        phase: options.phase,
      }),
  );

  return { records: data, error, isLoading, refresh: mutate };
}
