/* eslint-disable @typescript-eslint/unbound-method */
import { Subscription } from '@prisma/client';
import { SubscriptionId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { SubscriptionService } from './subscription.service';

describe('SubscriptionService', () => {
  let service: SubscriptionService;
  let dbService: jest.Mocked<DbService>;

  beforeEach(() => {
    // Create mock DB service
    dbService = {
      client: {
        subscription: {
          findMany: jest.fn(),
          deleteMany: jest.fn(),
        },
      },
    } as unknown as jest.Mocked<DbService>;

    service = new SubscriptionService(dbService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findForUser', () => {
    it('should find subscriptions for a user', async () => {
      const userId = 'user_123';
      const mockSubscriptions: Subscription[] = [
        {
          id: 'sub_1' as SubscriptionId,
          version: 1,
          userId,
          organizationId: 'org_1',
          planType: 'FREE_PLAN',
          stripeSubscriptionId: 'stripe_sub_1',
          expiration: new Date('2025-12-31'),
          priceInDollars: 0,
          stripeStatus: 'active',
          cancelAt: null,
          lastInvoicePaid: null,
          createdAt: new Date('2025-01-01'),
          updatedAt: new Date('2025-01-01'),
        },
        {
          id: 'sub_2' as SubscriptionId,
          version: 1,
          userId,
          organizationId: 'org_1',
          planType: 'FREE_PLAN',
          stripeSubscriptionId: 'stripe_sub_2',
          expiration: new Date('2025-12-31'),
          priceInDollars: 0,
          stripeStatus: 'active',
          cancelAt: null,
          lastInvoicePaid: null,
          createdAt: new Date('2025-01-01'),
          updatedAt: new Date('2025-01-01'),
        },
      ];

      (dbService.client.subscription.findMany as jest.Mock).mockResolvedValue(mockSubscriptions);

      const result = await service.findForUser(userId);

      expect(result).toEqual(mockSubscriptions);
      expect(dbService.client.subscription.findMany).toHaveBeenCalledWith({ where: { userId } });
      expect(dbService.client.subscription.findMany).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when user has no subscriptions', async () => {
      const userId = 'user_no_subs';

      (dbService.client.subscription.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.findForUser(userId);

      expect(result).toEqual([]);
      expect(dbService.client.subscription.findMany).toHaveBeenCalledWith({ where: { userId } });
    });

    it('should handle user IDs with special characters', async () => {
      const userId = 'user_with-special_chars.123';

      (dbService.client.subscription.findMany as jest.Mock).mockResolvedValue([]);

      await service.findForUser(userId);

      expect(dbService.client.subscription.findMany).toHaveBeenCalledWith({
        where: { userId: 'user_with-special_chars.123' },
      });
    });

    it('should handle database errors', async () => {
      const userId = 'user_123';
      const dbError = new Error('Database connection failed');

      (dbService.client.subscription.findMany as jest.Mock).mockRejectedValue(dbError);

      await expect(service.findForUser(userId)).rejects.toThrow('Database connection failed');
    });

    it('should return all subscriptions regardless of status', async () => {
      const userId = 'user_123';
      const mockSubscriptions: Subscription[] = [
        {
          id: 'sub_active' as SubscriptionId,
          version: 1,
          userId,
          organizationId: 'org_1',
          planType: 'FREE_PLAN',
          stripeSubscriptionId: 'stripe_sub_1',
          expiration: new Date('2025-12-31'),
          priceInDollars: 0,
          stripeStatus: 'active',
          cancelAt: null,
          lastInvoicePaid: null,
          createdAt: new Date('2025-01-01'),
          updatedAt: new Date('2025-01-01'),
        },
        {
          id: 'sub_canceled' as SubscriptionId,
          version: 1,
          userId,
          organizationId: 'org_1',
          planType: 'FREE_PLAN',
          stripeSubscriptionId: 'stripe_sub_2',
          expiration: new Date('2025-06-30'),
          priceInDollars: 0,
          stripeStatus: 'canceled',
          cancelAt: new Date('2025-06-30'),
          lastInvoicePaid: false,
          createdAt: new Date('2025-01-01'),
          updatedAt: new Date('2025-01-01'),
        },
      ];

      (dbService.client.subscription.findMany as jest.Mock).mockResolvedValue(mockSubscriptions);

      const result = await service.findForUser(userId);

      expect(result).toHaveLength(2);
      expect(result[0].stripeStatus).toBe('active');
      expect(result[1].stripeStatus).toBe('canceled');
    });
  });

  describe('delete', () => {
    it('should delete a subscription and return count', async () => {
      const subscriptionId = 'sub_123' as SubscriptionId;

      (dbService.client.subscription.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

      const result = await service.delete(subscriptionId);

      expect(result).toBe(1);
      expect(dbService.client.subscription.deleteMany).toHaveBeenCalledWith({ where: { id: subscriptionId } });
      expect(dbService.client.subscription.deleteMany).toHaveBeenCalledTimes(1);
    });

    it('should return 0 when subscription does not exist', async () => {
      const subscriptionId = 'sub_nonexistent' as SubscriptionId;

      (dbService.client.subscription.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });

      const result = await service.delete(subscriptionId);

      expect(result).toBe(0);
      expect(dbService.client.subscription.deleteMany).toHaveBeenCalledWith({ where: { id: subscriptionId } });
    });

    it('should handle subscription IDs with special characters', async () => {
      const subscriptionId = 'sub_special-chars_123.456' as SubscriptionId;

      (dbService.client.subscription.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.delete(subscriptionId);

      expect(dbService.client.subscription.deleteMany).toHaveBeenCalledWith({
        where: { id: 'sub_special-chars_123.456' },
      });
    });

    it('should handle database errors during deletion', async () => {
      const subscriptionId = 'sub_123' as SubscriptionId;
      const dbError = new Error('Database constraint violation');

      (dbService.client.subscription.deleteMany as jest.Mock).mockRejectedValue(dbError);

      await expect(service.delete(subscriptionId)).rejects.toThrow('Database constraint violation');
    });

    it('should use deleteMany instead of delete', async () => {
      const subscriptionId = 'sub_123' as SubscriptionId;

      (dbService.client.subscription.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.delete(subscriptionId);

      // Verify deleteMany is called, not delete
      expect(dbService.client.subscription.deleteMany).toHaveBeenCalled();
    });

    it('should return the exact count from database operation', async () => {
      const subscriptionId = 'sub_123' as SubscriptionId;

      // Test different count values
      (dbService.client.subscription.deleteMany as jest.Mock).mockResolvedValue({ count: 5 });

      const result = await service.delete(subscriptionId);

      expect(result).toBe(5);
    });
  });
});
