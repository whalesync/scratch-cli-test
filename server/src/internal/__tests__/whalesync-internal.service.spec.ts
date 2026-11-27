import { ConflictException } from '@nestjs/common';
import { ScratchPlanType, WhalesyncLiveExportAccess, WorkbookId, WorkbookManager } from '@spinner/shared-types';
import { UserCluster, WorkbookCluster } from 'src/db/cluster-types';
import { StripePaymentService } from 'src/payment/stripe-payment.service';
import { UsersService } from 'src/users/users.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { WhalesyncInternalService } from '../whalesync-internal.service';

const TEAM_ID = 'tm_acme';

describe('WhalesyncInternalService', () => {
  let service: WhalesyncInternalService;
  let mockUsersService: jest.Mocked<
    Pick<
      UsersService,
      | 'getOrCreateShadowUserForWhalesyncTeam'
      | 'findShadowUserForWhalesyncTeam'
      | 'mintWhalesyncSessionToken'
      | 'isSoleMemberOfOrganization'
      | 'deleteShadowUserAndOrganization'
    >
  >;
  let mockStripePaymentService: jest.Mocked<Pick<StripePaymentService, 'applyWhalesyncLiveExportAccess'>>;
  let mockWorkbookService: jest.Mocked<
    Pick<WorkbookService, 'findAllForUser' | 'findIdsOfAllWorkbooksOwnedByOrganization' | 'executeHardDeleteWorkbook'>
  >;

  const pureTeamShadowUser = {
    id: 'usr_shadow',
    clerkId: `ws_${TEAM_ID}`,
    whalesyncTeamId: TEAM_ID,
    organizationId: 'org_shadow',
  } as unknown as UserCluster.User;

  beforeEach(() => {
    mockUsersService = {
      getOrCreateShadowUserForWhalesyncTeam: jest.fn(),
      findShadowUserForWhalesyncTeam: jest.fn(),
      mintWhalesyncSessionToken: jest.fn(),
      isSoleMemberOfOrganization: jest.fn(),
      deleteShadowUserAndOrganization: jest.fn(),
    };
    mockStripePaymentService = {
      applyWhalesyncLiveExportAccess: jest.fn(),
    };
    mockWorkbookService = {
      findAllForUser: jest.fn(),
      findIdsOfAllWorkbooksOwnedByOrganization: jest.fn(),
      executeHardDeleteWorkbook: jest.fn(),
    };
    service = new WhalesyncInternalService(
      mockUsersService as unknown as UsersService,
      mockWorkbookService as unknown as WorkbookService,
      mockStripePaymentService as unknown as StripePaymentService,
    );
  });

  const pausedDailyLiveExportAccess: WhalesyncLiveExportAccess = {
    paused: true,
    recordLimit: 1_000_000,
    fastestCadence: 'daily',
  };

  describe('ensureSessionForWhalesyncTeam', () => {
    it("applies the session's Live Export access and mints a session token for the team's shadow user", async () => {
      const expiresAt = new Date('2026-11-27T00:10:00.000Z');
      mockUsersService.getOrCreateShadowUserForWhalesyncTeam.mockResolvedValue(pureTeamShadowUser);
      mockUsersService.mintWhalesyncSessionToken.mockResolvedValue({ token: 'session-token', expiresAt });

      const result = await service.ensureSessionForWhalesyncTeam(TEAM_ID, 'Acme', pausedDailyLiveExportAccess);

      expect(mockUsersService.getOrCreateShadowUserForWhalesyncTeam).toHaveBeenCalledWith(
        TEAM_ID,
        'Acme',
        pausedDailyLiveExportAccess,
      );
      expect(mockUsersService.mintWhalesyncSessionToken).toHaveBeenCalledWith('usr_shadow');
      expect(result).toEqual({ scratchUserId: 'usr_shadow', apiToken: 'session-token', expiresAt });
    });

    it('maps the old subscription payload onto an access when the session carries no access', async () => {
      mockUsersService.getOrCreateShadowUserForWhalesyncTeam.mockResolvedValue(pureTeamShadowUser);
      mockUsersService.mintWhalesyncSessionToken.mockResolvedValue({ token: 'session-token', expiresAt: new Date() });

      await service.ensureSessionForWhalesyncTeam(TEAM_ID, 'Acme', undefined, {
        status: 'expired',
        liveExportRecordCountLimit: 10_000,
        liveExportCadence: 'frequent',
        expiresAt: '2026-09-02T00:00:00.000Z',
      });

      expect(mockUsersService.getOrCreateShadowUserForWhalesyncTeam).toHaveBeenCalledWith(TEAM_ID, 'Acme', {
        paused: true,
        recordLimit: 10_000,
        fastestCadence: 'frequent',
      });
    });

    it('prefers the access to the old payload when the session carries both', async () => {
      mockUsersService.getOrCreateShadowUserForWhalesyncTeam.mockResolvedValue(pureTeamShadowUser);
      mockUsersService.mintWhalesyncSessionToken.mockResolvedValue({ token: 'session-token', expiresAt: new Date() });

      await service.ensureSessionForWhalesyncTeam(TEAM_ID, 'Acme', pausedDailyLiveExportAccess, { status: 'active' });

      expect(mockUsersService.getOrCreateShadowUserForWhalesyncTeam).toHaveBeenCalledWith(
        TEAM_ID,
        'Acme',
        pausedDailyLiveExportAccess,
      );
    });

    it('passes no access when the session carries neither', async () => {
      mockUsersService.getOrCreateShadowUserForWhalesyncTeam.mockResolvedValue(pureTeamShadowUser);
      mockUsersService.mintWhalesyncSessionToken.mockResolvedValue({ token: 'session-token', expiresAt: new Date() });

      await service.ensureSessionForWhalesyncTeam(TEAM_ID, 'Acme');

      expect(mockUsersService.getOrCreateShadowUserForWhalesyncTeam).toHaveBeenCalledWith(TEAM_ID, 'Acme', undefined);
    });

    it('mints nothing when the shadow user is refused', async () => {
      mockUsersService.getOrCreateShadowUserForWhalesyncTeam.mockRejectedValue(new ConflictException('real account'));

      await expect(service.ensureSessionForWhalesyncTeam(TEAM_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(mockUsersService.mintWhalesyncSessionToken).not.toHaveBeenCalled();
    });
  });

  describe('setLiveExportAccessForWhalesyncTeam', () => {
    it('is an idempotent no-op that creates nothing when the team has no shadow user', async () => {
      mockUsersService.findShadowUserForWhalesyncTeam.mockResolvedValue(null);

      const result = await service.setLiveExportAccessForWhalesyncTeam(TEAM_ID, pausedDailyLiveExportAccess);

      expect(mockUsersService.findShadowUserForWhalesyncTeam).toHaveBeenCalledWith(TEAM_ID, 'live-export-access');
      expect(result).toEqual({ scratchUserId: null, updated: false });
      expect(mockStripePaymentService.applyWhalesyncLiveExportAccess).not.toHaveBeenCalled();
    });

    it("applies the access to the team's shadow user and reports whether anything changed", async () => {
      mockUsersService.findShadowUserForWhalesyncTeam.mockResolvedValue(pureTeamShadowUser);
      mockStripePaymentService.applyWhalesyncLiveExportAccess.mockResolvedValue({ updated: true });

      const result = await service.setLiveExportAccessForWhalesyncTeam(TEAM_ID, pausedDailyLiveExportAccess);

      expect(mockStripePaymentService.applyWhalesyncLiveExportAccess).toHaveBeenCalledWith(
        pureTeamShadowUser,
        pausedDailyLiveExportAccess,
      );
      expect(result).toEqual({ scratchUserId: 'usr_shadow', updated: true });
    });

    it('lets the refusal of a user that is not a pure shadow user through', async () => {
      mockUsersService.findShadowUserForWhalesyncTeam.mockRejectedValue(new ConflictException('real account'));

      await expect(
        service.setLiveExportAccessForWhalesyncTeam(TEAM_ID, pausedDailyLiveExportAccess),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockStripePaymentService.applyWhalesyncLiveExportAccess).not.toHaveBeenCalled();
    });
  });

  describe('updateWhalesyncSubscription', () => {
    it('is an idempotent no-op when the team has no shadow user', async () => {
      mockUsersService.findShadowUserForWhalesyncTeam.mockResolvedValue(null);

      const result = await service.updateWhalesyncSubscription(TEAM_ID, { status: 'expired' });

      expect(mockUsersService.findShadowUserForWhalesyncTeam).toHaveBeenCalledWith(TEAM_ID, 'subscription');
      expect(result).toEqual({ scratchUserId: null, updated: false, planType: null });
      expect(mockStripePaymentService.applyWhalesyncLiveExportAccess).not.toHaveBeenCalled();
    });

    it.each([
      ['active', false],
      ['cancelled', true],
      ['expired', true],
      ['none', true],
    ] as const)("maps status '%s' onto an access that is paused: %s", async (status, paused) => {
      mockUsersService.findShadowUserForWhalesyncTeam.mockResolvedValue(pureTeamShadowUser);
      mockStripePaymentService.applyWhalesyncLiveExportAccess.mockResolvedValue({ updated: true });

      const result = await service.updateWhalesyncSubscription(TEAM_ID, {
        status,
        whalesyncProductType: 'Hs4Kp9',
        liveExportRecordCountLimit: 10_000,
        liveExportCadence: 'daily',
        expiresAt: '2026-12-25T00:00:00.000Z',
      });

      expect(mockStripePaymentService.applyWhalesyncLiveExportAccess).toHaveBeenCalledWith(pureTeamShadowUser, {
        paused,
        recordLimit: 10_000,
        fastestCadence: 'daily',
      });
      expect(result).toEqual({ scratchUserId: 'usr_shadow', updated: true, planType: ScratchPlanType.WHALESYNC_PLAN });
    });

    it('maps a payload with no limits onto an access with none', async () => {
      mockUsersService.findShadowUserForWhalesyncTeam.mockResolvedValue(pureTeamShadowUser);
      mockStripePaymentService.applyWhalesyncLiveExportAccess.mockResolvedValue({ updated: false });

      await service.updateWhalesyncSubscription(TEAM_ID, { status: 'active' });

      expect(mockStripePaymentService.applyWhalesyncLiveExportAccess).toHaveBeenCalledWith(pureTeamShadowUser, {
        paused: false,
        recordLimit: null,
        fastestCadence: null,
      });
    });
  });

  describe('listLiveExportsForWhalesyncTeam', () => {
    const workbook = (id: string, name: string | null, isPendingDelete = false): WorkbookCluster.Workbook =>
      ({
        id,
        name,
        isPendingDelete,
        createdAt: new Date('2026-10-01T12:00:00.000Z'),
        updatedAt: new Date('2026-10-02T12:00:00.000Z'),
      }) as unknown as WorkbookCluster.Workbook;

    it('returns an empty list without looking up workbooks when the team has no shadow user', async () => {
      mockUsersService.findShadowUserForWhalesyncTeam.mockResolvedValue(null);

      const result = await service.listLiveExportsForWhalesyncTeam(TEAM_ID);

      expect(mockUsersService.findShadowUserForWhalesyncTeam).toHaveBeenCalledWith(TEAM_ID, 'list');
      expect(result).toEqual({ liveExports: [] });
      expect(mockWorkbookService.findAllForUser).not.toHaveBeenCalled();
    });

    it('lists the Live Export workbooks newest first and skips those pending deletion', async () => {
      mockUsersService.findShadowUserForWhalesyncTeam.mockResolvedValue(pureTeamShadowUser);
      mockWorkbookService.findAllForUser.mockResolvedValue([
        workbook('wkb_named', 'Deals export'),
        workbook('wkb_deleting', 'Old export', true),
        workbook('wkb_unnamed', null),
      ]);

      const result = await service.listLiveExportsForWhalesyncTeam(TEAM_ID);

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

  describe('deprovisionWhalesyncTeam', () => {
    function idsOfDeletedWorkbooks(): string[] {
      return mockWorkbookService.executeHardDeleteWorkbook.mock.calls.map(([workbookId]) => workbookId);
    }

    // Every workbook the shadow user can reach. The last one belongs to another org and was only shared with the
    // shadow user through a WorkspacePermission (the DEV-12427 "Whalesync Internal" case).
    const workbooksReachableByShadowUser = [
      { id: 'wkb_own_first', organizationId: 'org_shadow' },
      { id: 'wkb_own_second', organizationId: 'org_shadow' },
      { id: 'wkb_shared_from_other_org', organizationId: 'org_other' },
    ];

    beforeEach(() => {
      mockWorkbookService.findIdsOfAllWorkbooksOwnedByOrganization.mockImplementation((organizationId) =>
        Promise.resolve(
          workbooksReachableByShadowUser
            .filter((reachableWorkbook) => reachableWorkbook.organizationId === organizationId)
            .map((reachableWorkbook) => reachableWorkbook.id as WorkbookId),
        ),
      );
    });

    it('is an idempotent no-op when the team has no shadow user', async () => {
      mockUsersService.findShadowUserForWhalesyncTeam.mockResolvedValue(null);

      await service.deprovisionWhalesyncTeam(TEAM_ID);

      expect(mockUsersService.findShadowUserForWhalesyncTeam).toHaveBeenCalledWith(TEAM_ID, 'delete');
      expect(mockWorkbookService.executeHardDeleteWorkbook).not.toHaveBeenCalled();
      expect(mockUsersService.deleteShadowUserAndOrganization).not.toHaveBeenCalled();
    });

    it('deletes the shadow user, the org, and the org-owned workbooks, but not one another org shared', async () => {
      mockUsersService.findShadowUserForWhalesyncTeam.mockResolvedValue(pureTeamShadowUser);
      mockUsersService.isSoleMemberOfOrganization.mockResolvedValue(true);

      await service.deprovisionWhalesyncTeam(TEAM_ID);

      expect(mockWorkbookService.findIdsOfAllWorkbooksOwnedByOrganization).toHaveBeenCalledWith('org_shadow');
      expect(mockWorkbookService.findAllForUser).not.toHaveBeenCalled();
      expect(idsOfDeletedWorkbooks()).toEqual(['wkb_own_first', 'wkb_own_second']);
      for (const [, hardDeleteOptions] of mockWorkbookService.executeHardDeleteWorkbook.mock.calls) {
        expect(hardDeleteOptions?.actor?.userId).toBe('usr_shadow');
      }
      expect(mockUsersService.deleteShadowUserAndOrganization).toHaveBeenCalledWith('usr_shadow', 'org_shadow');
    });

    it('deletes only the user, not the org or its workbooks, when the org has another member', async () => {
      mockUsersService.findShadowUserForWhalesyncTeam.mockResolvedValue(pureTeamShadowUser);
      mockUsersService.isSoleMemberOfOrganization.mockResolvedValue(false);

      await service.deprovisionWhalesyncTeam(TEAM_ID);

      expect(mockWorkbookService.findIdsOfAllWorkbooksOwnedByOrganization).not.toHaveBeenCalled();
      expect(mockWorkbookService.executeHardDeleteWorkbook).not.toHaveBeenCalled();
      expect(mockUsersService.deleteShadowUserAndOrganization).toHaveBeenCalledWith('usr_shadow', undefined);
    });

    it('propagates the 409 when the team lookup refuses a real Scratch account, deleting nothing', async () => {
      mockUsersService.findShadowUserForWhalesyncTeam.mockRejectedValue(new ConflictException('real account'));

      await expect(service.deprovisionWhalesyncTeam(TEAM_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(mockWorkbookService.executeHardDeleteWorkbook).not.toHaveBeenCalled();
      expect(mockUsersService.deleteShadowUserAndOrganization).not.toHaveBeenCalled();
    });
  });

  describe('deleteShadowUserWithItsOrganizationAndOwnedWorkbooks', () => {
    it.each([
      ['a real Clerk login', 'user_real_clerk_identity'],
      ['no clerkId at all', null],
    ])('refuses with a 409, deleting nothing, a user with %s', async (_description, clerkId) => {
      const userThatIsNotAPureShadowUser = {
        ...pureTeamShadowUser,
        clerkId,
      } as unknown as UserCluster.User;

      await expect(
        service.deleteShadowUserWithItsOrganizationAndOwnedWorkbooks(userThatIsNotAPureShadowUser, {
          deprovisionReason: 'test',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockUsersService.isSoleMemberOfOrganization).not.toHaveBeenCalled();
      expect(mockWorkbookService.executeHardDeleteWorkbook).not.toHaveBeenCalled();
      expect(mockUsersService.deleteShadowUserAndOrganization).not.toHaveBeenCalled();
    });
  });
});
