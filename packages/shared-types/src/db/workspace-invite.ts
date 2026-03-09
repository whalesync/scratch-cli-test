import { WorkbookId, WorkspaceInviteId } from '../ids';

export interface WorkspaceInvite {
  id: WorkspaceInviteId;
  workbookId: WorkbookId;
  email: string;
  role: 'editor' | 'viewer';
  createdAt: string;
  invitedByUserId: string | null;
}
