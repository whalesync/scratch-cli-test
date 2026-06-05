/* eslint-disable @typescript-eslint/unbound-method */
import { DbService } from 'src/db/db.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { UserCluster } from '../db/cluster-types';
import { UsersService } from './users.service';

/**
 * Unit tests for the Whalesync shadow-user provisioning and session-token methods on UsersService.
 * The DB client is mocked; these assert the shape of the rows we write (synthetic clerkId, `ws:`-prefixed
 * email, token type/TTL) and the idempotency behavior — not real persistence (see the integration suite
 * `test/integration/whalesync-shadow-user.spec.ts` for end-to-end coverage).
 */
describe('UsersService — Whalesync shadow users', () => {
  let service: UsersService;
  let dbService: jest.Mocked<DbService>;
  let postHogService: jest.Mocked<PostHogService>;

  // Typed extraction of a Prisma mock call's `{ data }` argument (avoids `any` member access).
  function firstCallData(mock: jest.Mock): Record<string, unknown> {
    const firstCallArgs = mock.mock.calls[0] as unknown[];
    return (firstCallArgs[0] as { data: Record<string, unknown> }).data;
  }

  function makeShadowUser(overrides: Partial<UserCluster.User> = {}): UserCluster.User {
    return {
      id: 'usr_shadow_1',
      clerkId: 'ws_wsu-123',
      whalesyncUserId: 'wsu-123',
      name: 'Ada Lovelace',
      email: 'ws:ada@example.com',
      organizationId: 'org_shadow_1',
      apiTokens: [],
      ...overrides,
    } as unknown as UserCluster.User;
  }

  beforeEach(() => {
    dbService = {
      client: {
        user: {
          findFirst: jest.fn(),
          create: jest.fn(),
          update: jest.fn(),
          delete: jest.fn(),
        },
        workbook: {
          create: jest.fn().mockResolvedValue({ id: 'wkb_1' }),
        },
        apiToken: {
          create: jest.fn(),
          deleteMany: jest.fn(),
        },
        organization: {
          delete: jest.fn(),
        },
      },
    } as unknown as jest.Mocked<DbService>;

    postHogService = { identifyNewUser: jest.fn() } as unknown as jest.Mocked<PostHogService>;

    service = new UsersService(
      dbService,
      postHogService,
      {} as never, // configService — unused by these methods
      {} as never, // slackNotificationService — unused (shadow path skips Slack)
      {} as never, // emailService — unused
    );
  });

  afterEach(() => jest.clearAllMocks());

  describe('getOrCreateShadowUserFromWhalesync', () => {
    it('creates a shadow user with a synthetic ws_ clerkId and ws:-prefixed, normalized email', async () => {
      (dbService.client.user.findFirst as jest.Mock).mockResolvedValue(null);
      const created = makeShadowUser();
      (dbService.client.user.create as jest.Mock).mockResolvedValue(created);

      const result = await service.getOrCreateShadowUserFromWhalesync('wsu-123', '  Ada@Example.COM  ', 'Ada Lovelace');

      expect(result).toBe(created);
      expect(dbService.client.user.create).toHaveBeenCalledTimes(1);
      const createData = firstCallData(dbService.client.user.create as jest.Mock);
      expect(createData.clerkId).toBe('ws_wsu-123');
      expect(createData.whalesyncUserId).toBe('wsu-123');
      // ws: prefix applied AND pre-normalized (trim + lowercase) to match the DB email trigger
      expect(createData.email).toBe('ws:ada@example.com');
      expect(postHogService.identifyNewUser).toHaveBeenCalledWith(created);
    });

    it('is idempotent: returns the existing shadow user without creating a new one', async () => {
      const existing = makeShadowUser();
      (dbService.client.user.findFirst as jest.Mock).mockResolvedValue(existing);

      const result = await service.getOrCreateShadowUserFromWhalesync('wsu-123', 'ada@example.com', 'Ada Lovelace');

      expect(result).toBe(existing);
      expect(dbService.client.user.create).not.toHaveBeenCalled();
      expect(dbService.client.user.update).not.toHaveBeenCalled();
      expect(postHogService.identifyNewUser).not.toHaveBeenCalled();
    });

    it('refreshes name/email on an existing shadow user only when they changed', async () => {
      const existing = makeShadowUser({ name: 'Old Name', email: 'ws:ada@example.com' });
      (dbService.client.user.findFirst as jest.Mock).mockResolvedValue(existing);

      await service.getOrCreateShadowUserFromWhalesync('wsu-123', 'ada@example.com', 'New Name');

      expect(dbService.client.user.update).toHaveBeenCalledTimes(1);
      expect(firstCallData(dbService.client.user.update as jest.Mock).name).toBe('New Name');
    });
  });

  describe('mintWhalesyncSessionToken', () => {
    it('creates an additive WHALESYNC_SESSION token expiring ~10 minutes out', async () => {
      const expiresAt = new Date(Date.now() + 1000 * 60 * 10);
      (dbService.client.apiToken.create as jest.Mock).mockResolvedValue({ token: 'tok_abc', expiresAt });

      const result = await service.mintWhalesyncSessionToken('usr_shadow_1');

      expect(result).toEqual({ token: 'tok_abc', expiresAt });
      const createData = firstCallData(dbService.client.apiToken.create as jest.Mock);
      expect(createData.type).toBe('WHALESYNC_SESSION');
      expect(createData.userId).toBe('usr_shadow_1');
      const ttlMs = (createData.expiresAt as Date).getTime() - Date.now();
      expect(ttlMs).toBeGreaterThan(1000 * 60 * 9);
      expect(ttlMs).toBeLessThanOrEqual(1000 * 60 * 10 + 1000);
      // Additive — must NOT delete sibling tokens (unlike generateUserApiToken)
      expect(dbService.client.apiToken.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('revokeWhalesyncSessionTokens', () => {
    it('deletes only WHALESYNC_SESSION rows and returns the count', async () => {
      (dbService.client.apiToken.deleteMany as jest.Mock).mockResolvedValue({ count: 3 });

      const result = await service.revokeWhalesyncSessionTokens('usr_shadow_1');

      expect(result).toBe(3);
      expect(dbService.client.apiToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'usr_shadow_1', type: 'WHALESYNC_SESSION' },
      });
    });
  });

  describe('deleteShadowUserAndOrganization', () => {
    it('deletes the user (cascading tokens) then the organization', async () => {
      await service.deleteShadowUserAndOrganization('usr_shadow_1', 'org_shadow_1');

      expect(dbService.client.user.delete).toHaveBeenCalledWith({ where: { id: 'usr_shadow_1' } });
      expect(dbService.client.organization.delete).toHaveBeenCalledWith({ where: { id: 'org_shadow_1' } });
    });

    it('warns and continues when organization deletion fails', async () => {
      (dbService.client.organization.delete as jest.Mock).mockRejectedValue(new Error('still referenced'));

      await expect(service.deleteShadowUserAndOrganization('usr_shadow_1', 'org_shadow_1')).resolves.toBeUndefined();
      expect(dbService.client.user.delete).toHaveBeenCalled();
    });

    it('skips organization deletion when no organizationId is provided', async () => {
      await service.deleteShadowUserAndOrganization('usr_shadow_1', undefined);

      expect(dbService.client.user.delete).toHaveBeenCalled();
      expect(dbService.client.organization.delete).not.toHaveBeenCalled();
    });
  });
});
