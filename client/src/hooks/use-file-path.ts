import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { FileDetailsResponseDto, UpdateFileDto, WorkbookId } from '@spinner/shared-types';
import { isUnauthorizedError } from '@spinner/shared-types/api-client';
import { useCallback, useMemo } from 'react';
import useSWR, { useSWRConfig } from 'swr';

export interface UseFileReturn {
  file: FileDetailsResponseDto | undefined;
  isLoading: boolean;
  error: string | undefined;
  updateFile: (dto: UpdateFileDto) => Promise<void>;
  deleteFile: () => Promise<void>;
  refreshFile: () => Promise<void>;
}

/**
 * Hook for managing individual file operations using a file path
 * @param workbookId - The workbook ID to scope the file operations to
 * @param path - The full path to the file
 */
export const useFileByPath = (workbookId: WorkbookId | null, path: string | null): UseFileReturn => {
  const { mutate: globalMutate } = useSWRConfig();

  const { data, error, isLoading, mutate } = useSWR<FileDetailsResponseDto, Error>(
    workbookId && path ? SWR_KEYS.files.detail(workbookId, path) : null,
    () => {
      if (!workbookId || !path) {
        throw new Error('workbookId and path are required');
      }
      return scratchApiClient.files.getFileByPath(workbookId, path);
    },
    {
      revalidateOnFocus: false,
      keepPreviousData: true,
    },
  );

  const refreshFile = useCallback(async () => {
    await mutate();
  }, [mutate]);

  const updateFile = useCallback(
    async (dto: UpdateFileDto): Promise<void> => {
      if (!workbookId || !path) {
        throw new Error('Workbook ID and file ID are required');
      }

      await scratchApiClient.files.updateFileByPath(workbookId, path, dto);

      // Revalidate this file
      await mutate();

      // Revalidate all file lists for this workbook to update the tree
      globalMutate(SWR_KEYS.files.listKeyMatcher(workbookId), undefined, { revalidate: true });
    },
    [workbookId, path, mutate, globalMutate],
  );

  const deleteFile = useCallback(async (): Promise<void> => {
    if (!workbookId || !path) {
      throw new Error('Workbook ID and file ID are required');
    }

    await scratchApiClient.files.deleteFileByPath(workbookId, path);

    // Clear this file from cache
    globalMutate(SWR_KEYS.files.detail(workbookId, path), undefined, { revalidate: false });

    // Revalidate all file lists for this workbook to update the tree
    globalMutate(SWR_KEYS.files.listKeyMatcher(workbookId), undefined, { revalidate: true });
  }, [workbookId, path, globalMutate]);

  const displayError = useMemo(() => {
    if (isUnauthorizedError(error)) {
      // ignore this error as it will be fixed after the token is refreshed
      return undefined;
    }
    return error?.message;
  }, [error]);

  return {
    file: data,
    isLoading,
    error: displayError,
    updateFile,
    deleteFile,
    refreshFile,
  };
};
