import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
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
      return scratchApiClient.permissions.listPermissions(workbookId);
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
      return scratchApiClient.permissions.listInvites(workbookId);
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
      await scratchApiClient.permissions.addPermission(workbookId, dto);
      await Promise.all([mutate(), mutateInvites()]);
    },
    [workbookId, mutate, mutateInvites],
  );

  const removePermission = useCallback(
    async (permissionId: WorkspacePermissionId) => {
      if (!workbookId) return;
      await scratchApiClient.permissions.removePermission(workbookId, permissionId);
      // Best-effort refresh: when a user removes their own access the list endpoint
      // returns 403 (they can no longer read the workbook), but the removal already
      // succeeded, so don't surface the revalidation failure as a removal error.
      await mutate().catch(() => undefined);
    },
    [workbookId, mutate],
  );

  const removeInvite = useCallback(
    async (inviteId: WorkspaceInviteId) => {
      if (!workbookId) return;
      await scratchApiClient.permissions.deleteInvite(workbookId, inviteId);
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
