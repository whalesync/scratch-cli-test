import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { isUnauthorizedError } from '@/lib/api/error';
import { SWR_KEYS } from '@/lib/api/keys';
import { workbookApi } from '@/lib/api/workbook';
import { trackDiscardChanges, trackPublishAll, trackPullFiles } from '@/lib/posthog';
import { useActiveJobsStore } from '@/stores/active-jobs-store';
import { useWorkbookEditorUIStore } from '@/stores/workbook-editor-store';
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
  error: Error | undefined;
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
  publishFolders: (dataFolderIds: DataFolderId[]) => Promise<void>;
  discardAllChanges: () => Promise<void>;
}

export const useWorkbook = (id: WorkbookId | null): UseWorkbookReturn => {
  const setWorkbookError = useWorkbookEditorUIStore((state) => state.setWorkbookError);
  const { data, error, isLoading, mutate } = useSWR(
    id ? SWR_KEYS.workbook.detail(id) : null,
    () => (id ? workbookApi.detail(id) : undefined),
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
        throw new Error('Workbook not found');
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
      await mutate();
      return dataFolder;
    },
    [id, mutate],
  );

  const publishFolders = useCallback(
    async (dataFolderIds: DataFolderId[]): Promise<void> => {
      if (!id || dataFolderIds.length === 0) {
        return;
      }
      trackPublishAll(id, dataFolderIds.length);
      try {
        const result = await dataFolderApi.publish(dataFolderIds, id);
        useActiveJobsStore.getState().trackJobIds([result.jobId]);
        // TODO: this notification is just overkill for now, we shouldn't need it at all once the UI is more reactive
        ScratchpadNotifications.info({ message: 'Initiated data publish job for changes' });
      } catch (error) {
        console.error('Failed to publish folders:', error);
        setWorkbookError({
          scope: 'review',
          description: 'Failed to start the data publish job for ${dataFolderIds.length} folders',
          cause: error as Error,
        });
      }
      await mutate();
      await useActiveJobsStore.getState().refreshJobs();
      await globalMutate(SWR_KEYS.dataFolders.list(id));
      for (const folderId of dataFolderIds) {
        globalMutate(SWR_KEYS.dataFolders.detail(folderId));
      }
    },
    [globalMutate, id, mutate, setWorkbookError],
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

  const pullFolders = useCallback(
    async (folderIds?: DataFolderId[]): Promise<void> => {
      if (!id || !data) {
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
      await mutate();
      await useActiveJobsStore.getState().refreshJobs();
      await globalMutate(SWR_KEYS.dataFolders.list(id));
      data.dataFolders?.forEach((folder) => {
        globalMutate(SWR_KEYS.dataFolders.detail(folder.id));
      });
    },
    [globalMutate, id, mutate, data, setWorkbookError],
  );

  return {
    workbook: data,
    isLoading,
    error: displayError,
    // publish,
    refreshWorkbook,
    updateWorkbook,
    addLinkedDataFolder,
    pullFolders,
    publishFolders,
    discardAllChanges,
  };
};
