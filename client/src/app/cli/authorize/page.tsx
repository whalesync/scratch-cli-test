'use client';

import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text13Book, Text13Regular, TextTitle2 } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { LoaderWithMessage } from '@/app/components/LoaderWithMessage';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { Alert, Container, PinInput, Stack } from '@mantine/core';
import { CheckCircleIcon, CircleXIcon, TerminalIcon } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';

type AuthState = 'input' | 'loading' | 'success' | 'error';

/**
 * CLI Authorization Page
 *
 * This page allows users to authorize the Scratch CLI by entering the verification code
 * displayed in their terminal. Works similar to gcloud auth login.
 *
 * Flow:
 * 1. User runs `scratchmd auth login` in terminal
 * 2. CLI displays a code (e.g., "ABCD-1234") and opens this page with ?code=XXXX-XXXX
 * 3. User reviews the code and clicks the Authorize button
 * 4. If valid, CLI receives an API token to use for future requests
 */
// Format code as XXXX-XXXX (the format stored in the database)
function formatCodeWithDash(code: string): string {
  const cleanCode = code.replace(/-/g, '').toUpperCase();
  if (cleanCode.length === 8) {
    return `${cleanCode.slice(0, 4)}-${cleanCode.slice(4)}`;
  }
  return cleanCode;
}

export default function CliAuthorizePage() {
  const searchParams = useSearchParams();
  const { user } = useScratchPadUser();
  // URL code comes with dash (e.g., "ABCD-1234"), store without dash for PinInput display
  const urlCode = searchParams.get('code') || '';
  const initialCodeForInput = urlCode.replace(/-/g, '');
  const clientType = searchParams.get('client');
  const appName = clientType === 'desktop' ? 'Desktop' : 'CLI';

  const [state, setState] = useState<AuthState>('input');
  const [code, setCode] = useState(initialCodeForInput);
  const [errorMessage, setErrorMessage] = useState<string>('');

  const handleSubmit = useCallback(async () => {
    // Format code with dash before sending to server
    const formattedCode = formatCodeWithDash(code);
    if (!formattedCode || formattedCode.length < 9) {
      // 9 = 8 chars + 1 dash
      setErrorMessage('Please enter the complete authorization code');
      return;
    }

    setState('loading');
    setErrorMessage('');

    try {
      const result = await scratchApiClient.cliAuth.verifyCliDeviceAuth(formattedCode);

      if (result.success) {
        setState('success');
      } else {
        setState('error');
        setErrorMessage(result.error || 'Failed to verify authorization code');
      }
    } catch (error) {
      setState('error');
      setErrorMessage(error instanceof Error ? error.message : 'An unexpected error occurred');
    }
  }, [code]);

  return (
    <Container size="sm" py="xl">
      <Stack align="center" gap="lg">
        <StyledLucideIcon Icon={TerminalIcon} size={48} c="var(--mantine-color-green-6)" />
        <TextTitle2>Authorize Scratch {appName}</TextTitle2>

        {state === 'input' && (
          <>
            <Text13Regular c="dimmed" ta="center" maw={400}>
              Enter the authorization code displayed in your {clientType === 'desktop' ? 'desktop app' : 'terminal'} to
              connect the Scratch {appName} to your {user?.email} account.
            </Text13Regular>

            <Stack gap="md" align="center" mt="md">
              <Text13Book c="dimmed">Authorization Code</Text13Book>
              <PinInput
                length={8}
                type="alphanumeric"
                size="lg"
                value={code}
                onChange={setCode}
                onPaste={(event) => {
                  event.preventDefault();
                  const pastedText = event.clipboardData.getData('text');
                  // Remove dashes, spaces, and other non-alphanumeric characters
                  const cleanedCode = pastedText
                    .replace(/[^A-Za-z0-9]/g, '')
                    .toUpperCase()
                    .slice(0, 8);
                  setCode(cleanedCode);
                }}
                placeholder=""
                styles={{
                  input: {
                    textTransform: 'uppercase',
                    fontFamily: 'monospace',
                    fontSize: '1.25rem',
                  },
                }}
              />
              <Text13Book c="dimmed" size="xs">
                The code looks like: ABCD-1234 (enter without the dash)
              </Text13Book>
            </Stack>

            {errorMessage && (
              <Alert color="red" title="Error" mt="md">
                {errorMessage}
              </Alert>
            )}

            <ButtonPrimaryLight onClick={handleSubmit} mt="lg" disabled={code.length < 8}>
              Authorize {appName}
            </ButtonPrimaryLight>
          </>
        )}

        {state === 'loading' && <LoaderWithMessage message="Verifying authorization code..." />}

        {state === 'success' && (
          <>
            <StyledLucideIcon Icon={CheckCircleIcon} size={64} c="var(--mantine-color-green-6)" />
            <TextTitle2 c="green">{appName} Authorized</TextTitle2>
            <Alert color="green" title="Success" maw={400}>
              Your Scratch {appName} has been authorized. You can now close this window and return to your{' '}
              {clientType === 'desktop' ? 'desktop app' : 'terminal'}.
            </Alert>
            <Text13Regular c="dimmed" ta="center" maw={400} mt="md">
              The CLI is now connected to your account and can now used advanced Scratch.md features.
            </Text13Regular>
          </>
        )}

        {state === 'error' && (
          <>
            <StyledLucideIcon Icon={CircleXIcon} size={64} c="var(--mantine-color-red-6)" />
            <TextTitle2 c="red">Authorization Failed</TextTitle2>
            <Alert color="red" title="Error">
              {errorMessage}
            </Alert>
            <Text13Regular c="dimmed" ta="center" mt="md">
              Make sure you entered the correct code from your {clientType === 'desktop' ? 'desktop app' : 'terminal'}.
            </Text13Regular>
            <ButtonSecondaryOutline
              onClick={() => {
                setState('input');
                setCode('');
                setErrorMessage('');
              }}
              mt="lg"
            >
              Try Again
            </ButtonSecondaryOutline>
          </>
        )}
      </Stack>
    </Container>
  );
}
