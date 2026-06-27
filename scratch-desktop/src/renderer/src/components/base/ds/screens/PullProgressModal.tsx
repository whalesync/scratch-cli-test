// Faithful reproduction of the desktop app's Pull-progress modal — overall progress + a per-connection
// table of pull jobs and their status. Self-contained; no IPC. From the real PullProgressModal source
// (DEV-10592).
import { Box, Group, Progress, Stack, Table } from '@mantine/core';
import { Text12Regular, Text13Regular, TextMono12Regular } from '../../text';
import { ModalShell } from './modal-shell';

const JOBS = [
  {
    connection: 'QA Webflow · Blog Posts (Demo)',
    status: 'completed',
    records: 40,
    color: 'var(--create-needs-review-stroke)',
  },
  { connection: 'QA Webflow · Recipes', status: 'completed', records: 5, color: 'var(--create-needs-review-stroke)' },
  { connection: 'QA Webflow · Mackerels', status: 'active', records: 8, color: 'var(--modified-needs-review-stroke)' },
  { connection: 'QA Webflow · Menu Items', status: 'pending', records: undefined, color: 'var(--fg-muted)' },
  { connection: 'QA Webflow · Assets', status: 'pending', records: undefined, color: 'var(--fg-muted)' },
];

function Pill({ label, color }: { label: string; color: string }) {
  return (
    <Box style={{ padding: '1px 8px', borderRadius: 4, background: color, display: 'inline-flex' }}>
      <TextMono12Regular c="#fff">{label}</TextMono12Regular>
    </Box>
  );
}

export function PullProgressModal() {
  return (
    <ModalShell title="Pulling data" width={620}>
      <Stack gap={14}>
        <Box>
          <Group justify="space-between" mb={4}>
            <Text12Regular c="var(--fg-muted)">2 / 5 pull jobs complete</Text12Regular>
            <Box style={{ padding: '1px 8px', borderRadius: 4, background: 'var(--modified-needs-review-bg)' }}>
              <TextMono12Regular c="var(--modified-needs-review-stroke)">in progress</TextMono12Regular>
            </Box>
          </Group>
          <Progress value={40} animated />
        </Box>
        <Table fz="xs" withRowBorders={false}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>
                <TextMono12Regular c="var(--fg-muted)">Connection</TextMono12Regular>
              </Table.Th>
              <Table.Th>
                <TextMono12Regular c="var(--fg-muted)">Status</TextMono12Regular>
              </Table.Th>
              <Table.Th style={{ textAlign: 'right' }}>
                <TextMono12Regular c="var(--fg-muted)">Records</TextMono12Regular>
              </Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {JOBS.map((j) => (
              <Table.Tr key={j.connection}>
                <Table.Td>
                  <Text13Regular c="var(--fg-primary)">{j.connection}</Text13Regular>
                </Table.Td>
                <Table.Td>
                  <Pill label={j.status} color={j.color} />
                </Table.Td>
                <Table.Td style={{ textAlign: 'right' }}>
                  <TextMono12Regular c="var(--fg-secondary)">{j.records ?? '—'}</TextMono12Regular>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Stack>
    </ModalShell>
  );
}
