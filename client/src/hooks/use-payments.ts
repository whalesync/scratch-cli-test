import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { trackClickManageSubscription, trackClickNewPlanCheckout } from '@/lib/posthog';
import { RouteUrls } from '@/utils/route-urls';
import { ScratchPlanType, SubscriptionPlan } from '@spinner/shared-types';
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
    return data ? data.sort((a, b) => a.costUSD - b.costUSD) : [];
  }, [data]);

  const displayError = useMemo(() => {
    if (isUnauthorizedError(error)) {
      // ignore this error as it will be fixed after the token is refreshed
      return undefined;
    }
    return error?.message;
  }, [error]);

  const redirectToPlanCheckout = useCallback(
    async (planType: ScratchPlanType) => {
      try {
        setPortalRedirectInProgress(true);
        const result = await scratchApiClient.payment.createCheckoutSession(planType, {
          returnPath: RouteUrls.billingPageUrl,
        });
        trackClickNewPlanCheckout(planType);
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
    async (planType: ScratchPlanType, returnPath: string) => {
      try {
        setPortalRedirectInProgress(true);
        const result = await scratchApiClient.payment.createCustomerPortalUrl({
          portalType: 'update_subscription',
          planType,
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
