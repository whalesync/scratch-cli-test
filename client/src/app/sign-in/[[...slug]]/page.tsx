'use client';

import { AuthLayout } from '@/app/components/layouts/AuthLayout';
import { useClerkAppearance } from '@/hooks/use-clerk-appearance/useClerkAppearance';
import { RouteUrls } from '@/utils/route-urls';
import { SignIn } from '@clerk/nextjs';
import { useSearchParams } from 'next/navigation';

export default function SignInPage() {
  const searchParams = useSearchParams();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- ClerkAppearanceRegistry augmentation not resolved
  const appearance = useClerkAppearance();

  /*
   * redirect_url is not always getting utilized by Clerk after the sign-up so we need to detect it here and
   * force the settings on the SignIn component. Need to make sure we do this in the sign-up page as well.
   */
  const redirect_url = searchParams.get('redirect_url');
  const signUpUrlWithRedirect = redirect_url ? RouteUrls.signUpPageWithRedirect(redirect_url) : '';

  const signInProps = redirect_url ? { forceRedirectUrl: redirect_url, signUpUrl: signUpUrlWithRedirect } : {};

  return (
    <AuthLayout title="Sign in - Scratch">
      {/* eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- ClerkAppearanceRegistry augmentation not resolved */}
      <SignIn appearance={appearance} routing="hash" {...signInProps} />
    </AuthLayout>
  );
}
