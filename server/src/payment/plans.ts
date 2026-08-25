import { BillingInterval, ScratchPlanType } from '@spinner/shared-types';
import { ScratchConfigService, ScratchEnvironment } from 'src/config/scratch-config.service';
import { assertIsDefined } from 'src/utils/asserts';

export function getPlanTypeFromString(typeString: string): ScratchPlanType | undefined {
  for (const [k, v] of Object.entries(ScratchPlanType)) {
    if (k === typeString) {
      return v;
    }
  }
  return undefined;
}

export interface PlanFeatures {
  // The maximum number of publishing actions that the user can perform. 0 means unlimited.
  publishingLimit: number;
  // The maximum number of data sources per service that the user can use. 0 means unlimited.
  dataSourcePerServiceLimit: number;
}

/**
 * One price a plan can be bought at. `costUSD` is what ONE billing period costs, so it is only
 * meaningful next to its `billingInterval` — $192 is the annual Pro price, not a monthly one.
 */
export interface PlanPrice {
  billingInterval: BillingInterval;
  costUSD: number;
  stripePriceId: string;
}

export interface Plan {
  planType: ScratchPlanType;
  displayName: string;
  stripeProductId: string;
  /**
   * Prices a NEW subscription can be created at, at most one per billing interval. The billing UI
   * renders exactly these, so adding an interval here is what makes it purchasable.
   */
  purchasablePrices: PlanPrice[];
  /**
   * Price IDs that map to this plan but can no longer be bought — archived prices and bespoke
   * one-off deals. Nothing is ever checked out at these, but subscriptions still sit on them, so
   * they must stay listed or `getPlanTypeForStripePriceId` fails to resolve their webhooks and the
   * subscriber silently loses access. Only ever append here.
   */
  legacyStripePriceIds: string[];
  popular: boolean;
  hidden: boolean;
  features: PlanFeatures;
}

/**
 * Free Plan
 *
 * This plan is doesn't actually exist on Stripe and is the default plan for users who don't have a subscription.
 *
 * Once a user has a subscription (active or expired), they never go back to the free plan.
 */
export const FREE_PLAN: Plan = {
  planType: ScratchPlanType.FREE_PLAN,
  displayName: 'Free',
  stripeProductId: 'free_plan',
  // The Free plan is the absence of a subscription, not something you buy, so it has no Stripe price
  // at any interval. Checkout for it fails fast with "no Stripe price" instead of being sent to
  // Stripe as a bogus price id.
  purchasablePrices: [],
  legacyStripePriceIds: [],
  popular: false,
  hidden: false,
  features: {
    publishingLimit: 10,
    dataSourcePerServiceLimit: 0,
  },
};

/**
 * Pro Plan
 *
 * This plan is a paid plan that allows users to use the product with unlimited publishing actions and credits.
 */
export const PRO_PLAN: Plan = {
  planType: ScratchPlanType.PRO_PLAN,
  displayName: 'Pro',
  stripeProductId: '', // Set differently for each environment
  purchasablePrices: [], // Set differently for each environment
  legacyStripePriceIds: [], // Set differently for each environment
  popular: true,
  hidden: false,
  features: {
    publishingLimit: 0,
    dataSourcePerServiceLimit: 0,
  },
};

/**
 * Max Plan — retired, not deleted.
 *
 * The tier was never built out past a "Coming soon" card, so `hidden: true` keeps it off the public
 * `/payment/plans` list and out of every billing UI. It stays in the plan tables on purpose: two
 * subscriptions are still live on its Stripe price, and `getPlanTypeForStripePriceId` resolves
 * incoming webhooks against these tables — removing the entry would make `upsertSubscription` reject
 * their events and silently strand the subscribers. Delete it once those subscriptions are cancelled
 * or moved to Pro (DEV-11372).
 */
export const MAX_PLAN: Plan = {
  planType: ScratchPlanType.MAX_PLAN,
  displayName: 'Max',
  stripeProductId: '', // Set differently for each environment
  purchasablePrices: [], // Set differently for each environment
  legacyStripePriceIds: [], // Set differently for each environment
  popular: false,
  hidden: true,
  features: {
    publishingLimit: 0,
    dataSourcePerServiceLimit: 0,
  },
};

/**
 * Whalesync Plan
 *
 * An internal, non-purchasable plan auto-assigned to Whalesync shadow users (see
 * `StripePaymentService.ensureWhalesyncPlanSubscription`). It is free, never billed, and has no Stripe
 * product/price — shadow users only arrive through the internal admin channel and never touch Stripe
 * checkout or webhooks, so the subscription is a purely internal DB row with a synthetic
 * `stripeSubscriptionId`. The empty `purchasablePrices` makes
 * `getStripePriceIdForPlanAndBillingInterval` return null (so checkout and trials naturally fail for it)
 * and `hidden: true` keeps it off the public `/payment/plans` list and the billing UI. Its feature set
 * intentionally mirrors the Pro plan.
 */
export const WHALESYNC_PLAN: Plan = {
  planType: ScratchPlanType.WHALESYNC_PLAN,
  displayName: 'Whalesync',
  stripeProductId: '', // No Stripe product — this plan is internal-only.
  purchasablePrices: [], // No Stripe price — this plan is never purchased through Stripe.
  legacyStripePriceIds: [],
  popular: false,
  hidden: true,
  features: { ...PRO_PLAN.features }, // Equivalent to the Pro plan.
};

