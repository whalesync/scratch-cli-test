import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { isUnauthorizedError } from '@/lib/api/error';
import { SWR_KEYS } from '@/lib/api/keys';
import { workbookApi } from '@/lib/api/workbook';
import { trackDiscardChanges, trackPullFiles } from '@/lib/posthog';
import { useActiveJobsStore } from '@/stores/active-jobs-store';
import { useWorkbookUIStore } from '@/stores/workbook-ui-store';
import {
  CreateDataFolderDto,
  DataFolder,
  DataFolderId,
  UpdateWorkbookDto,
  Workbook,
  WorkbookId,
} from '@spinner/shared-types';
import { useCallback, useMemo } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { dataFolderApi } from '../lib/api/data-folder';

export interface UseWorkbookReturn {
  workbook: Workbook | undefined;
  isLoading: boolean;
  error: string | undefined;
  refreshWorkbook: () => Promise<void>;
  updateWorkbook: (updateDto: UpdateWorkbookDto) => Promise<void>;
  addLinkedDataFolder: (
    tableId: string[],
    folderName: string,
    connectorAccountId: string,
    filter?: string,
    idFieldOverride?: string,
    nameFieldOverride?: string,
    options?: Record<string, unknown>,
    triggerPull?: boolean,
  ) => Promise<DataFolder>;
  pullFolders: (dataFolderIds?: DataFolderId[]) => Promise<void>;
  pullAssets: (dataFolderIds: DataFolderId[], options?: { rehost?: boolean }) => Promise<void>;
  discardAllChanges: () => Promise<void>;
}

export const useWorkbook = (id: WorkbookId | null): UseWorkbookReturn => {
  const setWorkbookError = useWorkbookUIStore((state) => state.setWorkbookError);
  const { data, error, isLoading, mutate } = useSWR<Workbook, Error>(
    id ? SWR_KEYS.workbook.detail(id) : null,
    () => workbookApi.detail(id!),
    {
      revalidateOnFocus: false,
    },
  );

  const { mutate: globalMutate } = useSWRConfig();

  const refreshWorkbook = useCallback(async () => {
    await mutate();
  }, [mutate]);

  const displayError = useMemo(() => {
    if (isUnauthorizedError(error)) {
      // ignore this error as it will be fixed after the token is refreshed
      return undefined;
    }
    return error?.message;
  }, [error]);

  const updateWorkbook = useCallback(
    async (updateDto: UpdateWorkbookDto): Promise<void> => {
      if (!id) {
        return;
      }
      await workbookApi.update(id, updateDto);
      globalMutate(SWR_KEYS.workbook.list());
      globalMutate(SWR_KEYS.workbook.detail(id));
    },
    [globalMutate, id],
  );

  const addLinkedDataFolder = useCallback(
    async (
      tableId: string[],
      folderName: string,
      connectorAccountId: string,
      filter?: string,
      idFieldOverride?: string,
      nameFieldOverride?: string,
      options?: Record<string, unknown>,
      triggerPull?: boolean,
    ): Promise<DataFolder> => {
      if (!id) {
        throw new Error('Workspace not found');
      }

      const dto: CreateDataFolderDto = {
        tableId,
        workbookId: id,
        name: folderName,
        connectorAccountId,
        filter,
        idFieldOverride,
        nameFieldOverride,
        options,
        triggerPull,
      };
      const dataFolder = await dataFolderApi.create(dto);
      return dataFolder;
    },
    [id],
  );

  const discardAllChanges = useCallback(async (): Promise<void> => {
    if (!id) {
      return;
    }
    trackDiscardChanges(id);
    try {
      await workbookApi.discardChanges(id);
      // TODO: this notification is just overkill for now, we shouldn't need it at all once the UI is more reactive
      ScratchpadNotifications.info({ message: 'All unpublished changes have been discarded' });
    } catch (error) {
      console.error('Failed to discard changes:', error);
      setWorkbookError({
        scope: 'files',
        description: 'Failed to discard all unpublished changes',
        cause: error as Error,
      });
      throw error;
    }
    await mutate();
    await globalMutate(SWR_KEYS.dataFolders.list(id));
    data?.dataFolders?.forEach((folder) => {
      globalMutate(SWR_KEYS.dataFolders.detail(folder.id));
    });
  }, [globalMutate, id, mutate, data, setWorkbookError]);

  const pullAssets = useCallback(
    async (dataFolderIds: DataFolderId[], options?: { rehost?: boolean }): Promise<void> => {
      if (!id) {
        return;
      }
      try {
        const result = await workbookApi.pullAssets(id, dataFolderIds, options);
        if (result.jobIds?.length) {
          useActiveJobsStore.getState().trackJobIds(result.jobIds);
        }
      } catch (error) {
        console.error('Failed to pull assets:', error);
        setWorkbookError({
          scope: 'files',
          description: 'Failed to start the asset pull job',
          cause: error as Error,
        });
      }
      await mutate();
      await useActiveJobsStore.getState().refreshJobs();
    },
    [id, mutate, setWorkbookError],
  );

  const pullFolders = useCallback(
    async (folderIds?: DataFolderId[]): Promise<void> => {
      if (!id) {
        return;
      }
      trackPullFiles(id);
      try {
        const result = await workbookApi.pullFiles(id, folderIds);
        if (result.jobIds?.length) {
          useActiveJobsStore.getState().trackJobIds(result.jobIds);
        }
      } catch (error) {
        console.error('Failed to pull files:', error);
        setWorkbookError({
          scope: 'files',
          description: `Failed to start the data pull job for ${folderIds?.length ?? ''} folders`,
          cause: error as Error,
        });
      }
      await useActiveJobsStore.getState().refreshJobs();
    },
    [id, setWorkbookError],
  );

  return {
    workbook: data,
    isLoading,
    error: displayError,
    refreshWorkbook,
    updateWorkbook,
    addLinkedDataFolder,
    pullFolders,
    pullAssets,
    discardAllChanges,
  };
};
