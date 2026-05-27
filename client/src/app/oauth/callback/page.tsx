'use client';

import { ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text13Regular, TextTitle2 } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { RouteUrls } from '@/utils/route-urls';
import { Alert, Container, Group, Loader, Stack } from '@mantine/core';
import { OAuthStatePayload } from '@spinner/shared-types';
import { CircleXIcon, InfoIcon } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

interface OAuthCallbackState {
  status: 'loading' | 'error' | 'denied';
  message?: string;
  connectorAccountId?: string;
}

/**
 * This is the page that we go back to during an OAuth authorization flow after the user has just gone out to the OAuth
 * authorization screen for a provider (e.g. Webflow). It reads the original host/port that the request came from in the
 * OAuth state param, then redirects back there to finish the flow.
 *
 * e.g. If this came from `localhost`, the OAuth flow will send the browser to `test.scratch.md`, which will then
 * redirect back to `localhost`.
 */
export default function OAuthCallbackPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [state, setState] = useState<OAuthCallbackState>({ status: 'loading' });
  const hasExecuted = useRef(false);

  useEffect(() => {
    // Prevent multiple executions
    if (hasExecuted.current) {
      return;
    }
    hasExecuted.current = true;

    const handleOAuthCallback = async () => {
      try {
        // Extract OAuth parameters from URL
        const code = searchParams.get('code');
        const oAuthStateString = searchParams.get('state');
        const error = searchParams.get('error');

        // If there's no state param at all, we can't redirect properly
        if (!oAuthStateString) {
          setState({
            status: 'error',
            message: 'Missing required OAuth state parameter',
          });
          return;
        }

        const oAuthState = decodeOAuthStatePayload(oAuthStateString);
        if (!oAuthState) {
          setState({
            status: 'error',
            message: 'Error parsing required OAuth param (state)',
          });
          return;
        }

        if (error) {
          // Check if user cancelled/denied the OAuth authorization
          const isDeniedError = error === 'access_denied' || error === 'user_cancelled_login';

          setState({
            status: isDeniedError ? 'denied' : 'error',
            message: isDeniedError ? undefined : error,
          });
          return;
        }

        // Validate code is present for successful OAuth
        if (!code) {
          setState({
            status: 'error',
            message: 'Missing required OAuth authorization code',
          });
          return;
        }

        // Desktop deep-link flow: redirect OAuth result back to desktop app if they originated there.
        if (oAuthState.returnPage?.startsWith('scratch://')) {
          const desktopUrl = new URL(oAuthState.returnPage);
          desktopUrl.searchParams.set('code', code);
          desktopUrl.searchParams.set('state', oAuthStateString);
          desktopUrl.searchParams.set('service', oAuthState.service);
          const realmId = searchParams.get('realmId');
          if (realmId) desktopUrl.searchParams.set('realmId', realmId);
          window.location.href = desktopUrl.toString();
        } else {
          // Otherwise send the result to the web client.
          window.location.href = `${oAuthState.redirectPrefix}/oauth/callback-step-2${window.location.search}`;
        }
      } catch (error) {
        console.error('OAuth callback error:', error);
        const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';
        setState({
          status: 'error',
          message: errorMessage,
        });
      }
    };

    handleOAuthCallback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const decodeOAuthStatePayload = (oAuthStateString: string): OAuthStatePayload | null => {
    try {
      if (!oAuthStateString) return null;

      // Decode the base64 state parameter.
      return (JSON.parse(Buffer.from(oAuthStateString, 'base64').toString()) as OAuthStatePayload) || null;
    } catch {
      return null;
    }
  };

  return (
    <Container size="sm" py="xl">
      <Stack align="center" gap="lg">
        {state.status === 'loading' && (
          <>
            <Loader size="lg" />
            <TextTitle2>Connecting your account...</TextTitle2>
            <Text13Regular c="dimmed" ta="center">
              Please wait while we complete the OAuth connection.
            </Text13Regular>
          </>
        )}

        {state.status === 'error' && (
          <>
            <StyledLucideIcon Icon={CircleXIcon} size={64} c="var(--mantine-color-red-6)" />
            <TextTitle2 c="red">Connection Failed</TextTitle2>
            <Alert color="red" title="Error">
              {state.message}
            </Alert>
            <Text13Regular c="dimmed" ta="center">
              You can try again or contact support if the problem persists.
            </Text13Regular>
            <Group gap="sm" mt="md">
              <ButtonSecondaryOutline onClick={() => router.push(RouteUrls.homePageUrl)}>
                Back to Home
              </ButtonSecondaryOutline>
            </Group>
          </>
        )}
        {state.status === 'denied' && (
          <>
            <StyledLucideIcon Icon={InfoIcon} size={64} c="var(--mantine-color-gray-6)" />
            <TextTitle2>Connection Cancelled</TextTitle2>
            <Alert color="gray">
              You cancelled the process of creating a new connection. If this was unintended, please go back to your
              workbook and create a new connection.
            </Alert>
            <Group gap="sm" mt="md">
              <ButtonSecondaryOutline onClick={() => router.push(RouteUrls.homePageUrl)}>
                Back to Home
              </ButtonSecondaryOutline>
            </Group>
          </>
        )}
      </Stack>
    </Container>
  );
}
