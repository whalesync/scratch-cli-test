// Faithful reproduction of the desktop app's Workspace Settings right-rail panel — automatic-update
// toggle + workspace permissions. Self-contained; no IPC. From the real component + a live
// screenshot (DEV-10592).
import { Box, Group, Stack, Switch, TextInput } from '@mantine/core';
import { Settings, UserRoundX } from 'lucide-react';
import { ButtonPrimarySolid } from '../../buttons';
import { Text13Regular, TextMono12Regular, TextMono9Regular, TextTitle4 } from '../../text';
import { PanelShell } from './panel-shell';

const PERMISSIONS = [{ name: 'Scratch Testing', email: 'testing@whalesync.com', role: 'editor' }];
const PERM_TEMPLATE = '1fr 280px 120px 60px';

export function SettingsPanel() {
  return (
    <PanelShell icon={<Settings size={16} color="var(--fg-secondary)" />} title="Workspace Settings">
      <Stack gap={32} p={16}>
        {/* Automatic updates */}
        <Stack gap={12}>
          <TextTitle4>Automatic updates</TextTitle4>
          <Group align="flex-start" justify="space-between" gap={16} wrap="nowrap">
            <Text13Regular c="var(--fg-muted)" style={{ flex: 1 }}>
              Automatically download the latest data from Scratch once an hour (and when you open the app), so your
              local files are up to date when you sit down. Your local edits are preserved.
            </Text13Regular>
            <Switch checked readOnly label="On" size="md" />
          </Group>
        </Stack>

        {/* Permissions */}
        <Stack gap={12}>
          <TextTitle4>Permissions</TextTitle4>
          <Group align="flex-start" gap={12} wrap="nowrap">
            <TextInput placeholder="user@example.com" style={{ flex: 1 }} />
            <ButtonPrimarySolid>Add User</ButtonPrimarySolid>
          </Group>
          {/* table */}
          <Box>
            <Box
              style={{
                display: 'grid',
                gridTemplateColumns: PERM_TEMPLATE,
                borderBottom: '0.5px solid var(--fg-divider)',
              }}
            >
              {['Name', 'Email', 'Role', ''].map((h, i) => (
                <Box key={i} py={8}>
                  <TextMono9Regular c="var(--fg-muted)" tt="uppercase" style={{ letterSpacing: '0.06em' }}>
                    {h}
                  </TextMono9Regular>
                </Box>
              ))}
            </Box>
            {PERMISSIONS.map((p) => (
              <Box
                key={p.email}
                style={{
                  display: 'grid',
                  gridTemplateColumns: PERM_TEMPLATE,
                  alignItems: 'center',
                  borderBottom: '0.5px solid var(--fg-divider)',
                }}
              >
                <Box py={10}>
                  <Text13Regular c="var(--fg-primary)">{p.name}</Text13Regular>
                </Box>
                <Box py={10}>
                  <TextMono12Regular c="var(--fg-secondary)">{p.email}</TextMono12Regular>
                </Box>
                <Box py={10}>
                  <Text13Regular c="var(--fg-secondary)">{p.role}</Text13Regular>
                </Box>
                <Box py={10} style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <UserRoundX size={15} color="var(--mantine-color-red-6)" />
                </Box>
              </Box>
            ))}
          </Box>
        </Stack>
      </Stack>
    </PanelShell>
  );
}
