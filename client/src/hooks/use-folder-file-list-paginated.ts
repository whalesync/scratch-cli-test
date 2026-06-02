import { isUnauthorizedError } from '@/lib/api/error';
import { filesApi } from '@/lib/api/files';
import { SWR_KEYS } from '@/lib/api/keys';
import { DataFolderId, FileOrFolderRefEntity, ListFilesResponseDto, WorkbookId } from '@spinner/shared-types';
import { useCallback, useMemo } from 'react';
import useSWRInfinite from 'swr/infinite';

const DEFAULT_PAGE_SIZE = 200;

export interface UseFolderFileListPaginatedReturn {
  files: FileOrFolderRefEntity[];
  isLoading: boolean;
  isLoadingMore: boolean;
  error: Error | undefined;
  hasMore: boolean;
  loadMore: () => void;
  dirtyCount: number;
  refreshFiles: () => Promise<void>;
}

export const useFolderFileListPaginated = (
  workbookId: WorkbookId | null,
  folderId: DataFolderId | null,
  pageSize: number = DEFAULT_PAGE_SIZE,
): UseFolderFileListPaginatedReturn => {
  const getKey = useCallback(
    (pageIndex: number, previousPageData: ListFilesResponseDto | null) => {
      if (!workbookId || !folderId) return null;
      if (pageIndex > 0 && previousPageData && !previousPageData.nextCursor) return null;

      const cursor = previousPageData?.nextCursor;
      return [...SWR_KEYS.files.listByFolder(workbookId, folderId), cursor ?? ''] as const;
    },
    [workbookId, folderId],
  );

  const fetcher = useCallback(
    (key: readonly string[]) => {
      if (!workbookId || !folderId) {
        throw new Error('workbookId and folderId are required');
      }
      const cursor = key[key.length - 1] || undefined;
      return filesApi.listFilesByFolder(workbookId, folderId, { cursor, limit: pageSize });
    },
    [workbookId, folderId, pageSize],
  );

  const { data, error, isLoading, size, setSize, mutate } = useSWRInfinite<ListFilesResponseDto, Error>(
    getKey,
    fetcher,
    {
      revalidateOnFocus: false,
      revalidateFirstPage: false,
    },
  );

  const files = useMemo(() => {
    if (!data) return [];
    return data.flatMap((page) => page.items);
  }, [data]);

  const dirtyCount = data?.[0]?.dirtyCount ?? 0;
  const hasMore = data ? !!data[data.length - 1]?.nextCursor : false;
  const isLoadingMore = size > 0 && data && typeof data[size - 1] === 'undefined';

  const displayError = useMemo(() => {
    if (isUnauthorizedError(error)) {
      return undefined;
    }
    return error;
  }, [error]);

  return {
    files,
    isLoading,
    isLoadingMore: isLoading || !!isLoadingMore,
    error: displayError,
    hasMore,
    loadMore: () => setSize(size + 1),
    dirtyCount,
    refreshFiles: async () => {
      await mutate();
    },
  };
};
