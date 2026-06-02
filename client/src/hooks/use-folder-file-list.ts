import { isUnauthorizedError } from '@/lib/api/error';
import { filesApi } from '@/lib/api/files';
import { SWR_KEYS } from '@/lib/api/keys';
import { DataFolderId, FileOrFolderRefEntity, ListFilesResponseDto, WorkbookId } from '@spinner/shared-types';
import { useMemo } from 'react';
import useSWR from 'swr';

export interface UseFolderFileListReturn {
  files: FileOrFolderRefEntity[];
  isLoading: boolean;
  error: string | undefined;
  dirtyCount: number;
  refreshFiles: () => Promise<void>;
}

/**
 * Hook for getting all the file contents for a folder (non-paginated).
 * Use useFolderFileListPaginated for large folders.
 */
export const useFolderFileList = (
  workbookId: WorkbookId | null,
  folderId: DataFolderId | null,
): UseFolderFileListReturn => {
  const { data, error, isLoading, mutate } = useSWR<ListFilesResponseDto, Error>(
    workbookId && folderId ? SWR_KEYS.files.listByFolder(workbookId, folderId) : null,
    () => {
      if (!workbookId || !folderId) {
        throw new Error('workbookId and folderId are required');
      }
      return filesApi.listFilesByFolder(workbookId, folderId);
    },
    {
      revalidateOnFocus: false,
    },
  );

  const displayError = useMemo(() => {
    if (isUnauthorizedError(error)) {
      // ignore this error as it will be fixed after the token is refreshed
      return undefined;
    }
    return error?.message;
  }, [error]);

  return {
    files: data?.items ?? [],
    isLoading,
    error: displayError,
    dirtyCount: data?.dirtyCount ?? 0,
    refreshFiles: async () => {
      await mutate();
    },
  };
};
