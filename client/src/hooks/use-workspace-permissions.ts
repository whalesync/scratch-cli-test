import { SWR_KEYS } from '@/lib/api/keys';
import { workbookApi } from '@/lib/api/workbook';
import {
  AddWorkspacePermissionDto,
  WorkbookId,
  WorkspacePermission,
  WorkspacePermissionId,
} from '@spinner/shared-types';
import { useCallback } from 'react';
import useSWR from 'swr';

export interface UseWorkspacePermissionsReturn {
  permissions: WorkspacePermission[];
  isLoading: boolean;
  error: Error | undefined;
  refresh: () => Promise<void>;
  addPermission: (dto: AddWorkspacePermissionDto) => Promise<void>;
  removePermission: (permissionId: WorkspacePermissionId) => Promise<void>;
}

export const useWorkspacePermissions = (workbookId: WorkbookId | null): UseWorkspacePermissionsReturn => {
  const { data, error, isLoading, mutate } = useSWR(
    workbookId ? SWR_KEYS.workbook.permissions(workbookId) : null,
    () => (workbookId ? workbookApi.listPermissions(workbookId) : undefined),
    {
      revalidateOnFocus: false,
    },
  );

  const refresh = useCallback(async () => {
    await mutate();
  }, [mutate]);

  const addPermission = useCallback(
    async (dto: AddWorkspacePermissionDto) => {
      if (!workbookId) return;
      await workbookApi.addPermission(workbookId, dto);
      await mutate();
    },
    [workbookId, mutate],
  );

  const removePermission = useCallback(
    async (permissionId: WorkspacePermissionId) => {
      if (!workbookId) return;
      await workbookApi.removePermission(workbookId, permissionId);
      await mutate();
    },
    [workbookId, mutate],
  );

  return {
    permissions: data ?? [],
    isLoading,
    error,
    refresh,
    addPermission,
    removePermission,
  };
};
