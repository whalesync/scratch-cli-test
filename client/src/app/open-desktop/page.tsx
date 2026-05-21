'use client';

import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text16Regular, TextTitle2 } from '@/app/components/base/text';
import { trackOpenInDesktopInterstitialFallback } from '@/lib/posthog';
import { RouteUrls } from '@/utils/route-urls';
import { Box, Center, Stack } from '@mantine/core';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, type ReactElement } from 'react';

const FALLBACK_MS = 2000;

function normalizeScratchDeepLink(rawDeepLink: string | null): string | null {
  if (!rawDeepLink) {
    return null;
  }

  try {
    const deepLink = new URL(rawDeepLink);
    if (deepLink.protocol !== 'scratch:') {
      return null;
    }
    deepLink.searchParams.set('source', 'webapp');
    return deepLink.toString();
  } catch {
    return null;
  }
}

function OpenDesktopInner(): ReactElement {
  const searchParams = useSearchParams();
  const deepLink = normalizeScratchDeepLink(searchParams.get('url') ?? searchParams.get('target'));
  const [showFallback, setShowFallback] = useState(false);
  const invalidTrackedRef = useRef(false);
  const timeoutAnalyticsSentRef = useRef(false);

  useEffect(() => {
    if (deepLink || invalidTrackedRef.current) {
      return;
    }
    invalidTrackedRef.current = true;
    trackOpenInDesktopInterstitialFallback({ reason: 'invalid_path' });
  }, [deepLink]);

  useEffect(() => {
    if (!deepLink) {
      return;
    }
    timeoutAnalyticsSentRef.current = false;
    window.location.href = deepLink;
    const timer = window.setTimeout(() => setShowFallback(true), FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [deepLink]);

  useEffect(() => {
    if (!showFallback || !deepLink || timeoutAnalyticsSentRef.current) {
      return;
    }
    timeoutAnalyticsSentRef.current = true;
    trackOpenInDesktopInterstitialFallback({ reason: 'timeout' });
  }, [deepLink, showFallback]);

  if (!deepLink) {
    return (
      <Center h="100vh" style={{ backgroundColor: 'var(--bg-base)' }}>
        <Stack align="center" gap="md" maw={420} px="md">
          <TextTitle2>Link could not be opened</TextTitle2>
          <Text16Regular c="dimmed" ta="center">
            This open link is not valid.
          </Text16Regular>
          <ButtonSecondaryOutline component={Link} href={RouteUrls.homePageUrl}>
            Go home
          </ButtonSecondaryOutline>
        </Stack>
      </Center>
    );
  }

  return (
    <Center h="100vh" style={{ backgroundColor: 'var(--bg-base)' }}>
      <Stack align="center" gap="lg" maw={440} px="md">
        {!showFallback ? (
          <>
            <TextTitle2>Opening Scratch...</TextTitle2>
            <Text16Regular c="dimmed" ta="center">
              If Scratch Desktop is installed, it should open now.
            </Text16Regular>
          </>
        ) : (
          <>
            <TextTitle2>Open Scratch Desktop</TextTitle2>
            <Text16Regular c="dimmed" ta="center">
              If Scratch Desktop did not open automatically, try opening it again or download the app.
            </Text16Regular>
            <Stack gap="sm" w="100%">
              <ButtonPrimaryLight onClick={() => (window.location.href = deepLink)}>
                Open Scratch Desktop
              </ButtonPrimaryLight>
              <ButtonSecondaryOutline component={Link} href={RouteUrls.downloadsPageUrl}>
                Download Scratch Desktop
              </ButtonSecondaryOutline>
            </Stack>
          </>
        )}
      </Stack>
    </Center>
  );
}

export default function OpenDesktopPage(): ReactElement {
  return (
    <Suspense
      fallback={
        <Box h="100vh" style={{ backgroundColor: 'var(--bg-base)' }}>
          <Center h="100%">
            <Text16Regular c="dimmed">Loading...</Text16Regular>
          </Center>
        </Box>
      }
    >
      <OpenDesktopInner />
    </Suspense>
  );
}
