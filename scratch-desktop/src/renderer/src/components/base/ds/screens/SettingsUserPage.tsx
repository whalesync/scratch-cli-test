// Faithful reproduction of the desktop app's User settings page — account info + sign out, inside the
// settings shell. Self-contained; no IPC. From the real UserSettingsPage source (DEV-10592).
import { Box, Group, Stack } from '@mantine/core';
import { LogOut, User } from 'lucide-react';
import type { ReactNode } from 'react';
import { ButtonSecondaryOutline } from '../../buttons';
import { Text12Regular, Text13Medium, Text13Regular, TextMono13Regular, TextTitle4 } from '../../text';
import { SettingsShell } from './settings-shell';

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Group justify="space-between" align="center" py={12} style={{ borderBottom: '0.5px solid var(--fg-divider)' }}>
      <Text13Medium c="var(--fg-secondary)">{label}</Text13Medium>
      {children}
    </Group>
  );
}

export function SettingsUserPage() {
  return (
    <SettingsShell active="User" pageIcon={User} pageTitle="User">
      <Stack gap={20} style={{ maxWidth: 800 }}>
        <Box>
          <TextTitle4>Account</TextTitle4>
          <Text12Regular c="var(--fg-muted)" style={{ marginTop: 2, marginBottom: 8 }}>
            Your Scratch account
          </Text12Regular>
          <Box>
            <InfoRow label="Email">
              <Text13Regular c="var(--fg-primary)">testing@whalesync.com</Text13Regular>
            </InfoRow>
            <InfoRow label="User ID">
              <TextMono13Regular c="var(--fg-secondary)">usr_a1b2c3d4e5</TextMono13Regular>
            </InfoRow>
          </Box>
        </Box>
        <Group>
          <ButtonSecondaryOutline leftSection={<LogOut size={16} />}>Sign out</ButtonSecondaryOutline>
        </Group>
      </Stack>
    </SettingsShell>
  );
}
