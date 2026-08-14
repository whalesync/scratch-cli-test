import { ButtonPrimaryLight } from '@/components/base/buttons';
import { Badge, Box, Center, Group, Loader, Modal, Progress, ScrollArea, Stack, Table } from '@mantine/core';
import type { Job } from '@spinner/shared-types';
import { Text12Regular, Text13Regular, TextMono12Regular } from '../../components/base/text';
import { useCurrentUser } from '../../hooks/use-current-user';
import { JobRawJsonButton } from './JobRawJsonButton';
import type { ConnectionDownloadProgress, PullTracker } from './use-pull-tracker';

type PullProgress = {
  totalFiles: number;
  folderCount: number;
  connectionName: string;
  folderId: string;
  folderName: string;
  connector: string;
  filter: string | null;
  status: 'pending' | 'active' | 'completed' | 'failed';
  createdPaths: string[];
  updatedPaths: string[];
  deletedPaths: string[];
  createdCount?: number;
  updatedCount?: number;
  deletedCount?: number;
};

function statusColor(state: PullProgress['status'] | Job['state']): string {
  switch (state) {
    case 'completed':
      return 'green';
    case 'failed':
    case 'canceled':
      return 'red';
    case 'active':
      return 'blue';
    case 'pending':
    case 'waiting':
    case 'delayed':
    case 'paused':
    case 'created':
      return 'gray';
    default:
      return 'gray';
  }
}

function getConnectionLabel(job: Job, progress?: PullProgress): string {
  return progress?.connectionName ?? progress?.folderName ?? job.bullJobId ?? '—';
}

/**
 * User-facing wording and badge color per connection download state
 * (DEV-10846). Keyed `Record`s rather than switches so adding a state to
 * `ConnectionDownloadProgress` is a compile error here.
 */
const CONNECTION_STATE_LABELS: Record<ConnectionDownloadProgress['state'], string> = {
  pending: 'queued',
  active: 'downloading',
  done: 'complete',
  error: 'failed',
};

const CONNECTION_STATE_COLORS: Record<ConnectionDownloadProgress['state'], string> = {
  pending: 'gray',
  active: 'blue',
  done: 'green',
  error: 'red',
};

interface PullProgressModalProps {
  opened: boolean;
  onClose: () => void;
  tracker: PullTracker;
}

/**
 * Presentational view of an in-flight pull, driven entirely by {@link PullTracker}
 * state. The tracker owns the work, so this modal is fully dismissible — closing
 * it just hides the detail view while the pull continues in the background
 * (surfaced by the header progress pill). (DEV-10501)
 */
