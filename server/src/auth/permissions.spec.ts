import { UserRole } from '@prisma/client';
import { UserId } from '@spinner/shared-types';
import { hasAdminToolsPermission } from './permissions';
import { AuthenticatedUser } from './types';

describe('permissions', () => {
  describe('hasAdminToolsPermission', () => {
    // Helper to create test users
    const createTestUser = (
      role: UserRole,
      authType: AuthenticatedUser['authType'],
      authSource: AuthenticatedUser['authSource'] = 'user',
    ): AuthenticatedUser => ({
      id: 'user_123' as UserId,
      createdAt: new Date(),
      updatedAt: new Date(),
      clerkId: 'clerk_123',
      whalesyncUserId: null,
      name: 'Test User',
      email: 'test@example.com',
      role,
      authType,
      authSource,
      stripeCustomerId: null,
      organizationId: 'org_123',
      apiTokens: [],
      workspacePermissions: [],
      organization: null,
      settings: null,
      lastWorkbookId: null,
      waitlistApproved: false,
    });

    describe('ADMIN users', () => {
      it('should return true for ADMIN with jwt auth', () => {
        const user = createTestUser(UserRole.ADMIN, 'jwt');
        expect(hasAdminToolsPermission(user)).toBe(true);
      });

      it('should return true for ADMIN with api-token auth', () => {
        const user = createTestUser(UserRole.ADMIN, 'api-token');
        expect(hasAdminToolsPermission(user)).toBe(true);
      });
    });

    describe('USER role (non-admin)', () => {
      it('should return false for USER with jwt auth', () => {
        const user = createTestUser(UserRole.USER, 'jwt');
        expect(hasAdminToolsPermission(user)).toBe(false);
      });

      it('should return false for USER with api-token auth', () => {
        const user = createTestUser(UserRole.USER, 'api-token');
        expect(hasAdminToolsPermission(user)).toBe(false);
      });
    });

    describe('edge cases', () => {
      it('should handle user with no organization id', () => {
        const user = createTestUser(UserRole.ADMIN, 'jwt');
        user.organizationId = null;
        expect(hasAdminToolsPermission(user)).toBe(true);
      });

      it('should handle user with missing clerk id', () => {
        const user = createTestUser(UserRole.ADMIN, 'jwt');
        user.clerkId = null;
        expect(hasAdminToolsPermission(user)).toBe(true);
      });

      it('should handle user with missing name and email', () => {
        const user = createTestUser(UserRole.ADMIN, 'api-token');
        user.name = null;
        user.email = null;
        expect(hasAdminToolsPermission(user)).toBe(true);
      });
    });

    describe('auth combinations', () => {
      // Test all combinations for completeness
      const testCases: Array<{
        role: UserRole;
        authType: AuthenticatedUser['authType'];
        expected: boolean;
        description: string;
      }> = [
        { role: UserRole.ADMIN, authType: 'jwt', expected: true, description: 'ADMIN + jwt' },
        { role: UserRole.ADMIN, authType: 'api-token', expected: true, description: 'ADMIN + api-token' },
        { role: UserRole.USER, authType: 'jwt', expected: false, description: 'USER + jwt' },
        { role: UserRole.USER, authType: 'api-token', expected: false, description: 'USER + api-token' },
      ];

      testCases.forEach(({ role, authType, expected, description }) => {
        it(`should return ${expected} for ${description}`, () => {
          const user = createTestUser(role, authType);
          expect(hasAdminToolsPermission(user)).toBe(expected);
        });
      });
    });
  });
});
