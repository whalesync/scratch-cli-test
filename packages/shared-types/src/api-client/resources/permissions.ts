import type { WorkspaceInvite, WorkspacePermission } from '../../db';
import type {
  AddWorkspacePermissionDto,
  UpdateWorkspacePermissionDto,
} from '../../dto/workspace-permission/workspace-permission.dto';
import type { WorkspaceInviteId, WorkspacePermissionId } from '../../ids';
import type { Http } from '../http';

/**
 * Workspace access control: permissions (members) and pending invites. Reached as
 * `client.permissions.*`.
 */
export function createPermissionsApi(http: Http) {
  return {
    listInvites: async (workbookId: string): Promise<WorkspaceInvite[]> => {
      const res = await http.get<WorkspaceInvite[]>(`/workbook/${workbookId}/invites`, {
        fallbackMessage: 'Failed to list workspace invites',
      });
      return res.data;
    },

    listPermissions: async (workbookId: string): Promise<WorkspacePermission[]> => {
      const res = await http.get<WorkspacePermission[]>(`/workbook/${workbookId}/permissions`, {
        fallbackMessage: 'Failed to list workspace permissions',
      });
      return res.data;
    },

    addPermission: async (workbookId: string, dto: AddWorkspacePermissionDto): Promise<void> => {
      await http.post<WorkspacePermission>(`/workbook/${workbookId}/permissions/add`, dto, {
        fallbackMessage: 'Failed to add workspace permission',
      });
    },

    removePermission: async (workbookId: string, permissionId: WorkspacePermissionId): Promise<void> => {
      await http.delete(`/workbook/${workbookId}/permission/${permissionId}`, {
        fallbackMessage: 'Failed to remove workspace permission',
      });
    },

    deleteInvite: async (workbookId: string, inviteId: WorkspaceInviteId): Promise<void> => {
      await http.delete(`/workbook/${workbookId}/invite/${inviteId}`, {
        fallbackMessage: 'Failed to delete workspace invite',
      });
    },

    updatePermission: async (
      workbookId: string,
      permissionId: WorkspacePermissionId,
      dto: UpdateWorkspacePermissionDto,
    ): Promise<WorkspacePermission> => {
      const res = await http.patch<WorkspacePermission>(`/workbook/${workbookId}/permission/${permissionId}`, dto, {
        fallbackMessage: 'Failed to update workspace permission',
      });
      return res.data;
    },
  };
}

export type PermissionsApi = ReturnType<typeof createPermissionsApi>;
