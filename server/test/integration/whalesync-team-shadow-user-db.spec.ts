/**
 * DB-backed integration test for DEV-13019 (one Whalesync shadow user per team), run against real Postgres.
 *
 * The unit specs mock Prisma. This spec runs the real `UsersService`, `WhalesyncInternalService`,
 * `StripePaymentService` (its Whalesync plan path never calls Stripe), and `WorkbookService` hard delete against
 * Postgres, and validates what those mocks can't:
 *   - the unique `whalesyncTeamId`, which keeps two shadow users from holding one team's Live Exports, including
 *     when two first sessions for a team race;
 *   - a team's shadow user is a pure shadow user (`ws_<team>` clerkId, no email, no Whalesync person), and any
 *     member's session reaches it;
 *   - the fail-safe: a real Scratch account carrying a team id is refused (409) by every Whalesync operation, and
 *     nothing about it changes;
 *   - deprovisioning deletes the shadow user, its organization, and the organization's workbooks, idempotently.
 *
 * Only scratch-git is faked (a recorder of deleted repo ids), since this suite doesn't run it, and the default
 * workspace a new user gets is stubbed for the same reason. Every id is unique to this run, so the assertions hold on
 * a database that has other data.
 */

import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  createConnectorAccountId,
  createOrganizationId,
  createUserId,
  createWorkbookId,
  createWorkspacePermissionId,
  ScratchPlanType,
  TokenType,
} from '@spinner/shared-types';
import { randomUUID } from 'crypto';
import { AuditLogService } from 'src/audit/audit-log.service';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';
import { WhalesyncInternalService } from 'src/internal/whalesync-internal.service';
import { StripePaymentService } from 'src/payment/stripe-payment.service';
import { FileIndexService } from 'src/publish-plan/file-index.service';
import { RecreatedIdMapService } from 'src/publish-plan/recreated-id-map.service';
import { UsersService } from 'src/users/users.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { createIntegrationTestDbService } from './integration-db-service';

