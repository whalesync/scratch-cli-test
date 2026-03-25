'use client';

import { AuthLayout } from '@/app/components/layouts/AuthLayout';
import { useClerkAppearance } from '@/hooks/use-clerk-appearance/useClerkAppearance';
import { RouteUrls } from '@/utils/route-urls';
import { SignUp } from '@clerk/nextjs';
import { useSearchParams } from 'next/navigation';

export default function SignUpPage() {
  const searchParams = useSearchParams();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- ClerkAppearanceRegistry augmentation not resolved
  const appearance = useClerkAppearance();

  /*
   * redirect_url is not always getting utilized by Clerk after the sign-in so we need to detect it here and
   * force the settings on the SignUp component. Need to make sure we do this in the sign-in page as well.
   */
  const redirect_url = searchParams.get('redirect_url');
  const signInUrlWithRedirect = redirect_url ? RouteUrls.signInPageWithRedirect(redirect_url) : '';

  const redirectURLProps = redirect_url ? { forceRedirectUrl: redirect_url, signInUrl: signInUrlWithRedirect } : {};

  return (
    <AuthLayout title="Sign Up - Scratch">
      {/* eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- ClerkAppearanceRegistry augmentation not resolved */}
      <SignUp appearance={appearance} routing="hash" {...redirectURLProps} />
    </AuthLayout>
  );
}
