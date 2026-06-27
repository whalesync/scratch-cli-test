// Faithful reproduction of the desktop app's Login screen — centered logo + title + the log-in /
// create-account actions. Self-contained; no IPC. From the real LoginPage source (DEV-10592).
import { Box, Stack } from '@mantine/core';
import { ButtonPrimaryLight, ButtonSecondaryOutline } from '../../buttons';
import { TextTitle1 } from '../../text';

export function LoginPage() {
  return (
    <Box
      style={{
        width: 900,
        height: 660,
        background: 'var(--bg-base)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '0.5px solid var(--fg-divider)',
      }}
    >
      <Stack gap={24} align="center" style={{ width: 340 }}>
        <Box
          style={{
            width: 80,
            height: 80,
            borderRadius: 18,
            background: '#9BF9EB',
            boxShadow: '0 4px 16px rgba(11,107,79,.12)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Box
            style={{
              fontFamily: 'var(--mantine-font-family-headings)',
              fontWeight: 700,
              fontSize: 34,
              color: '#0B6B4F',
            }}
          >
            S
          </Box>
        </Box>
        <TextTitle1>Scratch</TextTitle1>
        <Stack gap={10} style={{ width: '100%' }}>
          <ButtonPrimaryLight fullWidth>Log in</ButtonPrimaryLight>
          <ButtonSecondaryOutline fullWidth>Create an account</ButtonSecondaryOutline>
        </Stack>
      </Stack>
    </Box>
  );
}
