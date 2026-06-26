// Faithful reproduction of the desktop app's Validation right-rail panel — the per-folder list of
// enforce_schema problems. Self-contained example data; no IPC. From the real component + a live
// screenshot (DEV-10592).
import { Box, Group, Stack, Switch } from '@mantine/core';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { ButtonSecondaryOutline } from '../../buttons';
import { Text12Regular, Text13Regular, TextMono9Regular } from '../../text';
import { PanelShell } from './panel-shell';

function Tab({ label, active }: { label: string; active?: boolean }) {
  return (
    <Box py={9} style={{ borderBottom: active ? '2px solid var(--highlight-border)' : '2px solid transparent' }}>
      <Text13Regular c={active ? 'var(--fg-primary)' : 'var(--fg-secondary)'} fw={active ? 600 : undefined}>
        {label}
      </Text13Regular>
    </Box>
  );
}

export function ValidationPanel() {
  return (
    <PanelShell
      icon={<ShieldCheck size={16} color="var(--fg-secondary)" />}
      title="Validation"
      actions={
        <Group gap={10} wrap="nowrap" align="center">
          <ButtonSecondaryOutline size="xs" leftSection={<RefreshCw size={14} />}>
            Rerun all
          </ButtonSecondaryOutline>
          <Switch checked readOnly label="On" size="md" />
        </Group>
      }
    >
      <Stack gap={0} style={{ height: '100%' }}>
        {/* tabs */}
        <Group gap={18} wrap="nowrap" px={14} style={{ borderBottom: '0.5px solid var(--fg-divider)' }}>
          <Tab label="Problems (8)" active />
          <Tab label="Rules" />
        </Group>
        {/* two-column body */}
        <Group gap={0} wrap="nowrap" align="stretch" style={{ flex: 1, minHeight: 0 }}>
          <Box p={12} style={{ width: 360, flexShrink: 0, borderRight: '1px solid var(--fg-divider)' }}>
            <Box px={8} pb={6}>
              <TextMono9Regular c="var(--fg-muted)" tt="uppercase" style={{ letterSpacing: '0.06em' }}>
                QA Webflow
              </TextMono9Regular>
            </Box>
            <Group gap={8} wrap="nowrap" px={8} py={5} style={{ borderRadius: 6, background: 'var(--highlight-fill)' }}>
              <Box
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: 'var(--mantine-color-red-6)',
                  flex: 'none',
                }}
              />
              <Text12Regular c="var(--highlight-text)" truncate>
                Scratch General Test with E-Comm/Collections/Blog Posts (Demo)
              </Text12Regular>
            </Group>
          </Box>
          <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Text13Regular c="var(--fg-muted)">Select a folder on the left to see its validation issues.</Text13Regular>
          </Box>
        </Group>
      </Stack>
    </PanelShell>
  );
}
