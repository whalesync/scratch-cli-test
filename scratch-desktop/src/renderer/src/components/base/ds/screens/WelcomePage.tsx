// Faithful reproduction of the desktop app's first-run Welcome screen — "Download a workspace" with
// the cloud workspaces available to pull down. Self-contained; no IPC. From the real WelcomePage +
// CloudWorkspaceCard source (DEV-10592).
import { Box, Group, Stack } from '@mantine/core';
import { Download } from 'lucide-react';
import { ButtonSecondaryOutline } from '../../buttons';
import { Text12Medium, Text12Regular, Text13Regular, TextTitle1, TextTitle4 } from '../../text';

const CLOUD = [
  { name: 'Marketing site', files: 248, services: ['#146EF5', '#FCB400'] },
  { name: 'Product CRM', files: 1320, services: ['#FF7A59'] },
];

export function WelcomePage() {
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
      <Stack gap={20} style={{ width: 460 }}>
        <Stack gap={8}>
          <Text12Medium c="var(--fg-muted)" tt="uppercase" style={{ letterSpacing: '0.08em' }}>
            One quick step
          </Text12Medium>
          <TextTitle1>Download a workspace</TextTitle1>
          <Text13Regular c="var(--fg-muted)">
            Scratch keeps your workspaces on your computer, powered by our servers. Pick one to download and start
            editing locally.
          </Text13Regular>
        </Stack>
        <Box
          style={{
            border: '1px dashed var(--fg-divider)',
            borderRadius: 10,
            background: '#fbfbf9',
            overflow: 'hidden',
          }}
        >
          {CLOUD.map((w, i) => (
            <Group
              key={w.name}
              justify="space-between"
              wrap="nowrap"
              px={14}
              py={10}
              style={{ borderTop: i > 0 ? '1px solid var(--fg-divider)' : 'none' }}
            >
              <Box style={{ minWidth: 0 }}>
                <TextTitle4 c="var(--fg-secondary)">{w.name}</TextTitle4>
                <Group gap={8} align="center" mt={6}>
                  <Group gap={6} style={{ opacity: 0.75 }}>
                    {w.services.map((s, j) => (
                      <Box key={j} style={{ width: 16, height: 16, borderRadius: 3, background: s }} />
                    ))}
                  </Group>
                  <Text12Regular c="var(--fg-muted)">{w.files.toLocaleString()} files</Text12Regular>
                </Group>
              </Box>
              <ButtonSecondaryOutline size="xs" leftSection={<Download size={14} />}>
                Download to…
              </ButtonSecondaryOutline>
            </Group>
          ))}
        </Box>
      </Stack>
    </Box>
  );
}
