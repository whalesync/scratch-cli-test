import { Box, Code, Loader, Paper, Stack } from '@mantine/core';
import logoColor from '../assets/logo-color.svg';
import { ButtonPrimaryLight, ButtonSecondaryGhost } from '../components/base/buttons';
import { Text13Regular, TextTitle3 } from '../components/base/text';
import { useAuth } from '../providers/AuthProvider';

export function LoginPage() {
  const { login, cancelLogin, authFlow } = useAuth();

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
      <Paper p="xl" radius="md" w={420} withBorder={false}>
        <Stack gap="lg" align="center">
          <img src={logoColor} alt="Scratch" width={64} height={64} />
          <TextTitle3>Log in to Scratch</TextTitle3>

          {!authFlow.active && !authFlow.error && (
            <>
              <Text13Regular c="dimmed" ta="center">
                Authenticate by logging in through your browser.
              </Text13Regular>
              <ButtonPrimaryLight onClick={() => void login()} fullWidth>
                Log in with Scratch
              </ButtonPrimaryLight>
            </>
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
            <>
              <Text13Regular c="red" ta="center">
                {authFlow.error}
              </Text13Regular>
              <ButtonPrimaryLight onClick={() => void login()} fullWidth>
                Try again
              </ButtonPrimaryLight>
            </>
          )}
        </Stack>
      </Paper>
    </Box>
  );
}
