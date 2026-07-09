'use client';

/**
 * =============================================================================
 *   ⚠️  LEGACY OAuth landing page — this is NOT the active OAuth callback.  ⚠️
 * =============================================================================
 *
 * Since the migration to Whalesync-owned OAuth apps, the `redirect_uri` registered
 * with the OAuth provider for every current connector is Whalesync's connector
 * callback, NOT this page:
 *
 *     https://app.whalesync.com/oauth-callback/connector/<type>
 *     (dusky:  pages/oauth-callback/connector/[connectorType].tsx)
 *
 * THAT page holds the real routing: it decodes the OAuth `state`, runs
 * `deriveScratchOAuthDestination`, and forwards the result to the state's
 * `resultForwardUrl` (web → /oauth/callback-step-2, desktop → scratch://oauth-callback).
 *
 * This page (`/oauth/callback`) is the OLD, pre-migration `redirect_uri`. It is
 * reached ONLY by OAuth flows that still authorize against a legacy, Scratch-owned
 * OAuth app registered against this URL — no current connector uses it. It is kept
 * solely so those pre-migration flows keep working, and is slated for deletion once
 * every OAuth app is migrated to Whalesync-owned (OAuth cleanup: DEV-10734).
 *
 * ➜ DO NOT add or change routing logic here — the active equivalent is dusky's
 *   connector callback above. Anything you touch here affects legacy flows only.
 *   (The token exchange itself happens downstream at /oauth/callback-step-2.)
 * =============================================================================
 */

import { ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text13Regular, TextTitle2 } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { RouteUrls } from '@/utils/route-urls';
import { Alert, Container, Group, Loader, Stack } from '@mantine/core';
import { OAuthStatePayload } from '@spinner/shared-types';
import { CheckCircle2Icon, CircleXIcon, InfoIcon } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

interface OAuthCallbackState {
  status: 'loading' | 'error' | 'denied' | 'desktop-redirect';
  message?: string;
  connectorAccountId?: string;
  desktopUrl?: string;
}

/**
 * Returns true if the given OAuth `redirectPrefix` points at a Whalesync (dusky) origin that we're
 * willing to forward an OAuth result back to. Whalesync drives the Scratch OAuth endpoints directly
 * (e.g. from its CRM Mirror connect flow) and passes a query-free callback URL on its own origin as
 * the `redirectPrefix`; we forward `code`/`state` (and `realmId`/`error` where present) there the
 * same way we forward to the scratch desktop app.
 *
 * Pinned to exact `.whalesync.com` subdomains plus `localhost` (local dev) — this is not an open
 * redirect, the suffix check pins it to Whalesync. Mirrors the host check dusky uses for its own
 * connector OAuth callbacks (`dusky/pages/oauth-callback/connector/[connectorType].tsx`).
 */
const isWhalesyncRedirectPrefix = (redirectPrefix: string | undefined): boolean => {
  if (!redirectPrefix) return false;
  try {
    const url = new URL(redirectPrefix);
    return url.hostname.endsWith('.whalesync.com') || url.hostname === 'localhost';
  } catch {
    return false;
  }
};

/**
 * LEGACY — see the banner at the top of this file; the active routing lives in dusky's connector
 * callback, not here. This page is the pre-migration `redirect_uri`.
 *
 * This is the page that we go back to during an OAuth authorization flow after the user has just gone out to the OAuth
 * authorization screen for a provider (e.g. Webflow). It reads the original host/port that the request came from in the
 * OAuth state param, then redirects back there to finish the flow.
 *
 * e.g. If this came from `localhost`, the OAuth flow will send the browser to `test.scratch.md`, which will then
 * redirect back to `localhost`.
 */