/** A Whalesync team id shaped like the real ones (`tm_` and 12 characters), unique to this run. */
function createWhalesyncTeamIdForTest(): string {
  return `tm_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

describe('Whalesync shadow user per team (DB-backed)', () => {
  let prisma: PrismaClient;
  let db: DbService;
  let usersService: UsersService;
  let whalesyncInternalService: WhalesyncInternalService;

  /** Repo ids the fake scratch-git was asked to delete, in order. */
  const scratchGitRepoIdsDeleted: string[] = [];

  const createdWhalesyncTeamIds: string[] = [];
  const createdRealAccountUserIds: string[] = [];
  const createdRealAccountOrganizationIds: string[] = [];

  function newWhalesyncTeamId(): string {
    const whalesyncTeamId = createWhalesyncTeamIdForTest();
    createdWhalesyncTeamIds.push(whalesyncTeamId);
    return whalesyncTeamId;
  }

  beforeAll(() => {
    prisma = new PrismaClient();
    db = createIntegrationTestDbService(prisma);

    const postHogService = {
      identifyNewUser: jest.fn(),
      trackSubscriptionChanged: jest.fn(),
      trackRemoveWorkbook: jest.fn(),
    };
    const auditLogService = new AuditLogService(db);
    const stripePaymentService = new StripePaymentService(
      {
        getStripeApiKey: () => 'sk_test_integration_never_called',
        getStripeWebhookSecret: () => 'whsec_integration_never_called',
      } as unknown as ScratchConfigService,
      db,
      postHogService as never,
      {} as never,
      auditLogService,
      {} as never,
      {} as never,
    );
    usersService = new UsersService(
      db,
      postHogService as never,
      {} as never,
      { sendMessage: jest.fn() } as never,
      {} as never,
      // The default workspace needs scratch-git, which this spec does not run; it isn't what is under test.
      { createWorkbookWithConfigRepo: jest.fn().mockResolvedValue({ id: 'wkb_unused' }) } as never,
      { getBooleanFlag: jest.fn().mockResolvedValue(false) } as never,
      stripePaymentService,
    );
    const fakeScratchGitService = {
      resolveConnectionRepoPath: async (connectorAccountId: string) =>
        (await prisma.connectorAccount.findUniqueOrThrow({ where: { id: connectorAccountId } })).repoPath,
      deleteRepo: (repoId: string) => {
        scratchGitRepoIdsDeleted.push(repoId);
        return Promise.resolve();
      },
    };
    const fakeWorkbookRepoService = {
      deleteWorkbookRepo: (organizationId: string, workbookId: string) => {
        scratchGitRepoIdsDeleted.push(`${organizationId}/${workbookId}/${workbookId}`);
        return Promise.resolve();
      },
      deleteScratchRepo: (organizationId: string, workbookId: string) => {
        scratchGitRepoIdsDeleted.push(`${organizationId}/${workbookId}/scratch`);
        return Promise.resolve();
      },
    };
    const workbookService = new WorkbookService(
      db,
      {} as never,
      {} as never,
      postHogService as never,
      {} as never,
      auditLogService,
      fakeScratchGitService as never,
      new FileIndexService(db),
      {
        deleteForWorkbook: (workbookId: string) => prisma.fileReference.deleteMany({ where: { workbookId } }),
      } as never,
      new RecreatedIdMapService(db),
      fakeWorkbookRepoService as never,
      {} as never,
    );
    whalesyncInternalService = new WhalesyncInternalService(usersService, workbookService, stripePaymentService);
  });

  afterAll(async () => {
    const shadowUsersCreatedThisRun = await prisma.user.findMany({
      where: {
        OR: [
          { whalesyncTeamId: { in: createdWhalesyncTeamIds } },
          { clerkId: { in: createdWhalesyncTeamIds.map((whalesyncTeamId) => `ws_${whalesyncTeamId}`) } },
        ],
      },
      select: { id: true, organizationId: true },
    });
    const allUserIds = [...createdRealAccountUserIds, ...shadowUsersCreatedThisRun.map((user) => user.id)];
    const allOrganizationIds = [
      ...createdRealAccountOrganizationIds,
      ...shadowUsersCreatedThisRun.flatMap((user) => (user.organizationId ? [user.organizationId] : [])),
    ];
    await prisma.auditLogEvent.deleteMany({
      where: { OR: [{ organizationId: { in: allOrganizationIds } }, { userId: { in: allUserIds } }] },
    });
    // Workbooks, subscriptions, and permissions cascade from the organization; tokens from the user.
    await prisma.workbook.deleteMany({ where: { organizationId: { in: allOrganizationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: allUserIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: allOrganizationIds } } });
    await prisma.$disconnect();
  });

  /** A Live Export (with one connection) or a native workbook owned by the user's organization. */
  async function createWorkbookOwnedByUserOrganization(options: {
    ownerUserId: string;
    organizationId: string;
    managedBy: 'ws_export' | null;
    isPendingDelete?: boolean;
    name?: string;
  }): Promise<{ workbookId: string; connectionRepoPath: string }> {
    const workbookId = createWorkbookId();
    const connectorAccountId = createConnectorAccountId();
    const connectionRepoPath = `${options.organizationId}/${workbookId}/${connectorAccountId}`;
    await prisma.workbook.create({
      data: {
        id: workbookId,
        name: options.name ?? (options.managedBy ? 'A Live Export' : 'A native workbook'),
        organizationId: options.organizationId,
        userId: options.ownerUserId,
        managedBy: options.managedBy ?? undefined,
        isPendingDelete: options.isPendingDelete ?? false,
        workspacePermissions: { create: { id: createWorkspacePermissionId(), userId: options.ownerUserId } },
      },
    });
    await prisma.connectorAccount.create({
      data: {
        id: connectorAccountId,
        workbookId,
        userId: options.ownerUserId,
        service: 'AIRTABLE',
        displayName: 'Airtable',
        repoPath: connectionRepoPath,
        encryptedCredentials: { sealed: `credentials-${connectorAccountId}` },
      },
    });
    return { workbookId, connectionRepoPath };
  }

  /** A person's own Scratch account (real Clerk login) that carries a team id, with a native workbook. */
  async function createRealScratchAccountCarryingTeam(): Promise<{
    realUserId: string;
    organizationId: string;
    whalesyncTeamId: string;
    nativeWorkbookId: string;
  }> {
    const realUserId = createUserId();
    const organizationId = createOrganizationId();
    const whalesyncTeamId = newWhalesyncTeamId();
    createdRealAccountUserIds.push(realUserId);
    createdRealAccountOrganizationIds.push(organizationId);
    await prisma.organization.create({
      data: { id: organizationId, name: 'Real account org', clerkId: `user_${realUserId}` },
    });
    await prisma.user.create({
      data: {
        id: realUserId,
        clerkId: `user_${realUserId}`,
        email: `real-${realUserId.toLowerCase()}@example.com`,
        organizationId,
        whalesyncTeamId,
      },
    });
    const { workbookId: nativeWorkbookId } = await createWorkbookOwnedByUserOrganization({
      ownerUserId: realUserId,
      organizationId,
      managedBy: null,
    });
    return { realUserId, organizationId, whalesyncTeamId, nativeWorkbookId };
  }

  it('creates a pure shadow user for a team on its first session, and reuses it on the next', async () => {
    const whalesyncTeamId = newWhalesyncTeamId();

    const firstSession = await whalesyncInternalService.ensureSessionForWhalesyncTeam(whalesyncTeamId, 'Acme Team');
    const secondSession = await whalesyncInternalService.ensureSessionForWhalesyncTeam(whalesyncTeamId, 'Acme Team');

    expect(secondSession.scratchUserId).toBe(firstSession.scratchUserId);
    expect(secondSession.apiToken).not.toBe(firstSession.apiToken);
    const storedShadowUser = await prisma.user.findUniqueOrThrow({
      where: { id: firstSession.scratchUserId },
      include: { apiTokens: true, organization: { include: { subscriptions: true } } },
    });
    expect(storedShadowUser).toMatchObject({
      clerkId: `ws_${whalesyncTeamId}`,
      whalesyncTeamId,
      whalesyncUserId: null,
      email: null,
      name: 'Acme Team',
    });
    expect(storedShadowUser.organizationId).toEqual(expect.any(String));
    expect(
      storedShadowUser.apiTokens.filter((token) => token.type === (TokenType.WHALESYNC_SESSION as string)),
    ).toHaveLength(2);
    // The Whalesync plan was granted once, not once per session.
    expect(storedShadowUser.organization?.subscriptions.map((subscription) => subscription.planType)).toEqual([
      ScratchPlanType.WHALESYNC_PLAN,
    ]);
    expect(await prisma.user.count({ where: { whalesyncTeamId } })).toBe(1);
  });

  it("gives every member of a team the team's one shadow user", async () => {
    const whalesyncTeamId = newWhalesyncTeamId();

    // Two members' sessions: Scratch is told nothing about who is acting, so they differ only in what Whalesync sends.
    const firstMemberSession = await whalesyncInternalService.ensureSessionForWhalesyncTeam(whalesyncTeamId, 'Team');
    const secondMemberSession = await whalesyncInternalService.ensureSessionForWhalesyncTeam(
      whalesyncTeamId,
      'Renamed Team',
      { status: 'active', whalesyncProductType: 'growth' },
    );

    expect(secondMemberSession.scratchUserId).toBe(firstMemberSession.scratchUserId);
    // An existing shadow user's name is left alone.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: firstMemberSession.scratchUserId } })).name).toBe(
      'Team',
    );
    expect(await prisma.user.count({ where: { clerkId: `ws_${whalesyncTeamId}` } })).toBe(1);
  });

  it('ends two concurrent first sessions for one team with one shadow user', async () => {
    const whalesyncTeamId = newWhalesyncTeamId();

    const concurrentSessions = await Promise.all([
      whalesyncInternalService.ensureSessionForWhalesyncTeam(whalesyncTeamId, 'Racing Team'),
      whalesyncInternalService.ensureSessionForWhalesyncTeam(whalesyncTeamId, 'Racing Team'),
    ]);

    expect(concurrentSessions[1].scratchUserId).toBe(concurrentSessions[0].scratchUserId);
    expect(await prisma.user.count({ where: { whalesyncTeamId } })).toBe(1);
    expect(await prisma.user.count({ where: { clerkId: `ws_${whalesyncTeamId}` } })).toBe(1);
    expect(
      await prisma.apiToken.count({
        where: { userId: concurrentSessions[0].scratchUserId, type: TokenType.WHALESYNC_SESSION },
      }),
    ).toBe(2);
  });

  it("applies a subscription change to the team's shadow user, and is a no-op for a team with none", async () => {
    const whalesyncTeamId = newWhalesyncTeamId();
    const session = await whalesyncInternalService.ensureSessionForWhalesyncTeam(whalesyncTeamId, 'Team');

    await expect(
      whalesyncInternalService.updateWhalesyncSubscription(whalesyncTeamId, { status: 'cancelled' }),
    ).resolves.toEqual({ scratchUserId: session.scratchUserId, updated: true, planType: null });
    const shadowUser = await prisma.user.findUniqueOrThrow({ where: { id: session.scratchUserId } });
    const subscriptions = await prisma.subscription.findMany({
      where: { organizationId: shadowUser.organizationId ?? '' },
    });
    expect(subscriptions.map((subscription) => subscription.stripeStatus)).toEqual(['canceled']);

    await expect(
      whalesyncInternalService.updateWhalesyncSubscription(newWhalesyncTeamId(), { status: 'expired' }),
    ).resolves.toEqual({ scratchUserId: null, updated: false, planType: null });
  });

  it("lists a team's Live Exports, newest first, skipping those pending deletion and native workbooks", async () => {
    const whalesyncTeamId = newWhalesyncTeamId();
    const session = await whalesyncInternalService.ensureSessionForWhalesyncTeam(whalesyncTeamId, 'Team');
    const shadowUser = await prisma.user.findUniqueOrThrow({ where: { id: session.scratchUserId } });
    const shadowUserOrganizationId = shadowUser.organizationId ?? '';
    const olderLiveExport = await createWorkbookOwnedByUserOrganization({
      ownerUserId: shadowUser.id,
      organizationId: shadowUserOrganizationId,
      managedBy: 'ws_export',
      name: 'Older export',
    });
    const newerLiveExport = await createWorkbookOwnedByUserOrganization({
      ownerUserId: shadowUser.id,
      organizationId: shadowUserOrganizationId,
      managedBy: 'ws_export',
      name: 'Newer export',
    });
    await prisma.workbook.update({
      where: { id: olderLiveExport.workbookId },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });
    await createWorkbookOwnedByUserOrganization({
      ownerUserId: shadowUser.id,
      organizationId: shadowUserOrganizationId,
      managedBy: 'ws_export',
      isPendingDelete: true,
    });
    await createWorkbookOwnedByUserOrganization({
      ownerUserId: shadowUser.id,
      organizationId: shadowUserOrganizationId,
      managedBy: null,
    });

    const listedLiveExports = await whalesyncInternalService.listLiveExportsForWhalesyncTeam(whalesyncTeamId);

    expect(listedLiveExports.liveExports.map((liveExport) => liveExport.id)).toEqual([
      newerLiveExport.workbookId,
      olderLiveExport.workbookId,
    ]);
    // Read-only: a team with no shadow user gets an empty list, and none is created.
    const teamWithoutShadowUser = newWhalesyncTeamId();
    await expect(whalesyncInternalService.listLiveExportsForWhalesyncTeam(teamWithoutShadowUser)).resolves.toEqual({
      liveExports: [],
    });
    expect(await prisma.user.count({ where: { whalesyncTeamId: teamWithoutShadowUser } })).toBe(0);
  });

  it('refuses every Whalesync operation on a real Scratch account that carries the team id, changing nothing', async () => {
    const realAccount = await createRealScratchAccountCarryingTeam();
    const realAccountBefore = await prisma.user.findUniqueOrThrow({ where: { id: realAccount.realUserId } });

    await expect(
      whalesyncInternalService.ensureSessionForWhalesyncTeam(realAccount.whalesyncTeamId, 'Team'),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      whalesyncInternalService.updateWhalesyncSubscription(realAccount.whalesyncTeamId, { status: 'active' }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      whalesyncInternalService.listLiveExportsForWhalesyncTeam(realAccount.whalesyncTeamId),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(whalesyncInternalService.deprovisionWhalesyncTeam(realAccount.whalesyncTeamId)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(await prisma.user.findUniqueOrThrow({ where: { id: realAccount.realUserId } })).toEqual(realAccountBefore);
    expect(await prisma.organization.findUnique({ where: { id: realAccount.organizationId } })).not.toBeNull();
    expect(await prisma.workbook.findUnique({ where: { id: realAccount.nativeWorkbookId } })).not.toBeNull();
    expect(await prisma.apiToken.count({ where: { userId: realAccount.realUserId } })).toBe(0);
    expect(await prisma.subscription.count({ where: { organizationId: realAccount.organizationId } })).toBe(0);
    // No shadow user was created beside it for the team.
    expect(await prisma.user.count({ where: { clerkId: `ws_${realAccount.whalesyncTeamId}` } })).toBe(0);
  });

  it("deprovisions a team by deleting its shadow user, organization, and the organization's workbooks, idempotently", async () => {
    const whalesyncTeamId = newWhalesyncTeamId();
    const session = await whalesyncInternalService.ensureSessionForWhalesyncTeam(whalesyncTeamId, 'Team');
    const shadowUser = await prisma.user.findUniqueOrThrow({ where: { id: session.scratchUserId } });
    const shadowUserOrganizationId = shadowUser.organizationId ?? '';
    const liveExport = await createWorkbookOwnedByUserOrganization({
      ownerUserId: shadowUser.id,
      organizationId: shadowUserOrganizationId,
      managedBy: 'ws_export',
    });
    const defaultWorkbook = await createWorkbookOwnedByUserOrganization({
      ownerUserId: shadowUser.id,
      organizationId: shadowUserOrganizationId,
      managedBy: null,
    });
    // A workbook another organization shared with the shadow user is not the shadow user's to delete.
    const otherOrganizationId = createOrganizationId();
    const otherOrganizationOwnerUserId = createUserId();
    createdRealAccountOrganizationIds.push(otherOrganizationId);
    createdRealAccountUserIds.push(otherOrganizationOwnerUserId);
    await prisma.organization.create({
      data: { id: otherOrganizationId, name: 'Sharing org', clerkId: `user_${otherOrganizationOwnerUserId}` },
    });
    await prisma.user.create({
      data: {
        id: otherOrganizationOwnerUserId,
        clerkId: `user_${otherOrganizationOwnerUserId}`,
        organizationId: otherOrganizationId,
      },
    });
    const sharedWorkbook = await createWorkbookOwnedByUserOrganization({
      ownerUserId: otherOrganizationOwnerUserId,
      organizationId: otherOrganizationId,
      managedBy: null,
    });
    await prisma.workspacePermission.create({
      data: { id: createWorkspacePermissionId(), userId: shadowUser.id, workbookId: sharedWorkbook.workbookId },
    });

    await whalesyncInternalService.deprovisionWhalesyncTeam(whalesyncTeamId);

    expect(await prisma.user.findUnique({ where: { id: shadowUser.id } })).toBeNull();
    expect(await prisma.organization.findUnique({ where: { id: shadowUserOrganizationId } })).toBeNull();
    expect(
      await prisma.workbook.count({ where: { id: { in: [liveExport.workbookId, defaultWorkbook.workbookId] } } }),
    ).toBe(0);
    expect(await prisma.apiToken.count({ where: { userId: shadowUser.id } })).toBe(0);
    expect(scratchGitRepoIdsDeleted).toEqual(
      expect.arrayContaining([
        liveExport.connectionRepoPath,
        `${shadowUserOrganizationId}/${liveExport.workbookId}/${liveExport.workbookId}`,
        defaultWorkbook.connectionRepoPath,
      ]),
    );
    expect(await prisma.workbook.findUnique({ where: { id: sharedWorkbook.workbookId } })).not.toBeNull();
    expect(scratchGitRepoIdsDeleted).not.toContain(sharedWorkbook.connectionRepoPath);

    // A retry (or a team that was never provisioned) is a no-op.
    await expect(whalesyncInternalService.deprovisionWhalesyncTeam(whalesyncTeamId)).resolves.toBeUndefined();
    await expect(whalesyncInternalService.deprovisionWhalesyncTeam(newWhalesyncTeamId())).resolves.toBeUndefined();
    // A new session after deprovisioning starts the team over with a fresh shadow user.
    const sessionAfterDeprovision = await whalesyncInternalService.ensureSessionForWhalesyncTeam(whalesyncTeamId);
    expect(sessionAfterDeprovision.scratchUserId).not.toBe(shadowUser.id);
  });
});
