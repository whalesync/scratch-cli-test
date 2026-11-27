/**
 * DB-backed integration test for the DEV-13019 `whalesync-teamless-shadow-users-deprovision` code migration, run
 * against real Postgres.
 *
 * Runs the real migration service, the real `WhalesyncInternalService` delete path, the real `UsersService`, and the
 * real `WorkbookService` hard delete against Postgres, over fixtures built directly with Prisma: Whalesync shadow users
 * made for a person before teams that were never given a team (some still carrying the deprecated `whalesyncUserId`,
 * which the server no longer reads or writes outside this migration's candidate selection). Only scratch-git is faked
 * (a recorder of deleted repo ids), since this suite doesn't run it.
 *
 * Every run is narrowed with `scratchUserIdsToConsider` (the migration's `ids`) to this test's users, so the spec
 * holds on a database that has other data and never deletes anything it didn't create.
 */

import { PrismaClient } from '@prisma/client';
import {
  createConnectorAccountId,
  createOrganizationId,
  createUserId,
  createWorkbookId,
  createWorkspacePermissionId,
  MigrationResult,
} from '@spinner/shared-types';
import { randomUUID } from 'crypto';
import { AuditLogService } from 'src/audit/audit-log.service';
import { WhalesyncTeamlessShadowUsersDeprovisionService } from 'src/code-migrations/whalesync-teamless-shadow-users-deprovision.service';
import { DbService } from 'src/db/db.service';
import { WhalesyncInternalService } from 'src/internal/whalesync-internal.service';
import { FileIndexService } from 'src/publish-plan/file-index.service';
import { RecreatedIdMapService } from 'src/publish-plan/recreated-id-map.service';
import { UsersService } from 'src/users/users.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { createIntegrationTestDbService } from './integration-db-service';

/** The Scratch users one test's fixtures created, by the role each plays for the migration. */
interface TeamlessShadowUserFixtures {
  /** Pure shadow user, no team, sole member of its organization, which owns a native workbook: deprovisioned. */
  pureTeamlessShadowUserWithOrganization: { userId: string; organizationId: string; nativeWorkbookId: string };
  /** Pure shadow user, no team, no organization, and no leftover `whalesyncUserId` (found by clerkId): deprovisioned. */
  pureTeamlessShadowUserWithoutOrganizationUserId: string;
  /** Pure shadow user, no team, that created a Live Export: skipped. */
  teamlessShadowUserThatCreatedALiveExport: { userId: string; liveExportWorkbookId: string };
  /** Pure shadow user, no team, whose organization owns a Live Export nobody holds any more: skipped. */
  teamlessShadowUserWhoseOrganizationOwnsALiveExport: { userId: string; liveExportWorkbookId: string };
  /** A person's real Scratch account with a leftover `whalesyncUserId` and no team: skipped, untouched. */
  realScratchAccountWithLeftoverWhalesyncUserId: { userId: string; organizationId: string };
  /** Pure shadow user, no team, whose organization has a second (real) member: skipped. */
  teamlessShadowUserWhoseOrganizationHasAnotherMember: { userId: string; organizationId: string };
  /** A team's pure shadow user: never a candidate. */
  shadowUserOfTeamUserId: string;
}

