import { ForbiddenException } from '@nestjs/common';
import { WorkbookId } from '@spinner/shared-types';
import { Actor, isSystemActor, WorkspacePermissionRole } from './types';

/**
 * Checks if an actor has permission to access a workbook.
 * Admins and system actors always have access. For non-admins, the actor must have a matching workspace permission.
 */

export function hasWorkspacePermissions(
  actor: Actor,
  workbookId: WorkbookId,
  role: WorkspacePermissionRole = 'editor',
): boolean {
  if (actor.isAdmin) {
    return true;
  }

  if (isSystemActor(actor)) {
    return true;
  }

  if (!actor.workspacePermissions) {
    return false;
  }

  const matchingPermission = actor.workspacePermissions.find((wp) => wp.workbookId === workbookId);
  if (!matchingPermission) {
    return false;
  }

  return matchingPermission.role === role;
}

/**
 * Throws a ForbiddenException if the actor does not have permission to access the workbook.
 */
export function checkWorkspacePermissions(
  actor: Actor,
  workbookId: WorkbookId,
  role: WorkspacePermissionRole = 'editor',
): void {
  if (!hasWorkspacePermissions(actor, workbookId, role)) {
    throw new ForbiddenException(`User does not have permission to access workbook ${workbookId}`);
  }
}