export function PullProgressModal({ opened, onClose, tracker }: PullProgressModalProps) {
  const { user } = useCurrentUser();
  const showJobDebug = user?.isAdmin === true;

  const { phase, jobs, progress, completedCount, totalCount, title, error, downloadError, emptyMessage } = tracker;
  const { connectionDownloads } = tracker;

  const finishedConnectionCount = connectionDownloads.filter(
    (row) => row.state === 'done' || row.state === 'error',
  ).length;
  const connectionDownloadProgress =
    connectionDownloads.length > 0 ? Math.round((finishedConnectionCount / connectionDownloads.length) * 100) : 0;

  return (
    <Modal opened={opened} onClose={onClose} title={title} size="lg">
      <Stack gap="md">
        {/* `starting`, plus the brief gap on the start-pull path where we're
            `polling` but the first `getJobsStatus` hasn't returned yet (jobs is
            still empty), so the body isn't blank for that round-trip. */}
        {(phase === 'starting' || (phase === 'polling' && jobs.length === 0)) && (
          <Center py="xl">
            <Stack align="center" gap="sm">
              <Loader size="sm" />
              <Text13Regular c="dimmed">Starting pull…</Text13Regular>
            </Stack>
          </Center>
        )}

        {phase === 'error' && <Text13Regular c="var(--mantine-color-red-6)">{error}</Text13Regular>}

        {phase === 'download-error' && (
          <Stack gap="sm">
            <Text13Regular c="var(--mantine-color-red-6)">
              The pull finished on the server, but downloading the files to this computer didn't complete, so the new
              folders may not appear yet.
            </Text13Regular>
            {downloadError && <TextMono12Regular c="dimmed">{downloadError}</TextMono12Regular>}
            <Group justify="flex-end">
              <ButtonPrimaryLight onClick={tracker.retryDownload}>Try again</ButtonPrimaryLight>
            </Group>
          </Stack>
        )}

        {phase === 'done' && jobs.length === 0 && (
          <Text13Regular c="dimmed">{emptyMessage ?? 'No active pull jobs found.'}</Text13Regular>
        )}

        {/* DEV-10846: the local download reports per-connection progress, so show
            real rows once they arrive. The spinner is the fallback for the brief
            window before the CLI's first event (and for an older CLI that emits
            none). */}
        {phase === 'downloading' && connectionDownloads.length === 0 && (
          <Center py="sm">
            <Stack align="center" gap="sm">
              <Loader size="sm" />
              <Text13Regular c="dimmed">Downloading files to local workspace…</Text13Regular>
            </Stack>
          </Center>
        )}

        {phase === 'downloading' && connectionDownloads.length > 0 && (
          <Box>
            <Group justify="space-between" mb={4}>
              <Text12Regular c="dimmed">
                Downloading files to local workspace — {finishedConnectionCount.toLocaleString()} /{' '}
                {connectionDownloads.length.toLocaleString()} connections
              </Text12Regular>
            </Group>
            <Progress value={connectionDownloadProgress} animated mb="sm" />
            <ScrollArea.Autosize mah={240}>
              <Table fz="xs" withRowBorders={false}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Connection</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th style={{ textAlign: 'right' }}>Records Written</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {connectionDownloads.map((row) => (
                    <Table.Tr key={row.connection}>
                      <Table.Td>
                        <Text13Regular>{row.connection}</Text13Regular>
                      </Table.Td>
                      <Table.Td>
                        <Badge color={CONNECTION_STATE_COLORS[row.state]} size="xs" variant="light">
                          {CONNECTION_STATE_LABELS[row.state]}
                        </Badge>
                      </Table.Td>
                      <Table.Td style={{ textAlign: 'right' }}>
                        {row.changedRecords === undefined ? '—' : row.changedRecords.toLocaleString()}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea.Autosize>
          </Box>
        )}

        {(phase === 'polling' || phase === 'downloading' || phase === 'done' || phase === 'download-error') &&
          jobs.length > 0 && (
            <>
              <Box>
                <Group justify="space-between" mb={4}>
                  <Text12Regular c="dimmed">
                    {completedCount.toLocaleString()} / {totalCount.toLocaleString()} pull jobs complete
                  </Text12Regular>
                  {phase === 'done' && (
                    <Badge color="green" size="xs">
                      Complete
                    </Badge>
                  )}
                </Group>
                <Progress value={progress} animated={phase === 'polling' || phase === 'downloading'} />
              </Box>

              <ScrollArea.Autosize mah={360}>
                <Table fz="xs" withRowBorders={false}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Connection</Table.Th>
                      <Table.Th>Status</Table.Th>
                      <Table.Th style={{ textAlign: 'right' }}>Records Processed</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {jobs.map((job) => {
                      const prog = job.publicProgress as PullProgress | undefined;
                      const displayStatus =
                        prog?.status ?? (job.state === 'active' || phase === 'downloading' ? 'active' : job.state);
                      return (
                        <Table.Tr key={job.bullJobId}>
                          <Table.Td>
                            <Group gap={4} wrap="nowrap">
                              <Text13Regular style={{ minWidth: 0 }}>{getConnectionLabel(job, prog)}</Text13Regular>
                              {showJobDebug && <JobRawJsonButton jobId={job.bullJobId} />}
                            </Group>
                          </Table.Td>
                          <Table.Td>
                            <Badge color={statusColor(displayStatus)} size="xs" variant="light">
                              {displayStatus}
                            </Badge>
                          </Table.Td>
                          <Table.Td style={{ textAlign: 'right' }}>{prog?.totalFiles ?? '—'}</Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              </ScrollArea.Autosize>
            </>
          )}
      </Stack>
    </Modal>
  );
}
