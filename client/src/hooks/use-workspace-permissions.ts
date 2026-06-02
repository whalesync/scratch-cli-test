import { SWR_KEYS } from '@/lib/api/keys';
import { workbookApi } from '@/lib/api/workbook';
import {
  AddWorkspacePermissionDto,
  WorkbookId,
  WorkspaceInvite,
  WorkspaceInviteId,
  WorkspacePermission,
  WorkspacePermissionId,
} from '@spinner/shared-types';
import { useCallback } from 'react';
import useSWR from 'swr';

export interface UseWorkspacePermissionsReturn {
  permissions: WorkspacePermission[];
  invites: WorkspaceInvite[];
  isLoading: boolean;
  error: Error | undefined;
  refresh: () => Promise<void>;
  addPermission: (dto: AddWorkspacePermissionDto) => Promise<void>;
  removePermission: (permissionId: WorkspacePermissionId) => Promise<void>;
  removeInvite: (inviteId: WorkspaceInviteId) => Promise<void>;
}

export const useWorkspacePermissions = (workbookId: WorkbookId | null): UseWorkspacePermissionsReturn => {
  const { data, error, isLoading, mutate } = useSWR<WorkspacePermission[], Error>(
    workbookId ? SWR_KEYS.workbook.permissions(workbookId) : null,
    () => {
      if (!workbookId) {
        throw new Error('workbookId is required');
      }
      return workbookApi.listPermissions(workbookId);
    },
    {
      revalidateOnFocus: false,
    },
  );

  const {
    data: invitesData,
    error: invitesError,
    isLoading: invitesLoading,
    mutate: mutateInvites,
  } = useSWR<WorkspaceInvite[], Error>(
    workbookId ? SWR_KEYS.workbook.invites(workbookId) : null,
    () => {
      if (!workbookId) {
        throw new Error('workbookId is required');
      }
      return workbookApi.listInvites(workbookId);
    },
    {
      revalidateOnFocus: false,
    },
  );

  const refresh = useCallback(async () => {
    await Promise.all([mutate(), mutateInvites()]);
  }, [mutate, mutateInvites]);

  const addPermission = useCallback(
    async (dto: AddWorkspacePermissionDto) => {
      if (!workbookId) return;
      await workbookApi.addPermission(workbookId, dto);
      await Promise.all([mutate(), mutateInvites()]);
    },
    [workbookId, mutate, mutateInvites],
  );

  const removePermission = useCallback(
    async (permissionId: WorkspacePermissionId) => {
      if (!workbookId) return;
      await workbookApi.removePermission(workbookId, permissionId);
      await mutate();
    },
    [workbookId, mutate],
  );

  const removeInvite = useCallback(
    async (inviteId: WorkspaceInviteId) => {
      if (!workbookId) return;
      await workbookApi.deleteInvite(workbookId, inviteId);
      await mutateInvites();
    },
    [workbookId, mutateInvites],
  );

  return {
    permissions: data ?? [],
    invites: invitesData ?? [],
    isLoading: isLoading || invitesLoading,
    error: error ?? invitesError,
    refresh,
    addPermission,
    removePermission,
    removeInvite,
  };
};
