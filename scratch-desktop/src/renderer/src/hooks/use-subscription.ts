import { ScratchPlanType, SubscriptionInfo } from '@spinner/shared-types';
import { useCurrentUser } from './use-current-user';

export interface UseSubscriptionReturn {
  subscription: SubscriptionInfo;
  isFreePlan: boolean;
}

/**
 * Default surfaced while the user/subscription is loading or absent. Mirrors the web client's
 * `UNKNOWN_SUBSCRIPTION_STATUS` so the billing UI renders a stable "free / unmanageable" state rather than
 * crashing on an undefined subscription.
 */
const UNKNOWN_SUBSCRIPTION: SubscriptionInfo = {
  status: 'none',
  planDisplayName: 'No Plan',
  planType: ScratchPlanType.FREE_PLAN,
  costUSD: 0,
  daysRemaining: 0,
  isTrial: false,
  isCancelled: false,
  canManageSubscription: false,
  ownerId: '',
  features: {
    dataSourcePerServiceLimit: -1,
    publishingLimit: -1,
  },
  billableActions: {
    monthlyPublishCount: 0,
  },
};

/**
 * Desktop counterpart of the web client's `useSubscription`. The subscription already rides on the current user
 * (`GET /users/current`), so this reads it from `useCurrentUser()` rather than fetching a separate endpoint.
 */
export function useSubscription(): UseSubscriptionReturn {
  const { user } = useCurrentUser();

  if (!user?.subscription) {
    return { subscription: UNKNOWN_SUBSCRIPTION, isFreePlan: false };
  }

  return {
    subscription: user.subscription,
    isFreePlan: user.subscription.planType === ScratchPlanType.FREE_PLAN,
  };
}
