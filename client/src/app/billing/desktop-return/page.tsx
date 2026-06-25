'use client';

import { ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text13Regular, TextTitle2 } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { Container, Group, Loader, Stack } from '@mantine/core';
import { CheckCircle2Icon } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef } from 'react';

/**
 * Deep link that returns the user to the Billing sub-section of the desktop app's Settings view.
 * Kept in sync with the desktop deep-link mapper (`scratch-desktop/.../lib/deep-link-routes.ts`) and the
 * `DESKTOP_BILLING_RETURN_PATH` constant the desktop sends to Stripe as its return/cancel path.
 */
const DESKTOP_BILLING_DEEP_LINK = 'scratch://settings/billing';

/**
 * Build the `scratch://settings/billing` deep link, forwarding the Stripe `status` (success | cancel) so the
 * desktop app can show an appropriate toast. Uses the URL API the same way the OAuth callback page does.
 */
function buildDesktopBillingUrl(status: string | null): string {
  const desktopUrl = new URL(DESKTOP_BILLING_DEEP_LINK);
  if (status) {
    desktopUrl.searchParams.set('status', status);
  }
  return desktopUrl.toString();
}

/**
 * Bounce page that Stripe returns to after a billing workflow initiated from the desktop app.
 *
 * Stripe can only redirect a browser to an http(s) URL, never to a custom `scratch://` scheme, so the desktop
 * app passes this page's path as the checkout `success_url`/`cancel_url` and the portal `return_url`. On load we
 * redirect the browser into the desktop app via the `scratch://settings/billing` protocol handler — the same
 * technique the OAuth callback page (`/oauth/callback`) uses to return to the desktop app. The browser stays on
 * this page after a custom-protocol navigation, so we render a confirmation with an "Open the Scratch app"
 * fallback in case the handler did not fire (app not installed, redirect blocked, etc.).
 */
function DesktopBillingReturnContent() {
  const searchParams = useSearchParams();
  const hasRedirected = useRef(false);
  const status = searchParams.get('status');
  const desktopUrl = useMemo(() => buildDesktopBillingUrl(status), [status]);

  // Fire the protocol redirect once on mount. The browser stays on this page after a custom-scheme navigation,
  // so the markup below stands in as a confirmation with a manual "Open the Scratch app" fallback.
  useEffect(() => {
    if (hasRedirected.current) {
      return;
    }
    hasRedirected.current = true;
    window.location.href = desktopUrl;
  }, [desktopUrl]);

  // success → checkout completed; cancel → checkout abandoned; neither → portal ("Manage") return, which has no status.
  const heading = status === 'success' ? 'Payment complete' : status === 'cancel' ? 'Checkout cancelled' : 'All set';

  return (
    <Container size="sm" py="xl">
      <Stack align="center" gap="lg">
        <StyledLucideIcon Icon={CheckCircle2Icon} size={64} c="var(--mantine-color-green-6)" />
        <TextTitle2>{heading}</TextTitle2>
        <Text13Regular c="dimmed" ta="center">
          Returning you to the Scratch app. You can close this tab.
        </Text13Regular>
        <Group gap="sm" mt="md">
          <ButtonSecondaryOutline
            onClick={() => {
              window.location.href = desktopUrl;
            }}
          >
            Open the Scratch app
          </ButtonSecondaryOutline>
        </Group>
      </Stack>
    </Container>
  );
}

/**
 * `DesktopBillingReturnContent` reads the Stripe `status` from the URL via `useSearchParams()`, which forces a
 * client-side render. Next.js requires such a component to sit under a Suspense boundary, otherwise the page
 * bails out of static prerendering and the build fails. The fallback mirrors the inner loading state.
 */
export default function DesktopBillingReturnPage() {
  return (
    <Suspense
      fallback={
        <Container size="sm" py="xl">
          <Stack align="center" gap="lg">
            <Loader size="lg" />
            <TextTitle2>All set</TextTitle2>
            <Text13Regular c="dimmed" ta="center">
              Returning you to the Scratch app. You can close this tab.
            </Text13Regular>
          </Stack>
        </Container>
      }
    >
      <DesktopBillingReturnContent />
    </Suspense>
  );
}
