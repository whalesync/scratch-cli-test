export enum ScratchPlanType {
  FREE_PLAN = 'FREE_PLAN',
  PRO_PLAN = 'PRO_PLAN',
  MAX_PLAN = 'MAX_PLAN',
  // Internal, non-purchasable plan auto-assigned to Whalesync shadow users. Pro-equivalent feature set,
  // $0, never billed through Stripe. See server/src/payment/plans.ts (WHALESYNC_PLAN).
  WHALESYNC_PLAN = 'WHALESYNC_PLAN',
}

export interface SubscriptionPlanFeatures {
  publishingLimit: number;
  dataSourcePerServiceLimit: number;
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
  costUSD: number;
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
  costUSD: number;
  features: SubscriptionPlanFeatures;
}
