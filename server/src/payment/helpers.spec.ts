import { Subscription } from '@prisma/client';
import { getActiveSubscriptions, getLastestExpiringSubscription, isActiveSubscriptionOwnedByUser } from './helpers';

// Helper function to create test subscription objects
function createTestSubscription(
  overrides: Partial<Subscription> & { id: string; userId: string; expiration: Date },
): Subscription {
  const now = new Date();
  return {
    id: overrides.id,
    userId: overrides.userId,
    organizationId: overrides.organizationId || 'org_1',
    planType: overrides.planType || 'pro',
    expiration: overrides.expiration,
    stripeSubscriptionId: overrides.stripeSubscriptionId || `stripe_${overrides.id}`,
    priceInDollars: overrides.priceInDollars ?? 10,
    stripeStatus: overrides.stripeStatus ?? 'active',
    lastInvoicePaid: overrides.lastInvoicePaid ?? true,
    createdAt: overrides.createdAt || now,
    updatedAt: overrides.updatedAt || now,
    version: overrides.version ?? 1,
    cancelAt: overrides.cancelAt ?? null,
  };
}

describe('Payment Helpers', () => {
  describe('getActiveSubscriptions', () => {
    it('should return subscriptions that have not expired', () => {
      const now = new Date();
      const futureDate = new Date(now.getTime() + 86400000); // +1 day
      const pastDate = new Date(now.getTime() - 86400000); // -1 day

      const subscriptions: Subscription[] = [
        createTestSubscription({ id: 'sub_1', userId: 'usr_1', expiration: futureDate }),
        createTestSubscription({ id: 'sub_2', userId: 'usr_1', expiration: pastDate }),
      ];

      const result = getActiveSubscriptions(subscriptions);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('sub_1');
    });

    it('should return empty array when all subscriptions are expired', () => {
      const pastDate = new Date(Date.now() - 86400000); // -1 day

      const subscriptions: Subscription[] = [
        createTestSubscription({ id: 'sub_1', userId: 'usr_1', expiration: pastDate }),
      ];

      const result = getActiveSubscriptions(subscriptions);

      expect(result).toHaveLength(0);
    });

    it('should return empty array when no subscriptions provided', () => {
      const result = getActiveSubscriptions([]);

      expect(result).toHaveLength(0);
    });

    it('should include subscriptions with expiration equal to current date', () => {
      // Use end of today to avoid flakiness from milliseconds elapsing between
      // creating the expiration and the >= check inside getActiveSubscriptions.
      const endOfToday = new Date();
      endOfToday.setHours(23, 59, 59, 999);

      const subscriptions: Subscription[] = [
        createTestSubscription({ id: 'sub_1', userId: 'usr_1', expiration: endOfToday }),
      ];

      const result = getActiveSubscriptions(subscriptions);

      expect(result).toHaveLength(1);
    });
  });

  describe('getLastestExpiringSubscription', () => {
    it('should return subscription with the latest expiration date', () => {
      const now = new Date();
      const date1 = new Date(now.getTime() + 86400000); // +1 day
      const date2 = new Date(now.getTime() + 172800000); // +2 days
      const date3 = new Date(now.getTime() + 259200000); // +3 days

      const subscriptions: Subscription[] = [
        createTestSubscription({ id: 'sub_1', userId: 'usr_1', expiration: date1 }),
        createTestSubscription({ id: 'sub_2', userId: 'usr_1', expiration: date3 }), // Latest
        createTestSubscription({ id: 'sub_3', userId: 'usr_1', expiration: date2 }),
      ];

      const result = getLastestExpiringSubscription(subscriptions);

      expect(result).not.toBeNull();
      expect(result?.id).toBe('sub_2');
      expect(result?.expiration).toEqual(date3);
    });

    it('should return null when no subscriptions provided', () => {
      const result = getLastestExpiringSubscription([]);

      expect(result).toBeNull();
    });

    it('should return the only subscription when array has one element', () => {
      const futureDate = new Date(Date.now() + 86400000);

      const subscriptions: Subscription[] = [
        createTestSubscription({ id: 'sub_1', userId: 'usr_1', expiration: futureDate }),
      ];

      const result = getLastestExpiringSubscription(subscriptions);

      expect(result).not.toBeNull();
      expect(result?.id).toBe('sub_1');
    });

    it('should work with expired subscriptions', () => {
      const now = new Date();
      const pastDate1 = new Date(now.getTime() - 86400000); // -1 day
      const pastDate2 = new Date(now.getTime() - 172800000); // -2 days

      const subscriptions: Subscription[] = [
        createTestSubscription({ id: 'sub_1', userId: 'usr_1', expiration: pastDate2 }),
        createTestSubscription({ id: 'sub_2', userId: 'usr_1', expiration: pastDate1 }), // Less expired (latest)
      ];

      const result = getLastestExpiringSubscription(subscriptions);

      expect(result).not.toBeNull();
      expect(result?.id).toBe('sub_2');
    });
  });

  describe('isActiveSubscriptionOwnedByUser', () => {
    it('should return true when latest expiring subscription belongs to user', () => {
      const futureDate = new Date(Date.now() + 86400000);

      const subscriptions: Subscription[] = [
        createTestSubscription({ id: 'sub_1', userId: 'usr_123', expiration: futureDate }),
      ];

      const result = isActiveSubscriptionOwnedByUser(subscriptions, 'usr_123');

      expect(result).toBe(true);
    });

    it('should return false when latest expiring subscription belongs to different user', () => {
      const futureDate = new Date(Date.now() + 86400000);

      const subscriptions: Subscription[] = [
        createTestSubscription({ id: 'sub_1', userId: 'usr_456', expiration: futureDate }),
      ];

      const result = isActiveSubscriptionOwnedByUser(subscriptions, 'usr_123');

      expect(result).toBe(false);
    });

    it('should return false when no subscriptions provided', () => {
      const result = isActiveSubscriptionOwnedByUser([], 'usr_123');

      expect(result).toBe(false);
    });

    it('should check ownership of latest subscription when multiple exist', () => {
      const now = new Date();
      const date1 = new Date(now.getTime() + 86400000); // +1 day
      const date2 = new Date(now.getTime() + 172800000); // +2 days

      const subscriptions: Subscription[] = [
        createTestSubscription({ id: 'sub_1', userId: 'usr_123', expiration: date1 }),
        createTestSubscription({ id: 'sub_2', userId: 'usr_456', expiration: date2 }), // Latest, different user
      ];

      const result = isActiveSubscriptionOwnedByUser(subscriptions, 'usr_123');

      expect(result).toBe(false);
    });

    it('should work correctly even with expired subscriptions', () => {
      const pastDate = new Date(Date.now() - 86400000); // -1 day

      const subscriptions: Subscription[] = [
        createTestSubscription({ id: 'sub_1', userId: 'usr_123', expiration: pastDate }),
      ];

      // Should still check ownership even though subscription is expired
      const result = isActiveSubscriptionOwnedByUser(subscriptions, 'usr_123');

      expect(result).toBe(true);
    });
  });
});
