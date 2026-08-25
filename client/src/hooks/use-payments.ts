import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { trackClickManageSubscription, trackClickNewPlanCheckout } from '@/lib/posthog';
import { RouteUrls } from '@/utils/route-urls';
import {
  BillingInterval,
  getLowestPurchasablePriceCostUSD,
  getOfferedBillingIntervals,
  ScratchPlanType,
  SubscriptionPlan,
} from '@spinner/shared-types';
import { isUnauthorizedError } from '@spinner/shared-types/api-client';
import { useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';

export const usePayments = () => {
  const [portalRedirectInProgress, setPortalRedirectInProgress] = useState(false);
  const [portalRedirectError, setPortalRedirectError] = useState<string | null>(null);
  const { data, error, isLoading } = useSWR<SubscriptionPlan[], Error>(SWR_KEYS.billing.plans(), () =>
    scratchApiClient.payment.listPlans(),
  );

  const sortedPlans = useMemo(() => {
    return data
      ? [...data].sort((a, b) => getLowestPurchasablePriceCostUSD(a) - getLowestPurchasablePriceCostUSD(b))
      : [];
  }, [data]);

  // Only the intervals some plan is actually sold at — see getOfferedBillingIntervals.
  const offeredBillingIntervals = useMemo(() => getOfferedBillingIntervals(sortedPlans), [sortedPlans]);

  const displayError = useMemo(() => {
    if (isUnauthorizedError(error)) {
      // ignore this error as it will be fixed after the token is refreshed
      return undefined;
    }
    return error?.message;
  }, [error]);

  const redirectToPlanCheckout = useCallback(
    async (planType: ScratchPlanType, billingInterval: BillingInterval) => {
      try {
        setPortalRedirectInProgress(true);
        const result = await scratchApiClient.payment.createCheckoutSession(planType, {
          returnPath: RouteUrls.billingPageUrl,
          billingInterval,
        });
        trackClickNewPlanCheckout(planType, billingInterval);
        window.location.replace(result.url);
      } catch (error) {
        console.error('Failed to redirect to checkout page for plan: ', planType, error);
        setPortalRedirectError(error instanceof Error ? error.message : 'Unknown error');
        setPortalRedirectInProgress(false);
      }
    },
    [setPortalRedirectInProgress, setPortalRedirectError],
  );
  const redirectToUpdateSubscription = useCallback(
    async (planType: ScratchPlanType, billingInterval: BillingInterval, returnPath: string) => {
      try {
        setPortalRedirectInProgress(true);
        const result = await scratchApiClient.payment.createCustomerPortalUrl({
          portalType: 'update_subscription',
          planType,
          billingInterval,
          returnPath,
        });
        trackClickManageSubscription();
        window.location.replace(result.url);
      } catch (error) {
        console.error('Failed to redirect to update subscription: ', error);
        setPortalRedirectError(error instanceof Error ? error.message : 'Unknown error');
        setPortalRedirectInProgress(false);
      }
    },
    [setPortalRedirectInProgress, setPortalRedirectError],
  );

  const redirectToCancelSubscription = useCallback(
    async (returnPath: string) => {
      try {
        setPortalRedirectInProgress(true);
        const result = await scratchApiClient.payment.createCustomerPortalUrl({
          portalType: 'cancel_subscription',
          returnPath,
        });
        trackClickManageSubscription();
        window.location.replace(result.url);
      } catch (error) {
        console.error('Failed to redirect to update subscription: ', error);
        setPortalRedirectError(error instanceof Error ? error.message : 'Unknown error');
        setPortalRedirectInProgress(false);
      }
    },
    [setPortalRedirectInProgress, setPortalRedirectError],
  );

  const redirectToManageSubscription = useCallback(
    async (returnPath: string) => {
      try {
        setPortalRedirectInProgress(true);
        const result = await scratchApiClient.payment.createCustomerPortalUrl({ returnPath });
        trackClickManageSubscription();
        window.location.replace(result.url);
      } catch (error) {
        console.error('Failed to redirect to manage subscription: ', error);
        setPortalRedirectError(error instanceof Error ? error.message : 'Unknown error');
        setPortalRedirectInProgress(false);
      }
    },
    [setPortalRedirectInProgress, setPortalRedirectError],
  );

  return {
    plans: sortedPlans,
    offeredBillingIntervals,
    isLoading,
    error: displayError,
    redirectToUpdateSubscription,
    redirectToCancelSubscription,
    redirectToManageSubscription,
    redirectToPlanCheckout,
    portalRedirectInProgress,
    portalRedirectError,
  };
};
