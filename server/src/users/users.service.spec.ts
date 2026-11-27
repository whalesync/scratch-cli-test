/* eslint-disable @typescript-eslint/unbound-method */
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DbService } from 'src/db/db.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { WorkbookProvisioningService } from 'src/workbook/workbook-provisioning.service';
import { UserCluster } from '../db/cluster-types';
import { UsersService } from './users.service';

/**
 * Unit tests for the Whalesync shadow-user provisioning and session-token methods on UsersService.
 * The DB client is mocked; these assert the shape of the rows we write (synthetic `ws_<team>` clerkId,
 * no email, token type/TTL), the lookup by team only, the refusal of a real Scratch account, the
 * native sign-up's adopt-by-email branches, and idempotency — not real persistence (see the
 * integration suites `test/integration/whalesync-*.spec.ts` for that).
 */
describe('UsersService — Whalesync shadow users', () => {
  let service: UsersService;
  let dbService: jest.Mocked<DbService>;
  let postHogService: jest.Mocked<PostHogService>;
  let slackNotificationService: { sendMessage: jest.Mock };
  let workbookProvisioningService: jest.Mocked<WorkbookProvisioningService>;

  // Typed extraction of a Prisma mock call's `{ data }` argument (avoids `any` member access).
  function firstCallData(mock: jest.Mock): Record<string, unknown> {
    const firstCallArgs = mock.mock.calls[0] as unknown[];
    return (firstCallArgs[0] as { data: Record<string, unknown> }).data;
  }

  function makeShadowUser(overrides: Partial<UserCluster.User> = {}): UserCluster.User {
    return {
      id: 'usr_shadow_1',
      clerkId: 'ws_wsu-123',
      whalesyncUserId: null,
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
      whalesyncTeamId: null,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      organizationId: 'org_native_1',
      apiTokens: [],
      ...overrides,
    } as unknown as UserCluster.User;
  }

  // A non-expired WEBSOCKET token so the getOrCreateUserFromClerk token-ensuring block is a no-op
  // (the user already has a valid websocket token), keeping the adopt/hit tests focused on identity.
  function makeFutureWebsocketToken(): UserCluster.User['apiTokens'][number] {
    return {
      id: 'tok_ws_1',
      type: 'WEBSOCKET',
      token: 'ws-token-value',
      userId: 'usr_shadow_1',
      scopes: [],
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    } as unknown as UserCluster.User['apiTokens'][number];
  }

  beforeEach(() => {
    dbService = {
      client: {
        user: {
          findFirst: jest.fn(),
          findUnique: jest.fn(),
          findMany: jest.fn(),
          create: jest.fn(),
          update: jest.fn(),
          updateMany: jest.fn(),
          delete: jest.fn(),
        },
        workbook: {
          create: jest.fn().mockResolvedValue({ id: 'wkb_1' }),
        },
        apiToken: {
          create: jest.fn().mockResolvedValue(makeFutureWebsocketToken()),
          deleteMany: jest.fn(),
        },
        organization: {
          delete: jest.fn(),
        },
        // Queried by the native create path (getOrCreateUserFromClerk → redeemWorkspaceInvites).
        workspaceInvites: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        // Array form resolves the already-built operations, the way Prisma runs them in one transaction; the
        // interactive form gets the client itself as its transaction.
        $transaction: jest.fn((operations: Promise<unknown>[] | ((transaction: unknown) => Promise<unknown>)) =>
          typeof operations === 'function' ? operations(dbService.client) : Promise.all(operations),
        ),
      },
    } as unknown as jest.Mocked<DbService>;

    postHogService = {
      identifyNewUser: jest.fn(),
      trackClerkAccountLinked: jest.fn(),
    } as unknown as jest.Mocked<PostHogService>;

    slackNotificationService = { sendMessage: jest.fn().mockResolvedValue(undefined) };

    workbookProvisioningService = {
      createWorkbookWithConfigRepo: jest.fn().mockResolvedValue({ id: 'wkb_1' }),
    } as unknown as jest.Mocked<WorkbookProvisioningService>;

    service = new UsersService(
      dbService,
      postHogService,
      {} as never, // configService — unused by these methods
      slackNotificationService as never, // slackNotificationService — used by the adopt paths
      {} as never, // emailService — unused (invite redemption finds no invites in these tests)
      workbookProvisioningService,
      // experimentsService — the native create path checks the auto-trial flag (off here → no trial).
      { getBooleanFlag: jest.fn().mockResolvedValue(false) } as never,
      // stripePaymentService — the shadow-user path assigns the Whalesync plan via this method.
      {
        createTrialSubscription: jest.fn(),
        ensureWhalesyncPlanSubscription: jest.fn().mockResolvedValue(undefined),
      } as never,
    );
  });

  afterEach(() => jest.clearAllMocks());

  describe('a shadow user per Whalesync team (DEV-13019)', () => {
    const TEAM_ID = 'tm_abc123def456';

    function makeTeamShadowUser(overrides: Partial<UserCluster.User> = {}): UserCluster.User {
      return makeShadowUser({
        clerkId: `ws_${TEAM_ID}`,
        whalesyncUserId: null,
        whalesyncTeamId: TEAM_ID,
        name: 'Acme',
        email: null,
        ...overrides,
      });
    }

    // The service looks a team's shadow user up through `findUnique` on the unique team id. Successive lookups return
    // successive entries; the last one repeats.
    function mockShadowUserLookupsByTeamId(foundByTeamId: Array<UserCluster.User | null>): void {
      const remainingLookupResults = [...foundByTeamId];
      (dbService.client.user.findUnique as jest.Mock).mockImplementation(
        (args: { where: { whalesyncTeamId?: string } }) => {
          if (args.where.whalesyncTeamId === undefined) {
            return Promise.resolve(null);
          }
          return Promise.resolve(
            remainingLookupResults.length > 1 ? remainingLookupResults.shift() : (remainingLookupResults[0] ?? null),
          );
        },
      );
    }

    function uniqueConstraintViolation(): Error {
      return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      });
    }

    it('creates a pure shadow user for a new team: ws_<team> clerkId, the team name, no email, no person', async () => {
      mockShadowUserLookupsByTeamId([null]);
      const createdShadowUser = makeTeamShadowUser();
      (dbService.client.user.create as jest.Mock).mockResolvedValue(createdShadowUser);

      const result = await service.getOrCreateShadowUserForWhalesyncTeam(TEAM_ID, 'Acme');

      expect(result).toBe(createdShadowUser);
      const createData = firstCallData(dbService.client.user.create as jest.Mock);
      expect(createData.clerkId).toBe(`ws_${TEAM_ID}`);
      expect(createData.whalesyncTeamId).toBe(TEAM_ID);
      expect(createData.name).toBe('Acme');
      expect(createData.email).toBeUndefined();
      expect(createData).not.toHaveProperty('whalesyncUserId');
      expect(postHogService.identifyNewUser).toHaveBeenCalledWith(createdShadowUser);
      expect(slackNotificationService.sendMessage).not.toHaveBeenCalled();
    });

    it('provisions the default workspace (row + config repo together) via the shared provisioning service', async () => {
      // Regression for the signup default-workspace bug: this path used to call db.workbook.create
      // directly and never initialized the config git repo, so the desktop's init-workspace clone
      // 404'd ("Repository not found"). It must route through WorkbookProvisioningService — the
      // same primitive the manual "create workspace" flow uses — so the two can't diverge again.
      mockShadowUserLookupsByTeamId([null]);
      (dbService.client.user.create as jest.Mock).mockResolvedValue(makeTeamShadowUser());

      await service.getOrCreateShadowUserForWhalesyncTeam(TEAM_ID, 'Acme');

      expect(workbookProvisioningService.createWorkbookWithConfigRepo).toHaveBeenCalledTimes(1);
      expect(workbookProvisioningService.createWorkbookWithConfigRepo).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'My Scratch workspace',
          ownerUserId: 'usr_shadow_1',
          setAsOwnerDefaultWorkspace: true,
        }),
      );
      expect(dbService.client.workbook.create).not.toHaveBeenCalled();
    });

    it("reuses the team's shadow user for every session, without touching its name", async () => {
      const teamShadowUser = makeTeamShadowUser();
      mockShadowUserLookupsByTeamId([teamShadowUser]);

      const firstSessionShadowUser = await service.getOrCreateShadowUserForWhalesyncTeam(TEAM_ID, 'Acme');
      const secondSessionShadowUser = await service.getOrCreateShadowUserForWhalesyncTeam(TEAM_ID, 'Renamed team');

      expect(firstSessionShadowUser).toBe(teamShadowUser);
      expect(secondSessionShadowUser).toBe(teamShadowUser);
      expect(dbService.client.user.create).not.toHaveBeenCalled();
      expect(dbService.client.user.update).not.toHaveBeenCalled();
      expect(dbService.client.user.updateMany).not.toHaveBeenCalled();
    });

    it('never looks anyone up by Whalesync person or email', async () => {
      mockShadowUserLookupsByTeamId([null]);
      (dbService.client.user.create as jest.Mock).mockResolvedValue(makeTeamShadowUser());

      await service.getOrCreateShadowUserForWhalesyncTeam(TEAM_ID, 'Acme');

      const lookupCalls = [
        ...((dbService.client.user.findUnique as jest.Mock).mock.calls as unknown[][]),
        ...((dbService.client.user.findFirst as jest.Mock).mock.calls as unknown[][]),
      ];
      const lookupWhereClauses = lookupCalls.map((call) => (call[0] as { where: Record<string, unknown> }).where);
      expect(lookupWhereClauses).toEqual([{ whalesyncTeamId: TEAM_ID }]);
    });

    it('returns the shadow user another request created when two first sessions race', async () => {
      const createdByOtherRequest = makeTeamShadowUser({ id: 'usr_other' });
      mockShadowUserLookupsByTeamId([null, createdByOtherRequest]);
      (dbService.client.user.create as jest.Mock).mockRejectedValue(uniqueConstraintViolation());

      const result = await service.getOrCreateShadowUserForWhalesyncTeam(TEAM_ID);

      expect(result).toBe(createdByOtherRequest);
    });

    it('rethrows a failed create that is not a race', async () => {
      mockShadowUserLookupsByTeamId([null]);
      (dbService.client.user.create as jest.Mock).mockRejectedValue(new Error('db unavailable'));

      await expect(service.getOrCreateShadowUserForWhalesyncTeam(TEAM_ID)).rejects.toThrow('db unavailable');
    });

    it('refuses with a 409 a team id held by a real Scratch account, creating nothing', async () => {
      const realScratchAccountHoldingTeam = makeNativeUser({ whalesyncTeamId: TEAM_ID });
      mockShadowUserLookupsByTeamId([realScratchAccountHoldingTeam]);

      await expect(service.getOrCreateShadowUserForWhalesyncTeam(TEAM_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(dbService.client.user.create).not.toHaveBeenCalled();
    });

    it('refuses with a 409 a real Scratch account that won a race for the team id', async () => {
      const realScratchAccountHoldingTeam = makeNativeUser({ whalesyncTeamId: TEAM_ID });
      mockShadowUserLookupsByTeamId([null, realScratchAccountHoldingTeam]);
      (dbService.client.user.create as jest.Mock).mockRejectedValue(uniqueConstraintViolation());

      await expect(service.getOrCreateShadowUserForWhalesyncTeam(TEAM_ID)).rejects.toBeInstanceOf(ConflictException);
    });

    it('finds the team shadow user without creating one, and null for a team with none', async () => {
      const teamShadowUser = makeTeamShadowUser();
      mockShadowUserLookupsByTeamId([teamShadowUser]);
      await expect(service.findShadowUserForWhalesyncTeam(TEAM_ID, 'list')).resolves.toBe(teamShadowUser);

      mockShadowUserLookupsByTeamId([null]);
      await expect(service.findShadowUserForWhalesyncTeam(TEAM_ID, 'delete')).resolves.toBeNull();
      expect(dbService.client.user.create).not.toHaveBeenCalled();
    });

    it.each(['subscription', 'list', 'delete'] as const)(
      'refuses a %s request that would reach a real Scratch account',
      async (attemptedOperation) => {
        mockShadowUserLookupsByTeamId([makeNativeUser({ whalesyncTeamId: TEAM_ID })]);

        await expect(service.findShadowUserForWhalesyncTeam(TEAM_ID, attemptedOperation)).rejects.toBeInstanceOf(
          ConflictException,
        );
      },
    );
  });

  describe('getOrCreateUserFromClerk', () => {
    it('adopts a Whalesync shadow user that owns the email, updating only its clerkId (DEV-10731)', async () => {
      // No user by clerkId (the shadow row stores ws_…), but a shadow user owns the email → adopt it
      // into the real Clerk identity instead of colliding on the @unique email (the 401 root cause).
      (dbService.client.user.findFirst as jest.Mock).mockResolvedValue(null);
      const shadowUser = makeShadowUser();
      (dbService.client.user.findUnique as jest.Mock).mockResolvedValue(shadowUser);
      const adoptedUser = makeShadowUser({ clerkId: 'user_realclerkid', apiTokens: [makeFutureWebsocketToken()] });
      (dbService.client.user.update as jest.Mock).mockResolvedValue(adoptedUser);

      const result = await service.getOrCreateUserFromClerk('user_realclerkid', 'Ada Lovelace', 'ada@example.com');

      expect(result).toBe(adoptedUser);
      // No new user — we link the existing shadow row.
      expect(dbService.client.user.create).not.toHaveBeenCalled();
      // The email/name are unchanged, so the only write is the adopt itself.
      expect(dbService.client.user.update).toHaveBeenCalledTimes(1);
      const updateCallArgs = (dbService.client.user.update as jest.Mock).mock.calls[0] as unknown[];
      const updateArgs = updateCallArgs[0] as { where: { id: string }; data: Record<string, unknown> };
      expect(updateArgs.where.id).toBe('usr_shadow_1');
      // Only clerkId is set — email / org are preserved (dual-identity account).
      expect(updateArgs.data).toEqual({ clerkId: 'user_realclerkid' });
      // Adopt is a link, not a creation: no identifyNewUser.
      expect(postHogService.identifyNewUser).not.toHaveBeenCalled();
      // ...but it DOES fire the dedicated Clerk-link event with the linked user and the real clerkId.
      expect(postHogService.trackClerkAccountLinked).toHaveBeenCalledWith(adoptedUser, 'user_realclerkid');
      // ...and posts a Slack notification carrying both the Scratch user id and the clerkId.
      expect(slackNotificationService.sendMessage).toHaveBeenCalledTimes(1);
      const slackCallArgs = slackNotificationService.sendMessage.mock.calls[0] as unknown[];
      const slackMessage = slackCallArgs[0] as string;
      expect(slackMessage).toContain('usr_shadow_1');
      expect(slackMessage).toContain('user_realclerkid');
    });

    it('re-links (and warns) when the email is owned by a row with a real, non-ws_ clerkId', async () => {
      // Anomalous: email owned by a row that already has a real Clerk id (stale/rotated). Still adopt,
      // but the helper logs at warn rather than info; behavior (the update + link event) is unchanged.
      (dbService.client.user.findFirst as jest.Mock).mockResolvedValue(null);
      (dbService.client.user.findUnique as jest.Mock).mockResolvedValue(makeNativeUser({ clerkId: 'user_old' }));
      const relinked = makeNativeUser({ clerkId: 'user_new', apiTokens: [makeFutureWebsocketToken()] });
      (dbService.client.user.update as jest.Mock).mockResolvedValue(relinked);

      const result = await service.getOrCreateUserFromClerk('user_new', 'Ada Lovelace', 'ada@example.com');

      expect(result).toBe(relinked);
      expect(dbService.client.user.create).not.toHaveBeenCalled();
      expect(dbService.client.user.update).toHaveBeenCalledTimes(1);
      expect(firstCallData(dbService.client.user.update as jest.Mock)).toEqual({ clerkId: 'user_new' });
      expect(postHogService.trackClerkAccountLinked).toHaveBeenCalledWith(relinked, 'user_new');
    });

    it('creates a new user when no existing row owns the email', async () => {
      // No user by clerkId and nobody owns the email → the original native create path runs unchanged.
      (dbService.client.user.findFirst as jest.Mock).mockResolvedValue(null);
      (dbService.client.user.findUnique as jest.Mock).mockResolvedValue(null);
      const created = makeNativeUser({
        id: 'usr_created',
        clerkId: 'user_new',
        apiTokens: [makeFutureWebsocketToken()],
      });
      (dbService.client.user.create as jest.Mock).mockResolvedValue(created);

      const result = await service.getOrCreateUserFromClerk('user_new', 'New User', 'new@example.com');

      expect(result).toBe(created);
      expect(dbService.client.user.create).toHaveBeenCalledTimes(1);
      // A genuine new native signup: identify, but no adopt (no clerkId update / link event).
      expect(postHogService.identifyNewUser).toHaveBeenCalledWith(created);
      expect(dbService.client.user.update).not.toHaveBeenCalled();
      expect(postHogService.trackClerkAccountLinked).not.toHaveBeenCalled();
    });

    it('returns the existing user directly on a clerkId hit, never reconciling by email', async () => {
      const existing = makeNativeUser({ apiTokens: [makeFutureWebsocketToken()] });
      (dbService.client.user.findFirst as jest.Mock).mockResolvedValue(existing);

      const result = await service.getOrCreateUserFromClerk('user_realclerkid', 'Ada Lovelace', 'ada@example.com');

      expect(result).toBe(existing);
      // Found by clerkId → no email reconciliation, no create, no adopt.
      expect(dbService.client.user.findUnique).not.toHaveBeenCalled();
      expect(dbService.client.user.create).not.toHaveBeenCalled();
      expect(dbService.client.user.update).not.toHaveBeenCalled();
      expect(postHogService.trackClerkAccountLinked).not.toHaveBeenCalled();
    });

    it('skips email reconciliation entirely when no email is provided', async () => {
      (dbService.client.user.findFirst as jest.Mock).mockResolvedValue(null);
      const created = makeNativeUser({
        id: 'usr_created',
        clerkId: 'user_new',
        apiTokens: [makeFutureWebsocketToken()],
      });
      (dbService.client.user.create as jest.Mock).mockResolvedValue(created);

      await service.getOrCreateUserFromClerk('user_new', 'New User');

      // No email → cannot collide by email, so findByEmail (findUnique) is never called; straight to create.
      expect(dbService.client.user.findUnique).not.toHaveBeenCalled();
      expect(dbService.client.user.create).toHaveBeenCalledTimes(1);
      expect(postHogService.trackClerkAccountLinked).not.toHaveBeenCalled();
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

describe('UsersService.isSoleMemberOfOrganization', () => {
  function createService(userCountResult: number) {
    const userCount = jest.fn().mockResolvedValue(userCountResult);
    const dbService = {
      client: { user: { count: userCount } },
    } as unknown as jest.Mocked<DbService>;

    const service = new UsersService(
      dbService,
      {} as never, // postHogService — unused
      {} as never, // configService — unused
      {} as never, // slackNotificationService — unused
      {} as never, // emailService — unused
      {} as never, // workbookProvisioningService — unused
      {} as never, // experimentsService — unused
      {} as never, // stripePaymentService — unused
    );
    return { service, userCount };
  }

  it('returns false for a user with no organization without querying', async () => {
    const { service, userCount } = createService(1);

    await expect(service.isSoleMemberOfOrganization({ organizationId: null })).resolves.toBe(false);
    expect(userCount).not.toHaveBeenCalled();
  });

  it('returns true when the organization has exactly one member', async () => {
    const { service, userCount } = createService(1);

    await expect(service.isSoleMemberOfOrganization({ organizationId: 'org_solo' })).resolves.toBe(true);
    expect(userCount).toHaveBeenCalledWith({ where: { organizationId: 'org_solo' } });
  });

  it('returns false when the organization has more than one member', async () => {
    const { service } = createService(2);

    await expect(service.isSoleMemberOfOrganization({ organizationId: 'org_shared' })).resolves.toBe(false);
  });
});
