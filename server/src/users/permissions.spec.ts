import { ForbiddenException } from '@nestjs/common';
import { WorkbookId } from '@spinner/shared-types';
import { checkPermission, hasPermissions } from './permissions';
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

  describe('hasPermissions', () => {
    it('should return true for admin actors regardless of permissions', () => {
      expect(hasPermissions(adminActor, workbookId)).toBe(true);
      expect(hasPermissions(adminActor, otherWorkbookId)).toBe(true);
    });

    it('should return true when actor has a matching permission for the workbook', () => {
      expect(hasPermissions(editorActor, workbookId)).toBe(true);
    });

    it('should return false when actor has no matching permission for the workbook', () => {
      expect(hasPermissions(editorActor, otherWorkbookId)).toBe(false);
    });

    it('should return false when actor has no permissions array', () => {
      expect(hasPermissions(undefinedPermissionsActor, workbookId)).toBe(false);
    });

    it('should return false when actor has empty permissions array', () => {
      expect(hasPermissions(noPermissionsActor, workbookId)).toBe(false);
    });

    it('should return true when role matches the permission role', () => {
      expect(hasPermissions(editorActor, workbookId, 'editor')).toBe(true);
    });

    it('should return false when role does not match the permission role', () => {
      expect(hasPermissions(editorActor, workbookId, 'viewer')).toBe(false);
      expect(hasPermissions(viewerActor, workbookId, 'editor')).toBe(false);
    });

    it('should return true when no role is specified and permission exists', () => {
      expect(hasPermissions(viewerActor, workbookId)).toBe(true);
    });

    it('should return true for admin even when a role is specified', () => {
      expect(hasPermissions(adminActor, workbookId, 'editor')).toBe(true);
    });
  });

  describe('checkPermission', () => {
    it('should not throw when actor has permission', () => {
      expect(() => checkPermission(editorActor, workbookId)).not.toThrow();
    });

    it('should not throw for admin actors', () => {
      expect(() => checkPermission(adminActor, workbookId)).not.toThrow();
    });

    it('should throw ForbiddenException when actor lacks permission', () => {
      expect(() => checkPermission(noPermissionsActor, workbookId)).toThrow(ForbiddenException);
    });

    it('should include workbook id in error message', () => {
      expect(() => checkPermission(noPermissionsActor, workbookId)).toThrow(
        `User does not have permission to access workbook ${workbookId}`,
      );
    });

    it('should throw when role does not match', () => {
      expect(() => checkPermission(viewerActor, workbookId, 'editor')).toThrow(ForbiddenException);
    });

    it('should not throw when role matches', () => {
      expect(() => checkPermission(editorActor, workbookId, 'editor')).not.toThrow();
    });
  });
});
