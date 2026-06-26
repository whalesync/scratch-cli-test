// Faithful reproduction of the desktop app's Publish History right-rail panel — the log of publish
// plans/runs (empty state here, the common first-look). Self-contained; no IPC. From the real
// component + a live screenshot (DEV-10592).
import { Box, Group } from '@mantine/core';
import { ChevronDown, RefreshCw, ScrollText } from 'lucide-react';
import { ButtonSecondaryOutline } from '../../buttons';
import { Text13Regular, TextMono9Regular } from '../../text';
import { PanelShell } from './panel-shell';

const COLUMNS = ['Date', 'Status', 'Connection', 'Author', '', '', '', '', '', 'Actions'];
const COLUMN_TEMPLATE = '280px 110px 1fr 180px 36px 36px 36px 36px 36px 110px';

export function PublishHistoryPanel() {
  return (
    <PanelShell
      icon={<ScrollText size={16} color="var(--fg-secondary)" />}
      title="Publish History"
      actions={
        <Group gap={10} wrap="nowrap" align="center">
          <Group
            gap={6}
            wrap="nowrap"
            px={10}
            py={5}
            style={{
              border: '1px solid var(--fg-divider)',
              borderRadius: 4,
              width: 200,
              justifyContent: 'space-between',
            }}
          >
            <Text13Regular c="var(--fg-muted)">All connections</Text13Regular>
            <ChevronDown size={14} color="var(--fg-muted)" />
          </Group>
          <ButtonSecondaryOutline size="xs" leftSection={<RefreshCw size={14} />}>
            Refresh
          </ButtonSecondaryOutline>
        </Group>
      }
    >
      {/* table header */}
      <Box
        style={{ display: 'grid', gridTemplateColumns: COLUMN_TEMPLATE, borderBottom: '0.5px solid var(--fg-divider)' }}
      >
        {COLUMNS.map((c, i) => (
          <Box
            key={i}
            px={10}
            py={9}
            style={{
              borderRight: i < COLUMNS.length - 1 ? '0.5px solid var(--fg-divider)' : 'none',
              display: 'flex',
              justifyContent: i === COLUMNS.length - 1 ? 'flex-end' : 'flex-start',
            }}
          >
            <TextMono9Regular c="var(--fg-muted)" tt="uppercase" style={{ letterSpacing: '0.06em' }}>
              {c}
            </TextMono9Regular>
          </Box>
        ))}
      </Box>
      {/* empty state */}
      <Box style={{ padding: '64px 0', display: 'flex', justifyContent: 'center' }}>
        <Text13Regular c="var(--fg-muted)">No publish plans yet.</Text13Regular>
      </Box>
    </PanelShell>
  );
}
