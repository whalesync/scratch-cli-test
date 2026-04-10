import { WorkbookId, WorkspacePermissionId } from '../ids';

export interface WorkspacePermission {
  id: WorkspacePermissionId;
  workbookId: WorkbookId;
  role: 'editor';
  userId: string;
  userName: string;
  userEmail: string;
  organizationId: string | null;
  organizationName: string | null;
  isAdmin: boolean;
}
