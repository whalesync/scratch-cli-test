import { Injectable, NotFoundException } from '@nestjs/common';
import { createWorkspacePermissionId, WorkbookId, WorkspacePermissionId } from '@spinner/shared-types';
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
  ): Promise<WorkspacePermissionCluster.WorkspacePermission> {
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

    return permission;
  }

  async createByEmail(
    workbookId: WorkbookId,
    email: string,
    role: WorkspacePermissionRole,
    actor: Actor,
  ): Promise<WorkspacePermissionCluster.WorkspacePermission> {
    const user = await this.db.client.user.findFirst({
      where: { email },
    });

    if (!user) {
      throw new NotFoundException(`User with email ${email} not found`);
    }

    return this.createByUserId(workbookId, user.id, role, actor);
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
