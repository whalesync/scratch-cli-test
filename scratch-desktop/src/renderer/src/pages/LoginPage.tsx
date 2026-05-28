import { Box, Code, Loader, Stack } from '@mantine/core';
import logoColor from '../assets/logo-color.svg';
import { ButtonPrimaryLight, ButtonSecondaryGhost, ButtonSecondaryOutline } from '../components/base/buttons';
import { Text13Regular, TextTitle1 } from '../components/base/text';
import { ServerConnectionSplash } from '../components/ServerConnectionSplash';
import { useAuth } from '../providers/AuthProvider';

export function LoginPage() {
  const { login, cancelLogin, authFlow } = useAuth();

  if (authFlow.connectionUnavailable) {
    return <ServerConnectionSplash />;
  }

  return (
    <Box
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100vh',
        padding: 20,
      }}
    >
      <Stack gap="lg" align="center" maw={340} w="100%">
        <Box
          style={{
            width: 80,
            height: 80,
            borderRadius: 18,
            backgroundColor: '#9BF9EB',
            backgroundImage: `url(${logoColor})`,
            backgroundSize: 64,
            backgroundRepeat: 'no-repeat',
            backgroundPosition: 'center',
            boxShadow: '0 4px 16px rgba(11,107,79,.12)',
          }}
        />

        <TextTitle1>Scratch</TextTitle1>

        {!authFlow.active && !authFlow.error && (
          <Stack gap="sm" w="100%">
            <ButtonPrimaryLight fullWidth onClick={() => void login()}>
              Log in
            </ButtonPrimaryLight>
            <ButtonSecondaryOutline fullWidth onClick={() => void login({ signUp: true })}>
              Create an account
            </ButtonSecondaryOutline>
          </Stack>
        )}

        {authFlow.active && authFlow.userCode && (
          <>
            <Text13Regular c="dimmed" ta="center">
              Enter this code in the browser window that just opened:
            </Text13Regular>
            <Code
              block
              style={{
                fontSize: 28,
                letterSpacing: 4,
                textAlign: 'center',
                padding: '16px 24px',
                width: '100%',
              }}
            >
              {authFlow.userCode}
            </Code>
            <Stack gap="xs" align="center">
              <Loader size="sm" />
              <Text13Regular c="dimmed">Waiting for authorization...</Text13Regular>
            </Stack>
            <ButtonSecondaryGhost onClick={cancelLogin}>Cancel</ButtonSecondaryGhost>
          </>
        )}

        {authFlow.active && !authFlow.userCode && !authFlow.error && <Loader size="md" />}

        {authFlow.error && (
          <Stack gap="sm" w="100%">
            <Text13Regular c="red" ta="center">
              {authFlow.error}
            </Text13Regular>
            <ButtonPrimaryLight onClick={() => void login()} fullWidth>
              Try again
            </ButtonPrimaryLight>
          </Stack>
        )}
      </Stack>
    </Box>
  );
}
