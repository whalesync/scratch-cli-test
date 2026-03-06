import { Injectable, NotFoundException } from '@nestjs/common';
import { createWorkspacePermissionId, WorkbookId, WorkspacePermissionId } from '@spinner/shared-types';
import { WorkspacePermissionCluster } from 'src/db/cluster-types';
import { DbService } from 'src/db/db.service';
import { WorkspacePermissionRole } from 'src/users/types';

@Injectable()
export class WorkspacePermissionsService {
  constructor(private readonly db: DbService) {}

  async createByUserId(
    workbookId: WorkbookId,
    userId: string,
    role: WorkspacePermissionRole,
  ): Promise<WorkspacePermissionCluster.WorkspacePermission> {
    return this.db.client.workspacePermission.create({
      data: {
        id: createWorkspacePermissionId(),
        workbookId,
        userId,
        role,
      },
      include: WorkspacePermissionCluster._validator.include,
    });
  }

  async createByEmail(
    workbookId: WorkbookId,
    email: string,
    role: WorkspacePermissionRole,
  ): Promise<WorkspacePermissionCluster.WorkspacePermission> {
    const user = await this.db.client.user.findFirst({
      where: { email },
    });

    if (!user) {
      throw new NotFoundException(`User with email ${email} not found`);
    }

    return this.createByUserId(workbookId, user.id, role);
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

  async removeAllForUser(userId: string): Promise<void> {
    await this.db.client.workspacePermission.deleteMany({
      where: { userId },
    });
  }

  async update(
    workspacePermissionId: WorkspacePermissionId,
    newRole: WorkspacePermissionRole,
  ): Promise<WorkspacePermissionCluster.WorkspacePermission> {
    return this.db.client.workspacePermission.update({
      where: { id: workspacePermissionId },
      data: { role: newRole },
      include: WorkspacePermissionCluster._validator.include,
    });
  }

  async delete(workspacePermissionId: WorkspacePermissionId): Promise<void> {
    await this.db.client.workspacePermission.delete({
      where: { id: workspacePermissionId },
    });
  }
}