// Plans configured in the Scratch Test sandbox environment for developer testing
export const TEST_SANDBOX_PLANS: Plan[] = [
  FREE_PLAN,
  {
    ...PRO_PLAN,
    stripeProductId: 'prod_TVV4n4JqTQnENy',
    purchasablePrices: [
      { billingInterval: 'month', costUSD: 20, stripePriceId: 'price_1SYU4jBdRE0kMHNq4mMMjgWH' },
      { billingInterval: 'year', costUSD: 192, stripePriceId: 'price_1U82mCBdRE0kMHNq1lBo9MqX' },
    ],
  },
  {
    ...MAX_PLAN,
    stripeProductId: 'prod_TVV6aVZ43QYJmO',
    purchasablePrices: [{ billingInterval: 'month', costUSD: 100, stripePriceId: 'price_1SYU6CBdRE0kMHNqr7YRm7uu' }],
  },
  WHALESYNC_PLAN, // Internal-only: no Stripe product/price in any environment.
];

// Plans configured in the Scratch Staging sandbox environment
// TODO(DEV-11372): this Stripe sandbox has no annual Pro price, so staging cannot exercise annual
// billing at all — the billing UI derives its Monthly/Yearly toggle from these prices, so the toggle
// stays hidden there. Create an annual price in the staging Stripe account and add it to the Pro
// plan's `purchasablePrices` below to light it up.
export const STAGING_SANDBOX_PLANS: Plan[] = [
  FREE_PLAN,
  {
    ...PRO_PLAN,
    stripeProductId: 'prod_TVXbDaLac1BeEs',
    purchasablePrices: [{ billingInterval: 'month', costUSD: 20, stripePriceId: 'price_1SYWWVPd1pp0ErHMfWTsG55n' }],
  },
  {
    ...MAX_PLAN,
    stripeProductId: 'prod_TVXeZZtBUz1VRA',
    purchasablePrices: [{ billingInterval: 'month', costUSD: 100, stripePriceId: 'price_1SYWZDPd1pp0ErHMwtBs7ycN' }],
  },
  WHALESYNC_PLAN, // Internal-only: no Stripe product/price in any environment.
];

// Plans configured in the Stripe Production environment
export const PRODUCTION_PLANS: Plan[] = [
  FREE_PLAN,
  {
    ...PRO_PLAN,
    stripeProductId: 'prod_TVXVbCVSdlGOjc',
    purchasablePrices: [
      { billingInterval: 'month', costUSD: 20, stripePriceId: 'price_1SYWQ2BuGFTHqsGmiLNoiPCv' },
      { billingInterval: 'year', costUSD: 192, stripePriceId: 'price_1U82nOBuGFTHqsGmNkIi8R7e' },
    ],
    // Archived $5/month price kept for Viktor's existing subscription.
    legacyStripePriceIds: ['price_1T2cQxBuGFTHqsGmBOQjhThc'],
  },
  {
    ...MAX_PLAN,
    stripeProductId: 'prod_TVXUCHtF58Bzd2',
    purchasablePrices: [{ billingInterval: 'month', costUSD: 100, stripePriceId: 'price_1SYWPuBuGFTHqsGmOtGqjM6E' }],
  },
  WHALESYNC_PLAN, // Internal-only: no Stripe product/price in any environment.
];

export function getPlans(environment: ScratchEnvironment): Plan[] {
  if (environment === 'production') {
    return PRODUCTION_PLANS;
  } else if (environment === 'staging') {
    return STAGING_SANDBOX_PLANS;
  }
  return TEST_SANDBOX_PLANS;
}

export function getPlan(planType: ScratchPlanType): Plan | undefined {
  return getPlans(ScratchConfigService.getScratchEnvironment()).find((p) => p.planType === planType);
}

export function getFreePlan(): Plan {
  const freePlan = getPlan(ScratchPlanType.FREE_PLAN);
  assertIsDefined<Plan>(freePlan, 'Unable to identify free plan in the system');
  return freePlan;
}

/**
 * Every Stripe price id that maps to this plan — the purchasable ones plus the archived/bespoke
 * ones. This is the set a webhook is resolved against, so it must include the legacy ids.
 */
export function getAllStripePriceIdsForPlan(plan: Plan): string[] {
  return [...plan.purchasablePrices.map((price) => price.stripePriceId), ...plan.legacyStripePriceIds];
}

/**
 * The plan a Stripe price belongs to, or null if we don't recognize the price. Returning null here
 * is what makes an incoming subscription webhook fail loudly rather than granting the wrong plan, so
 * a newly created Stripe price MUST be added to `plans.ts` before anyone can be put on it.
 */
export function getPlanTypeForStripePriceId(
  environment: ScratchEnvironment,
  stripePriceId: string,
): ScratchPlanType | null {
  const planForPrice = getPlans(environment).find((plan) => getAllStripePriceIdsForPlan(plan).includes(stripePriceId));
  return planForPrice?.planType ?? null;
}

/**
 * The Stripe price to check out at for a plan + interval, or null when the plan isn't sold at that
 * interval (or isn't sold at all, like Free and Whalesync).
 */
export function getStripePriceIdForPlanAndBillingInterval(
  environment: ScratchEnvironment,
  planType: ScratchPlanType,
  billingInterval: BillingInterval,
): string | null {
  const plan = getPlans(environment).find((p) => p.planType === planType);
  return plan?.purchasablePrices.find((price) => price.billingInterval === billingInterval)?.stripePriceId ?? null;
}

/** The plan's list price at `billingInterval`, or null when it isn't sold at that interval. */
export function getPlanPriceForBillingInterval(plan: Plan, billingInterval: BillingInterval): PlanPrice | null {
  return plan.purchasablePrices.find((price) => price.billingInterval === billingInterval) ?? null;
}
