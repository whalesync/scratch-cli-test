import { Badge, Box, Center, Group, Loader, Modal, Progress, ScrollArea, Stack, Table, Text } from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCurrentUser } from '../../hooks/use-current-user';
import { jobApi, type JobStatus } from '../../lib/job-api';
import { workspacesApi } from '../../lib/workspaces-api';
import { JobRawJsonButton } from './JobRawJsonButton';

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

function isTerminalState(state: JobStatus['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled' || state === 'unknown';
}

function statusColor(state: PullProgress['status'] | JobStatus['state']): string {
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

function getConnectionLabel(job: JobStatus, progress?: PullProgress): string {
  return progress?.connectionName ?? progress?.folderName ?? job.bullJobId ?? '—';
}

interface PullFoldersModalProps {
  opened: boolean;
  onClose: () => void;
  localPath: string | null;
  workspaceId: string;
  title: string;
  onDataRefresh: () => void;
  dataFolderIds?: string[];
  emptyStateMessage?: string;
}

export function PullFoldersModal({
  opened,
  onClose,
  localPath,
  workspaceId,
  title,
  onDataRefresh,
  dataFolderIds,
  emptyStateMessage = 'No linked tables found for this selection.',
}: PullFoldersModalProps) {
  const { user } = useCurrentUser();
  const [phase, setPhase] = useState<'starting' | 'polling' | 'downloading' | 'done' | 'error'>('starting');
  const [error, setError] = useState<string | null>(null);
  const [emptyMessage, setEmptyMessage] = useState<string>(emptyStateMessage);
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const pollingIntervalRef = useRef<number | null>(null);
  const showJobDebug = user?.isAdmin === true;

  const clearPolling = useCallback(() => {
    if (pollingIntervalRef.current !== null) {
      window.clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    setPhase('starting');
    setError(null);
    setEmptyMessage(emptyStateMessage);
    setJobIds([]);
    setJobs([]);
    clearPolling();
  }, [clearPolling, emptyStateMessage]);

  useEffect(() => {
    if (!opened) {
      return;
    }

    reset();
    if (!localPath) {
      setPhase('error');
      setError('No local workspace path.');
      return;
    }

    let cancelled = false;

    workspacesApi
      .pullFiles(workspaceId, dataFolderIds)
      .then((result) => {
        if (cancelled) return;

        const ids = result.jobIds ?? (result.jobId ? [result.jobId] : []);
        if (ids.length === 0) {
          setEmptyMessage(result.warning ?? emptyStateMessage);
          setPhase('done');
          return;
        }

        setJobIds(ids);
        setPhase('polling');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPhase('error');
        setError(err instanceof Error ? err.message : 'Failed to start pull jobs');
      });

    return () => {
      cancelled = true;
    };
  }, [dataFolderIds, emptyStateMessage, localPath, opened, reset, workspaceId]);

  useEffect(() => {
    if (phase !== 'polling' || jobIds.length === 0) {
      clearPolling();
      return;
    }

    let cancelled = false;

    const poll = async () => {
      try {
        const statuses = await jobApi.getJobsStatus(jobIds);
        if (cancelled) return;

        const byId = new Map(statuses.map((job) => [job.bullJobId ?? '', job]));
        const hydrated = jobIds.map(
          (jobId) =>
            byId.get(jobId) ?? { bullJobId: jobId, state: 'created' as const, type: 'pull-linked-folder-files' },
        );
        setJobs(hydrated);

        if (hydrated.every((job) => isTerminalState(job.state))) {
          clearPolling();

          if (hydrated.every((job) => job.state === 'completed')) {
            setPhase('downloading');
          } else {
            setPhase('error');
            setError('One or more pull jobs did not complete successfully.');
          }
        }
      } catch (err) {
        if (cancelled) return;
        setPhase('error');
        setError(err instanceof Error ? err.message : 'Failed to poll pull jobs');
      }
    };

    void poll();
    pollingIntervalRef.current = window.setInterval(() => {
      void poll();
    }, 1500);

    return () => {
      cancelled = true;
      clearPolling();
    };
  }, [clearPolling, jobIds, phase]);

  useEffect(() => {
    if (phase !== 'downloading' || !localPath) {
      return;
    }

    let cancelled = false;

    window.scratchDesktop
      .pullWorkspaceChanges(localPath, { onDelete: 'remove' })
      .then(() => {
        if (cancelled) return;
        setPhase('done');
        onDataRefresh();
      })
      .catch((err) => {
        if (cancelled) return;
        console.debug('Post-pull download failed:', err);
        setPhase('done');
        onDataRefresh();
      });

    return () => {
      cancelled = true;
    };
  }, [localPath, onDataRefresh, phase]);

  const allDone = jobs.length > 0 && jobs.every((job) => isTerminalState(job.state));
  const completedCount = jobs.filter((job) => job.state === 'completed').length;
  const progress = jobs.length > 0 ? Math.round((completedCount / jobs.length) * 100) : phase === 'done' ? 100 : 0;
  const canClose = phase === 'done' || phase === 'error';

  return (
    <Modal opened={opened} onClose={canClose ? onClose : () => undefined} title={title} size="lg">
      <Stack gap="md">
        {phase === 'starting' && (
          <Center py="xl">
            <Stack align="center" gap="sm">
              <Loader size="sm" />
              <Text size="sm" c="dimmed">
                Starting pull jobs…
              </Text>
            </Stack>
          </Center>
        )}

        {phase === 'error' && (
          <Text size="sm" c="red">
            {error}
          </Text>
        )}

        {phase === 'done' && jobs.length === 0 && (
          <Text size="sm" c="dimmed">
            {emptyMessage}
          </Text>
        )}

        {phase === 'downloading' && (
          <Center py="sm">
            <Stack align="center" gap="sm">
              <Loader size="sm" />
              <Text size="sm" c="dimmed">
                Downloading files to local workspace…
              </Text>
            </Stack>
          </Center>
        )}

        {(phase === 'polling' || phase === 'downloading' || phase === 'done') && jobs.length > 0 && (
          <>
            <Box>
              <Group justify="space-between" mb={4}>
                <Text size="xs" c="dimmed">
                  {completedCount} / {jobs.length} pull jobs complete
                </Text>
                {allDone && phase === 'done' && (
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
                            <Text size="xs" style={{ minWidth: 0 }}>
                              {getConnectionLabel(job, prog)}
                            </Text>
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
