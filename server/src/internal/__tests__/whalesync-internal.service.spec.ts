import { ConflictException } from '@nestjs/common';
import { WorkbookId, WorkbookManager } from '@spinner/shared-types';
import { UserCluster, WorkbookCluster } from 'src/db/cluster-types';
import { StripePaymentService } from 'src/payment/stripe-payment.service';
import { UsersService } from 'src/users/users.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { WhalesyncInternalService } from '../whalesync-internal.service';

describe('WhalesyncInternalService', () => {
  let service: WhalesyncInternalService;
  let mockUsersService: jest.Mocked<
    Pick<
      UsersService,
      | 'findByWhalesyncUserId'
      | 'findShadowUserForWhalesyncTeam'
      | 'findWhalesyncUserIdsOfShadowUsersWithoutTeam'
      | 'linkShadowUsersToWhalesyncTeams'
      | 'isSoleMemberOfOrganization'
      | 'deleteShadowUserAndOrganization'
      | 'unlinkUserFromWhalesyncIdentity'
    >
  >;
  let mockStripePaymentService: jest.Mocked<
    Pick<StripePaymentService, 'clearWhalesyncPlanSubscription' | 'applyWhalesyncSubscriptionState'>
  >;
  let mockWorkbookService: jest.Mocked<
    Pick<
      WorkbookService,
      | 'findAllForUser'
      | 'findIdsOfAllWorkbooksOwnedByOrganization'
      | 'findIdsOfLiveExportWorkbooksCreatedByUser'
      | 'executeHardDeleteWorkbook'
    >
  >;

  beforeEach(() => {
    mockUsersService = {
      findByWhalesyncUserId: jest.fn(),
      findShadowUserForWhalesyncTeam: jest.fn(),
      findWhalesyncUserIdsOfShadowUsersWithoutTeam: jest.fn(),
      linkShadowUsersToWhalesyncTeams: jest.fn(),
      isSoleMemberOfOrganization: jest.fn(),
      deleteShadowUserAndOrganization: jest.fn(),
      unlinkUserFromWhalesyncIdentity: jest.fn(),
    };
    mockStripePaymentService = {
      clearWhalesyncPlanSubscription: jest.fn(),
      applyWhalesyncSubscriptionState: jest.fn(),
    };
    mockWorkbookService = {
      findAllForUser: jest.fn(),
      findIdsOfAllWorkbooksOwnedByOrganization: jest.fn(),
      findIdsOfLiveExportWorkbooksCreatedByUser: jest.fn(),
      executeHardDeleteWorkbook: jest.fn(),
    };
    service = new WhalesyncInternalService(
      mockUsersService as unknown as UsersService,
      mockWorkbookService as unknown as WorkbookService,
      mockStripePaymentService as unknown as StripePaymentService,
    );
  });

  describe('clearWhalesyncSubscriptionForWhalesyncUser', () => {
    it('is an idempotent no-op when no shadow user exists', async () => {
      mockUsersService.findByWhalesyncUserId.mockResolvedValue(null);

      const result = await service.clearWhalesyncSubscriptionForWhalesyncUser('ws_missing');

      expect(result).toEqual({ scratchUserId: null, cleared: false });
      expect(mockStripePaymentService.clearWhalesyncPlanSubscription).not.toHaveBeenCalled();
    });

    it('delegates to the payment service and returns the resolved shadow user id', async () => {
      const shadowUser = { id: 'usr_shadow' } as unknown as UserCluster.User;
      mockUsersService.findByWhalesyncUserId.mockResolvedValue(shadowUser);
      mockStripePaymentService.clearWhalesyncPlanSubscription.mockResolvedValue({ cleared: true });

      const result = await service.clearWhalesyncSubscriptionForWhalesyncUser('ws_1');

      expect(mockStripePaymentService.clearWhalesyncPlanSubscription).toHaveBeenCalledWith(shadowUser);
      expect(result).toEqual({ scratchUserId: 'usr_shadow', cleared: true });
    });

    it('propagates the ConflictException when the user has a real Scratch subscription', async () => {
      const shadowUser = { id: 'usr_paid' } as unknown as UserCluster.User;
      mockUsersService.findByWhalesyncUserId.mockResolvedValue(shadowUser);
      mockStripePaymentService.clearWhalesyncPlanSubscription.mockRejectedValue(new ConflictException('nope'));

      await expect(service.clearWhalesyncSubscriptionForWhalesyncUser('ws_paid')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('updateWhalesyncSubscription', () => {
    it('is an idempotent no-op when no shadow user exists', async () => {
      mockUsersService.findByWhalesyncUserId.mockResolvedValue(null);

      const result = await service.updateWhalesyncSubscription(
        { whalesyncUserId: 'ws_missing' },
        { status: 'expired' },
      );

      expect(result).toEqual({ scratchUserId: null, updated: false, planType: null });
      expect(mockStripePaymentService.applyWhalesyncSubscriptionState).not.toHaveBeenCalled();
    });

    it('delegates to the payment service with the 409-on-real-sub flag and returns the result', async () => {
      const shadowUser = { id: 'usr_shadow' } as unknown as UserCluster.User;
      mockUsersService.findByWhalesyncUserId.mockResolvedValue(shadowUser);
      mockStripePaymentService.applyWhalesyncSubscriptionState.mockResolvedValue({ planType: null, updated: true });

      const result = await service.updateWhalesyncSubscription({ whalesyncUserId: 'ws_1' }, { status: 'cancelled' });

      expect(mockStripePaymentService.applyWhalesyncSubscriptionState).toHaveBeenCalledWith(
        shadowUser,
        { status: 'cancelled' },
        { throwOnRealSubscriptionConflict: true },
      );
      expect(result).toEqual({ scratchUserId: 'usr_shadow', updated: true, planType: null });
    });

    it('propagates the ConflictException when the user has a real Scratch subscription', async () => {
      const shadowUser = { id: 'usr_paid' } as unknown as UserCluster.User;
      mockUsersService.findByWhalesyncUserId.mockResolvedValue(shadowUser);
      mockStripePaymentService.applyWhalesyncSubscriptionState.mockRejectedValue(new ConflictException('nope'));

      await expect(
        service.updateWhalesyncSubscription({ whalesyncUserId: 'ws_paid' }, { status: 'active' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('by team (DEV-13019)', () => {
    const teamShadowUser = {
      id: 'usr_team_shadow',
      clerkId: 'ws_tm_1',
      organizationId: 'org_team_shadow',
    } as unknown as UserCluster.User;

    it("applies a plan change to the team's shadow user, recording the team on one made before teams", async () => {
      mockUsersService.findShadowUserForWhalesyncTeam.mockResolvedValue(teamShadowUser);
      mockStripePaymentService.applyWhalesyncSubscriptionState.mockResolvedValue({ planType: null, updated: true });

      const result = await service.updateWhalesyncSubscription(
        { whalesyncTeamId: 'tm_1', whalesyncUserId: 'wsu_only_member' },
        { status: 'active' },
      );

      expect(mockUsersService.findShadowUserForWhalesyncTeam).toHaveBeenCalledWith('tm_1', 'wsu_only_member', {
        recordTeamIdOnShadowUserMadeBeforeTeams: true,
      });
      expect(mockUsersService.findByWhalesyncUserId).not.toHaveBeenCalled();
      expect(result).toEqual({ scratchUserId: 'usr_team_shadow', updated: true, planType: null });
    });

    it('is a no-op for a plan change to a team with no shadow user', async () => {
      mockUsersService.findShadowUserForWhalesyncTeam.mockResolvedValue(null);

      const result = await service.updateWhalesyncSubscription({ whalesyncTeamId: 'tm_none' }, { status: 'active' });

      expect(result).toEqual({ scratchUserId: null, updated: false, planType: null });
      expect(mockStripePaymentService.applyWhalesyncSubscriptionState).not.toHaveBeenCalled();
    });

    it("lists a team's Live Exports without recording anything", async () => {
      mockUsersService.findShadowUserForWhalesyncTeam.mockResolvedValue(teamShadowUser);
      mockWorkbookService.findAllForUser.mockResolvedValue([
        {
          id: 'wkb_1',
          name: 'Orders',
          isPendingDelete: false,
          createdAt: new Date('2026-11-01T00:00:00.000Z'),
          updatedAt: new Date('2026-11-02T00:00:00.000Z'),
        },
      ] as unknown as WorkbookCluster.Workbook[]);

      const result = await service.listLiveExportsForWhalesyncTeam('tm_1', 'wsu_only_member');

      expect(mockUsersService.findShadowUserForWhalesyncTeam).toHaveBeenCalledWith('tm_1', 'wsu_only_member', {
        recordTeamIdOnShadowUserMadeBeforeTeams: false,
      });
      expect(result.liveExports.map((liveExport) => liveExport.id)).toEqual(['wkb_1']);
    });

    it("deletes a team's pure shadow user with its organization and workbooks", async () => {
      mockUsersService.findShadowUserForWhalesyncTeam.mockResolvedValue(teamShadowUser);
      mockUsersService.isSoleMemberOfOrganization.mockResolvedValue(true);
      mockWorkbookService.findIdsOfAllWorkbooksOwnedByOrganization.mockResolvedValue(['wkb_1' as WorkbookId]);

      await service.deprovisionWhalesyncTeam('tm_1');

      expect(mockUsersService.findShadowUserForWhalesyncTeam).toHaveBeenCalledWith('tm_1', undefined, {
        recordTeamIdOnShadowUserMadeBeforeTeams: false,
      });
      expect(mockWorkbookService.executeHardDeleteWorkbook).toHaveBeenCalledWith('wkb_1', expect.anything());
      expect(mockUsersService.deleteShadowUserAndOrganization).toHaveBeenCalledWith(
        'usr_team_shadow',
        'org_team_shadow',
      );
    });

    it("unlinks rather than deletes when the team's Live Exports are held by a real Scratch account", async () => {
      const realScratchUser = { id: 'usr_real', clerkId: 'user_real', organizationId: 'org_real' };
      mockUsersService.findShadowUserForWhalesyncTeam.mockResolvedValue(realScratchUser as unknown as UserCluster.User);
      mockWorkbookService.findIdsOfLiveExportWorkbooksCreatedByUser.mockResolvedValue([]);
      mockStripePaymentService.clearWhalesyncPlanSubscription.mockResolvedValue({ cleared: false });
      mockUsersService.unlinkUserFromWhalesyncIdentity.mockResolvedValue({ revokedWhalesyncSessionTokenCount: 0 });

      await service.deprovisionWhalesyncTeam('tm_1', 'wsu_only_member');

      expect(mockUsersService.unlinkUserFromWhalesyncIdentity).toHaveBeenCalledWith('usr_real', {});
      expect(mockUsersService.deleteShadowUserAndOrganization).not.toHaveBeenCalled();
    });

    it('is a no-op when the team has no shadow user', async () => {
      mockUsersService.findShadowUserForWhalesyncTeam.mockResolvedValue(null);

      await service.deprovisionWhalesyncTeam('tm_none');

      expect(mockUsersService.deleteShadowUserAndOrganization).not.toHaveBeenCalled();
      expect(mockUsersService.unlinkUserFromWhalesyncIdentity).not.toHaveBeenCalled();
    });

    it('pages through the shadow users that have no team yet', async () => {
      mockUsersService.findWhalesyncUserIdsOfShadowUsersWithoutTeam.mockResolvedValue(['wsu_b', 'wsu_c']);

      const result = await service.listPendingTeamLinks('wsu_a');

      expect(mockUsersService.findWhalesyncUserIdsOfShadowUsersWithoutTeam).toHaveBeenCalledWith('wsu_a', 500);
      expect(result).toEqual({ whalesyncUserIds: ['wsu_b', 'wsu_c'] });
    });

    it('passes the team links through and returns what was done with each', async () => {
      const outcome = { linked: 1, alreadyLinked: 0, skipped: [] };
      mockUsersService.linkShadowUsersToWhalesyncTeams.mockResolvedValue(outcome);
      const links = [{ whalesyncUserId: 'wsu_a', whalesyncTeamId: 'tm_a' }];

      expect(await service.linkTeams(links)).toEqual(outcome);
      expect(mockUsersService.linkShadowUsersToWhalesyncTeams).toHaveBeenCalledWith(links);
    });
  });

  describe('listLiveExportsForWhalesyncUser', () => {
    const workbook = (id: string, name: string | null, isPendingDelete = false): WorkbookCluster.Workbook =>
      ({
        id,
        name,
        isPendingDelete,
        createdAt: new Date('2026-10-01T12:00:00.000Z'),
        updatedAt: new Date('2026-10-02T12:00:00.000Z'),
      }) as unknown as WorkbookCluster.Workbook;

    it('returns an empty list without looking up workbooks when no shadow user exists', async () => {
      mockUsersService.findByWhalesyncUserId.mockResolvedValue(null);

      const result = await service.listLiveExportsForWhalesyncUser('ws_missing');

      expect(result).toEqual({ liveExports: [] });
      expect(mockWorkbookService.findAllForUser).not.toHaveBeenCalled();
    });

    it('lists the Live Export workbooks newest first and skips those pending deletion', async () => {
      const shadowUser = { id: 'usr_shadow', organizationId: 'org_shadow' } as unknown as UserCluster.User;
      mockUsersService.findByWhalesyncUserId.mockResolvedValue(shadowUser);
      mockWorkbookService.findAllForUser.mockResolvedValue([
        workbook('wkb_named', 'Deals export'),
        workbook('wkb_deleting', 'Old export', true),
        workbook('wkb_unnamed', null),
      ]);

      const result = await service.listLiveExportsForWhalesyncUser('ws_1');

      expect(mockWorkbookService.findAllForUser).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'usr_shadow' }),
        'createdAt',
        'desc',
        WorkbookManager.WS_EXPORT,
      );
      expect(result).toEqual({
        liveExports: [
          {
            id: 'wkb_named',
            name: 'Deals export',
            createdAt: '2026-10-01T12:00:00.000Z',
            updatedAt: '2026-10-02T12:00:00.000Z',
          },
          {
            id: 'wkb_unnamed',
            name: null,
            createdAt: '2026-10-01T12:00:00.000Z',
            updatedAt: '2026-10-02T12:00:00.000Z',
          },
        ],
      });
    });
  });

  describe('deprovisionWhalesyncUser', () => {
    function idsOfDeletedWorkbooks(): string[] {
      return mockWorkbookService.executeHardDeleteWorkbook.mock.calls.map(([workbookId]) => workbookId);
    }

    it('is an idempotent no-op when no linked user exists', async () => {
      mockUsersService.findByWhalesyncUserId.mockResolvedValue(null);

      await service.deprovisionWhalesyncUser('ws_missing');

      expect(mockWorkbookService.executeHardDeleteWorkbook).not.toHaveBeenCalled();
      expect(mockUsersService.deleteShadowUserAndOrganization).not.toHaveBeenCalled();
      expect(mockUsersService.unlinkUserFromWhalesyncIdentity).not.toHaveBeenCalled();
      expect(mockStripePaymentService.clearWhalesyncPlanSubscription).not.toHaveBeenCalled();
    });

    describe('for a pure shadow user', () => {
      const shadowUser = {
        id: 'usr_shadow',
        clerkId: 'ws_1',
        organizationId: 'org_shadow',
      } as unknown as UserCluster.User;

      // Every workbook the shadow user can reach. The last one belongs to another org and was only shared with
      // the shadow user through a WorkspacePermission (the DEV-12427 "Whalesync Internal" case).
      const workbooksReachableByShadowUser = [
        { id: 'wkb_own_first', organizationId: 'org_shadow' },
        { id: 'wkb_own_second', organizationId: 'org_shadow' },
        { id: 'wkb_shared_from_other_org', organizationId: 'org_other' },
      ];

      beforeEach(() => {
        mockUsersService.findByWhalesyncUserId.mockResolvedValue(shadowUser);
        // The membership-scoped query returns every reachable workbook, including the shared one.
        mockWorkbookService.findAllForUser.mockResolvedValue(
          workbooksReachableByShadowUser as unknown as WorkbookCluster.Workbook[],
        );
        // The org-scoped query returns only the workbooks the given org owns.
        mockWorkbookService.findIdsOfAllWorkbooksOwnedByOrganization.mockImplementation((organizationId) =>
          Promise.resolve(
            workbooksReachableByShadowUser
              .filter((workbook) => workbook.organizationId === organizationId)
              .map((workbook) => workbook.id as WorkbookId),
          ),
        );
      });

      it('deletes the user, the org, and the org-owned workbooks, but not one another org shared', async () => {
        mockUsersService.isSoleMemberOfOrganization.mockResolvedValue(true);

        await service.deprovisionWhalesyncUser('ws_1');

        expect(mockWorkbookService.findIdsOfAllWorkbooksOwnedByOrganization).toHaveBeenCalledWith('org_shadow');
        expect(mockWorkbookService.findAllForUser).not.toHaveBeenCalled();
        expect(idsOfDeletedWorkbooks()).toEqual(['wkb_own_first', 'wkb_own_second']);
        expect(idsOfDeletedWorkbooks()).not.toContain('wkb_shared_from_other_org');
        for (const [, hardDeleteOptions] of mockWorkbookService.executeHardDeleteWorkbook.mock.calls) {
          expect(hardDeleteOptions?.actor?.userId).toBe('usr_shadow');
        }
        expect(mockUsersService.deleteShadowUserAndOrganization).toHaveBeenCalledWith('usr_shadow', 'org_shadow');
        expect(mockUsersService.unlinkUserFromWhalesyncIdentity).not.toHaveBeenCalled();
      });

      it('deletes only the user, not the org or its workbooks, when the org has another member', async () => {
        mockUsersService.isSoleMemberOfOrganization.mockResolvedValue(false);

        await service.deprovisionWhalesyncUser('ws_1');

        expect(mockWorkbookService.findIdsOfAllWorkbooksOwnedByOrganization).not.toHaveBeenCalled();
        expect(mockWorkbookService.findAllForUser).not.toHaveBeenCalled();
        expect(mockWorkbookService.executeHardDeleteWorkbook).not.toHaveBeenCalled();
        expect(mockUsersService.deleteShadowUserAndOrganization).toHaveBeenCalledWith('usr_shadow', undefined);
        expect(mockUsersService.unlinkUserFromWhalesyncIdentity).not.toHaveBeenCalled();
      });
    });

    // DEV-12578: a native account adopted by email, or a shadow row that later signed in natively, has a real
    // clerkId. Deprovisioning it must keep the account and remove only what belongs to the Whalesync identity.
    describe('for a real Scratch user linked to Whalesync', () => {
      const realScratchUser = {
        id: 'usr_real',
        clerkId: 'user_real_clerk_identity',
        organizationId: 'org_real',
      } as unknown as UserCluster.User;

      // Every workbook the real user's org owns. Only the Live Export belongs to the Whalesync account.
      const liveExportWorkbookIdsCreatedByRealUser = ['wkb_live_export' as WorkbookId];

      beforeEach(() => {
        mockUsersService.findByWhalesyncUserId.mockResolvedValue(realScratchUser);
        mockUsersService.isSoleMemberOfOrganization.mockResolvedValue(true);
        mockWorkbookService.findIdsOfAllWorkbooksOwnedByOrganization.mockResolvedValue([
          'wkb_native_first' as WorkbookId,
          'wkb_native_second' as WorkbookId,
          ...liveExportWorkbookIdsCreatedByRealUser,
        ]);
        mockWorkbookService.findIdsOfLiveExportWorkbooksCreatedByUser.mockResolvedValue(
          liveExportWorkbookIdsCreatedByRealUser,
        );
        mockStripePaymentService.clearWhalesyncPlanSubscription.mockResolvedValue({ cleared: true });
        mockUsersService.unlinkUserFromWhalesyncIdentity.mockResolvedValue({ revokedWhalesyncSessionTokenCount: 2 });
      });

      it('keeps the user, the org, and the native workbooks', async () => {
        await service.deprovisionWhalesyncUser('ws_real');

        expect(mockUsersService.deleteShadowUserAndOrganization).not.toHaveBeenCalled();
        expect(mockWorkbookService.findIdsOfAllWorkbooksOwnedByOrganization).not.toHaveBeenCalled();
        expect(idsOfDeletedWorkbooks()).not.toContain('wkb_native_first');
        expect(idsOfDeletedWorkbooks()).not.toContain('wkb_native_second');
      });

      it('deletes only the Live Export workbooks the user created, acting as the user', async () => {
        await service.deprovisionWhalesyncUser('ws_real');

        expect(mockWorkbookService.findIdsOfLiveExportWorkbooksCreatedByUser).toHaveBeenCalledWith('usr_real');
        expect(idsOfDeletedWorkbooks()).toEqual(['wkb_live_export']);
        expect(mockWorkbookService.executeHardDeleteWorkbook.mock.calls[0][1]?.actor?.userId).toBe('usr_real');
      });

      it('clears the Whalesync plan without refusing on a real subscription', async () => {
        await service.deprovisionWhalesyncUser('ws_real');

        expect(mockStripePaymentService.clearWhalesyncPlanSubscription).toHaveBeenCalledWith(realScratchUser, {
          throwOnRealSubscriptionConflict: false,
        });
      });

      it('revokes the session tokens and clears whalesyncUserId last', async () => {
        await service.deprovisionWhalesyncUser('ws_real');

        expect(mockUsersService.unlinkUserFromWhalesyncIdentity).toHaveBeenCalledWith('usr_real', {});
        const unlinkCallOrder = mockUsersService.unlinkUserFromWhalesyncIdentity.mock.invocationCallOrder[0];
        expect(unlinkCallOrder).toBeGreaterThan(
          mockWorkbookService.executeHardDeleteWorkbook.mock.invocationCallOrder[0],
        );
        expect(unlinkCallOrder).toBeGreaterThan(
          mockStripePaymentService.clearWhalesyncPlanSubscription.mock.invocationCallOrder[0],
        );
      });

      describe('for the migration off real accounts (DEV-13019)', () => {
        it('refuses, deleting nothing, while the account still created a Live Export', async () => {
          await expect(service.unlinkRealScratchUserFromWhalesyncIdentity(realScratchUser, {}, {})).rejects.toThrow(
            ConflictException,
          );

          expect(mockWorkbookService.executeHardDeleteWorkbook).not.toHaveBeenCalled();
          expect(mockStripePaymentService.clearWhalesyncPlanSubscription).not.toHaveBeenCalled();
          expect(mockUsersService.unlinkUserFromWhalesyncIdentity).not.toHaveBeenCalled();
        });

        it('hands the Whalesync ids to the shadow user in the unlink, which refuses inside its transaction too', async () => {
          mockWorkbookService.findIdsOfLiveExportWorkbooksCreatedByUser.mockResolvedValue([]);
          const teamShadowUser = { ...realScratchUser, id: 'usr_team_shadow' };

          await service.unlinkRealScratchUserFromWhalesyncIdentity(
            realScratchUser,
            {},
            {
              handOverWhalesyncIdentityTo: teamShadowUser,
            },
          );

          expect(mockWorkbookService.executeHardDeleteWorkbook).not.toHaveBeenCalled();
          expect(mockUsersService.unlinkUserFromWhalesyncIdentity).toHaveBeenCalledWith('usr_real', {
            refuseWhileUserOwnsLiveExports: true,
            handOverWhalesyncIdentityToUserId: 'usr_team_shadow',
          });
        });
      });

      it('unlinks rather than deletes a user with no clerkId', async () => {
        mockUsersService.findByWhalesyncUserId.mockResolvedValue({
          ...realScratchUser,
          clerkId: null,
        } as unknown as UserCluster.User);

        await service.deprovisionWhalesyncUser('ws_real');

        expect(mockUsersService.deleteShadowUserAndOrganization).not.toHaveBeenCalled();
        expect(mockUsersService.unlinkUserFromWhalesyncIdentity).toHaveBeenCalledWith('usr_real', {});
      });

      it('stays linked when an earlier step fails, so a retry can finish the job', async () => {
        mockStripePaymentService.clearWhalesyncPlanSubscription.mockRejectedValue(new Error('db unavailable'));

        await expect(service.deprovisionWhalesyncUser('ws_real')).rejects.toThrow('db unavailable');

        expect(mockUsersService.unlinkUserFromWhalesyncIdentity).not.toHaveBeenCalled();
        expect(mockUsersService.deleteShadowUserAndOrganization).not.toHaveBeenCalled();
      });

      it('is idempotent: deprovisioning twice unlinks once and then does nothing', async () => {
        // Once unlinked, the user is no longer found by whalesyncUserId.
        mockUsersService.findByWhalesyncUserId.mockResolvedValueOnce(realScratchUser).mockResolvedValueOnce(null);

        await service.deprovisionWhalesyncUser('ws_real');
        await service.deprovisionWhalesyncUser('ws_real');

        expect(mockUsersService.unlinkUserFromWhalesyncIdentity).toHaveBeenCalledTimes(1);
        expect(mockStripePaymentService.clearWhalesyncPlanSubscription).toHaveBeenCalledTimes(1);
        expect(idsOfDeletedWorkbooks()).toEqual(['wkb_live_export']);
        expect(mockUsersService.deleteShadowUserAndOrganization).not.toHaveBeenCalled();
      });
    });
  });
});
