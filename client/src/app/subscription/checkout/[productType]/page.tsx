'use client';
import { ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { FullPageLoader } from '@/app/components/FullPageLoader';
import { Info } from '@/app/components/InfoPanel';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { stringToEnum } from '@/utils/helpers';
import { RouteUrls } from '@/utils/route-urls';
import { ScratchPlanType } from '@spinner/shared-types';
import { RotateCwIcon } from 'lucide-react';
import { useParams } from 'next/navigation';
import { JSX, useEffect, useState } from 'react';

async function goToPaymentCheckoutUrl(args: { planType: string | string[] | undefined }): Promise<void> {
  if (typeof args.planType === 'string' && typeof window !== 'undefined') {
    const rawplanType = args.planType;
    const planType: ScratchPlanType = stringToEnum(rawplanType, ScratchPlanType, ScratchPlanType.PRO_PLAN);
    // Generate a URL and redirect to it.
    // This will either be a link to create a new subscription, or to update the current subscription if it exists.
    const result = await scratchApiClient.payment.createCheckoutSession(planType, {
      returnPath: RouteUrls.billingPageUrl,
    });
    window.location.replace(result.url);
  }
}

/**
 * Generates a Stripe Checkout URL based on the signed-in user and the planType requested, then
 * redirects to it.
 *
 * The `planType` parameter accepts the strings from the `planType`, and defaults to 'starter'.
 */
const ProductCheckoutRedirect = (): JSX.Element => {
  const params = useParams();
  const { isSignedIn } = useScratchPadUser();
  const [error, setError] = useState<string | null>(null);

  const planType = params.planType as string;

  useEffect(() => {
    if (isSignedIn && planType) {
      goToPaymentCheckoutUrl({
        planType,
      }).catch((e: unknown) => {
        console.error('Failed to load payment checkout URL: ', e);
        setError(e instanceof Error ? e.message : 'Unknown error');
      });
    }
  }, [planType, isSignedIn]);

  if (error) {
    return (
      <Info>
        <Info.ErrorIcon />
        <Info.Title>Unable to load Stripe billing portal.</Info.Title>
        <Info.Actions>
          <ButtonSecondaryOutline href={RouteUrls.homePageUrl} leftSection={<RotateCwIcon />} component="a">
            Return to Snapshots
          </ButtonSecondaryOutline>
        </Info.Actions>
      </Info>
    );
  }

  return <FullPageLoader />;
};

export default ProductCheckoutRedirect;
