import { scratchApiClient } from '@/lib/scratch-api-client';
import { DataFolderGroup } from '@spinner/shared-types';
import { useCallback } from 'react';
import useSWR from 'swr';

const SWR_KEY_PREFIX = 'data-folders';

export function useDataFolders(workbookId: string | undefined) {
  const { data, error, isLoading, mutate } = useSWR<DataFolderGroup[], Error>(
    workbookId ? [SWR_KEY_PREFIX, workbookId] : null,
    () => {
      if (!workbookId) throw new Error('workbookId is required');
      return scratchApiClient.dataFolders.list(workbookId);
    },
    { revalidateOnFocus: false },
  );

  const refresh = useCallback(async () => {
    await mutate();
  }, [mutate]);

  return {
    dataFolderGroups: data ?? [],
    isLoading,
    error,
    refresh,
  };
}
