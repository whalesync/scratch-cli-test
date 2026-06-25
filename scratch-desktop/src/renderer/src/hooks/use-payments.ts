import { ScratchPlanType, SubscriptionPlan } from '@spinner/shared-types';
import { isUnauthorizedError } from '@spinner/shared-types/api-client';
import { useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import { trackBillingManageSubscription, trackBillingStartCheckout } from '../lib/posthog';
import { scratchApiClient } from '../lib/scratch-api-client';

/**
 * Web-client paths (resolved against the SERVER's configured client base URL) that Stripe returns to. They
 * point at the web bounce page (`client/src/app/billing/desktop-return/page.tsx`), which immediately redirects
 * back into the desktop app via `scratch://settings/billing`. Stripe only accepts http(s) URLs, so the desktop
 * cannot hand it a `scratch://` URL directly — hence the web hop. Keep these in sync with that route.
 */
const DESKTOP_BILLING_SUCCESS_PATH = '/billing/desktop-return?status=success';
const DESKTOP_BILLING_CANCEL_PATH = '/billing/desktop-return?status=cancel';
const DESKTOP_BILLING_PORTAL_RETURN_PATH = '/billing/desktop-return';

const PLANS_SWR_KEY = '/payment/plans';

/**
 * Desktop counterpart of the web client's `usePayments`. Same server calls (`scratchApiClient.payment.*`), but
 * every redirect opens the Stripe URL in the system browser via `window.scratchAuth.openExternal` instead of
 * navigating the current document — and passes the desktop bounce-page paths so the flow returns to the app.
 */
export const usePayments = () => {
  const [portalRedirectInProgress, setPortalRedirectInProgress] = useState(false);
  const [portalRedirectError, setPortalRedirectError] = useState<string | null>(null);
  const { data, error, isLoading } = useSWR<SubscriptionPlan[], Error>(PLANS_SWR_KEY, () =>
    scratchApiClient.payment.listPlans(),
  );

  const sortedPlans = useMemo(() => (data ? [...data].sort((a, b) => a.costUSD - b.costUSD) : []), [data]);

  const displayError = useMemo(() => {
    if (isUnauthorizedError(error)) {
      // Ignore — this resolves once the API token is refreshed.
      return undefined;
    }
    return error?.message;
  }, [error]);

  // Unlike the web client (which navigates the document away via window.location and never returns), the desktop
  // renderer stays mounted after openExternal, so we must always clear the in-progress flag in `finally`.
  const openStripeUrl = useCallback(async (run: () => Promise<{ url: string }>): Promise<void> => {
    try {
      setPortalRedirectInProgress(true);
      setPortalRedirectError(null);
      const result = await run();
      await window.scratchAuth.openExternal(result.url);
    } catch (error) {
      console.debug('Failed to open Stripe billing url', error);
      setPortalRedirectError(error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setPortalRedirectInProgress(false);
    }
  }, []);

  const redirectToPlanCheckout = useCallback(
    async (planType: ScratchPlanType) => {
      void trackBillingStartCheckout(planType);
      await openStripeUrl(() =>
        scratchApiClient.payment.createCheckoutSession(planType, {
          returnPath: DESKTOP_BILLING_SUCCESS_PATH,
          cancelPath: DESKTOP_BILLING_CANCEL_PATH,
        }),
      );
    },
    [openStripeUrl],
  );

  const redirectToUpdateSubscription = useCallback(
    async (planType: ScratchPlanType) => {
      void trackBillingManageSubscription();
      await openStripeUrl(() =>
        scratchApiClient.payment.createCustomerPortalUrl({
          portalType: 'update_subscription',
          planType,
          returnPath: DESKTOP_BILLING_PORTAL_RETURN_PATH,
        }),
      );
    },
    [openStripeUrl],
  );

  const redirectToCancelSubscription = useCallback(async () => {
    void trackBillingManageSubscription();
    await openStripeUrl(() =>
      scratchApiClient.payment.createCustomerPortalUrl({
        portalType: 'cancel_subscription',
        returnPath: DESKTOP_BILLING_PORTAL_RETURN_PATH,
      }),
    );
  }, [openStripeUrl]);

  const redirectToManageSubscription = useCallback(async () => {
    void trackBillingManageSubscription();
    await openStripeUrl(() =>
      scratchApiClient.payment.createCustomerPortalUrl({ returnPath: DESKTOP_BILLING_PORTAL_RETURN_PATH }),
    );
  }, [openStripeUrl]);

  return {
    plans: sortedPlans,
    isLoading,
    error: displayError,
    redirectToPlanCheckout,
    redirectToUpdateSubscription,
    redirectToCancelSubscription,
    redirectToManageSubscription,
    portalRedirectInProgress,
    portalRedirectError,
  };
};
