'use client';

import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text13Regular, TextTitle2 } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { LoaderWithMessage } from '@/app/components/LoaderWithMessage';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { approveMcpAuthorization } from '@/lib/api/mcp-auth';
import { Alert, Container, Stack } from '@mantine/core';
import { CheckCircleIcon, CircleXIcon, ShieldCheckIcon } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';

type ConsentState = 'consent' | 'loading' | 'success' | 'error';

interface DecodedState {
  client_id: string;
  redirect_uri: string;
  scope?: string;
}

/**
 * MCP OAuth Consent Page
 *
 * This page is shown when Claude requests access to a user's Scratch workbooks via MCP.
 * The OAuth authorize endpoint redirects here with encoded state containing the OAuth params.
 *
 * Flow:
 * 1. Claude initiates MCP connection, triggers OAuth flow
 * 2. Server encodes OAuth params into base64url state and redirects here
 * 3. User reviews scopes and clicks "Authorize"
 * 4. Client calls POST /mcp-auth/approve with Clerk JWT + state
 * 5. Server generates auth code and returns redirect URI back to Claude
 */
export default function McpAuthorizePage() {
  const searchParams = useSearchParams();
  const { user } = useScratchPadUser();
  const stateParam = searchParams.get('state') || '';

  const [consentState, setConsentState] = useState<ConsentState>('consent');
  const [errorMessage, setErrorMessage] = useState('');

  const decoded = useMemo<DecodedState | null>(() => {
    if (!stateParam) return null;
    try {
      return JSON.parse(atob(stateParam.replace(/-/g, '+').replace(/_/g, '/')));
    } catch {
      return null;
    }
  }, [stateParam]);

  const scopes = useMemo(() => {
    if (!decoded?.scope) return ['read:workbooks', 'read:files'];
    return decoded.scope.split(' ');
  }, [decoded]);

  const handleAuthorize = useCallback(async () => {
    if (!stateParam) return;

    setConsentState('loading');
    setErrorMessage('');

    try {
      const result = await approveMcpAuthorization(stateParam);
      setConsentState('success');

      // Redirect back to Claude with the authorization code
      window.location.href = result.redirect_uri;
    } catch (error) {
      setConsentState('error');
      setErrorMessage(error instanceof Error ? error.message : 'Failed to authorize');
    }
  }, [stateParam]);

  if (!stateParam || !decoded) {
    return (
      <Container size="sm" py="xl">
        <Stack align="center" gap="lg">
          <StyledLucideIcon Icon={CircleXIcon} size={48} c="var(--mantine-color-red-6)" />
          <TextTitle2>Invalid Authorization Request</TextTitle2>
          <Text13Regular c="dimmed" ta="center" maw={400}>
            This page requires a valid authorization state parameter. Please start the connection from Claude.
          </Text13Regular>
        </Stack>
      </Container>
    );
  }

  return (
    <Container size="sm" py="xl">
      <Stack align="center" gap="lg">
        <StyledLucideIcon Icon={ShieldCheckIcon} size={48} c="var(--mantine-color-green-6)" />
        <TextTitle2>Authorize Claude</TextTitle2>

        {consentState === 'consent' && (
          <>
            <Text13Regular c="dimmed" ta="center" maw={400}>
              Claude is requesting access to your Scratch workbooks. This will allow Claude to read your workbook data
              during conversations.
            </Text13Regular>

            <Stack gap="xs" mt="md" maw={400} w="100%">
              <Text13Regular fw={600}>Permissions requested:</Text13Regular>
              {scopes.map((scope) => (
                <Text13Regular key={scope} c="dimmed" ml="md">
                  • {formatScope(scope)}
                </Text13Regular>
              ))}
            </Stack>

            <Text13Regular c="dimmed" ta="center" maw={400} mt="sm">
              Signed in as <strong>{user?.email}</strong>
            </Text13Regular>

            <Stack gap="sm" mt="lg">
              <ButtonPrimaryLight onClick={handleAuthorize}>Authorize</ButtonPrimaryLight>
              <ButtonSecondaryOutline onClick={() => window.close()}>Cancel</ButtonSecondaryOutline>
            </Stack>
          </>
        )}

        {consentState === 'loading' && <LoaderWithMessage message="Authorizing..." />}

        {consentState === 'success' && (
          <>
            <StyledLucideIcon Icon={CheckCircleIcon} size={64} c="var(--mantine-color-green-6)" />
            <Alert color="green" title="Authorized" maw={400}>
              Claude has been authorized. You will be redirected back shortly.
            </Alert>
          </>
        )}

        {consentState === 'error' && (
          <>
            <StyledLucideIcon Icon={CircleXIcon} size={64} c="var(--mantine-color-red-6)" />
            <TextTitle2 c="red">Authorization Failed</TextTitle2>
            <Alert color="red" title="Error">
              {errorMessage}
            </Alert>
            <ButtonSecondaryOutline onClick={() => setConsentState('consent')} mt="lg">
              Try Again
            </ButtonSecondaryOutline>
          </>
        )}
      </Stack>
    </Container>
  );
}

function formatScope(scope: string): string {
  switch (scope) {
    case 'read:workbooks':
      return 'View your workbooks and folders';
    case 'read:files':
      return 'Read record files in your workbooks';
    case 'write:files':
      return 'Create and modify record files';
    default:
      return scope;
  }
}
