import { ScratchPlanType, Service, SubscriptionInfo } from '@spinner/shared-types';
import { useCallback, useMemo } from 'react';
import { useScratchPadUser } from './useScratchpadUser';

export interface UseSubscriptionReturn {
  subscription: SubscriptionInfo;
  isFreePlan: boolean;
  canPublishWorkbook: boolean;
  canCreateDataSource: (service: Service) => boolean;
}

const UNKNOWN_SUBSCRIPTION_STATUS: UseSubscriptionReturn = {
  subscription: {
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
  },
  isFreePlan: false,
  canPublishWorkbook: false,
  canCreateDataSource: () => false,
};

/**
 * This is a bit thin right now, but more will be added as we integrate subscription evaluation into the UI.
 *
 * For now I am extracting the subscription out of the user, but this will get swapped into a new endpoint that we can refresh from the server.
 *
 * TODO: add utilities to test which features are available and if the user can perform actions based on the subscription
 */
export function useSubscription(): UseSubscriptionReturn {
  const { user } = useScratchPadUser();

  const canPublishWorkbook = useMemo(() => {
    if (!user) return false;
    if (!user.subscription) return false;

    if (user.subscription.status !== 'valid') {
      return false;
    }

    const limit = user.subscription.features.publishingLimit ?? 10;

    if (limit === 0) {
      return true;
    }

    const monthlyPublishCount = user.subscription.billableActions?.monthlyPublishCount ?? 0;
    return monthlyPublishCount < limit;
  }, [user]);

  /**
   * Check if the subscription allows creating data sources for a given service.
   * The actual per-workbook limit enforcement is done server-side when creating the connection.
   */
  const canCreateDataSource = useCallback(
    // Service parameter kept for API compatibility - limit checking happens server-side
    (service: Service): boolean => {
      void service; // Acknowledge parameter for future use
      if (!user) return false;
      if (!user.subscription) return false;

      if (user.subscription.status !== 'valid') {
        return false;
      }

      // Return true if subscription allows data sources; server enforces actual limits
      return user.subscription.features.dataSourcePerServiceLimit !== undefined;
    },
    [user],
  );

  if (!user) {
    return UNKNOWN_SUBSCRIPTION_STATUS;
  }

  if (!user.subscription) {
    return UNKNOWN_SUBSCRIPTION_STATUS;
  }

  return {
    subscription: user.subscription,
    isFreePlan: user.subscription.planType === ScratchPlanType.FREE_PLAN,
    canPublishWorkbook,
    canCreateDataSource,
  };
}
