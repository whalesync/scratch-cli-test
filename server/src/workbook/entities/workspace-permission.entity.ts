import { WorkbookId, WorkspacePermission, WorkspacePermissionId } from '@spinner/shared-types';
import { WorkspacePermissionCluster } from 'src/db/cluster-types';
import { WorkspacePermissionRole } from 'src/users/types';

export class WorkspacePermissionEntity implements WorkspacePermission {
  id: WorkspacePermissionId;
  workbookId: WorkbookId;
  role: WorkspacePermissionRole;
  userId: string;
  userName: string;
  userEmail: string;

  constructor(permission: WorkspacePermissionCluster.WorkspacePermission) {
    this.id = permission.id as WorkspacePermissionId;
    this.workbookId = permission.workbookId as WorkbookId;
    this.role = permission.role as WorkspacePermissionRole;
    this.userId = permission.userId;
    this.userName = permission.user.name ?? '';
    this.userEmail = permission.user.email ?? '';
  }
}
