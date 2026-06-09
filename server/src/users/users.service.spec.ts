/* eslint-disable @typescript-eslint/unbound-method */
import { DbService } from 'src/db/db.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { UserCluster } from '../db/cluster-types';
import { UsersService } from './users.service';

/**
 * Unit tests for the Whalesync shadow-user provisioning and session-token methods on UsersService.
 * The DB client is mocked; these assert the shape of the rows we write (synthetic clerkId, real
 * un-prefixed email, token type/TTL), the email-reconciliation branches (create / adopt / collision),
 * and the idempotency behavior — not real persistence (see the integration suite
 * `test/integration/whalesync-shadow-user.spec.ts` for end-to-end coverage).
 */
describe('UsersService — Whalesync shadow users', () => {
  let service: UsersService;
  let dbService: jest.Mocked<DbService>;
  let postHogService: jest.Mocked<PostHogService>;
  let slackNotificationService: { sendMessage: jest.Mock };

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
      email: 'ada@example.com',
      organizationId: 'org_shadow_1',
      apiTokens: [],
      ...overrides,
    } as unknown as UserCluster.User;
  }

  // A pre-existing native Scratch user (real Clerk login, not yet linked to any Whalesync identity).
  function makeNativeUser(overrides: Partial<UserCluster.User> = {}): UserCluster.User {
    return {
      id: 'usr_native_1',
      clerkId: 'user_realclerkid',
      whalesyncUserId: null,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      organizationId: 'org_native_1',
      apiTokens: [],
      ...overrides,
    } as unknown as UserCluster.User;
  }

  beforeEach(() => {
    dbService = {
      client: {
        user: {
          findFirst: jest.fn(),
          findUnique: jest.fn(),
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

    postHogService = {
      identifyNewUser: jest.fn(),
      trackWhalesyncAccountLinked: jest.fn(),
    } as unknown as jest.Mocked<PostHogService>;

    slackNotificationService = { sendMessage: jest.fn().mockResolvedValue(undefined) };

    service = new UsersService(
      dbService,
      postHogService,
      {} as never, // configService — unused by these methods
      slackNotificationService as never, // slackNotificationService — used by the adopt path
      {} as never, // emailService — unused
    );
  });

  afterEach(() => jest.clearAllMocks());

  describe('getOrCreateShadowUserFromWhalesync', () => {
    it('creates a shadow user with a synthetic ws_ clerkId and a real, normalized (un-prefixed) email', async () => {
      // No user by whalesyncUserId, and no user owns the email → create fresh.
      (dbService.client.user.findFirst as jest.Mock).mockResolvedValue(null);
      (dbService.client.user.findUnique as jest.Mock).mockResolvedValue(null);
      const created = makeShadowUser();
      (dbService.client.user.create as jest.Mock).mockResolvedValue(created);

      const result = await service.getOrCreateShadowUserFromWhalesync('wsu-123', '  Ada@Example.COM  ', 'Ada Lovelace');

      expect(result).toBe(created);
      expect(dbService.client.user.create).toHaveBeenCalledTimes(1);
      const createData = firstCallData(dbService.client.user.create as jest.Mock);
      expect(createData.clerkId).toBe('ws_wsu-123');
      expect(createData.whalesyncUserId).toBe('wsu-123');
      // Real address, NOT ws:-prefixed, pre-normalized (trim + lowercase) to match the DB email trigger.
      expect(createData.email).toBe('ada@example.com');
      expect(postHogService.identifyNewUser).toHaveBeenCalledWith(created);
      // Creating a brand-new shadow user is not a "link" — no Slack notification (that's adopt-only).
      expect(slackNotificationService.sendMessage).not.toHaveBeenCalled();
    });

    it('adopts an existing native Scratch user that owns the email, linking it without creating a duplicate', async () => {
      // No user by whalesyncUserId, but a native (unlinked) user owns the email → adopt it.
      (dbService.client.user.findFirst as jest.Mock).mockResolvedValue(null);
      const nativeUser = makeNativeUser();
      (dbService.client.user.findUnique as jest.Mock).mockResolvedValue(nativeUser);
      const linkedUser = makeNativeUser({ whalesyncUserId: 'wsu-123' });
      (dbService.client.user.update as jest.Mock).mockResolvedValue(linkedUser);

      const result = await service.getOrCreateShadowUserFromWhalesync('wsu-123', 'ada@example.com', 'Ada Lovelace');

      expect(result).toBe(linkedUser);
      // No new user — we link the existing one.
      expect(dbService.client.user.create).not.toHaveBeenCalled();
      expect(dbService.client.user.update).toHaveBeenCalledTimes(1);
      const updateCallArgs = (dbService.client.user.update as jest.Mock).mock.calls[0] as unknown[];
      const updateArgs = updateCallArgs[0] as { where: { id: string }; data: Record<string, unknown> };
      expect(updateArgs.where.id).toBe('usr_native_1');
      // Only whalesyncUserId is set — the native clerkId / email / org are preserved.
      expect(updateArgs.data).toEqual({ whalesyncUserId: 'wsu-123' });
      // Adopt path does not re-identify (the user already exists; firing "created" again would be wrong)...
      expect(postHogService.identifyNewUser).not.toHaveBeenCalled();
      // ...but it DOES fire the dedicated link event with the linked user and the Whalesync id.
      expect(postHogService.trackWhalesyncAccountLinked).toHaveBeenCalledWith(linkedUser, 'wsu-123');
      // ...and posts a Slack notification (linking is rare and worth surfacing). The message carries
      // both the Scratch user id and the Whalesync id.
      expect(slackNotificationService.sendMessage).toHaveBeenCalledTimes(1);
      const slackCallArgs = slackNotificationService.sendMessage.mock.calls[0] as unknown[];
      const slackMessage = slackCallArgs[0] as string;
      expect(slackMessage).toContain('usr_native_1');
      expect(slackMessage).toContain('wsu-123');
    });

    it('creates a shadow user with no email when the email is already linked to a different Whalesync user', async () => {
      // No user by whalesyncUserId, but the email is owned by a DIFFERENT Whalesync identity → cannot adopt.
      (dbService.client.user.findFirst as jest.Mock).mockResolvedValue(null);
      const otherWhalesyncUser = makeShadowUser({
        id: 'usr_other',
        whalesyncUserId: 'wsu-other',
        clerkId: 'ws_wsu-other',
      });
      (dbService.client.user.findUnique as jest.Mock).mockResolvedValue(otherWhalesyncUser);
      const created = makeShadowUser({ email: null });
      (dbService.client.user.create as jest.Mock).mockResolvedValue(created);

      const result = await service.getOrCreateShadowUserFromWhalesync('wsu-123', 'ada@example.com', 'Ada Lovelace');

      expect(result).toBe(created);
      expect(dbService.client.user.update).not.toHaveBeenCalled();
      expect(dbService.client.user.create).toHaveBeenCalledTimes(1);
      const createData = firstCallData(dbService.client.user.create as jest.Mock);
      expect(createData.clerkId).toBe('ws_wsu-123');
      expect(createData.whalesyncUserId).toBe('wsu-123');
      // The colliding address is owned by another identity, so the new user gets no email.
      expect(createData.email).toBeUndefined();
      expect(postHogService.identifyNewUser).toHaveBeenCalledWith(created);
    });

    it('is idempotent: returns the existing linked user without creating or updating when nothing changed', async () => {
      const existing = makeShadowUser();
      (dbService.client.user.findFirst as jest.Mock).mockResolvedValue(existing);

      const result = await service.getOrCreateShadowUserFromWhalesync('wsu-123', 'ada@example.com', 'Ada Lovelace');

      expect(result).toBe(existing);
      expect(dbService.client.user.findUnique).not.toHaveBeenCalled();
      expect(dbService.client.user.create).not.toHaveBeenCalled();
      expect(dbService.client.user.update).not.toHaveBeenCalled();
      expect(postHogService.identifyNewUser).not.toHaveBeenCalled();
    });

    it('refreshes name on an already-linked user when only the name changed', async () => {
      const existing = makeShadowUser({ name: 'Old Name' });
      (dbService.client.user.findFirst as jest.Mock).mockResolvedValue(existing);
      (dbService.client.user.update as jest.Mock).mockResolvedValue(makeShadowUser({ name: 'New Name' }));

      await service.getOrCreateShadowUserFromWhalesync('wsu-123', 'ada@example.com', 'New Name');

      // Email unchanged → no collision check needed.
      expect(dbService.client.user.findUnique).not.toHaveBeenCalled();
      expect(dbService.client.user.update).toHaveBeenCalledTimes(1);
      expect(firstCallData(dbService.client.user.update as jest.Mock)).toEqual({ name: 'New Name' });
    });

    it('organically un-prefixes a legacy ws: shadow email when the un-prefixed address is free', async () => {
      const legacyShadowUser = makeShadowUser({ email: 'ws:ada@example.com' });
      (dbService.client.user.findFirst as jest.Mock).mockResolvedValue(legacyShadowUser);
      // No other user owns the un-prefixed address → safe to rewrite.
      (dbService.client.user.findUnique as jest.Mock).mockResolvedValue(null);
      (dbService.client.user.update as jest.Mock).mockResolvedValue(makeShadowUser());

      await service.getOrCreateShadowUserFromWhalesync('wsu-123', 'ada@example.com', 'Ada Lovelace');

      expect(dbService.client.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { email: 'ada@example.com' } }),
      );
      expect(dbService.client.user.update).toHaveBeenCalledTimes(1);
      expect(firstCallData(dbService.client.user.update as jest.Mock)).toEqual({ email: 'ada@example.com' });
    });

    it('skips the email refresh when the incoming address is owned by a different user', async () => {
      const legacyShadowUser = makeShadowUser({ email: 'ws:ada@example.com' });
      (dbService.client.user.findFirst as jest.Mock).mockResolvedValue(legacyShadowUser);
      // A different user already owns the un-prefixed address → must not clobber the @unique column.
      (dbService.client.user.findUnique as jest.Mock).mockResolvedValue(makeNativeUser());

      const result = await service.getOrCreateShadowUserFromWhalesync('wsu-123', 'ada@example.com', 'Ada Lovelace');

      // Name unchanged and email blocked → no write at all; the existing row is returned untouched.
      expect(result).toBe(legacyShadowUser);
      expect(dbService.client.user.update).not.toHaveBeenCalled();
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
