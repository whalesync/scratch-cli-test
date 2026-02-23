import { UserRole } from '@prisma/client';
import { UserCluster } from 'src/db/cluster-types';
import { WSLogger } from 'src/logger';
import { userToActor } from './types';

describe('User Type Utilities', () => {
  describe('userToActor', () => {
    let loggerErrorSpy: jest.SpyInstance;
    let testUser: UserCluster.User;

    beforeEach(() => {
      loggerErrorSpy = jest.spyOn(WSLogger, 'error').mockImplementation();
      testUser = {
        id: 'user_123',
        clerkId: 'clerk_456',
        organizationId: 'org_789',
        createdAt: new Date(),
        updatedAt: new Date(),
        email: 'test@example.com',
        name: 'Test User',
        role: UserRole.USER,
        stripeCustomerId: 'stripe_123',
        settings: {},
        lastWorkbookId: null,
        apiTokens: [],
        organization: {
          id: 'org_789',
          name: 'Test Organization',
          createdAt: new Date(),
          updatedAt: new Date(),
          clerkId: 'clerk_org_789',
          subscriptions: [],
        },
      };
    });

    afterEach(() => {
      // Restore WSLogger.error if it was spied on
      if (loggerErrorSpy) {
        loggerErrorSpy.mockRestore();
      }
    });

    it('should convert user to actor with organization id', () => {
      const actor = userToActor(testUser);

      expect(actor).toEqual({
        userId: 'user_123',
        organizationId: 'org_789',
        authSource: 'user',
        isAdmin: false,
        subscriptionStatus: {
          planType: 'FREE_PLAN',
          status: 'active',
        },
      });
    });

    it('should handle user with null organization id with fallback', () => {
      // Suppress expected error logs from WSLogger
      loggerErrorSpy = jest.spyOn(WSLogger, 'error').mockImplementation();

      const user: UserCluster.User = {
        id: 'user_123',
        clerkId: 'clerk_456',
        organizationId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        email: 'test@example.com',
        name: 'Test User',
        role: UserRole.USER,
        stripeCustomerId: 'stripe_123',
        settings: {},
        lastWorkbookId: null,
        apiTokens: [],
        organization: null,
      };

      const actor = userToActor(user);

      expect(actor.userId).toBe('user_123');
      expect(actor.organizationId).toBe('<empty org id>');
    });

    it('should handle user with undefined organization id with fallback', () => {
      // Suppress expected error logs from WSLogger
      loggerErrorSpy = jest.spyOn(WSLogger, 'error').mockImplementation();

      const user: UserCluster.User = {
        ...testUser,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        organizationId: undefined as any,
        organization: null,
      };

      const actor = userToActor(user);

      expect(actor.userId).toBe('user_123');
      expect(actor.organizationId).toBe('<empty org id>');
    });

    it('should preserve user id exactly as provided', () => {
      const userId = 'very-long-user-id-with-special-chars_123-456';
      const user: UserCluster.User = { ...testUser, id: userId };

      const actor = userToActor(user);

      expect(actor.userId).toBe(userId);
    });

    it('should preserve organization id exactly as provided', () => {
      const orgId = 'very-long-org-id-with-special-chars_789-abc';
      const user: UserCluster.User = { ...testUser, organizationId: orgId };

      const actor = userToActor(user);

      expect(actor.organizationId).toBe(orgId);
    });

    it('should handle user with all optional fields', () => {
      const actor = userToActor(testUser);

      expect(actor).toBeDefined();
      expect(actor.userId).toBe('user_123');
      expect(actor.organizationId).toBe('org_789');
    });

    it('should handle user with custom settings', () => {
      const user: UserCluster.User = { ...testUser, settings: { theme: 'dark', language: 'en' } };

      const actor = userToActor(user);

      expect(actor.userId).toBe('user_123');
      expect(actor.organizationId).toBe('org_789');
    });

    it('should set isAdmin to true when user has ADMIN role', () => {
      const user: UserCluster.User = { ...testUser, role: UserRole.ADMIN };

      const actor = userToActor(user);

      expect(actor.isAdmin).toBe(true);
    });

    it('should not include any user metadata in actor', () => {
      const actor = userToActor(testUser);

      expect(actor).not.toHaveProperty('email');
      expect(actor).not.toHaveProperty('name');
      expect(actor).not.toHaveProperty('settings');
      expect(actor).not.toHaveProperty('profileImageUrl');
      expect(actor).not.toHaveProperty('clerkId');
      expect(actor).not.toHaveProperty('createdAt');
      expect(actor).not.toHaveProperty('updatedAt');
    });
  });
});
