import { WorkbookId, WorkspacePermissionId } from '../ids';

export interface WorkspacePermission {
  id: WorkspacePermissionId;
  workbookId: WorkbookId;
  role: 'editor' | 'viewer';
  userId: string;
  userName: string;
  userEmail: string;
}
