'use client';

import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text16Regular, TextTitle2 } from '@/app/components/base/text';
import { trackOpenInDesktopInterstitialFallback } from '@/lib/posthog';
import { RouteUrls } from '@/utils/route-urls';
import { Box, Center, Stack } from '@mantine/core';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState, type ReactElement } from 'react';

const FALLBACK_MS = 2000;

/** Remount when the open path changes so `showFallback` does not leak across navigations. */
function OpenInDesktopInnerWrapper(): ReactElement {
  const params = useParams<{ path?: string[] }>();
  const pathKey = (params.path ?? []).join('/') || '__root__';
  return <OpenInDesktopInner key={pathKey} />;
}

function OpenInDesktopInner(): ReactElement {
  const params = useParams<{ path?: string[] }>();
  const searchParams = useSearchParams();
  const segments = params.path ?? [];
  const [showFallback, setShowFallback] = useState(false);

  const query = searchParams.toString();
  const querySuffix = query ? `?${query}` : '';

  const webPath = `/${segments.join('/')}`;
  const isValid = segments[0] === 'workbook' && segments.length >= 2;
  const deepLink = isValid ? `scratch://${segments.join('/')}${querySuffix}` : '';

  const invalidPathTrackedKeyRef = useRef<string | null>(null);
  const timeoutAnalyticsSentRef = useRef(false);

  // Invalid URL: analytics only — UI is derived from `isValid`, no setState in this effect.
  useEffect(() => {
    if (isValid) {
      return;
    }
    if (invalidPathTrackedKeyRef.current === webPath) {
      return;
    }
    invalidPathTrackedKeyRef.current = webPath;
    trackOpenInDesktopInterstitialFallback({ reason: 'invalid_path' });
  }, [isValid, webPath]);

  // Valid URL: open handler + delayed fallback (setState runs in timer callback, not synchronously in the effect).
  useEffect(() => {
    if (!isValid) {
      return;
    }
    timeoutAnalyticsSentRef.current = false;
    window.location.href = deepLink;
    const timer = window.setTimeout(() => setShowFallback(true), FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [deepLink, isValid]);

  useEffect(() => {
    if (!showFallback || !isValid || timeoutAnalyticsSentRef.current) {
      return;
    }
    timeoutAnalyticsSentRef.current = true;
    trackOpenInDesktopInterstitialFallback({ reason: 'timeout' });
  }, [showFallback, isValid]);

  if (!isValid) {
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
            <TextTitle2>Opening Scratch…</TextTitle2>
            <Text16Regular c="dimmed" ta="center">
              If Scratch Desktop is installed, it should open now.
            </Text16Regular>
          </>
        ) : (
          <>
            <TextTitle2>Continue in your browser</TextTitle2>
            <Text16Regular c="dimmed" ta="center">
              We could not open the Scratch Desktop app. You can download it or keep working in the browser.
            </Text16Regular>
            <Stack gap="sm" w="100%">
              <ButtonPrimaryLight
                onClick={() => {
                  window.open(RouteUrls.downloadsPageUrl, '_blank', 'noopener,noreferrer');
                }}
              >
                Download Scratch Desktop
              </ButtonPrimaryLight>
              <ButtonSecondaryOutline component={Link} href={`${webPath}${querySuffix}`}>
                Continue in browser
              </ButtonSecondaryOutline>
            </Stack>
          </>
        )}
      </Stack>
    </Center>
  );
}

export default function OpenInDesktopPage(): ReactElement {
  return (
    <Suspense
      fallback={
        <Box h="100vh" style={{ backgroundColor: 'var(--bg-base)' }}>
          <Center h="100%">
            <Text16Regular c="dimmed">Loading…</Text16Regular>
          </Center>
        </Box>
      }
    >
      <OpenInDesktopInnerWrapper />
    </Suspense>
  );
}
