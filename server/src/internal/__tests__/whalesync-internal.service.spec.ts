import { ConflictException } from '@nestjs/common';
import { WorkbookManager } from '@spinner/shared-types';
import { UserCluster, WorkbookCluster } from 'src/db/cluster-types';
import { StripePaymentService } from 'src/payment/stripe-payment.service';
import { UsersService } from 'src/users/users.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { WhalesyncInternalService } from '../whalesync-internal.service';

describe('WhalesyncInternalService', () => {
  let service: WhalesyncInternalService;
  let mockUsersService: jest.Mocked<Pick<UsersService, 'findByWhalesyncUserId'>>;
  let mockStripePaymentService: jest.Mocked<
    Pick<StripePaymentService, 'clearWhalesyncPlanSubscription' | 'applyWhalesyncSubscriptionState'>
  >;
  let mockWorkbookService: jest.Mocked<Pick<WorkbookService, 'findAllForUser'>>;

  beforeEach(() => {
    mockUsersService = { findByWhalesyncUserId: jest.fn() };
    mockStripePaymentService = {
      clearWhalesyncPlanSubscription: jest.fn(),
      applyWhalesyncSubscriptionState: jest.fn(),
    };
    mockWorkbookService = { findAllForUser: jest.fn() };
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

      const result = await service.updateWhalesyncSubscription('ws_missing', { status: 'expired' });

      expect(result).toEqual({ scratchUserId: null, updated: false, planType: null });
      expect(mockStripePaymentService.applyWhalesyncSubscriptionState).not.toHaveBeenCalled();
    });

    it('delegates to the payment service with the 409-on-real-sub flag and returns the result', async () => {
      const shadowUser = { id: 'usr_shadow' } as unknown as UserCluster.User;
      mockUsersService.findByWhalesyncUserId.mockResolvedValue(shadowUser);
      mockStripePaymentService.applyWhalesyncSubscriptionState.mockResolvedValue({ planType: null, updated: true });

      const result = await service.updateWhalesyncSubscription('ws_1', { status: 'cancelled' });

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

      await expect(service.updateWhalesyncSubscription('ws_paid', { status: 'active' })).rejects.toBeInstanceOf(
        ConflictException,
      );
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
});
