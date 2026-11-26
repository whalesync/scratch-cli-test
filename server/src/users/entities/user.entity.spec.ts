import { Subscription } from '@prisma/client';
import { ScratchPlanType, SubscriptionId } from '@spinner/shared-types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { UserCluster } from 'src/db/cluster-types';
import { User } from './user.entity';

/**
 * Covers `toSubscriptionInfo`'s price/interval mapping — what the billing UI renders as "$X per Y".
 * It is module-private, so these go through the `User` entity that calls it.
 */
describe('User.subscription', () => {
  beforeEach(() => {
    // Pin the plan tables so the Pro list prices under test are the production ones.
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
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
      userId: 'usr_test',
      organizationId: 'org_test',
      planType: ScratchPlanType.PRO_PLAN,
      stripeSubscriptionId: 'stripe_sub_test',
      expiration: oneMonthFromNow,
      priceInDollars: 20,
      stripePriceId: 'price_1SYWQ2BuGFTHqsGmiLNoiPCv',
      billingInterval: 'month',
      stripeStatus: 'active',
      cancelAt: null,
      lastInvoicePaid: true,
      trialEndingReminderSentAt: null,
      trialExpiredReminderSentAt: null,
      metadata: null,
      ...overrides,
    };
  }

  function buildUserWithSubscription(subscription: Subscription): User {
    const userCluster = {
      id: 'usr_test',
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-01'),
      clerkId: 'clerk_test',
      whalesyncUserId: null,
      whalesyncTeamId: null,
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
      organization: { id: 'org_test', subscriptions: [subscription] },
    } as unknown as UserCluster.User;

    return new User(userCluster);
  }

  it('reports the amount actually charged for a monthly subscription', () => {
    const user = buildUserWithSubscription(buildSubscription());
    expect(user.subscription?.costUSD).toBe(20);
    expect(user.subscription?.billingInterval).toBe('month');
  });

  it('reports the annual amount and interval for a yearly subscription', () => {
    const user = buildUserWithSubscription(
      buildSubscription({
        priceInDollars: 192,
        billingInterval: 'year',
        stripePriceId: 'price_1U82nOBuGFTHqsGmNkIi8R7e',
      }),
    );
    expect(user.subscription?.costUSD).toBe(192);
    expect(user.subscription?.billingInterval).toBe('year');
  });

  it('reports a bespoke price rather than the plan list price', () => {
    // The archived $5 Pro price Viktor is on — the UI must show what he pays, not $20.
    const user = buildUserWithSubscription(
      buildSubscription({ priceInDollars: 5, stripePriceId: 'price_1T2cQxBuGFTHqsGmBOQjhThc' }),
    );
    expect(user.subscription?.costUSD).toBe(5);
  });

  it('falls back to the plan list price when no price was ever recorded', () => {
    // priceInDollars is NOT NULL DEFAULT 0, so 0 means "we could not read a price off Stripe"
    // (non-USD or tiered/metered). Showing a paying Pro subscriber "$0" would be wrong.
    const user = buildUserWithSubscription(buildSubscription({ priceInDollars: 0 }));
    expect(user.subscription?.costUSD).toBe(20);
  });

  it('falls back to the annual list price for a yearly subscription with no recorded price', () => {
    const user = buildUserWithSubscription(buildSubscription({ priceInDollars: 0, billingInterval: 'year' }));
    expect(user.subscription?.costUSD).toBe(192);
  });

  it('keeps the never-billed Whalesync plan at zero', () => {
    // Whalesync has no list price to fall back to, so the 0 stands — which is correct, it is free.
    const user = buildUserWithSubscription(
      buildSubscription({ planType: ScratchPlanType.WHALESYNC_PLAN, priceInDollars: 0, stripePriceId: null }),
    );
    expect(user.subscription?.costUSD).toBe(0);
    expect(user.subscription?.planType).toBe(ScratchPlanType.WHALESYNC_PLAN);
  });

  it('treats a row written before we recorded the interval as monthly', () => {
    const user = buildUserWithSubscription(buildSubscription({ billingInterval: 'not-an-interval' }));
    expect(user.subscription?.billingInterval).toBe('month');
  });
});
