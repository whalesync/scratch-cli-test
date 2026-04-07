import { Box, Paper, Stack } from '@mantine/core';
import { CloudOff } from 'lucide-react';
import logoColor from '../assets/logo-color.svg';
import { ButtonPrimaryLight, ButtonSecondaryOutline } from './base/buttons';
import { Text13Regular, TextTitle3 } from './base/text';
import { StyledLucideIcon } from './icons/StyledLucideIcon';

const SCRATCH_STATUS_URL = 'https://status.scratch.md';

export function ServerConnectionSplash() {
  const handleReload = (): void => {
    window.location.reload();
  };

  const handleOpenStatus = (): void => {
    void window.scratchAuth.openExternal(SCRATCH_STATUS_URL);
  };

  return (
    <Box
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100vh',
        padding: 20,
        backgroundColor: 'var(--bg-base)',
      }}
    >
      <Paper p="xl" radius="md" maw={440} w="100%" withBorder={false}>
        <Stack gap="lg" align="center">
          <img src={logoColor} alt="Scratch" width={64} height={64} />
          <StyledLucideIcon Icon={CloudOff} size="lg" c="dimmed" />
          <TextTitle3 ta="center">Can&apos;t reach Scratch</TextTitle3>
          <Text13Regular c="dimmed" ta="center">
            We couldn&apos;t connect to the Scratch servers. Check your network connection, or see whether Scratch is
            experiencing an outage.
          </Text13Regular>
          <Stack gap="sm" w="100%">
            <ButtonPrimaryLight onClick={handleReload} fullWidth>
              Reload
            </ButtonPrimaryLight>
            <ButtonSecondaryOutline onClick={handleOpenStatus} fullWidth>
              Scratch status
            </ButtonSecondaryOutline>
          </Stack>
        </Stack>
      </Paper>
    </Box>
  );
}
