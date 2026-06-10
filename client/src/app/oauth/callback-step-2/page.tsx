'use client';

import { ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { getServiceName, useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { RouteUrls } from '@/utils/route-urls';
import { Alert, Container, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { Service } from '@spinner/shared-types';
import { CircleCheckBigIcon, CircleXIcon } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

interface OAuthCallbackState {
  status: 'loading' | 'success' | 'error';
  message?: string;
  connectorAccountId?: string;
}

export default function OAuthCallbackPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [state, setState] = useState<OAuthCallbackState>({ status: 'loading' });
  const hasExecuted = useRef(false);
  const { metadata } = useConnectorsMetadata();

  useEffect(() => {
    // Wait for metadata to load before processing the callback
    if (!metadata) {
      return;
    }

    // Prevent multiple executions
    if (hasExecuted.current) {
      return;
    }
    hasExecuted.current = true;

    const handleOAuthCallback = async () => {
      try {
        // Extract OAuth parameters from URL
        const code = searchParams.get('code');
        const state = searchParams.get('state');
        const error = searchParams.get('error');
        const errorDescription = searchParams.get('error_description');

        // Handle OAuth error (user denied access, etc.)
        if (error) {
          setState({
            status: 'error',
            message: errorDescription || `OAuth error: ${error}`,
          });
          return;
        }

        // Validate required parameters
        if (!code || !state) {
          setState({
            status: 'error',
            message: 'Missing required OAuth parameters (code or state)',
          });
          return;
        }

        // Determine service from URL parameter or state parameter
        const serviceParam = searchParams.get('service');
        const serviceFromState = extractServiceFromState();

        console.debug('OAuth callback debug:', {
          serviceParam,
          serviceFromState,
          state,
        });

        const service = (serviceParam as Service) || serviceFromState;

        if (!service || !isValidOAuthService(service)) {
          setState({
            status: 'error',
            message: `Unable to determine OAuth service. Found: ${service || 'none'}. Check console for debug info.`,
          });
          return;
        }

        // QuickBooks includes realmId as a query parameter on the callback
        const realmId = searchParams.get('realmId') || undefined;
        const result = await scratchApiClient.oauth.callback(service, { code, state, realmId });

        setState({
          status: 'success',
          message: `Successfully connected to ${getServiceName(metadata, service)}!`,
          connectorAccountId: result.connectorAccountId,
        });

        // Redirect to returnPage (if specified) or workbooks page after a short delay
        const returnPage = extractReturnPageFromState();
        const redirectUrl = new URL(returnPage || RouteUrls.homePageUrl, window.location.origin);
        redirectUrl.searchParams.set('newConnectionId', result.connectorAccountId);
        setTimeout(() => {
          router.push(redirectUrl.pathname + redirectUrl.search);
        }, 1000);
      } catch (error) {
        console.error('OAuth callback error:', error);

        // Handle specific OAuth errors
        const errorMessage = error instanceof Error ? error.message : 'An unexpected error occurred';

        if (errorMessage.includes('invalid_grant') || errorMessage.includes('code has already been used')) {
          setState({
            status: 'error',
            message: 'This authorization code has already been used or has expired. Please try connecting again.',
          });
        } else {
          setState({
            status: 'error',
            message: errorMessage,
          });
        }
      }
    };

    handleOAuthCallback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metadata]);

  const extractServiceFromState = (): Service | null => {
    try {
      const state = searchParams.get('state');
      if (!state) return null;

      // Decode the base64 state parameter
      const decoded = atob(state);
      const parsed = JSON.parse(decoded) as Record<string, unknown>;

      // Extract service from the parsed state
      return (parsed.service as Service) || null;
    } catch {
      return null;
    }
  };

  const extractReturnPageFromState = (): string | null => {
    try {
      const state = searchParams.get('state');
      if (!state) return null;

      // Decode the base64 state parameter
      const decoded = atob(state);
      const parsed = JSON.parse(decoded) as Record<string, unknown>;

      // Extract returnPage from the parsed state
      return (parsed.returnPage as string) || null;
    } catch {
      return null;
    }
  };

  const isValidOAuthService = (service: string): service is Service => {
    return metadata ? metadata[service as Service]?.oauth !== undefined : false;
  };

  return (
    <Container size="sm" py="xl">
      <Stack align="center" gap="lg">
        {state.status === 'loading' && (
          <>
            <Loader size="lg" />
            <Title order={2}>Connecting your account...</Title>
            <Text c="dimmed" ta="center">
              Please wait while we complete the OAuth connection.
            </Text>
          </>
        )}
        {state.status === 'success' && (
          <>
            <CircleCheckBigIcon size={64} color="var(--mantine-color-green-6)" />
            <Title order={2} c="green">
              Connection Successful!
            </Title>
            <Text c="dimmed" ta="center">
              {state.message}
            </Text>
            <Text size="sm" c="dimmed" ta="center">
              Redirecting to connections page...
            </Text>
          </>
        )}

        {state.status === 'error' && (
          <>
            <CircleXIcon size={64} color="var(--mantine-color-red-6)" />
            <Title order={2} c="red">
              Connection Failed
            </Title>
            <Alert color="red" title="Error">
              {state.message}
            </Alert>
            <Text size="sm" c="dimmed" ta="center">
              You can try again or contact support if the problem persists.
            </Text>
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
