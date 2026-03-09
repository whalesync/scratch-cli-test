import { Injectable } from '@nestjs/common';
import {
  createWorkspaceInviteId,
  createWorkspacePermissionId,
  WorkbookId,
  WorkspaceInviteId,
  WorkspacePermissionId,
} from '@spinner/shared-types';
import { AuditLogService } from 'src/audit/audit-log.service';
import { WorkspacePermissionCluster } from 'src/db/cluster-types';
import { DbService } from 'src/db/db.service';
import { PostHogEventName, PostHogService } from 'src/posthog/posthog.service';
import { Actor, WorkspacePermissionRole } from 'src/users/types';

@Injectable()
export class WorkspacePermissionsService {
  constructor(
    private readonly db: DbService,
    private readonly posthogService: PostHogService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async createByUserId(
    workbookId: WorkbookId,
    userId: string,
    role: WorkspacePermissionRole,
    actor: Actor,
  ): Promise<void> {
    const permission = await this.db.client.workspacePermission.create({
      data: {
        id: createWorkspacePermissionId(),
        workbookId,
        userId,
        role,
      },
      include: WorkspacePermissionCluster._validator.include,
    });

    this.posthogService.captureEvent(PostHogEventName.WORKSPACE_PERMISSION_CREATED, actor, {
      workbookId,
      permissionId: permission.id,
      role,
      userId,
    });

    await this.auditLogService.logEvent({
      actor,
      eventType: 'create',
      message: `Added workspace permission for user ${permission.user.email ?? userId} with role ${role}`,
      entityId: permission.id as WorkspacePermissionId,
      organizationId: actor.organizationId,
      context: { workbookId, role, userId },
    });
  }

  async createByEmail(
    workbookId: WorkbookId,
    email: string,
    role: WorkspacePermissionRole,
    actor: Actor,
  ): Promise<void> {
    const user = await this.db.client.user.findFirst({
      where: { email },
    });

    if (!user) {
      await this.db.client.workspaceInvites.create({
        data: {
          id: createWorkspaceInviteId(),
          email,
          workbookId,
          userId: actor.userId,
        },
      });

      await this.auditLogService.logEvent({
        actor,
        eventType: 'create',
        message: `Created workspace invite for ${email}`,
        entityId: workbookId,
        organizationId: actor.organizationId,
        context: { workbookId, email },
      });
      return;
    }

    await this.createByUserId(workbookId, user.id, role, actor);
  }

  async listByUser(userId: string): Promise<WorkspacePermissionCluster.WorkspacePermission[]> {
    return this.db.client.workspacePermission.findMany({
      where: { userId },
      include: WorkspacePermissionCluster._validator.include,
    });
  }

  async listByWorkbook(workbookId: WorkbookId): Promise<WorkspacePermissionCluster.WorkspacePermission[]> {
    return this.db.client.workspacePermission.findMany({
      where: { workbookId },
      include: WorkspacePermissionCluster._validator.include,
    });
  }

  async listInvitesByWorkbook(workbookId: WorkbookId) {
    return this.db.client.workspaceInvites.findMany({
      where: { workbookId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async removeAllForUser(userId: string, _actor: Actor): Promise<void> {
    await this.db.client.workspacePermission.deleteMany({
      where: { userId },
    });
  }

  async update(
    workspacePermissionId: WorkspacePermissionId,
    newRole: WorkspacePermissionRole,
    actor: Actor,
  ): Promise<WorkspacePermissionCluster.WorkspacePermission> {
    const permission = await this.db.client.workspacePermission.update({
      where: { id: workspacePermissionId },
      data: { role: newRole },
      include: WorkspacePermissionCluster._validator.include,
    });

    this.posthogService.captureEvent(PostHogEventName.WORKSPACE_PERMISSION_UPDATED, actor, {
      workbookId: permission.workbookId,
      permissionId: permission.id,
      role: newRole,
      userId: permission.userId,
    });

    await this.auditLogService.logEvent({
      actor,
      eventType: 'update',
      message: `Updated workspace permission for user ${permission.user.email ?? permission.userId} to role ${newRole}`,
      entityId: permission.id as WorkspacePermissionId,
      organizationId: actor.organizationId,
      context: { workbookId: permission.workbookId, role: newRole, userId: permission.userId },
    });

    return permission;
  }

  async deleteInvite(inviteId: WorkspaceInviteId, actor: Actor): Promise<void> {
    const invite = await this.db.client.workspaceInvites.findUnique({
      where: { id: inviteId },
    });

    await this.db.client.workspaceInvites.delete({
      where: { id: inviteId },
    });

    if (invite) {
      await this.auditLogService.logEvent({
        actor,
        eventType: 'delete',
        message: `Removed workspace invite for ${invite.email}`,
        entityId: invite.workbookId as WorkbookId,
        organizationId: actor.organizationId,
        context: { workbookId: invite.workbookId, email: invite.email },
      });
    }
  }

  async delete(workspacePermissionId: WorkspacePermissionId, actor: Actor): Promise<void> {
    const permission = await this.db.client.workspacePermission.findUnique({
      where: { id: workspacePermissionId },
      include: WorkspacePermissionCluster._validator.include,
    });

    await this.db.client.workspacePermission.delete({
      where: { id: workspacePermissionId },
    });

    if (permission) {
      this.posthogService.captureEvent(PostHogEventName.WORKSPACE_PERMISSION_REMOVED, actor, {
        workbookId: permission.workbookId,
        permissionId: permission.id,
        userId: permission.userId,
      });

      await this.auditLogService.logEvent({
        actor,
        eventType: 'delete',
        message: `Removed workspace permission for user ${permission.user.email ?? permission.userId}`,
        entityId: permission.id as WorkspacePermissionId,
        organizationId: actor.organizationId,
        context: { workbookId: permission.workbookId, userId: permission.userId },
      });
    }
  }
}
