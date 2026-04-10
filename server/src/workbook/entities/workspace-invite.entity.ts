import { WorkspaceInvites } from '@prisma/client';
import { WorkbookId, WorkspaceInvite, WorkspaceInviteId } from '@spinner/shared-types';

export class WorkspaceInviteEntity implements WorkspaceInvite {
  id: WorkspaceInviteId;
  workbookId: WorkbookId;
  email: string;
  role: 'editor';
  createdAt: string;
  invitedByUserId: string | null;

  constructor(invite: WorkspaceInvites) {
    this.id = invite.id as WorkspaceInviteId;
    this.workbookId = invite.workbookId as WorkbookId;
    this.email = invite.email;
    this.role = invite.role as 'editor';
    this.createdAt = invite.createdAt.toISOString();
    this.invitedByUserId = invite.userId ?? null;
  }
}
