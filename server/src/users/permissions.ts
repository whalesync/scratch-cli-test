import { ForbiddenException } from '@nestjs/common';
import { WorkbookId } from '@spinner/shared-types';
import { Actor, WorkspacePermissionRole } from './types';

/**
 * Checks if an actor has permission to access a workbook.
 * Admins always have access. For non-admins, the actor must have a matching workspace permission.
 */

export function hasPermissions(actor: Actor, workbookId: WorkbookId, role?: WorkspacePermissionRole): boolean {
  if (actor.isAdmin) {
    return true;
  }

  if (!actor.workspacePermissions) {
    return false;
  }

  const matchingPermission = actor.workspacePermissions.find((wp) => wp.workbookId === workbookId);
  if (!matchingPermission) {
    return false;
  }

  if (role) {
    return matchingPermission.role === role;
  }

  return true;
}

/**
 * Throws a ForbiddenException if the actor does not have permission to access the workbook.
 */
export function checkPermission(actor: Actor, workbookId: WorkbookId, role?: WorkspacePermissionRole): void {
  if (!hasPermissions(actor, workbookId, role)) {
    throw new ForbiddenException(`User does not have permission to access workbook ${workbookId}`);
  }
}
