import { SWR_KEYS } from '@/lib/api/keys';
import { workbookApi } from '@/lib/api/workbook';
import { DataFolder, DataFolderGroup, DataFolderId, WorkbookId } from '@spinner/shared-types';
import { useCallback, useMemo } from 'react';
import useSWR from 'swr';
import { dataFolderApi } from '../lib/api/data-folder';
import { useActiveWorkbook } from './use-active-workbook';

export interface UseDataFoldersReturn {
  dataFolderGroups: DataFolderGroup[];
  folders: DataFolder[];
  isLoading: boolean;
  error: Error | undefined;
  refresh: () => Promise<void>;
  deleteFolder: (dataFolderId: DataFolderId) => Promise<void>;
}

/**
 * Hook for fetching data folders for the active workbook.
 * Uses SWR for caching and automatic revalidation.
 *
 * @param overrideWorkbookId - Optional workbook ID to use instead of the active workbook from the store
 */
export const useDataFolders = (overrideWorkbookId?: WorkbookId): UseDataFoldersReturn => {
  const { workbook } = useActiveWorkbook();
  const workbookId = overrideWorkbookId ?? workbook?.id ?? null;

  const { data, error, isLoading, mutate } = useSWR<DataFolderGroup[], Error>(
    workbookId ? SWR_KEYS.dataFolders.list(workbookId) : null,
    () => {
      if (!workbookId) {
        throw new Error('workbookId is required');
      }
      return workbookApi.listDataFolders(workbookId);
    },
    {
      revalidateOnFocus: false,
    },
  );

  const refresh = useCallback(async () => {
    await mutate();
  }, [mutate]);

  const deleteFolder = useCallback(
    async (dataFolderId: DataFolderId) => {
      if (!workbookId) return;
      await dataFolderApi.delete(dataFolderId);
      await mutate();
    },
    [workbookId, mutate],
  );

  // Generate a flat list of folders from the group
  const folders = useMemo(() => {
    const temp: DataFolder[] = [];

    if (data) {
      data?.forEach((grp) => {
        temp.push(...grp.dataFolders);
      });
    }
    return temp;
  }, [data]);

  return {
    dataFolderGroups: data ?? [],
    folders,
    isLoading,
    error,
    refresh,
    deleteFolder,
  };
};
