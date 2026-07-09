import { UserCluster } from 'src/db/cluster-types';
import { SlackFormatters } from './slack-formatters';

describe('SlackFormatters', () => {
  describe('formatLink', () => {
    it('should format a basic link correctly', () => {
      const result = SlackFormatters.formatLink('Google', 'https://google.com');
      expect(result).toBe('<https://google.com|Google>');
    });

    it('should handle links with special characters in label', () => {
      const result = SlackFormatters.formatLink('Test & Demo', 'https://example.com');
      expect(result).toBe('<https://example.com|Test & Demo>');
    });

    it('should handle links with query parameters', () => {
      const result = SlackFormatters.formatLink('Search', 'https://example.com?q=test&page=2');
      expect(result).toBe('<https://example.com?q=test&page=2|Search>');
    });

    it('should handle links with fragments', () => {
      const result = SlackFormatters.formatLink('Section', 'https://example.com#section-1');
      expect(result).toBe('<https://example.com#section-1|Section>');
    });

    it('should handle empty label', () => {
      const result = SlackFormatters.formatLink('', 'https://example.com');
      expect(result).toBe('<https://example.com|>');
    });

    it('should handle long labels', () => {
      const longLabel = 'This is a very long label that might be used in practice';
      const result = SlackFormatters.formatLink(longLabel, 'https://example.com');
      expect(result).toBe(`<https://example.com|${longLabel}>`);
    });

    it('should handle URLs with pipes (edge case for Slack)', () => {
      // Pipes are special in Slack markdown, but this formatter doesn't escape them
      const result = SlackFormatters.formatLink('Link', 'https://example.com?param=value|other');
      expect(result).toBe('<https://example.com?param=value|other|Link>');
    });

    it('should handle Unicode characters in label', () => {
      const result = SlackFormatters.formatLink('🚀 Rocket', 'https://example.com');
      expect(result).toBe('<https://example.com|🚀 Rocket>');
    });
  });

  describe('newUserSignup', () => {
    // Helper function to create a minimal user object for testing
    const createTestUser = (overrides: Partial<Pick<UserCluster.User, 'id' | 'email' | 'name'>>): UserCluster.User => {
      return {
        id: overrides.id || 'user_123',
        email: overrides.email,
        name: overrides.name,
        apiTokens: [],
        organization: null,
      } as unknown as UserCluster.User;
    };

    it('should format new user with email', () => {
      const user = createTestUser({
        id: 'user_123',
        email: 'test@example.com',
        name: 'Test User',
      });

      const result = SlackFormatters.newUserSignup(user);
      expect(result).toBe('👤 New user signup: test@example.com (user_123) ');
    });

    it('should format new user with email and offer code', () => {
      const user = createTestUser({
        id: 'user_123',
        email: 'test@example.com',
        name: 'Test User',
      });

      const result = SlackFormatters.newUserSignup(user, 'PROMO2024');
      expect(result).toBe('👤 New user signup: test@example.com (user_123) with offer code PROMO2024');
    });

    it('should use name when email is not available', () => {
      const user = createTestUser({
        id: 'user_123',
        email: null,
        name: 'Test User',
      });

      const result = SlackFormatters.newUserSignup(user);
      expect(result).toBe('👤 New user signup: Test User (user_123) ');
    });

    it('should use "no email" when neither email nor name is available', () => {
      const user = createTestUser({
        id: 'user_123',
        email: null,
        name: null,
      });

      const result = SlackFormatters.newUserSignup(user);
      expect(result).toBe('👤 New user signup: no email (user_123) ');
    });

    it('should use "no email" when email and name are empty strings', () => {
      const user = createTestUser({
        id: 'user_123',
        email: '',
        name: '',
      });

      const result = SlackFormatters.newUserSignup(user);
      expect(result).toBe('👤 New user signup: no email (user_123) ');
    });

    it('should prefer email over name when both are available', () => {
      const user = createTestUser({
        id: 'user_123',
        email: 'test@example.com',
        name: 'Test User',
      });

      const result = SlackFormatters.newUserSignup(user);
      expect(result).toContain('test@example.com');
      expect(result).not.toContain('Test User');
    });

    it('should handle offer code with special characters', () => {
      const user = createTestUser({
        id: 'user_123',
        email: 'test@example.com',
        name: 'Test User',
      });

      const result = SlackFormatters.newUserSignup(user, 'PROMO-2024_V2');
      expect(result).toBe('👤 New user signup: test@example.com (user_123) with offer code PROMO-2024_V2');
    });

    it('should handle empty offer code string', () => {
      const user = createTestUser({
        id: 'user_123',
        email: 'test@example.com',
        name: 'Test User',
      });

      const result = SlackFormatters.newUserSignup(user, '');
      expect(result).toBe('👤 New user signup: test@example.com (user_123) ');
    });

    it('should handle user with only undefined properties', () => {
      const user = createTestUser({
        id: 'user_123',
        email: undefined,
        name: undefined,
      });

      const result = SlackFormatters.newUserSignup(user);
      expect(result).toBe('👤 New user signup: no email (user_123) ');
    });

    it('should include user ID in all cases', () => {
      const user1 = createTestUser({
        id: 'user_abc123',
        email: 'test@example.com',
      });

      const user2 = createTestUser({
        id: 'user_xyz789',
        name: 'Test User',
      });

      const result1 = SlackFormatters.newUserSignup(user1);
      const result2 = SlackFormatters.newUserSignup(user2);

      expect(result1).toContain('user_abc123');
      expect(result2).toContain('user_xyz789');
    });
  });

  describe('userIdentifier', () => {
    const createTestUser = (overrides: Partial<Pick<UserCluster.User, 'id' | 'email' | 'name'>>): UserCluster.User => {
      return {
        id: overrides.id || 'user_123',
        email: overrides.email,
        name: overrides.name,
        apiTokens: [],
        organization: null,
      } as unknown as UserCluster.User;
    };

    it('should format user with email using default emoji', () => {
      const user = createTestUser({
        id: 'user_123',
        email: 'test@example.com',
        name: 'Test User',
      });

      const result = SlackFormatters.userIdentifier(user);
      expect(result).toBe('👤 test@example.com ');
    });

    it('should format user with email and custom emoji', () => {
      const user = createTestUser({
        id: 'user_123',
        email: 'test@example.com',
        name: 'Test User',
      });

      const result = SlackFormatters.userIdentifier(user, '🚀');
      expect(result).toBe('🚀 test@example.com ');
    });

    it('should format user with email and include ID', () => {
      const user = createTestUser({
        id: 'user_123',
        email: 'test@example.com',
        name: 'Test User',
      });

      const result = SlackFormatters.userIdentifier(user, '👤', true);
      expect(result).toBe('👤 test@example.com (user_123)');
    });

    it('should use name when email is not available', () => {
      const user = createTestUser({
        id: 'user_123',
        email: null,
        name: 'Test User',
      });

      const result = SlackFormatters.userIdentifier(user);
      expect(result).toBe('👤 Test User ');
    });

    it('should use ID when neither email nor name is available', () => {
      const user = createTestUser({
        id: 'user_123',
        email: null,
        name: null,
      });

      const result = SlackFormatters.userIdentifier(user);
      expect(result).toBe('👤 user_123 ');
    });

    it('should prefer email over name when both are available', () => {
      const user = createTestUser({
        id: 'user_123',
        email: 'test@example.com',
        name: 'Test User',
      });

      const result = SlackFormatters.userIdentifier(user);
      expect(result).toContain('test@example.com');
      expect(result).not.toContain('Test User');
    });
  });

  describe('whalesyncAccountLinked', () => {
    const createTestUser = (overrides: Partial<Pick<UserCluster.User, 'id' | 'email' | 'name'>>): UserCluster.User => {
      return {
        id: overrides.id || 'usr_native_1',
        email: overrides.email,
        name: overrides.name,
        apiTokens: [],
        organization: null,
      } as unknown as UserCluster.User;
    };

    it('includes the Scratch user id, email, and the Whalesync user id', () => {
      const user = createTestUser({ id: 'usr_native_1', email: 'ada@example.com', name: 'Ada Lovelace' });

      const result = SlackFormatters.whalesyncAccountLinked(user, 'wsu-123');

      expect(result).toBe(
        '🔗 *Whalesync account linked*\n👤 ada@example.com (usr_native_1)\n🐳 Whalesync user: wsu-123',
      );
    });

    it('falls back to name then id when the email is missing', () => {
      const withName = SlackFormatters.whalesyncAccountLinked(createTestUser({ id: 'usr_1', name: 'Ada' }), 'wsu-1');
      expect(withName).toContain('👤 Ada (usr_1)');

      const withoutNameOrEmail = SlackFormatters.whalesyncAccountLinked(createTestUser({ id: 'usr_2' }), 'wsu-2');
      expect(withoutNameOrEmail).toContain('👤 usr_2 (usr_2)');
    });
  });

  describe('clerkAccountLinked', () => {
    const createTestUser = (overrides: Partial<Pick<UserCluster.User, 'id' | 'email' | 'name'>>): UserCluster.User => {
      return {
        id: overrides.id || 'usr_shadow_1',
        email: overrides.email,
        name: overrides.name,
        apiTokens: [],
        organization: null,
      } as unknown as UserCluster.User;
    };

    it('includes the Scratch user id, email, and the real clerk id', () => {
      const user = createTestUser({ id: 'usr_shadow_1', email: 'ada@example.com', name: 'Ada Lovelace' });

      const result = SlackFormatters.clerkAccountLinked(user, 'user_realclerkid');

      expect(result).toBe(
        '🔗 *Native Clerk sign-in linked to shadow user*\n👤 ada@example.com (usr_shadow_1)\n🔑 Clerk id: user_realclerkid',
      );
    });

    it('falls back to name then id when the email is missing', () => {
      const withName = SlackFormatters.clerkAccountLinked(createTestUser({ id: 'usr_1', name: 'Ada' }), 'user_1');
      expect(withName).toContain('👤 Ada (usr_1)');

      const withoutNameOrEmail = SlackFormatters.clerkAccountLinked(createTestUser({ id: 'usr_2' }), 'user_2');
      expect(withoutNameOrEmail).toContain('👤 usr_2 (usr_2)');
    });
  });

  describe('SlackFormatters class', () => {
    it('should not be instantiable (utility class pattern)', () => {
      // The constructor is private, so we can't test instantiation directly
      // But we can verify all methods are static
      expect(typeof SlackFormatters.formatLink).toBe('function');
      expect(typeof SlackFormatters.newUserSignup).toBe('function');
      expect(typeof SlackFormatters.userIdentifier).toBe('function');
      expect(typeof SlackFormatters.whalesyncAccountLinked).toBe('function');
      expect(typeof SlackFormatters.clerkAccountLinked).toBe('function');
    });
  });
});
