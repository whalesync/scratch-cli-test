// Faithful reproduction of the desktop app's Connections right-rail panel — the list of connected
// services and their synced folders. Self-contained example data; no IPC. Reproduced from the real
// component + a live screenshot (DEV-10592).
import { Box, Group, Stack } from '@mantine/core';
import { Folder, Plus, Settings2, Trash2, Unplug } from 'lucide-react';
import { ButtonSecondaryOutline } from '../../buttons';
import { Text13Medium, Text13Regular, TextMono9Regular } from '../../text';
import { PanelShell } from './panel-shell';

const COLLECTIONS = ['Blog Posts (Demo)', 'Mackerels', 'Menu Items', 'Recipes', 'Assets'];

function SectionLabel({ label }: { label: string }) {
  return (
    <Box px={14} py={8} style={{ borderBottom: '0.5px solid var(--fg-divider)' }}>
      <TextMono9Regular c="var(--fg-muted)" tt="uppercase" style={{ letterSpacing: '0.06em' }}>
        {label}
      </TextMono9Regular>
    </Box>
  );
}

function FolderRow({ name }: { name: string }) {
  return (
    <Group
      gap={8}
      wrap="nowrap"
      justify="space-between"
      px={18}
      py={9}
      style={{ borderBottom: '0.5px solid var(--fg-divider)' }}
    >
      <Group gap={8} wrap="nowrap">
        <Folder size={14} color="var(--fg-secondary)" />
        <Text13Regular c="var(--fg-primary)">{name}</Text13Regular>
      </Group>
      <Settings2 size={14} color="var(--fg-muted)" />
    </Group>
  );
}

export function ConnectionsPanel() {
  return (
    <PanelShell
      icon={<Unplug size={16} color="var(--fg-secondary)" />}
      title="Connections"
      actions={
        <ButtonSecondaryOutline size="xs" leftSection={<Plus size={14} />}>
          Connect service
        </ButtonSecondaryOutline>
      }
    >
      <Box p={20} style={{ display: 'flex', justifyContent: 'center' }}>
        <Stack gap={14} style={{ width: 640, maxWidth: '100%' }}>
          {/* connection card */}
          <Box style={{ border: '1px solid var(--fg-divider)', borderRadius: 6, overflow: 'hidden' }}>
            <Group
              gap={10}
              wrap="nowrap"
              justify="space-between"
              px={14}
              py={11}
              style={{ borderBottom: '0.5px solid var(--fg-divider)' }}
            >
              <Group gap={10} wrap="nowrap">
                <Box
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 5,
                    background: '#146EF5',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text13Medium c="#fff">W</Text13Medium>
                </Box>
                <Text13Medium c="var(--fg-primary)">QA Webflow</Text13Medium>
                <Box style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--mantine-color-green-6)' }} />
              </Group>
              <Group gap={8} wrap="nowrap">
                <ButtonSecondaryOutline size="xs">Choose tables</ButtonSecondaryOutline>
                <ButtonSecondaryOutline size="xs">Edit settings</ButtonSecondaryOutline>
                <Trash2 size={15} color="var(--fg-muted)" />
              </Group>
            </Group>
            <SectionLabel label="Scratch General Test with E-Comm" />
            <SectionLabel label="Collections" />
            {COLLECTIONS.map((c) => (
              <FolderRow key={c} name={c} />
            ))}
          </Box>
          {/* scratch folders card */}
          <Group
            gap={10}
            wrap="nowrap"
            px={14}
            py={12}
            style={{ border: '1px solid var(--fg-divider)', borderRadius: 6 }}
          >
            <Folder size={15} color="var(--fg-secondary)" />
            <Text13Medium c="var(--fg-primary)">Scratch</Text13Medium>
            <Box style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--mantine-color-green-6)' }} />
          </Group>
        </Stack>
      </Box>
    </PanelShell>
  );
}