describe('Whalesync teamless shadow users deprovision migration (DB-backed)', () => {
  let prisma: PrismaClient;
  let db: DbService;
  let migrationService: WhalesyncTeamlessShadowUsersDeprovisionService;

  /** Repo ids the fake scratch-git was asked to delete, in order. */
  const scratchGitRepoIdsDeleted: string[] = [];

  const createdUserIds: string[] = [];
  const createdOrganizationIds: string[] = [];

  beforeAll(() => {
    prisma = new PrismaClient();
    db = createIntegrationTestDbService(prisma);

    const postHogService = { identifyNewUser: jest.fn(), trackRemoveWorkbook: jest.fn() };
    const auditLogService = new AuditLogService(db);
    const usersService = new UsersService(
      db,
      postHogService as never,
      {} as never,
      { sendMessage: jest.fn() } as never,
      {} as never,
      {} as never,
      { getBooleanFlag: jest.fn().mockResolvedValue(false) } as never,
      {} as never,
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
    // The migration only deletes; the plan service is never reached.
    const whalesyncInternalService = new WhalesyncInternalService(usersService, workbookService, {} as never);
    migrationService = new WhalesyncTeamlessShadowUsersDeprovisionService(
      db,
      usersService,
      workbookService,
      whalesyncInternalService,
    );
  });

  afterAll(async () => {
    await prisma.auditLogEvent.deleteMany({
      where: { OR: [{ organizationId: { in: createdOrganizationIds } }, { userId: { in: createdUserIds } }] },
    });
    await prisma.workbook.deleteMany({ where: { organizationId: { in: createdOrganizationIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: createdOrganizationIds } } });
    await prisma.$disconnect();
  });

  async function createOrganization(clerkId: string): Promise<string> {
    const organizationId = createOrganizationId();
    createdOrganizationIds.push(organizationId);
    await prisma.organization.create({ data: { id: organizationId, name: 'Teamless deprovision test org', clerkId } });
    return organizationId;
  }

  async function createUser(data: {
    clerkId: string;
    organizationId?: string;
    whalesyncUserId?: string;
    whalesyncTeamId?: string;
    withEmail?: boolean;
  }): Promise<string> {
    const userId = createUserId();
    createdUserIds.push(userId);
    await prisma.user.create({
      data: {
        id: userId,
        clerkId: data.clerkId,
        organizationId: data.organizationId,
        whalesyncUserId: data.whalesyncUserId,
        whalesyncTeamId: data.whalesyncTeamId,
        email: data.withEmail ? `teamless-${userId.toLowerCase()}@example.com` : undefined,
      },
    });
    return userId;
  }

  /** A shadow user made for a Whalesync person before teams, never given one: `ws_<person>` clerkId and email. */
  async function createPureTeamlessShadowUser(options: {
    withOrganization: boolean;
    withLeftoverWhalesyncUserId: boolean;
  }): Promise<{ userId: string; organizationId: string | undefined }> {
    const whalesyncPersonId = randomUUID();
    const clerkId = `ws_${whalesyncPersonId}`;
    const organizationId = options.withOrganization ? await createOrganization(clerkId) : undefined;
    const userId = await createUser({
      clerkId,
      organizationId,
      whalesyncUserId: options.withLeftoverWhalesyncUserId ? whalesyncPersonId : undefined,
      withEmail: true,
    });
    return { userId, organizationId };
  }

  async function createWorkbook(options: {
    organizationId: string;
    creatorUserId: string | null;
    managedBy: 'ws_export' | null;
  }): Promise<string> {
    const workbookId = createWorkbookId();
    const connectorAccountId = createConnectorAccountId();
    await prisma.workbook.create({
      data: {
        id: workbookId,
        name: options.managedBy ? 'A Live Export' : 'My Scratch workspace',
        organizationId: options.organizationId,
        userId: options.creatorUserId ?? undefined,
        managedBy: options.managedBy ?? undefined,
        ...(options.creatorUserId
          ? { workspacePermissions: { create: { id: createWorkspacePermissionId(), userId: options.creatorUserId } } }
          : {}),
      },
    });
    await prisma.connectorAccount.create({
      data: {
        id: connectorAccountId,
        workbookId,
        userId: options.creatorUserId ?? undefined,
        service: 'AIRTABLE',
        displayName: 'Airtable',
        repoPath: `${options.organizationId}/${workbookId}/${connectorAccountId}`,
        encryptedCredentials: { sealed: `credentials-${connectorAccountId}` },
      },
    });
    return workbookId;
  }

  async function createTeamlessShadowUserFixtures(): Promise<TeamlessShadowUserFixtures> {
    const pureWithOrganization = await createPureTeamlessShadowUser({
      withOrganization: true,
      withLeftoverWhalesyncUserId: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const pureWithOrganizationOrganizationId = pureWithOrganization.organizationId!;
    const nativeWorkbookId = await createWorkbook({
      organizationId: pureWithOrganizationOrganizationId,
      creatorUserId: pureWithOrganization.userId,
      managedBy: null,
    });

    const pureWithoutOrganization = await createPureTeamlessShadowUser({
      withOrganization: false,
      withLeftoverWhalesyncUserId: false,
    });

    const createdALiveExport = await createPureTeamlessShadowUser({
      withOrganization: true,
      withLeftoverWhalesyncUserId: true,
    });
    const liveExportCreatedByTeamlessShadowUser = await createWorkbook({
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      organizationId: createdALiveExport.organizationId!,
      creatorUserId: createdALiveExport.userId,
      managedBy: 'ws_export',
    });

    const organizationOwnsALiveExport = await createPureTeamlessShadowUser({
      withOrganization: true,
      withLeftoverWhalesyncUserId: true,
    });
    // Its creator is gone (`Workbook.userId` was set null), but the organization still owns it.
    const liveExportOwnedByTeamlessShadowUserOrganization = await createWorkbook({
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      organizationId: organizationOwnsALiveExport.organizationId!,
      creatorUserId: null,
      managedBy: 'ws_export',
    });

    const realAccountClerkId = `user_${randomUUID()}`;
    const realAccountOrganizationId = await createOrganization(realAccountClerkId);
    const realAccountUserId = await createUser({
      clerkId: realAccountClerkId,
      organizationId: realAccountOrganizationId,
      whalesyncUserId: randomUUID(),
      withEmail: true,
    });
    await createWorkbook({
      organizationId: realAccountOrganizationId,
      creatorUserId: realAccountUserId,
      managedBy: null,
    });

    const organizationHasAnotherMember = await createPureTeamlessShadowUser({
      withOrganization: true,
      withLeftoverWhalesyncUserId: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const sharedOrganizationId = organizationHasAnotherMember.organizationId!;
    await createUser({ clerkId: `user_${randomUUID()}`, organizationId: sharedOrganizationId, withEmail: true });
    await createWorkbook({
      organizationId: sharedOrganizationId,
      creatorUserId: organizationHasAnotherMember.userId,
      managedBy: null,
    });

    const whalesyncTeamId = `tm_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const shadowUserOfTeamOrganizationId = await createOrganization(`ws_${whalesyncTeamId}`);
    const shadowUserOfTeamUserId = await createUser({
      clerkId: `ws_${whalesyncTeamId}`,
      organizationId: shadowUserOfTeamOrganizationId,
      whalesyncTeamId,
    });

    return {
      pureTeamlessShadowUserWithOrganization: {
        userId: pureWithOrganization.userId,
        organizationId: pureWithOrganizationOrganizationId,
        nativeWorkbookId,
      },
      pureTeamlessShadowUserWithoutOrganizationUserId: pureWithoutOrganization.userId,
      teamlessShadowUserThatCreatedALiveExport: {
        userId: createdALiveExport.userId,
        liveExportWorkbookId: liveExportCreatedByTeamlessShadowUser,
      },
      teamlessShadowUserWhoseOrganizationOwnsALiveExport: {
        userId: organizationOwnsALiveExport.userId,
        liveExportWorkbookId: liveExportOwnedByTeamlessShadowUserOrganization,
      },
      realScratchAccountWithLeftoverWhalesyncUserId: {
        userId: realAccountUserId,
        organizationId: realAccountOrganizationId,
      },
      teamlessShadowUserWhoseOrganizationHasAnotherMember: {
        userId: organizationHasAnotherMember.userId,
        organizationId: sharedOrganizationId,
      },
      shadowUserOfTeamUserId,
    };
  }

  function allUserIdsOfFixtures(fixtures: TeamlessShadowUserFixtures): string[] {
    return [
      fixtures.pureTeamlessShadowUserWithOrganization.userId,
      fixtures.pureTeamlessShadowUserWithoutOrganizationUserId,
      fixtures.teamlessShadowUserThatCreatedALiveExport.userId,
      fixtures.teamlessShadowUserWhoseOrganizationOwnsALiveExport.userId,
      fixtures.realScratchAccountWithLeftoverWhalesyncUserId.userId,
      fixtures.teamlessShadowUserWhoseOrganizationHasAnotherMember.userId,
      fixtures.shadowUserOfTeamUserId,
    ];
  }

  function countOfSummaryRow(result: MigrationResult, label: string): number | undefined {
    return result.summary?.find((summaryRow) => summaryRow.label === label)?.count;
  }

  /** A snapshot of every row the fixtures created, to prove a run wrote nothing. */
  async function snapshotRowsOfUsers(userIds: string[]) {
    const users = await prisma.user.findMany({ where: { id: { in: userIds } }, orderBy: { id: 'asc' } });
    const organizationIds = users.flatMap((user) => (user.organizationId ? [user.organizationId] : []));
    return {
      users,
      organizations: await prisma.organization.findMany({
        where: { id: { in: organizationIds } },
        orderBy: { id: 'asc' },
      }),
      workbooks: await prisma.workbook.findMany({
        where: { organizationId: { in: organizationIds } },
        orderBy: { id: 'asc' },
      }),
    };
  }

  /** The skips every run reports for the users it must leave alone. */
  function expectSkipsReported(result: MigrationResult, fixtures: TeamlessShadowUserFixtures): void {
    expect(result.report).toEqual(
      expect.arrayContaining([
        `${fixtures.teamlessShadowUserThatCreatedALiveExport.userId}: Skipped: holds a Live Export`,
        `${fixtures.teamlessShadowUserWhoseOrganizationOwnsALiveExport.userId}: Skipped: holds a Live Export`,
        `${fixtures.realScratchAccountWithLeftoverWhalesyncUserId.userId}: Skipped: not a pure shadow user (has a real Clerk login)`,
        `${fixtures.teamlessShadowUserWhoseOrganizationHasAnotherMember.userId}: Skipped: organization has another member`,
      ]),
    );
    expect(countOfSummaryRow(result, 'Skipped: holds a Live Export')).toBe(2);
    expect(countOfSummaryRow(result, 'Skipped: not a pure shadow user (has a real Clerk login)')).toBe(1);
    expect(countOfSummaryRow(result, 'Skipped: organization has another member')).toBe(1);
    expect(countOfSummaryRow(result, 'Failed')).toBe(0);
    // A team's shadow user is never a candidate, even when its id is passed in.
    expect(result.report?.some((reportLine) => reportLine.startsWith(fixtures.shadowUserOfTeamUserId))).toBe(false);
  }

  it('reports what it would deprovision on a dry run, and writes nothing', async () => {
    const fixtures = await createTeamlessShadowUserFixtures();
    const allFixtureUserIds = allUserIdsOfFixtures(fixtures);
    const rowsBeforeDryRun = await snapshotRowsOfUsers(allFixtureUserIds);
    const repoDeletionCountBeforeDryRun = scratchGitRepoIdsDeleted.length;

    const dryRunResult = await migrationService.run({ dryRun: true, scratchUserIdsToConsider: allFixtureUserIds });

    expect(dryRunResult.dryRun).toBe(true);
    expect([...dryRunResult.migratedIds].sort()).toEqual(
      [
        fixtures.pureTeamlessShadowUserWithOrganization.userId,
        fixtures.pureTeamlessShadowUserWithoutOrganizationUserId,
      ].sort(),
    );
    expect(dryRunResult.report).toEqual(
      expect.arrayContaining([
        `${fixtures.pureTeamlessShadowUserWithOrganization.userId}: would deprovision`,
        `${fixtures.pureTeamlessShadowUserWithoutOrganizationUserId}: would deprovision`,
      ]),
    );
    expect(dryRunResult.report).toHaveLength(6);
    expect(countOfSummaryRow(dryRunResult, 'Candidates (teamless shadow users) before this run')).toBe(6);
    expect(countOfSummaryRow(dryRunResult, 'Would deprovision')).toBe(2);
    expectSkipsReported(dryRunResult, fixtures);
    // Nothing was deleted, so every candidate remains.
    expect(dryRunResult.remainingCount).toBe(6);
    expect(await snapshotRowsOfUsers(allFixtureUserIds)).toEqual(rowsBeforeDryRun);
    expect(scratchGitRepoIdsDeleted).toHaveLength(repoDeletionCountBeforeDryRun);
  });

  it('deprovisions the pure teamless shadow users with their organizations and workbooks; a second run is a no-op', async () => {
    const fixtures = await createTeamlessShadowUserFixtures();
    const allFixtureUserIds = allUserIdsOfFixtures(fixtures);
    const realAccountBefore = await prisma.user.findUniqueOrThrow({
      where: { id: fixtures.realScratchAccountWithLeftoverWhalesyncUserId.userId },
    });

    const firstRunResult = await migrationService.run({ dryRun: false, scratchUserIdsToConsider: allFixtureUserIds });

    expect(firstRunResult.dryRun).toBe(false);
    expect([...firstRunResult.migratedIds].sort()).toEqual(
      [
        fixtures.pureTeamlessShadowUserWithOrganization.userId,
        fixtures.pureTeamlessShadowUserWithoutOrganizationUserId,
      ].sort(),
    );
    expect(firstRunResult.report).toEqual(
      expect.arrayContaining([
        `${fixtures.pureTeamlessShadowUserWithOrganization.userId}: deprovisioned`,
        `${fixtures.pureTeamlessShadowUserWithoutOrganizationUserId}: deprovisioned`,
      ]),
    );
    expect(countOfSummaryRow(firstRunResult, 'Deprovisioned')).toBe(2);
    expectSkipsReported(firstRunResult, fixtures);
    // The four skipped users are still candidates.
    expect(firstRunResult.remainingCount).toBe(4);

    // Deprovisioned: the user, its organization, and the organization's workbook (with its repos) are gone.
    const { userId, organizationId, nativeWorkbookId } = fixtures.pureTeamlessShadowUserWithOrganization;
    expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull();
    expect(await prisma.organization.findUnique({ where: { id: organizationId } })).toBeNull();
    expect(await prisma.workbook.findUnique({ where: { id: nativeWorkbookId } })).toBeNull();
    expect(scratchGitRepoIdsDeleted).toContain(`${organizationId}/${nativeWorkbookId}/${nativeWorkbookId}`);
    expect(
      await prisma.user.findUnique({ where: { id: fixtures.pureTeamlessShadowUserWithoutOrganizationUserId } }),
    ).toBeNull();

    // Skipped: everything they hold stays.
    expect(
      await prisma.workbook.findUnique({
        where: { id: fixtures.teamlessShadowUserThatCreatedALiveExport.liveExportWorkbookId },
      }),
    ).not.toBeNull();
    expect(
      await prisma.workbook.findUnique({
        where: { id: fixtures.teamlessShadowUserWhoseOrganizationOwnsALiveExport.liveExportWorkbookId },
      }),
    ).not.toBeNull();
    expect(
      await prisma.user.findUniqueOrThrow({
        where: { id: fixtures.realScratchAccountWithLeftoverWhalesyncUserId.userId },
      }),
    ).toEqual(realAccountBefore);
    expect(
      await prisma.organization.findUnique({
        where: { id: fixtures.realScratchAccountWithLeftoverWhalesyncUserId.organizationId },
      }),
    ).not.toBeNull();
    expect(
      await prisma.user.count({
        where: { organizationId: fixtures.teamlessShadowUserWhoseOrganizationHasAnotherMember.organizationId },
      }),
    ).toBe(2);
    expect(await prisma.user.findUnique({ where: { id: fixtures.shadowUserOfTeamUserId } })).not.toBeNull();

    // Idempotent: a second run deletes nothing and reports the same skips.
    const rowsBeforeSecondRun = await snapshotRowsOfUsers(allFixtureUserIds);
    const repoDeletionCountBeforeSecondRun = scratchGitRepoIdsDeleted.length;

    const secondRunResult = await migrationService.run({ dryRun: false, scratchUserIdsToConsider: allFixtureUserIds });

    expect(secondRunResult.migratedIds).toEqual([]);
    expect(countOfSummaryRow(secondRunResult, 'Candidates (teamless shadow users) before this run')).toBe(4);
    expect(countOfSummaryRow(secondRunResult, 'Deprovisioned')).toBe(0);
    expectSkipsReported(secondRunResult, fixtures);
    expect(secondRunResult.remainingCount).toBe(4);
    expect(await snapshotRowsOfUsers(allFixtureUserIds)).toEqual(rowsBeforeSecondRun);
    expect(scratchGitRepoIdsDeleted).toHaveLength(repoDeletionCountBeforeSecondRun);
  });

  it('considers only the given Scratch user ids', async () => {
    const fixtures = await createTeamlessShadowUserFixtures();

    const narrowedRunResult = await migrationService.run({
      dryRun: false,
      scratchUserIdsToConsider: [fixtures.pureTeamlessShadowUserWithOrganization.userId],
    });

    expect(narrowedRunResult.migratedIds).toEqual([fixtures.pureTeamlessShadowUserWithOrganization.userId]);
    expect(narrowedRunResult.report).toEqual([
      `${fixtures.pureTeamlessShadowUserWithOrganization.userId}: deprovisioned`,
    ]);
    expect(narrowedRunResult.remainingCount).toBe(0);
    // The other eligible user was not considered, so it is still there.
    expect(
      await prisma.user.findUnique({ where: { id: fixtures.pureTeamlessShadowUserWithoutOrganizationUserId } }),
    ).not.toBeNull();

    // Narrowed to users that aren't candidates (a team's shadow user), the run considers no one.
    const nonCandidateRunResult = await migrationService.run({
      dryRun: false,
      scratchUserIdsToConsider: [fixtures.shadowUserOfTeamUserId],
    });
    expect(nonCandidateRunResult.migratedIds).toEqual([]);
    expect(nonCandidateRunResult.report).toEqual([]);
    expect(await prisma.user.findUnique({ where: { id: fixtures.shadowUserOfTeamUserId } })).not.toBeNull();
  });

  it('considers at most the given number of candidates', async () => {
    const fixtures = await createTeamlessShadowUserFixtures();
    const bothEligibleUserIds = [
      fixtures.pureTeamlessShadowUserWithOrganization.userId,
      fixtures.pureTeamlessShadowUserWithoutOrganizationUserId,
    ];

    const limitedRunResult = await migrationService.run({
      dryRun: false,
      scratchUserIdsToConsider: bothEligibleUserIds,
      maximumCandidateCount: 1,
    });

    expect(countOfSummaryRow(limitedRunResult, 'Candidates (teamless shadow users) before this run')).toBe(2);
    expect(countOfSummaryRow(limitedRunResult, 'Considered this run')).toBe(1);
    expect(limitedRunResult.migratedIds).toHaveLength(1);
    expect(bothEligibleUserIds).toContain(limitedRunResult.migratedIds[0]);
    expect(limitedRunResult.remainingCount).toBe(1);
    const usersStillPresent = await prisma.user.findMany({
      where: { id: { in: bothEligibleUserIds } },
      select: { id: true },
    });
    expect(usersStillPresent.map((user) => user.id)).toEqual(
      bothEligibleUserIds.filter((userId) => userId !== limitedRunResult.migratedIds[0]),
    );

    // The next limited run takes the other one.
    const nextLimitedRunResult = await migrationService.run({
      dryRun: false,
      scratchUserIdsToConsider: bothEligibleUserIds,
      maximumCandidateCount: 1,
    });
    expect(nextLimitedRunResult.migratedIds).toEqual(usersStillPresent.map((user) => user.id));
    expect(nextLimitedRunResult.remainingCount).toBe(0);
  });
});
