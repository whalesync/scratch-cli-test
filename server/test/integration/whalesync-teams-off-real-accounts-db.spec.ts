/**
 * DB-backed integration test for the DEV-13019 migration that takes Whalesync teams off real Scratch accounts, run
 * against real Postgres.
 *
 * The unit spec (`whalesync-real-account-migration.spec.ts`) covers the decisions, the order of steps, and resuming
 * after a crash, against an in-memory Scratch. This spec runs the real service, the real unlink, the real plan copy,
 * the real quiesce and schedule markers, and the real row moves against Postgres; only scratch-git is faked (an
 * in-memory set of repo ids with the move endpoint's contract), since this suite doesn't run it. Every id is unique
 * to this run, and the migration is limited to this run's accounts by id, so it holds on a database with other data.
 * Config is stubbed rather than read from `.env`, so the spec doesn't depend on local values.
 */

import { PrismaClient } from '@prisma/client';
import {
  createApiTokenId,
  createConnectorAccountId,
  createJobId,
  createOrganizationId,
  createRoutineRunId,
  createScheduleId,
  createSubscriptionId,
  createUserId,
  createWorkbookId,
  createWorkspacePermissionId,
  ScheduleAction,
  ScratchPlanType,
  TokenType,
  WorkbookId,
  WorkbookManager,
} from '@spinner/shared-types';
import { randomUUID } from 'crypto';
import { AuditLogService } from 'src/audit/audit-log.service';
import { ConnectionQuiesceService } from 'src/code-migrations/connection-quiesce.service';
import { WhalesyncRealAccountMigrationService } from 'src/code-migrations/whalesync-real-account-migration.service';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';
import { WhalesyncInternalService } from 'src/internal/whalesync-internal.service';
import { MigrationLockService } from 'src/migration-lock/migration-lock.service';
import { StripePaymentService } from 'src/payment/stripe-payment.service';
import { ScheduleService } from 'src/schedule/schedule.service';
import { ScratchGitNotFoundError } from 'src/scratch-git/scratch-git.client';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { UsersService } from 'src/users/users.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { createIntegrationTestDbService } from './integration-db-service';

/** scratch-git's move contract over a set of repo ids: atomic, no overwrite, a repeated move is done. */
class InMemoryScratchGitRepos {
  readonly repoIdsOnDisk = new Set<string>();

  moveRepo(fromRepoId: string, toRepoId: string): Promise<{ moved: boolean }> {
    const sourceExists = this.repoIdsOnDisk.has(fromRepoId);
    const destinationExists = this.repoIdsOnDisk.has(toRepoId);
    if (sourceExists && destinationExists) {
      return Promise.reject(new Error(`scratch-git 409: ${toRepoId} exists`));
    }
    if (sourceExists) {
      this.repoIdsOnDisk.delete(fromRepoId);
      this.repoIdsOnDisk.add(toRepoId);
      return Promise.resolve({ moved: true });
    }
    if (destinationExists) {
      return Promise.resolve({ moved: false });
    }
    return Promise.reject(
      new ScratchGitNotFoundError(
        '/api/repo/manage/move',
        JSON.stringify({ data: { error: 'Neither repo exists', reason: 'neither_repo_exists' } }),
      ),
    );
  }
}

