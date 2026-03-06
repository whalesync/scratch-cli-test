import { ForbiddenException } from '@nestjs/common';
import { WorkbookId } from '@spinner/shared-types';
import { checkWorkspacePermissions, hasWorkspacePermissions } from './permissions';
import { Actor } from './types';

describe('Permissions', () => {
  const workbookId = 'wb_123' as WorkbookId;
  const otherWorkbookId = 'wb_999' as WorkbookId;

  const adminActor: Actor = {
    userId: 'user_admin',
    organizationId: 'org_1',
    isAdmin: true,
    workspacePermissions: [],
  };

  const editorActor: Actor = {
    userId: 'user_editor',
    organizationId: 'org_1',
    isAdmin: false,
    workspacePermissions: [{ workbookId, role: 'editor' }],
  };

  const viewerActor: Actor = {
    userId: 'user_viewer',
    organizationId: 'org_1',
    isAdmin: false,
    workspacePermissions: [{ workbookId, role: 'viewer' }],
  };

  const noPermissionsActor: Actor = {
    userId: 'user_none',
    organizationId: 'org_1',
    isAdmin: false,
    workspacePermissions: [],
  };

  const undefinedPermissionsActor: Actor = {
    userId: 'user_undef',
    organizationId: 'org_1',
    isAdmin: false,
  };

  describe('hasWorkspacePermissions', () => {
    it('should return true for admin actors regardless of permissions', () => {
      expect(hasWorkspacePermissions(adminActor, workbookId)).toBe(true);
      expect(hasWorkspacePermissions(adminActor, otherWorkbookId)).toBe(true);
    });

    it('should return true when actor has a matching permission for the workbook', () => {
      expect(hasWorkspacePermissions(editorActor, workbookId)).toBe(true);
    });

    it('should return false when actor has no matching permission for the workbook', () => {
      expect(hasWorkspacePermissions(editorActor, otherWorkbookId)).toBe(false);
    });

    it('should return false when actor has no permissions array', () => {
      expect(hasWorkspacePermissions(undefinedPermissionsActor, workbookId)).toBe(false);
    });

    it('should return false when actor has empty permissions array', () => {
      expect(hasWorkspacePermissions(noPermissionsActor, workbookId)).toBe(false);
    });

    it('should return true when role matches the permission role', () => {
      expect(hasWorkspacePermissions(editorActor, workbookId, 'editor')).toBe(true);
    });

    it('should return false when role does not match the permission role', () => {
      expect(hasWorkspacePermissions(editorActor, workbookId, 'viewer')).toBe(false);
      expect(hasWorkspacePermissions(viewerActor, workbookId, 'editor')).toBe(false);
    });

    it('should return true when no role is specified and permission exists', () => {
      expect(hasWorkspacePermissions(viewerActor, workbookId)).toBe(true);
    });

    it('should return true for admin even when a role is specified', () => {
      expect(hasWorkspacePermissions(adminActor, workbookId, 'editor')).toBe(true);
    });
  });

  describe('checkWorkspacePermissions', () => {
    it('should not throw when actor has permission', () => {
      expect(() => checkWorkspacePermissions(editorActor, workbookId)).not.toThrow();
    });

    it('should not throw for admin actors', () => {
      expect(() => checkWorkspacePermissions(adminActor, workbookId)).not.toThrow();
    });

    it('should throw ForbiddenException when actor lacks permission', () => {
      expect(() => checkWorkspacePermissions(noPermissionsActor, workbookId)).toThrow(ForbiddenException);
    });

    it('should include workbook id in error message', () => {
      expect(() => checkWorkspacePermissions(noPermissionsActor, workbookId)).toThrow(
        `User does not have permission to access workbook ${workbookId}`,
      );
    });

    it('should throw when role does not match', () => {
      expect(() => checkWorkspacePermissions(viewerActor, workbookId, 'editor')).toThrow(ForbiddenException);
    });

    it('should not throw when role matches', () => {
      expect(() => checkWorkspacePermissions(editorActor, workbookId, 'editor')).not.toThrow();
    });
  });
});
