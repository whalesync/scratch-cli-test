import { isUnauthorizedError } from '@/lib/api/error';
import { SWR_KEYS } from '@/lib/api/keys';
import { workbookApi, WorkbookSortBy, WorkbookSortOrder } from '@/lib/api/workbook';
import { RouteUrls } from '@/utils/route-urls';
import { CreateWorkbookDto, UpdateWorkbookDto, Workbook, WorkbookId } from '@spinner/shared-types';
import { useCallback, useMemo } from 'react';
import useSWR, { useSWRConfig } from 'swr';

export interface UseWorkbooksOptions {
  connectorAccountId?: string;
  sortBy?: WorkbookSortBy;
  sortOrder?: WorkbookSortOrder;
}

export interface UseWorkbooksReturn {
  workbooks: Workbook[] | undefined;
  isLoading: boolean;
  error: string | undefined;
  createWorkbook: (dto: CreateWorkbookDto) => Promise<Workbook>;
  updateWorkbook: (id: WorkbookId, updateDto: UpdateWorkbookDto) => Promise<Workbook>;
  deleteWorkbook: (id: WorkbookId) => Promise<void>;
  refreshWorkbooks: () => Promise<void>;
  getWorkbookPageUrl: (id: WorkbookId) => string;
}

export const useWorkbooks = (options: UseWorkbooksOptions = {}): UseWorkbooksReturn => {
  const { connectorAccountId, sortBy = 'createdAt', sortOrder = 'desc' } = options;
  const { mutate } = useSWRConfig();
  const { data, error, isLoading } = useSWR<Workbook[], Error>(
    SWR_KEYS.workbook.list(sortBy, sortOrder),
    () => workbookApi.list(connectorAccountId, sortBy, sortOrder),
    {
      revalidateOnReconnect: true,
    },
  );

  const createWorkbook = useCallback(
    async (dto: CreateWorkbookDto): Promise<Workbook> => {
      const newWorkbook = await workbookApi.create(dto);
      mutate(SWR_KEYS.workbook.listKeyMatcher());
      return newWorkbook;
    },
    [mutate],
  );

  const updateWorkbook = useCallback(
    async (id: WorkbookId, updateDto: UpdateWorkbookDto): Promise<Workbook> => {
      const updatedWorkbook = await workbookApi.update(id, updateDto);
      mutate(SWR_KEYS.workbook.listKeyMatcher());
      mutate(SWR_KEYS.workbook.detail(id));
      return updatedWorkbook;
    },
    [mutate],
  );

  const deleteWorkbook = useCallback(
    async (id: WorkbookId): Promise<void> => {
      await workbookApi.delete(id);
      mutate(SWR_KEYS.workbook.listKeyMatcher());
    },
    [mutate],
  );

  const refreshWorkbooks = useCallback(async () => {
    await mutate(SWR_KEYS.workbook.listKeyMatcher());
  }, [mutate]);

  const displayError = useMemo(() => {
    if (isUnauthorizedError(error)) {
      // ignore this error as it will be fixed after the token is refreshed
      return undefined;
    }
    return error?.message;
  }, [error]);

  const getWorkbookPageUrl = (id: WorkbookId) => {
    return RouteUrls.workbookFilesPageUrl(id);
  };
  return {
    workbooks: data,
    isLoading,
    error: displayError,
    createWorkbook,
    updateWorkbook,
    deleteWorkbook,
    refreshWorkbooks,
    getWorkbookPageUrl,
  };
};
