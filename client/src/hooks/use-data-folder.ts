import { dataFolderApi } from '@/lib/api/data-folder';
import { SWR_KEYS } from '@/lib/api/keys';
import { DataFolder, DataFolderId } from '@spinner/shared-types';
import { useCallback } from 'react';
import useSWR from 'swr';

export interface UseDataFolderReturn {
  dataFolder: DataFolder | undefined;
  isLoading: boolean;
  error: Error | undefined;
  refresh: () => Promise<void>;
  updateFilter: (filter: string | null) => Promise<void>;
}

/**
 * Hook for fetching a single data folder by ID.
 * Uses SWR for caching and automatic revalidation.
 */
export const useDataFolder = (dataFolderId: DataFolderId | null): UseDataFolderReturn => {
  const { data, error, isLoading, mutate } = useSWR<DataFolder, Error>(
    dataFolderId ? SWR_KEYS.dataFolders.detail(dataFolderId) : null,
    () => {
      if (!dataFolderId) {
        throw new Error('dataFolderId is required');
      }
      return dataFolderApi.findOne(dataFolderId);
    },
    {
      revalidateOnFocus: false,
    },
  );

  const refresh = useCallback(async () => {
    await mutate();
  }, [mutate]);

  const updateFilter = useCallback(
    async (filter: string | null) => {
      if (!dataFolderId) {
        return;
      }

      if (filter && filter.trim() === '') {
        throw new Error('Filter cannot be empty');
      }

      await dataFolderApi.update(dataFolderId, { filter });
      await mutate();
    },
    [dataFolderId, mutate],
  );

  return {
    dataFolder: data,
    isLoading,
    error,
    refresh,
    updateFilter,
  };
};