function createWhalesyncTeamIdForTest(): string {
  return `tm_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

describe('Whalesync teams off real Scratch accounts (DB-backed)', () => {
  let prisma: PrismaClient;
  let db: DbService;
  let scratchGitRepos: InMemoryScratchGitRepos;
  let migrationService: WhalesyncRealAccountMigrationService;

  const createdOrganizationIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdWorkbookIds: string[] = [];
  const createdWhalesyncTeamIds: string[] = [];

  beforeAll(() => {
    prisma = new PrismaClient();
    db = createIntegrationTestDbService(prisma);
    scratchGitRepos = new InMemoryScratchGitRepos();

    const postHogService = {
      identifyNewUser: jest.fn(),
      trackWhalesyncAccountLinked: jest.fn(),
      trackSubscriptionChanged: jest.fn(),
    };
    const auditLogService = new AuditLogService(db);
    const usersService = new UsersService(
      db,
      postHogService as never,
      {} as never,
      { sendMessage: jest.fn() } as never,
      {} as never,
      // The default workspace needs scratch-git; it isn't what is under test.
      { createWorkbookWithConfigRepo: jest.fn().mockResolvedValue({ id: 'wkb_unused' }) } as never,
      { getBooleanFlag: jest.fn().mockResolvedValue(false) } as never,
      { ensureWhalesyncPlanSubscription: jest.fn().mockResolvedValue(undefined) } as never,
    );
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
    // The unlink's only WorkbookService calls; the hard delete must never run in migration mode.
    const workbookService = {
      findIdsOfLiveExportWorkbooksCreatedByUser: async (userId: string) =>
        (
          await prisma.workbook.findMany({
            where: { userId, managedBy: WorkbookManager.WS_EXPORT },
            select: { id: true },
          })
        ).map((workbook) => workbook.id as WorkbookId),
      executeHardDeleteWorkbook: jest.fn().mockRejectedValue(new Error('must not hard-delete a Live Export')),
    } as unknown as WorkbookService;
    const whalesyncInternalService = new WhalesyncInternalService(usersService, workbookService, stripePaymentService);
    const scheduleService = new ScheduleService(db, {
      isProductionEnvironment: () => true,
    } as unknown as ScratchConfigService);
    const connectionQuiesceService = new ConnectionQuiesceService(
      new MigrationLockService(db),
      scheduleService,
      { cancelNonTerminalPlansForConnection: jest.fn().mockResolvedValue(0) } as never,
      {
        getNonTerminalJobsForWorkbook: jest.fn().mockResolvedValue([]),
        getActiveBullJobDatas: jest.fn().mockResolvedValue([]),
      } as never,
      { sendWorkbookEvent: jest.fn() } as never,
    );

    migrationService = new WhalesyncRealAccountMigrationService(
      db,
      usersService,
      whalesyncInternalService,
      stripePaymentService,
      scratchGitRepos as unknown as ScratchGitService,
      connectionQuiesceService,
      scheduleService,
      auditLogService,
    );
  });

  afterAll(async () => {
    const shadowUsers = await prisma.user.findMany({
      where: { clerkId: { in: createdWhalesyncTeamIds.map((whalesyncTeamId) => `ws_${whalesyncTeamId}`) } },
      select: { id: true, organizationId: true },
    });
    const allUserIds = [...createdUserIds, ...shadowUsers.map((user) => user.id)];
    const allOrganizationIds = [
      ...createdOrganizationIds,
      ...shadowUsers.flatMap((user) => (user.organizationId ? [user.organizationId] : [])),
    ];
    await prisma.auditLogEvent.deleteMany({ where: { entityId: { in: createdWorkbookIds } } });
    await prisma.workbook.deleteMany({ where: { id: { in: createdWorkbookIds } } });
    await prisma.subscription.deleteMany({ where: { organizationId: { in: allOrganizationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: allUserIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: allOrganizationIds } } });
    await prisma.$disconnect();
  });

  /** A person's real Scratch account, adopted into Whalesync before teams, with the free Whalesync plan. */
  async function createRealScratchAccountLinkedToTeam(): Promise<{
    realUserId: string;
    organizationId: string;
    whalesyncTeamId: string;
    whalesyncUserId: string;
  }> {
    const realUserId = createUserId();
    const organizationId = createOrganizationId();
    const whalesyncTeamId = createWhalesyncTeamIdForTest();
    const whalesyncUserId = randomUUID();
    createdUserIds.push(realUserId);
    createdOrganizationIds.push(organizationId);
    createdWhalesyncTeamIds.push(whalesyncTeamId);
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
        whalesyncUserId,
      },
    });
    await prisma.subscription.create({
      data: {
        id: createSubscriptionId(),
        userId: realUserId,
        organizationId,
        planType: ScratchPlanType.WHALESYNC_PLAN,
        stripeSubscriptionId: `whalesync_${organizationId}`,
        expiration: new Date('2126-01-01T00:00:00.000Z'),
        stripeStatus: 'active',
        lastInvoicePaid: true,
        metadata: { whalesyncStatus: 'active', liveExportRecordCountLimit: 50000, liveExportCadence: 'hourly' },
      },
    });
    await prisma.apiToken.createMany({
      data: [
        {
          id: createApiTokenId(),
          userId: realUserId,
          token: randomUUID(),
          type: TokenType.WHALESYNC_SESSION,
          expiresAt: new Date(Date.now() + 600_000),
        },
        {
          id: createApiTokenId(),
          userId: realUserId,
          token: randomUUID(),
          type: TokenType.USER,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      ],
    });
    return { realUserId, organizationId, whalesyncTeamId, whalesyncUserId };
  }

  async function createWorkbookWithConnections(options: {
    realUserId: string;
    organizationId: string;
    managedBy: 'ws_export' | null;
    connectionCount: number;
  }): Promise<{ workbookId: string; connectorAccountIds: string[] }> {
    const workbookId = createWorkbookId();
    createdWorkbookIds.push(workbookId);
    await prisma.workbook.create({
      data: {
        id: workbookId,
        name: options.managedBy ? 'A Live Export' : 'My own workbook',
        organizationId: options.organizationId,
        userId: options.realUserId,
        managedBy: options.managedBy ?? undefined,
        workspacePermissions: { create: { id: createWorkspacePermissionId(), userId: options.realUserId } },
      },
    });
    scratchGitRepos.repoIdsOnDisk.add(`${options.organizationId}/${workbookId}/${workbookId}`);
    scratchGitRepos.repoIdsOnDisk.add(`${options.organizationId}/${workbookId}/scratch`);
    const connectorAccountIds: string[] = [];
    for (let connectionIndex = 0; connectionIndex < options.connectionCount; connectionIndex++) {
      const connectorAccountId = createConnectorAccountId();
      const repoPath = `${options.organizationId}/${workbookId}/${connectorAccountId}`;
      await prisma.connectorAccount.create({
        data: {
          id: connectorAccountId,
          workbookId,
          userId: options.realUserId,
          service: 'AIRTABLE',
          displayName: 'Airtable',
          repoPath,
          encryptedCredentials: { sealed: `credentials-${connectorAccountId}` },
        },
      });
      scratchGitRepos.repoIdsOnDisk.add(repoPath);
      connectorAccountIds.push(connectorAccountId);
    }
    return { workbookId, connectorAccountIds };
  }

  it('refuses a real run, changing nothing, against a scratch-git without the move route', async () => {
    const account = await createRealScratchAccountLinkedToTeam();
    const moveRepo = jest
      .spyOn(scratchGitRepos, 'moveRepo')
      .mockRejectedValue(new ScratchGitNotFoundError('/api/repo/manage/move', ''));
    try {
      const dryRun = await migrationService.run({ dryRun: true, realUserIds: [account.realUserId] });
      expect(dryRun.report?.[0]).toContain('NOT SUPPORTED');
      await expect(migrationService.run({ dryRun: false, realUserIds: [account.realUserId] })).rejects.toThrow(
        'deploy scratch-git',
      );
      expect((await prisma.user.findUniqueOrThrow({ where: { id: account.realUserId } })).whalesyncTeamId).toBe(
        account.whalesyncTeamId,
      );
    } finally {
      moveRepo.mockRestore();
    }
    // Leave the account for nobody: unlink it so later tests don't see it.
    await migrationService.run({ dryRun: false, realUserIds: [account.realUserId] });
  });

  it('unlinks a real account that holds no Live Export, and creates no shadow user', async () => {
    const account = await createRealScratchAccountLinkedToTeam();
    const nativeWorkbook = await createWorkbookWithConnections({ ...account, managedBy: null, connectionCount: 1 });

    const dryRun = await migrationService.run({ dryRun: true, realUserIds: [account.realUserId] });
    expect(dryRun.migratedIds).toEqual([account.realUserId]);
    expect(dryRun.report?.[1]).toContain(`${account.realUserId}: would_unlink`);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: account.realUserId } })).whalesyncTeamId).toBe(
      account.whalesyncTeamId,
    );

    const result = await migrationService.run({ dryRun: false, realUserIds: [account.realUserId] });

    expect(result.migratedIds).toEqual([account.realUserId]);
    expect(result.summary).toEqual(expect.arrayContaining([{ label: 'accounts unlinked', count: 1 }]));
    const realUser = await prisma.user.findUniqueOrThrow({
      where: { id: account.realUserId },
      include: { apiTokens: true },
    });
    expect(realUser).toMatchObject({
      whalesyncTeamId: null,
      whalesyncUserId: null,
      clerkId: `user_${account.realUserId}`,
      email: `real-${account.realUserId.toLowerCase()}@example.com`,
      organizationId: account.organizationId,
    });
    expect(realUser.apiTokens.map((token) => token.type)).toEqual([TokenType.USER]);
    expect(
      await prisma.subscription.count({
        where: { organizationId: account.organizationId, planType: ScratchPlanType.WHALESYNC_PLAN },
      }),
    ).toBe(0);
    expect(await prisma.workbook.findUniqueOrThrow({ where: { id: nativeWorkbook.workbookId } })).toMatchObject({
      userId: account.realUserId,
      organizationId: account.organizationId,
    });
    expect(await prisma.user.count({ where: { clerkId: `ws_${account.whalesyncTeamId}` } })).toBe(0);
  });

  it('moves every Live Export, connection, schedule, and permission to a new pure shadow user in its own organization, then unlinks the account; a re-run does nothing', async () => {
    const account = await createRealScratchAccountLinkedToTeam();
    const nativeWorkbook = await createWorkbookWithConnections({ ...account, managedBy: null, connectionCount: 1 });
    const firstLiveExport = await createWorkbookWithConnections({
      ...account,
      managedBy: 'ws_export',
      connectionCount: 2,
    });
    const secondLiveExport = await createWorkbookWithConnections({
      ...account,
      managedBy: 'ws_export',
      connectionCount: 1,
    });
    // The second predates scratch repos.
    scratchGitRepos.repoIdsOnDisk.delete(`${account.organizationId}/${secondLiveExport.workbookId}/scratch`);
    await prisma.user.update({
      where: { id: account.realUserId },
      data: { lastWorkbookId: firstLiveExport.workbookId },
    });
    const enabledScheduleId = createScheduleId();
    const userDisabledScheduleId = createScheduleId();
    await prisma.schedule.createMany({
      data: [
        {
          id: enabledScheduleId,
          workbookId: firstLiveExport.workbookId,
          organizationId: account.organizationId,
          userId: account.realUserId,
          name: 'Hourly Live Export',
          action: ScheduleAction.ROUTINE,
          entityId: 'routines/live-export.yaml',
          cronExpression: '0 * * * *',
          enabled: true,
        },
        {
          id: userDisabledScheduleId,
          workbookId: secondLiveExport.workbookId,
          organizationId: account.organizationId,
          userId: account.realUserId,
          name: 'Paused Live Export',
          action: ScheduleAction.ROUTINE,
          entityId: 'routines/live-export.yaml',
          cronExpression: '0 0 * * *',
          enabled: false,
        },
      ],
    });
    const finishedRoutineRunId = createRoutineRunId();
    await prisma.routineRun.create({
      data: {
        id: finishedRoutineRunId,
        workbookId: firstLiveExport.workbookId,
        routineFilePath: 'routines/live-export.yaml',
        routineName: 'Live Export',
        status: 'completed',
        trigger: 'schedule',
        triggeredByUserId: account.realUserId,
      },
    });
    const finishedJobId = createJobId();
    await prisma.dbJob.create({
      data: {
        id: finishedJobId,
        userId: account.realUserId,
        workbookId: firstLiveExport.workbookId,
        status: 'completed',
        type: 'pull-linked-folder-files',
        data: {},
      },
    });
    const finishedPublishPlanId = `pp_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    await prisma.publishPlan.create({
      data: {
        id: finishedPublishPlanId,
        workbookId: firstLiveExport.workbookId,
        userId: account.realUserId,
        authorId: account.realUserId,
        status: 'completed',
        branchName: 'dirty',
      },
    });

    const dryRun = await migrationService.run({ dryRun: true, realUserIds: [account.realUserId] });
    expect(dryRun.report?.[1]).toContain(`${account.realUserId}: would_move`);
    expect(dryRun.summary).toEqual(
      expect.arrayContaining([
        { label: 'Live Exports moved', count: 2 },
        { label: 'connections moved', count: 3 },
        { label: 'schedules moved', count: 2 },
      ]),
    );
    expect(await prisma.user.count({ where: { clerkId: `ws_${account.whalesyncTeamId}` } })).toBe(0);

    const result = await migrationService.run({ dryRun: false, realUserIds: [account.realUserId] });
    expect(result.summary).toEqual(expect.arrayContaining([{ label: 'accounts moved', count: 1 }]));

    // The new pure shadow user holds the team, in an organization of its own.
    const shadowUser = await prisma.user.findUniqueOrThrow({
      where: { clerkId: `ws_${account.whalesyncTeamId}` },
      include: { organization: { include: { subscriptions: true } } },
    });
    const shadowOrganizationId = shadowUser.organizationId as string;
    expect(shadowUser).toMatchObject({
      whalesyncTeamId: account.whalesyncTeamId,
      whalesyncUserId: account.whalesyncUserId,
      email: null,
    });
    expect(shadowOrganizationId).not.toBe(account.organizationId);
    expect(await prisma.user.count({ where: { organizationId: shadowOrganizationId } })).toBe(1);
    // The Whalesync plan was copied: status, metadata, and expiration.
    expect(shadowUser.organization?.subscriptions).toEqual([
      expect.objectContaining({
        planType: ScratchPlanType.WHALESYNC_PLAN,
        stripeStatus: 'active',
        expiration: new Date('2126-01-01T00:00:00.000Z'),
        metadata: { whalesyncStatus: 'active', liveExportRecordCountLimit: 50000, liveExportCadence: 'hourly' },
      }),
    ]);

    for (const liveExport of [firstLiveExport, secondLiveExport]) {
      const movedWorkbook = await prisma.workbook.findUniqueOrThrow({
        where: { id: liveExport.workbookId },
        include: { connectorAccounts: true, workspacePermissions: true, schedules: true },
      });
      expect(movedWorkbook).toMatchObject({ userId: shadowUser.id, organizationId: shadowOrganizationId });
      expect(movedWorkbook.workspacePermissions.map((permission) => permission.userId)).toEqual([shadowUser.id]);
      for (const connectorAccount of movedWorkbook.connectorAccounts) {
        const newRepoPath = `${shadowOrganizationId}/${liveExport.workbookId}/${connectorAccount.id}`;
        expect(connectorAccount).toMatchObject({
          repoPath: newRepoPath,
          userId: shadowUser.id,
          migrationLockedAt: null,
        });
        // Credentials aren't organization-scoped and move untouched.
        expect(connectorAccount.encryptedCredentials).toEqual({ sealed: `credentials-${connectorAccount.id}` });
        expect(scratchGitRepos.repoIdsOnDisk.has(newRepoPath)).toBe(true);
        expect(
          scratchGitRepos.repoIdsOnDisk.has(
            `${account.organizationId}/${liveExport.workbookId}/${connectorAccount.id}`,
          ),
        ).toBe(false);
      }
      for (const schedule of movedWorkbook.schedules) {
        expect(schedule).toMatchObject({
          organizationId: shadowOrganizationId,
          userId: shadowUser.id,
          disabledForMigrationAt: null,
        });
      }
      expect(
        scratchGitRepos.repoIdsOnDisk.has(`${shadowOrganizationId}/${liveExport.workbookId}/${liveExport.workbookId}`),
      ).toBe(true);
    }
    expect(scratchGitRepos.repoIdsOnDisk.has(`${shadowOrganizationId}/${firstLiveExport.workbookId}/scratch`)).toBe(
      true,
    );
    // The enabled schedule runs again on its next tick; the one the person had disabled stays disabled.
    expect(await prisma.schedule.findUniqueOrThrow({ where: { id: enabledScheduleId } })).toMatchObject({
      enabled: true,
    });
    expect(await prisma.schedule.findUniqueOrThrow({ where: { id: userDisabledScheduleId } })).toMatchObject({
      enabled: false,
    });
    expect(await prisma.routineRun.findUniqueOrThrow({ where: { id: finishedRoutineRunId } })).toMatchObject({
      triggeredByUserId: shadowUser.id,
    });
    expect(await prisma.dbJob.findUniqueOrThrow({ where: { id: finishedJobId } })).toMatchObject({
      userId: shadowUser.id,
    });
    expect(await prisma.publishPlan.findUniqueOrThrow({ where: { id: finishedPublishPlanId } })).toMatchObject({
      userId: shadowUser.id,
      authorId: shadowUser.id,
    });

    // The person keeps their account, organization, and native workbook, unlinked from Whalesync.
    const realUser = await prisma.user.findUniqueOrThrow({
      where: { id: account.realUserId },
      include: { apiTokens: true },
    });
    expect(realUser).toMatchObject({
      whalesyncTeamId: null,
      whalesyncUserId: null,
      clerkId: `user_${account.realUserId}`,
      email: `real-${account.realUserId.toLowerCase()}@example.com`,
      organizationId: account.organizationId,
      lastWorkbookId: null,
    });
    expect(realUser.apiTokens.map((token) => token.type)).toEqual([TokenType.USER]);
    expect(
      await prisma.subscription.count({
        where: { organizationId: account.organizationId, planType: ScratchPlanType.WHALESYNC_PLAN },
      }),
    ).toBe(0);
    const keptNativeWorkbook = await prisma.workbook.findUniqueOrThrow({
      where: { id: nativeWorkbook.workbookId },
      include: { connectorAccounts: true },
    });
    expect(keptNativeWorkbook).toMatchObject({ userId: account.realUserId, organizationId: account.organizationId });
    expect(keptNativeWorkbook.connectorAccounts[0].repoPath).toBe(
      `${account.organizationId}/${nativeWorkbook.workbookId}/${nativeWorkbook.connectorAccountIds[0]}`,
    );
    expect(await prisma.workbook.count({ where: { userId: account.realUserId, managedBy: 'ws_export' } })).toBe(0);

    // A re-run finds nothing to do and changes nothing.
    const repoIdsBeforeRerun = [...scratchGitRepos.repoIdsOnDisk].sort();
    const rerun = await migrationService.run({ dryRun: false, realUserIds: [account.realUserId] });
    expect(rerun.migratedIds).toEqual([]);
    expect(rerun.report).toEqual(['scratch-git repo moves: supported']);
    expect([...scratchGitRepos.repoIdsOnDisk].sort()).toEqual(repoIdsBeforeRerun);
    expect(await prisma.user.count({ where: { clerkId: `ws_${account.whalesyncTeamId}` } })).toBe(1);
  });
});
