import { SWR_KEYS } from '@/lib/api/keys';
import { workbookApi } from '@/lib/api/workbook';
import { DirtyFile, WorkbookId } from '@spinner/shared-types';
import useSWR from 'swr';

export interface UseDirtyFilesReturn {
  dirtyFiles: DirtyFile[];
  isLoading: boolean;
  error: Error | undefined;
  refresh: () => void;
}

export const useDirtyFiles = (workbookId: WorkbookId | null): UseDirtyFilesReturn => {
  const { data, error, isLoading, mutate } = useSWR<DirtyFile[], Error>(
    workbookId ? SWR_KEYS.dirtyFiles.list(workbookId) : null,
    () => workbookApi.getStatus(workbookId!),
    {
      revalidateOnFocus: false,
    },
  );

  return {
    dirtyFiles: data ?? [],
    isLoading,
    error,
    refresh: () => mutate(),
  };
};
