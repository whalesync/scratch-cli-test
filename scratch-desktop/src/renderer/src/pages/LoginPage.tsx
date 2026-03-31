import { Box, Button, Code, Loader, Paper, Stack, Text, Title } from '@mantine/core';
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
      <Paper shadow="sm" p="xl" radius="md" w={420}>
        <Stack gap="lg" align="center">
          <Title order={3}>Log in to Scratch</Title>

          {!authFlow.active && !authFlow.error && (
            <>
              <Text c="dimmed" ta="center" size="sm">
                Authenticate by logging in through your browser.
              </Text>
              <Button onClick={() => void login()} fullWidth size="md">
                Log in with Scratch
              </Button>
            </>
          )}

          {authFlow.active && authFlow.userCode && (
            <>
              <Text c="dimmed" ta="center" size="sm">
                Enter this code in the browser window that just opened:
              </Text>
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
                <Text size="sm" c="dimmed">
                  Waiting for authorization...
                </Text>
              </Stack>
              <Button variant="subtle" onClick={cancelLogin} size="sm">
                Cancel
              </Button>
            </>
          )}

          {authFlow.active && !authFlow.userCode && !authFlow.error && <Loader size="md" />}

          {authFlow.error && (
            <>
              <Text c="red" ta="center" size="sm">
                {authFlow.error}
              </Text>
              <Button onClick={() => void login()} fullWidth size="md">
                Try again
              </Button>
            </>
          )}
        </Stack>
      </Paper>
    </Box>
  );
}
