import { ButtonPrimaryLight } from '@/components/base/buttons';
import { Text13Regular } from '@/components/base/text';
import { scratchApiClient } from '@/lib/scratch-api-client';
import { Alert, Center, Loader, Stack } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

interface OAuthCallbackState {
  status: 'loading' | 'success' | 'error';
  message?: string;
  workbookId?: string;
  connectorAccountId?: string;
}

export function OAuthCallbackPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [state, setState] = useState<OAuthCallbackState>({ status: 'loading' });
  const hasExecuted = useRef(false);

  useEffect(() => {
    if (hasExecuted.current) return;
    hasExecuted.current = true;

    const handleCallback = async () => {
      try {
        const code = searchParams.get('code');
        // Client-credentials (2-legged) providers like Wix return no `code` — their
        // external-install redirect hands back an install-scoped `instanceId` instead.
        const instanceId = searchParams.get('instanceId');
        const stateParam = searchParams.get('state');
        const service = searchParams.get('service');
        const realmId = searchParams.get('realmId') ?? undefined;
        const errorParam = searchParams.get('error');
        const errorDescription = searchParams.get('error_description');

        if (errorParam) {
          setState({
            status: 'error',
            message: errorDescription || errorParam,
          });
          return;
        }

        if ((!code && !instanceId) || !stateParam) {
          setState({
            status: 'error',
            message: 'Missing required OAuth parameters (code/instanceId or state)',
          });
          return;
        }

        // Decode state to extract service (fallback) and workbookId
        let decodedService = service ?? '';
        let workbookId = '';
        try {
          const decoded = JSON.parse(atob(stateParam)) as { service?: string; workbookId?: string };
          if (!decodedService && decoded.service) {
            decodedService = decoded.service;
          }
          workbookId = decoded.workbookId ?? '';
        } catch {
          // If state can't be decoded, use the service param from the URL
        }

        if (!decodedService) {
          setState({
            status: 'error',
            message: 'Could not determine OAuth service',
          });
          return;
        }

        const result = await scratchApiClient.oauth.callback(decodedService, {
          code: code ?? '',
          state: stateParam,
          realmId,
          instanceId: instanceId ?? undefined,
        });

        setState({
          status: 'success',
          workbookId,
          connectorAccountId: result.connectorAccountId,
        });

        // Navigate to workspace with openConnections flag
        const params = new URLSearchParams();
        params.set('openConnections', 'true');
        if (result.connectorAccountId) {
          params.set('newConnectionId', result.connectorAccountId);
        }
        void navigate(`/workspace/${workbookId}?${params.toString()}`, { replace: true });
      } catch (error) {
        console.debug('[oauth-callback] error:', error);
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'OAuth callback failed',
        });
      }
    };

    void handleCallback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.status === 'loading') {
    return (
      <Center h="100vh">
        <Stack align="center" gap="md">
          <Loader size="md" />
          <Text13Regular c="dimmed">Completing connection...</Text13Regular>
        </Stack>
      </Center>
    );
  }

  if (state.status === 'error') {
    return (
      <Center h="100vh">
        <Stack align="center" gap="md" maw={400}>
          <Alert color="red" title="Connection failed">
            {state.message}
          </Alert>
          <ButtonPrimaryLight
            onClick={() => {
              if (state.workbookId) {
                void navigate(`/workspace/${state.workbookId}`);
              } else {
                void navigate('/');
              }
            }}
          >
            Back to workspace
          </ButtonPrimaryLight>
        </Stack>
      </Center>
    );
  }

  // Success state navigates away; show loader as fallback
  return (
    <Center h="100vh">
      <Loader size="sm" />
    </Center>
  );
}
