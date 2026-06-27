// Faithful reproduction of the desktop app's Publish modal — the publishing stage: per-connection
// progress with a bar, success/failed counts, and the operation table (planned vs done).
// Self-contained; no IPC. From the real PublishChangesModal / ConnectionPublishRow (DEV-10592).
import { Box, Group, Progress, Stack, Table } from '@mantine/core';
import { Text12Medium, Text12Regular, Text13Medium, TextMono12Regular } from '../../text';
import { ModalShell } from './modal-shell';

function StatusBadge({ label, color }: { label: string; color: string }) {
  return (
    <Box style={{ padding: '2px 9px', borderRadius: 4, background: color, display: 'inline-flex' }}>
      <TextMono12Regular c="#fff">{label}</TextMono12Regular>
    </Box>
  );
}

const OPERATIONS = [
  { label: 'Update existing records', planned: 5, done: 5, state: 'done' as const },
  { label: 'Create new records', planned: 2, done: 1, state: 'active' as const },
  { label: 'Delete records', planned: 0, done: 0, state: 'idle' as const },
];

function ConnectionPublishRow() {
  return (
    <Box>
      <Group justify="space-between" align="center" mb={4} wrap="nowrap">
        <Group gap={8} wrap="nowrap" align="baseline">
          <Text13Medium c="var(--fg-primary)">QA Webflow</Text13Medium>
          <Text12Regular c="var(--fg-muted)">Blog Posts (Demo)</Text12Regular>
        </Group>
        <StatusBadge label="6 / 8" color="var(--mantine-color-blue-6)" />
      </Group>
      <Progress value={75} size="sm" animated mb={10} />
      <Group gap={8} mb={10}>
        <StatusBadge label="5 succeeded" color="var(--mantine-color-green-6)" />
        <StatusBadge label="0 failed" color="var(--mantine-color-red-6)" />
      </Group>
      <Table withColumnBorders fz="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>
              <TextMono12Regular c="var(--fg-muted)">Operation</TextMono12Regular>
            </Table.Th>
            <Table.Th>
              <TextMono12Regular c="var(--fg-muted)">Planned</TextMono12Regular>
            </Table.Th>
            <Table.Th>
              <TextMono12Regular c="var(--fg-muted)">Done</TextMono12Regular>
            </Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {OPERATIONS.map((op) => (
            <Table.Tr
              key={op.label}
              style={{ background: op.state === 'active' ? 'var(--modified-needs-review-bg)' : undefined }}
            >
              <Table.Td>
                <Text12Medium
                  c={op.planned === 0 ? 'var(--fg-muted)' : 'var(--fg-primary)'}
                  fw={op.state === 'active' ? 600 : 425}
                >
                  {op.label}
                </Text12Medium>
              </Table.Td>
              <Table.Td>
                <Text12Regular c={op.planned === 0 ? 'var(--fg-muted)' : 'var(--fg-secondary)'}>
                  {op.planned === 0 ? '—' : op.planned}
                </Text12Regular>
              </Table.Td>
              <Table.Td>
                <Text12Regular
                  c={
                    op.state === 'done'
                      ? 'var(--create-needs-review-stroke)'
                      : op.state === 'active'
                        ? 'var(--modified-needs-review-stroke)'
                        : 'var(--fg-muted)'
                  }
                >
                  {op.planned === 0 ? '—' : op.done}
                </Text12Regular>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Box>
  );
}

export function PublishProgressModal() {
  return (
    <ModalShell title="Publishing changes" width={580}>
      <Stack gap={16}>
        <ConnectionPublishRow />
      </Stack>
    </ModalShell>
  );
}
