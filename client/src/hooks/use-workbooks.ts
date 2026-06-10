import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { RouteUrls } from '@/utils/route-urls';
import {
  CreateWorkbookDto,
  DeleteWorkbookResponseDto,
  UpdateWorkbookDto,
  WorkbookId,
  Workspace,
} from '@spinner/shared-types';
import type { WorkbookSortBy, WorkbookSortOrder } from '@spinner/shared-types/api-client';
import { isUnauthorizedError } from '@spinner/shared-types/api-client';
import { useCallback, useMemo } from 'react';
import useSWR, { useSWRConfig } from 'swr';

export interface UseWorkbooksOptions {
  connectorAccountId?: string;
  sortBy?: WorkbookSortBy;
  sortOrder?: WorkbookSortOrder;
}

export interface UseWorkbooksReturn {
  workbooks: Workspace[] | undefined;
  isLoading: boolean;
  error: string | undefined;
  createWorkbook: (dto: CreateWorkbookDto) => Promise<Workspace>;
  updateWorkbook: (id: WorkbookId, updateDto: UpdateWorkbookDto) => Promise<Workspace>;
  /**
   * Delete a workbook. Default path is asynchronous: server flags the workbook for
   * deletion and the worker tears it down. Pass `{ force: true }` for synchronous
   * hard delete (admin/non-prod only) — used by integration & smoke tests.
   */
  deleteWorkbook: (id: WorkbookId, options?: { force?: boolean }) => Promise<DeleteWorkbookResponseDto>;
  refreshWorkbooks: () => Promise<void>;
  getWorkbookPageUrl: (id: WorkbookId) => string;
}

export const useWorkbooks = (options: UseWorkbooksOptions = {}): UseWorkbooksReturn => {
  const { connectorAccountId, sortBy = 'createdAt', sortOrder = 'desc' } = options;
  const { mutate } = useSWRConfig();
  const { data, error, isLoading } = useSWR<Workspace[], Error>(
    SWR_KEYS.workbook.list(sortBy, sortOrder),
    () => scratchApiClient.workspaces.list(connectorAccountId, sortBy, sortOrder),
    {
      revalidateOnReconnect: true,
    },
  );

  const createWorkbook = useCallback(
    async (dto: CreateWorkbookDto): Promise<Workspace> => {
      const newWorkbook = await scratchApiClient.workspaces.create(dto);
      mutate(SWR_KEYS.workbook.listKeyMatcher());
      return newWorkbook;
    },
    [mutate],
  );

  const updateWorkbook = useCallback(
    async (id: WorkbookId, updateDto: UpdateWorkbookDto): Promise<Workspace> => {
      const updatedWorkbook = await scratchApiClient.workspaces.update(id, updateDto);
      mutate(SWR_KEYS.workbook.listKeyMatcher());
      mutate(SWR_KEYS.workbook.detail(id));
      return updatedWorkbook;
    },
    [mutate],
  );

  const deleteWorkbook = useCallback(
    async (id: WorkbookId, options?: { force?: boolean }): Promise<DeleteWorkbookResponseDto> => {
      const result = await scratchApiClient.workspaces.delete(id, options);
      // Revalidate the list so the row immediately reflects either the pending state
      // (default async path) or removal (force path).
      mutate(SWR_KEYS.workbook.listKeyMatcher());
      return result;
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
