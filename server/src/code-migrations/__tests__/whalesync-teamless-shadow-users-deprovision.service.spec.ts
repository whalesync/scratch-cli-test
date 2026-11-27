import { ConflictException } from '@nestjs/common';
import { UserCluster } from 'src/db/cluster-types';
import { DbService } from 'src/db/db.service';
import { WhalesyncInternalService } from 'src/internal/whalesync-internal.service';
import { UsersService } from 'src/users/users.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { WhalesyncTeamlessShadowUsersDeprovisionService } from '../whalesync-teamless-shadow-users-deprovision.service';

function makeUser(overrides: Partial<UserCluster.User>): UserCluster.User {
  return {
    id: 'usr_teamless',
    clerkId: 'ws_3f1c2a4e-5b6d-4c7e-8f90-a1b2c3d4e5f6',
    whalesyncTeamId: null,
    organizationId: 'org_teamless',
    ...overrides,
  } as unknown as UserCluster.User;
}

describe('WhalesyncTeamlessShadowUsersDeprovisionService', () => {
  let usersById: Map<string, UserCluster.User>;
  let organizationMemberCountByOrganizationId: Map<string, number>;
  let liveExportCountOwnedByOrganizationId: Map<string, number>;
  let liveExportWorkbookIdsCreatedByUserId: Map<string, string[]>;
  let userFindMany: jest.Mock;
  let deleteShadowUserWithItsOrganizationAndOwnedWorkbooks: jest.Mock;
  let service: WhalesyncTeamlessShadowUsersDeprovisionService;

  beforeEach(() => {
    usersById = new Map();
    organizationMemberCountByOrganizationId = new Map();
    liveExportCountOwnedByOrganizationId = new Map();
    liveExportWorkbookIdsCreatedByUserId = new Map();

    // Answers the candidate query the way Postgres would: no team, and a ws_ clerkId or a leftover person id.
    userFindMany = jest.fn((args: { where: { id?: { in: string[] } } }) =>
      Promise.resolve(
        [...usersById.values()]
          .filter((user) => user.whalesyncTeamId === null)
          .filter((user) => user.clerkId?.startsWith('ws_') === true || user.whalesyncUserId)
          .filter((user) => !args.where.id || args.where.id.in.includes(user.id))
          .sort((first, second) => first.id.localeCompare(second.id))
          .map((user) => ({ id: user.id })),
      ),
    );
    deleteShadowUserWithItsOrganizationAndOwnedWorkbooks = jest.fn((user: UserCluster.User) => {
      if (!user.clerkId?.startsWith('ws_')) {
        return Promise.reject(new ConflictException('real account'));
      }
      usersById.delete(user.id);
      return Promise.resolve();
    });

    const db = {
      client: {
        user: { findMany: userFindMany },
        workbook: {
          count: jest.fn((args: { where: { organizationId: string } }) =>
            Promise.resolve(liveExportCountOwnedByOrganizationId.get(args.where.organizationId) ?? 0),
          ),
        },
      },
    } as unknown as DbService;
    const usersService = {
      findOne: jest.fn((userId: string) => Promise.resolve(usersById.get(userId) ?? null)),
      isSoleMemberOfOrganization: jest.fn((user: UserCluster.User) =>
        Promise.resolve((organizationMemberCountByOrganizationId.get(user.organizationId ?? '') ?? 1) === 1),
      ),
    } as unknown as UsersService;
    const workbookService = {
      findIdsOfLiveExportWorkbooksCreatedByUser: jest.fn((userId: string) =>
        Promise.resolve(liveExportWorkbookIdsCreatedByUserId.get(userId) ?? []),
      ),
    } as unknown as WorkbookService;
    const whalesyncInternalService = {
      deleteShadowUserWithItsOrganizationAndOwnedWorkbooks,
    } as unknown as WhalesyncInternalService;

    service = new WhalesyncTeamlessShadowUsersDeprovisionService(
      db,
      usersService,
      workbookService,
      whalesyncInternalService,
    );
  });

  function addUser(overrides: Partial<UserCluster.User>): UserCluster.User {
    const user = makeUser(overrides);
    usersById.set(user.id, user);
    return user;
  }

  it('deprovisions a teamless pure shadow user, skips and reports the rest, and never considers a team user', async () => {
    addUser({ id: 'usr_a_teamless_pure' });
    addUser({ id: 'usr_b_holds_created_live_export', organizationId: 'org_b' });
    liveExportWorkbookIdsCreatedByUserId.set('usr_b_holds_created_live_export', ['wkb_export']);
    addUser({ id: 'usr_c_org_owns_live_export', organizationId: 'org_c' });
    liveExportCountOwnedByOrganizationId.set('org_c', 1);
    addUser({ id: 'usr_d_shared_org', organizationId: 'org_d' });
    organizationMemberCountByOrganizationId.set('org_d', 2);
    addUser({ id: 'usr_e_real_account', clerkId: 'user_real', whalesyncUserId: 'wsu-leftover' });
    addUser({ id: 'usr_f_team_shadow_user', clerkId: 'ws_tm_acme', whalesyncTeamId: 'tm_acme' });

    const result = await service.run({ dryRun: false });

    expect(result.migratedIds).toEqual(['usr_a_teamless_pure']);
    expect(deleteShadowUserWithItsOrganizationAndOwnedWorkbooks).toHaveBeenCalledTimes(1);
    expect(deleteShadowUserWithItsOrganizationAndOwnedWorkbooks).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'usr_a_teamless_pure' }),
      { deprovisionReason: 'whalesync-teamless-shadow-users-deprovision' },
    );
    expect(result.report).toEqual([
      'usr_a_teamless_pure: deprovisioned',
      'usr_b_holds_created_live_export: Skipped: holds a Live Export',
      'usr_c_org_owns_live_export: Skipped: holds a Live Export',
      'usr_d_shared_org: Skipped: organization has another member',
      'usr_e_real_account: Skipped: not a pure shadow user (has a real Clerk login)',
    ]);
    expect(result.remainingCount).toBe(4);
    expect(usersById.has('usr_f_team_shadow_user')).toBe(true);
  });

  it('writes nothing on a dry run and reports what it would deprovision', async () => {
    addUser({ id: 'usr_teamless' });

    const result = await service.run({ dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.migratedIds).toEqual(['usr_teamless']);
    expect(result.report).toEqual(['usr_teamless: would deprovision']);
    expect(result.summary).toContainEqual({ label: 'Would deprovision', count: 1 });
    expect(deleteShadowUserWithItsOrganizationAndOwnedWorkbooks).not.toHaveBeenCalled();
    expect(result.remainingCount).toBe(1);
  });

  it('is idempotent: a second run finds nothing left to deprovision', async () => {
    addUser({ id: 'usr_teamless' });

    await service.run({ dryRun: false });
    const secondRunResult = await service.run({ dryRun: false });

    expect(secondRunResult.migratedIds).toEqual([]);
    expect(secondRunResult.remainingCount).toBe(0);
    expect(deleteShadowUserWithItsOrganizationAndOwnedWorkbooks).toHaveBeenCalledTimes(1);
  });

  it('narrows to the given ids, which must still be candidates, and limits to qty', async () => {
    addUser({ id: 'usr_first' });
    addUser({ id: 'usr_second' });
    addUser({ id: 'usr_team', clerkId: 'ws_tm_acme', whalesyncTeamId: 'tm_acme' });

    const narrowedResult = await service.run({ dryRun: true, scratchUserIdsToConsider: ['usr_second', 'usr_team'] });
    expect(narrowedResult.migratedIds).toEqual(['usr_second']);

    const limitedResult = await service.run({ dryRun: true, maximumCandidateCount: 1 });
    expect(limitedResult.migratedIds).toEqual(['usr_first']);
    expect(limitedResult.summary).toContainEqual({
      label: 'Candidates (teamless shadow users) before this run',
      count: 2,
    });
  });

  it('re-checks each candidate right before deleting it', async () => {
    addUser({ id: 'usr_given_team_meanwhile' });
    addUser({ id: 'usr_deleted_meanwhile' });
    // The candidate query sees both; by the time each one's turn comes, one has a team and the other is gone.
    userFindMany.mockImplementationOnce(() =>
      Promise.resolve([{ id: 'usr_deleted_meanwhile' }, { id: 'usr_given_team_meanwhile' }]),
    );
    usersById.set('usr_given_team_meanwhile', makeUser({ id: 'usr_given_team_meanwhile', whalesyncTeamId: 'tm_new' }));
    usersById.delete('usr_deleted_meanwhile');

    const result = await service.run({ dryRun: false });

    expect(result.report).toEqual([
      'usr_deleted_meanwhile: already gone',
      'usr_given_team_meanwhile: Skipped: was given a Whalesync team meanwhile',
    ]);
    expect(deleteShadowUserWithItsOrganizationAndOwnedWorkbooks).not.toHaveBeenCalled();
  });

  it('reports a failed delete and goes on with the rest', async () => {
    addUser({ id: 'usr_a_fails' });
    addUser({ id: 'usr_b_succeeds' });
    deleteShadowUserWithItsOrganizationAndOwnedWorkbooks.mockRejectedValueOnce(new Error('scratch-git unavailable'));

    const result = await service.run({ dryRun: false });

    expect(result.report).toEqual(['usr_a_fails: FAILED: scratch-git unavailable', 'usr_b_succeeds: deprovisioned']);
    expect(result.summary).toContainEqual({ label: 'Failed', count: 1 });
  });
});
