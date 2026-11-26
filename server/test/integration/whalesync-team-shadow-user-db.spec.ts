/**
 * DB-backed integration test for DEV-13019 (a Whalesync shadow user per team), run against real Postgres.
 *
 * The unit specs mock Prisma. This spec validates what those mocks can't (migration
 * `20261125120000_user_whalesync_team_id`):
 *   - the unique `whalesyncTeamId`, which keeps two shadow users from holding one team's Live Exports;
 *   - recording a team on a shadow user made before teams, guarded on the row still having none;
 *   - the page of shadow users that have no team yet, and its cursor.
 * Every id is unique to this run, so the assertions hold on a database that has other data.
 */

import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createOrganizationId, createUserId } from '@spinner/shared-types';
import { randomUUID } from 'crypto';
import { DbService } from 'src/db/db.service';
import { UsersService } from 'src/users/users.service';
import { createIntegrationTestDbService } from './integration-db-service';

/** A Whalesync team id shaped like the real ones (`tm_` and 12 characters), unique to this run. */
function createWhalesyncTeamIdForTest(): string {
  return `tm_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

describe('Whalesync shadow user per team (DB-backed)', () => {
  let prisma: PrismaClient;
  let db: DbService;
  let usersService: UsersService;

  const createdWhalesyncUserIds: string[] = [];
  const createdWhalesyncTeamIds: string[] = [];

  /** A shadow user as they were made before teams: linked to one Whalesync person, with no team id. */
  async function createShadowUserMadeBeforeTeams(options: { realScratchAccount?: boolean } = {}): Promise<{
    scratchUserId: string;
    whalesyncUserId: string;
  }> {
    const scratchUserId = createUserId();
    const organizationId = createOrganizationId();
    const whalesyncUserId = randomUUID();
    createdWhalesyncUserIds.push(whalesyncUserId);
    const clerkId = options.realScratchAccount ? `user_${whalesyncUserId}` : `ws_${whalesyncUserId}`;
    await prisma.organization.create({ data: { id: organizationId, name: 'Team shadow test org', clerkId } });
    await prisma.user.create({
      data: {
        id: scratchUserId,
        email: `team-shadow-${scratchUserId}@example.com`,
        organizationId,
        whalesyncUserId,
        clerkId,
      },
    });
    return { scratchUserId, whalesyncUserId };
  }

  function newWhalesyncTeamId(): string {
    const whalesyncTeamId = createWhalesyncTeamIdForTest();
    createdWhalesyncTeamIds.push(whalesyncTeamId);
    return whalesyncTeamId;
  }

  /** A session request for a team, as the team's only member unless said otherwise. */
  function ensureTeamShadowUser(
    whalesyncTeamId: string,
    actingWhalesyncUserId: string,
    options: { actingUserIsTeamsOnlyMember: boolean } = { actingUserIsTeamsOnlyMember: true },
  ) {
    return usersService.getOrCreateShadowUserFromWhalesync(
      actingWhalesyncUserId,
      `acting-${actingWhalesyncUserId}@example.com`,
      'Acting Person',
      undefined,
      { whalesyncTeamId, ...options },
    );
  }

  /** A session request by person alone, as a Whalesync server that hasn't changed over to teams makes it. */
  function ensureShadowUserByPerson(whalesyncUserId: string) {
    createdWhalesyncUserIds.push(whalesyncUserId);
    return usersService.getOrCreateShadowUserFromWhalesync(
      whalesyncUserId,
      `person-${whalesyncUserId}@example.com`,
      'A Person',
    );
  }

  beforeAll(() => {
    prisma = new PrismaClient();
    db = createIntegrationTestDbService(prisma);
    usersService = new UsersService(
      db,
      { identifyNewUser: jest.fn(), trackWhalesyncAccountLinked: jest.fn() } as never,
      {} as never,
      { sendMessage: jest.fn() } as never,
      {} as never,
      // The default workspace needs scratch-git, which this spec does not run; it isn't what is under test.
      { createWorkbookWithConfigRepo: jest.fn().mockResolvedValue({ id: 'wkb_unused' }) } as never,
      { getBooleanFlag: jest.fn().mockResolvedValue(false) } as never,
      { ensureWhalesyncPlanSubscription: jest.fn().mockResolvedValue(undefined) } as never,
    );
  });

  afterAll(async () => {
    const createdUsers = await prisma.user.findMany({
      where: {
        OR: [
          { whalesyncUserId: { in: createdWhalesyncUserIds } },
          { whalesyncTeamId: { in: createdWhalesyncTeamIds } },
        ],
      },
      select: { id: true, organizationId: true },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUsers.map((user) => user.id) } } });
    await prisma.organization.deleteMany({
      where: { id: { in: createdUsers.flatMap((user) => (user.organizationId ? [user.organizationId] : [])) } },
    });
    await prisma.$disconnect();
  });

  it("makes a person's shadow user from before teams their team's, once", async () => {
    const { scratchUserId, whalesyncUserId } = await createShadowUserMadeBeforeTeams();
    const whalesyncTeamId = newWhalesyncTeamId();

    const first = await ensureTeamShadowUser(whalesyncTeamId, whalesyncUserId);
    const again = await ensureTeamShadowUser(whalesyncTeamId, whalesyncUserId);

    expect(first.id).toBe(scratchUserId);
    expect(again.id).toBe(scratchUserId);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: scratchUserId } });
    expect(stored.whalesyncTeamId).toBe(whalesyncTeamId);
    // Still the person's too, so a Whalesync that hasn't deployed its side keeps finding it by user id.
    expect(stored.whalesyncUserId).toBe(whalesyncUserId);
    // A pure shadow user no longer carries its person's email once it is a team's.
    expect(stored.email).toBeNull();
  });

  it('finds one shadow user whether Whalesync asks by team or by person, in either order', async () => {
    // By team first: a server on the new code creates it, then one still on the old code asks by person.
    const teamFirstTeamId = newWhalesyncTeamId();
    const teamFirstUserId = randomUUID();
    const createdByTeam = await ensureTeamShadowUser(teamFirstTeamId, teamFirstUserId);
    const foundByPerson = await ensureShadowUserByPerson(teamFirstUserId);

    expect(foundByPerson.id).toBe(createdByTeam.id);
    // Asking by person must not put that person's email on the team's shadow user.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: createdByTeam.id } })).email).toBeNull();

    // By person first, then by team.
    const personFirstTeamId = newWhalesyncTeamId();
    const personFirstUserId = randomUUID();
    const createdByPerson = await ensureShadowUserByPerson(personFirstUserId);
    const foundByTeam = await ensureTeamShadowUser(personFirstTeamId, personFirstUserId);

    expect(foundByTeam.id).toBe(createdByPerson.id);
    expect(await prisma.user.count({ where: { whalesyncTeamId: { in: [teamFirstTeamId, personFirstTeamId] } } })).toBe(
      2,
    );
  });

  it("leaves a person's own shadow user alone when they act in a team with several members", async () => {
    const { scratchUserId, whalesyncUserId } = await createShadowUserMadeBeforeTeams();
    const sharedTeamId = newWhalesyncTeamId();

    const forSharedTeam = await ensureTeamShadowUser(sharedTeamId, whalesyncUserId, {
      actingUserIsTeamsOnlyMember: false,
    });

    expect(forSharedTeam.id).not.toBe(scratchUserId);
    expect(forSharedTeam.whalesyncUserId).toBeNull();
    const ownShadowUser = await prisma.user.findUniqueOrThrow({ where: { id: scratchUserId } });
    expect(ownShadowUser.whalesyncTeamId).toBeNull();
    expect(ownShadowUser.email).not.toBeNull();
  });

  it("gives a teammate the team's shadow user, not one of their own", async () => {
    const { scratchUserId, whalesyncUserId } = await createShadowUserMadeBeforeTeams();
    const whalesyncTeamId = newWhalesyncTeamId();
    await ensureTeamShadowUser(whalesyncTeamId, whalesyncUserId);

    const forTeammate = await ensureTeamShadowUser(whalesyncTeamId, randomUUID(), {
      actingUserIsTeamsOnlyMember: false,
    });

    expect(forTeammate.id).toBe(scratchUserId);
  });

  it('creates a pure shadow user with no email for a team that has none', async () => {
    const whalesyncTeamId = newWhalesyncTeamId();

    const onlyMemberUserId = randomUUID();
    const created = await ensureTeamShadowUser(whalesyncTeamId, onlyMemberUserId);

    expect(created.clerkId).toBe(`ws_${whalesyncTeamId}`);
    expect(created.whalesyncTeamId).toBe(whalesyncTeamId);
    // Its only member's id too, so a lookup by person finds the same shadow user.
    expect(created.whalesyncUserId).toBe(onlyMemberUserId);
    expect(created.email).toBeNull();
    expect(created.organizationId).toEqual(expect.any(String));
  });

  it("does not take over a shadow user that already holds another team's Live Exports", async () => {
    const { scratchUserId, whalesyncUserId } = await createShadowUserMadeBeforeTeams();
    const firstTeamId = newWhalesyncTeamId();
    const secondTeamId = newWhalesyncTeamId();
    await ensureTeamShadowUser(firstTeamId, whalesyncUserId);

    const forSecondTeam = await ensureTeamShadowUser(secondTeamId, whalesyncUserId);

    expect(forSecondTeam.id).not.toBe(scratchUserId);
    expect(forSecondTeam.whalesyncTeamId).toBe(secondTeamId);
    // The person's id is unique and already on the first team's shadow user.
    expect(forSecondTeam.whalesyncUserId).toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: scratchUserId } })).whalesyncTeamId).toBe(firstTeamId);
  });

  it("refuses a teammate a session for a real Scratch account that holds the team's Live Exports", async () => {
    const { scratchUserId, whalesyncUserId } = await createShadowUserMadeBeforeTeams({ realScratchAccount: true });
    const whalesyncTeamId = newWhalesyncTeamId();

    expect((await ensureTeamShadowUser(whalesyncTeamId, whalesyncUserId)).id).toBe(scratchUserId);
    await expect(
      ensureTeamShadowUser(whalesyncTeamId, randomUUID(), { actingUserIsTeamsOnlyMember: false }),
    ).rejects.toBeInstanceOf(ConflictException);
    // A real account keeps its email: it is how its person signs in to Scratch.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: scratchUserId } })).email).not.toBeNull();
  });

  it('pages through the shadow users that have no team, and links each to the team Whalesync names', async () => {
    const unlinked = [
      await createShadowUserMadeBeforeTeams(),
      await createShadowUserMadeBeforeTeams(),
      await createShadowUserMadeBeforeTeams(),
    ].sort((a, b) => a.whalesyncUserId.localeCompare(b.whalesyncUserId));
    const idsOfUnlinked = unlinked.map((shadowUser) => shadowUser.whalesyncUserId);
    const alreadyLinked = await createShadowUserMadeBeforeTeams();
    const teamOfAlreadyLinked = newWhalesyncTeamId();
    await ensureTeamShadowUser(teamOfAlreadyLinked, alreadyLinked.whalesyncUserId);

    // The database may hold other shadow users with no team, so look only at this test's.
    const pendingBefore = await usersService.findWhalesyncUserIdsOfShadowUsersWithoutTeam(undefined, 100_000);
    expect(pendingBefore.filter((id) => idsOfUnlinked.includes(id))).toEqual(idsOfUnlinked);
    expect(pendingBefore).not.toContain(alreadyLinked.whalesyncUserId);
    expect([...pendingBefore].sort((a, b) => a.localeCompare(b))).toEqual(pendingBefore);

    const pendingAfterFirst = await usersService.findWhalesyncUserIdsOfShadowUsersWithoutTeam(
      idsOfUnlinked[0],
      100_000,
    );
    expect(pendingAfterFirst).not.toContain(idsOfUnlinked[0]);
    expect(pendingAfterFirst).toEqual(expect.arrayContaining(idsOfUnlinked.slice(1)));

    const teamForFirst = newWhalesyncTeamId();
    const result = await usersService.linkShadowUsersToWhalesyncTeams([
      { whalesyncUserId: idsOfUnlinked[0], whalesyncTeamId: teamForFirst },
      // Already carries this team.
      { whalesyncUserId: alreadyLinked.whalesyncUserId, whalesyncTeamId: teamOfAlreadyLinked },
      // Already carries a different team.
      { whalesyncUserId: alreadyLinked.whalesyncUserId, whalesyncTeamId: newWhalesyncTeamId() },
      // The team already has a shadow user: the unique index refuses a second.
      { whalesyncUserId: idsOfUnlinked[1], whalesyncTeamId: teamOfAlreadyLinked },
      { whalesyncUserId: randomUUID(), whalesyncTeamId: newWhalesyncTeamId() },
    ]);

    expect(result.linked).toBe(1);
    expect(result.alreadyLinked).toBe(1);
    expect(result.skipped.map((skipped) => skipped.reason)).toEqual([
      'linked_to_another_team',
      'team_has_another_shadow_user',
      'no_shadow_user',
    ]);
    const pendingAfter = await usersService.findWhalesyncUserIdsOfShadowUsersWithoutTeam(undefined, 100_000);
    expect(pendingAfter).not.toContain(idsOfUnlinked[0]);
    expect(pendingAfter).toEqual(expect.arrayContaining(idsOfUnlinked.slice(1)));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: unlinked[0].scratchUserId } })).whalesyncTeamId).toBe(
      teamForFirst,
    );
  });
});
