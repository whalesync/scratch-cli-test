import { trackAddWorkspacePermission, trackRemoveWorkspaceInvite, trackRemoveWorkspacePermission } from '@/lib/posthog';
import { scratchApiClient } from '@/lib/scratch-api-client';
import {
  AddWorkspacePermissionDto,
  WorkspaceInvite,
  WorkspaceInviteId,
  WorkspacePermission,
  WorkspacePermissionId,
} from '@spinner/shared-types';
import { useCallback } from 'react';
import useSWR from 'swr';

const PERMISSIONS_SWR_KEY_PREFIX = 'workspace-permissions';
const INVITES_SWR_KEY_PREFIX = 'workspace-invites';

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

export const useWorkspacePermissions = (workbookId: string | null): UseWorkspacePermissionsReturn => {
  const { data, error, isLoading, mutate } = useSWR<WorkspacePermission[], Error>(
    workbookId ? [PERMISSIONS_SWR_KEY_PREFIX, workbookId] : null,
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
    workbookId ? [INVITES_SWR_KEY_PREFIX, workbookId] : null,
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
      void trackAddWorkspacePermission(workbookId);
      await Promise.all([mutate(), mutateInvites()]);
    },
    [workbookId, mutate, mutateInvites],
  );

  const removePermission = useCallback(
    async (permissionId: WorkspacePermissionId) => {
      if (!workbookId) return;
      await scratchApiClient.permissions.removePermission(workbookId, permissionId);
      void trackRemoveWorkspacePermission(workbookId);
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
      void trackRemoveWorkspaceInvite(workbookId);
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