function OAuthCallbackContent() {
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
        // Client-credentials (2-legged) providers like Wix return no `code` — their
        // external-install redirect hands back an install-scoped `instanceId` instead.
        const instanceId = searchParams.get('instanceId');
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
          // Whalesync (dusky) flow: forward the error back to its callback so it can surface the
          // failure in its own wizard, the same way we forward a successful result below.
          if (isWhalesyncRedirectPrefix(oAuthState.redirectPrefix)) {
            const whalesyncUrl = new URL(oAuthState.redirectPrefix);
            whalesyncUrl.searchParams.set('error', error);
            const errorDescription = searchParams.get('error_description');
            if (errorDescription) whalesyncUrl.searchParams.set('error_description', errorDescription);
            whalesyncUrl.searchParams.set('state', oAuthStateString);
            window.location.href = whalesyncUrl.toString();
            return;
          }

          // Check if user cancelled/denied the OAuth authorization.
          // Pipedrive sends `user_denied` when the user clicks Cancel on its consent screen.
          const isDeniedError =
            error === 'access_denied' || error === 'user_cancelled_login' || error === 'user_denied';

          setState({
            status: isDeniedError ? 'denied' : 'error',
            message: isDeniedError ? undefined : error,
          });
          return;
        }

        // Validate a success credential is present: an authorization `code` (classic
        // flow) or an `instanceId` (client-credentials install flow, e.g. Wix).
        if (!code && !instanceId) {
          setState({
            status: 'error',
            message: 'Missing required OAuth authorization code',
          });
          return;
        }

        // Desktop deep-link flow: redirect OAuth result back to desktop app if they originated there.
        if (oAuthState.returnPage?.startsWith('scratch://')) {
          const desktopUrl = new URL(oAuthState.returnPage);
          if (code) desktopUrl.searchParams.set('code', code);
          if (instanceId) desktopUrl.searchParams.set('instanceId', instanceId);
          desktopUrl.searchParams.set('state', oAuthStateString);
          desktopUrl.searchParams.set('service', oAuthState.service);
          const realmId = searchParams.get('realmId');
          if (realmId) desktopUrl.searchParams.set('realmId', realmId);
          const desktopUrlString = desktopUrl.toString();
          window.location.href = desktopUrlString;
          // The browser stays on this page after a custom protocol redirect,
          // so update state to show a confirmation instead of the loading spinner.
          setState({ status: 'desktop-redirect', desktopUrl: desktopUrlString });
          return;
        }

        // Whalesync (dusky) flow: the redirectPrefix is a full, query-free callback URL on a
        // Whalesync origin. Forward the OAuth result there directly, the same way we forward to the
        // desktop app above.
        if (isWhalesyncRedirectPrefix(oAuthState.redirectPrefix)) {
          const whalesyncUrl = new URL(oAuthState.redirectPrefix);
          if (code) whalesyncUrl.searchParams.set('code', code);
          if (instanceId) whalesyncUrl.searchParams.set('instanceId', instanceId);
          whalesyncUrl.searchParams.set('state', oAuthStateString);
          whalesyncUrl.searchParams.set('service', oAuthState.service);
          const realmId = searchParams.get('realmId');
          if (realmId) whalesyncUrl.searchParams.set('realmId', realmId);
          window.location.href = whalesyncUrl.toString();
          return;
        }

        // Otherwise send the result to the web client.
        window.location.href = `${oAuthState.redirectPrefix}/oauth/callback-step-2${window.location.search}`;
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
        {state.status === 'desktop-redirect' && (
          <>
            <StyledLucideIcon Icon={CheckCircle2Icon} size={64} c="var(--mantine-color-green-6)" />
            <TextTitle2>Opening in Scratch desktop...</TextTitle2>
            <Text13Regular c="dimmed" ta="center">
              The connection was successful. You can close this tab.
            </Text13Regular>
            <Group gap="sm" mt="md">
              <ButtonSecondaryOutline
                onClick={() => {
                  if (state.desktopUrl) window.location.href = state.desktopUrl;
                }}
              >
                Open again
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

/**
 * `OAuthCallbackContent` reads the OAuth result from the URL via `useSearchParams()`, which forces a
 * client-side render. Next.js requires such a component to sit under a Suspense boundary, otherwise
 * the whole page bails out of static prerendering and the build fails. The fallback mirrors the
 * inner "loading" state so there's no visual flash before the redirect runs.
 */
export default function OAuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <Container size="sm" py="xl">
          <Stack align="center" gap="lg">
            <Loader size="lg" />
            <TextTitle2>Connecting your account...</TextTitle2>
            <Text13Regular c="dimmed" ta="center">
              Please wait while we complete the OAuth connection.
            </Text13Regular>
          </Stack>
        </Container>
      }
    >
      <OAuthCallbackContent />
    </Suspense>
  );
}
