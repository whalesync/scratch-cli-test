import { ConflictException } from '@nestjs/common';
import { UserCluster } from 'src/db/cluster-types';
import { StripePaymentService } from 'src/payment/stripe-payment.service';
import { UsersService } from 'src/users/users.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { WhalesyncInternalService } from '../whalesync-internal.service';

describe('WhalesyncInternalService', () => {
  let service: WhalesyncInternalService;
  let mockUsersService: jest.Mocked<Pick<UsersService, 'findByWhalesyncUserId'>>;
  let mockStripePaymentService: jest.Mocked<Pick<StripePaymentService, 'clearWhalesyncPlanSubscription'>>;

  beforeEach(() => {
    mockUsersService = { findByWhalesyncUserId: jest.fn() };
    mockStripePaymentService = { clearWhalesyncPlanSubscription: jest.fn() };
    service = new WhalesyncInternalService(
      mockUsersService as unknown as UsersService,
      {} as unknown as WorkbookService,
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
});
