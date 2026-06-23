'use client';

import { ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text13Regular, TextTitle2 } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { RouteUrls } from '@/utils/route-urls';
import { Container, Loader, Stack } from '@mantine/core';
import { CircleXIcon } from 'lucide-react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

/**
 * PUBLIC redeem step of the marketplace-initiated ("inbound") OAuth install.
 *
 * The connector's marketplace (e.g. the GoHighLevel App Marketplace) is configured to redirect here:
 * `app.scratch.md/oauth/install/:service?code=…`. The page immediately posts the one-time `code` to
 * the public redeem endpoint (the code expires in minutes — it can't survive a sign-up/login detour),
 * gets back a single-use `installId`, and forwards to the auth-gated `/connect/:service` claim page,
 * where Clerk handles sign-up/in (states A/B/C) before the user finishes connecting.
 *
 * This route is in `RouteUrls.publicRoutePatterns` so it loads without a scratch.md session. It does
 * nothing sensitive — reads the `code`, posts it, redirects. Connector-agnostic: no branching on the
 * service. Mirrors how Scratch's app-initiated OAuth lands on the web host (`/oauth/callback`).
 */
function InstallRedeemContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const hasRedeemed = useRef(false);
  // Only the async redeem failure lives in state; the URL-derived error states below
  // are computed during render (setting them in the effect would be a cascading-render
  // anti-pattern flagged by react-hooks/set-state-in-effect).
  const [redeemErrorMessage, setRedeemErrorMessage] = useState<string | undefined>(undefined);

  const service = Array.isArray(params.service) ? params.service[0] : (params.service ?? '');
  const code = searchParams.get('code');
  const oauthError = searchParams.get('error');

  // Error states that are pure functions of the URL — no effect needed.
  const staticErrorMessage = oauthError
    ? `${oauthError}. Please retry the install from the marketplace.`
    : !code || !service
      ? 'This install link is missing its authorization code.'
      : undefined;

  useEffect(() => {
    // Nothing to redeem if the URL itself is already an error case.
    if (staticErrorMessage || !code || !service) return;
    // Strict Mode double-renders; the code is single-use, so guard against a double redeem.
    if (hasRedeemed.current) return;
    hasRedeemed.current = true;

    void (async () => {
      try {
        const { installId } = await scratchApiClient.oauth.redeemInboundInstall(service, code);
        // Hand off to the auth-gated claim page; Clerk handles sign-up/in if the user isn't logged in.
        router.replace(`${RouteUrls.connectClaimPageUrl(service)}?install=${encodeURIComponent(installId)}`);
      } catch (e) {
        setRedeemErrorMessage(e instanceof Error ? e.message : 'Failed to start the connection.');
      }
    })();
  }, [staticErrorMessage, code, service, router]);

  const errorMessage = staticErrorMessage ?? redeemErrorMessage;
  if (errorMessage) {
    return (
      <Container size="sm" py="xl">
        <Stack align="center" gap="lg">
          <StyledLucideIcon Icon={CircleXIcon} size={40} />
          <TextTitle2 ta="center">We couldn&apos;t start the connection</TextTitle2>
          <Text13Regular c="dimmed" ta="center">
            {errorMessage}
          </Text13Regular>
          <ButtonSecondaryOutline onClick={() => router.replace(RouteUrls.workbookPickerPageUrl)}>
            Go to Scratch
          </ButtonSecondaryOutline>
        </Stack>
      </Container>
    );
  }

  return <InstallRedeemLoading />;
}

function InstallRedeemLoading() {
  return (
    <Container size="sm" py="xl">
      <Stack align="center" gap="lg">
        <Loader size="lg" />
        <TextTitle2 ta="center">Connecting your account…</TextTitle2>
        <Text13Regular c="dimmed" ta="center">
          Hang tight while we set up your connection.
        </Text13Regular>
      </Stack>
    </Container>
  );
}

export default function InstallRedeemPage() {
  return (
    <Suspense fallback={<InstallRedeemLoading />}>
      <InstallRedeemContent />
    </Suspense>
  );
}
