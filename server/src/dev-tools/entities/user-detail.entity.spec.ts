import { Subscription } from '@prisma/client';
import { ScratchPlanType, SubscriptionId } from '@spinner/shared-types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { UserCluster } from 'src/db/cluster-types';
import { UserDetail } from './user-detail.entity';

/**
 * Covers the dev-tools-only `subscriptionDetails` the User Details panel renders. This data is
 * deliberately NOT on the shared `SubscriptionInfo`, so it must only ever be produced here.
 */
describe('UserDetail.subscriptionDetails', () => {
  beforeEach(() => {
    // `new User(...)` builds the shared SubscriptionInfo, which reads the plan tables keyed on the
    // environment; pin it so the test doesn't depend on APP_ENV being set (it isn't in CI).
    jest.spyOn(ScratchConfigService, 'getScratchEnvironment').mockReturnValue('production');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function buildSubscription(overrides: Partial<Subscription> = {}): Subscription {
    const oneMonthFromNow = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    return {
      id: 'sub_test' as SubscriptionId,
      version: 1,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-02-01T00:00:00.000Z'),
      userId: 'usr_test',
      organizationId: 'org_test',
      planType: ScratchPlanType.PRO_PLAN,
      stripeSubscriptionId: 'stripe_sub_test',
      expiration: oneMonthFromNow,
      priceInDollars: 20,
      stripePriceId: 'price_test',
      billingInterval: 'month',
      stripeStatus: 'trialing',
      cancelAt: null,
      lastInvoicePaid: true,
      trialEndingReminderSentAt: null,
      trialExpiredReminderSentAt: null,
      metadata: { whalesyncStatus: 'active' },
      ...overrides,
    };
  }

  function buildUserDetail(subscriptions: Subscription[]): UserDetail {
    const userCluster = {
      id: 'usr_test',
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
      clerkId: 'clerk_test',
      whalesyncUserId: null,
      role: 'USER',
      name: 'Test User',
      email: 'test@example.com',
      stripeCustomerId: 'cus_test',
      lastWorkbookId: null,
      waitlistApproved: true,
      settings: {},
      apiTokens: [],
      workspacePermissions: [],
      organizationId: 'org_test',
      organization: { id: 'org_test', subscriptions },
    } as unknown as UserCluster.User;

    return new UserDetail(userCluster, [], [], [], new Map(), 0);
  }

  it('surfaces the raw subscription row detail (created/updated/status/cancel/metadata)', () => {
    const detail = buildUserDetail([buildSubscription()]);

    expect(detail.subscriptionDetails?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(detail.subscriptionDetails?.updatedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(detail.subscriptionDetails?.stripeStatus).toBe('trialing');
    expect(detail.subscriptionDetails?.cancelAt).toBeNull();
    expect(detail.subscriptionDetails?.metadata).toEqual({ whalesyncStatus: 'active' });
    expect(typeof detail.subscriptionDetails?.expiration).toBe('string');
  });

  it('serializes cancelAt to an ISO string when the subscription is set to cancel', () => {
    const detail = buildUserDetail([buildSubscription({ cancelAt: new Date('2026-03-01T00:00:00.000Z') })]);

    expect(detail.subscriptionDetails?.cancelAt).toBe('2026-03-01T00:00:00.000Z');
  });

  it('is null for a user with no subscription (the synthetic Free plan)', () => {
    const detail = buildUserDetail([]);

    expect(detail.subscriptionDetails).toBeNull();
  });
});
