export enum ScratchPlanType {
  FREE_PLAN = 'FREE_PLAN',
  PRO_PLAN = 'PRO_PLAN',
  MAX_PLAN = 'MAX_PLAN',
  // Internal, non-purchasable plan auto-assigned to Whalesync shadow users. Pro-equivalent feature set,
  // $0, never billed through Stripe. See server/src/payment/plans.ts (WHALESYNC_PLAN).
  WHALESYNC_PLAN = 'WHALESYNC_PLAN',
}

/**
 * How often a subscription is billed. The values mirror Stripe's price `recurring.interval`, so a
 * value can be compared against a Stripe price without translation.
 */
export type BillingInterval = 'month' | 'year';

/** Every billing interval a plan can be purchased at, in the order the billing UI offers them. */
export const ALL_BILLING_INTERVALS: readonly BillingInterval[] = ['month', 'year'];

export function isBillingInterval(value: unknown): value is BillingInterval {
  return value === 'month' || value === 'year';
}

export interface SubscriptionPlanFeatures {
  publishingLimit: number;
  dataSourcePerServiceLimit: number;
}

/**
 * One purchasable price for a plan — what a single billing period costs at that interval. A plan has
 * at most one price per interval (e.g. Pro is $20/month or $192/year).
 */
export interface SubscriptionPlanPrice {
  billingInterval: BillingInterval;
  /** Cost in USD of ONE billing period: 20 for $20/month, 192 for $192/year. */
  costUSD: number;
}

/**
 * Actions that are billable and can be used to determine if a user is over their limit.
 */
export interface BillableActions {
  /** Number of publish actions the organization has performed in the current month */
  monthlyPublishCount: number;
}

export interface SubscriptionInfo {
  status: 'valid' | 'expired' | 'payment_failed' | 'none';
  planDisplayName: string;
  planType: ScratchPlanType;
  /**
   * What the organization is actually charged for ONE billing period, in USD — sourced from the
   * Stripe subscription, so it reflects an annual price or a bespoke/legacy price rather than the
   * plan's list price. Read it together with `billingInterval`; on its own it is ambiguous.
   */
  costUSD: number;
  /** The interval `costUSD` is charged over. `month` for the Free plan, which is never billed. */
  billingInterval: BillingInterval;
  daysRemaining: number;
  isTrial: boolean;
  isCancelled: boolean;
  canManageSubscription: boolean;
  ownerId: string;
  features: SubscriptionPlanFeatures;
  billableActions: BillableActions;
}

export interface SubscriptionPlan {
  planType: ScratchPlanType;
  displayName: string;
  popular: boolean;
  /**
   * Every interval this plan can be bought at, at most one entry per interval. Empty for plans with
   * no purchasable Stripe price (the internal Whalesync plan).
   */
  purchasablePrices: SubscriptionPlanPrice[];
  /**
   * @deprecated Read `purchasablePrices` instead — it is the only field that can express an annual
   * price. This is the plan's MONTHLY list price (0 when it isn't sold monthly), kept on the wire
   * purely so desktop builds shipped before annual billing keep rendering a price instead of
   * "$undefined". Drop it once those builds have rolled forward.
   */
  costUSD: number;
  features: SubscriptionPlanFeatures;
}

/** The plan's price at `billingInterval`, or undefined when the plan isn't sold at that interval. */
export function findPurchasablePriceForBillingInterval(
  plan: SubscriptionPlan,
  billingInterval: BillingInterval,
): SubscriptionPlanPrice | undefined {
  return plan.purchasablePrices.find((price) => price.billingInterval === billingInterval);
}

/**
 * Lowest per-billing-period cost the plan is sold at, used only for ordering the plan cards from
 * cheapest to most expensive. A plan with no purchasable price costs nothing — that's the Free plan,
 * which belongs at the front of the list. (The other price-less plan, Whalesync, is `hidden` and
 * filtered out of `/payment/plans` before it ever reaches a client.)
 */
export function getLowestPurchasablePriceCostUSD(plan: SubscriptionPlan): number {
  if (plan.purchasablePrices.length === 0) {
    return 0;
  }
  return Math.min(...plan.purchasablePrices.map((price) => price.costUSD));
}

/**
 * The billing intervals worth offering for a set of plans — those at least one plan is actually sold
 * at, in display order. The billing UI derives its Monthly/Yearly toggle from this, so an
 * environment whose Stripe account has no annual price simply renders monthly-only instead of
 * offering a toggle that leads to empty cards.
 */
export function getOfferedBillingIntervals(plans: SubscriptionPlan[]): BillingInterval[] {
  return ALL_BILLING_INTERVALS.filter((billingInterval) =>
    plans.some((plan) => plan.purchasablePrices.some((price) => price.billingInterval === billingInterval)),
  );
}

/**
 * What an annual price works out to per month, for the "$16/month billed annually" line under a
 * yearly price. A monthly price is already its own monthly cost.
 */
export function getMonthlyEquivalentCostUSD(price: SubscriptionPlanPrice): number {
  return price.billingInterval === 'year' ? price.costUSD / 12 : price.costUSD;
}
