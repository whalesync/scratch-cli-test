import { Badge, Box, Center, Group, Loader, Modal, Progress, ScrollArea, Stack, Table, Text } from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { jobApi, type JobStatus } from '../../lib/job-api';

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
      return 'gray';
    default:
      return 'gray';
  }
}

interface PullAllModalProps {
  opened: boolean;
  onClose: () => void;
  localPath: string | null;
  workspaceName?: string | null;
}

export function PullAllModal({ opened, onClose, localPath, workspaceName }: PullAllModalProps) {
  const [phase, setPhase] = useState<'starting' | 'polling' | 'done' | 'error'>('starting');
  const [error, setError] = useState<string | null>(null);
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const pollingIntervalRef = useRef<number | null>(null);

  const reset = useCallback(() => {
    setPhase('starting');
    setError(null);
    setJobIds([]);
    setJobs([]);
    if (pollingIntervalRef.current !== null) {
      window.clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  }, []);

  // Start pull-all when modal opens
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

    window.scratchDesktop
      .pullAllLinkedTables(localPath)
      .then(({ jobIds: ids }) => {
        if (cancelled) return;
        if (ids.length === 0) {
          setPhase('done');
        } else {
          setJobIds(ids);
          setPhase('polling');
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPhase('error');
        setError(err instanceof Error ? err.message : 'Failed to start pull jobs');
      });

    return () => {
      cancelled = true;
    };
  }, [opened, localPath, reset]);

  // Poll job statuses
  useEffect(() => {
    if (phase !== 'polling' || jobIds.length === 0) {
      if (pollingIntervalRef.current !== null) {
        window.clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
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
          if (pollingIntervalRef.current !== null) {
            window.clearInterval(pollingIntervalRef.current);
            pollingIntervalRef.current = null;
          }

          if (hydrated.every((job) => job.state === 'completed')) {
            setPhase('done');
            if (localPath) {
              window.scratchDesktop.pullWorkspaceChanges(localPath).catch((err) => {
                console.debug('Post-pull download failed:', err);
              });
            }
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
      if (pollingIntervalRef.current !== null) {
        window.clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    };
  }, [phase, jobIds, localPath]);

  const allDone = jobs.length > 0 && jobs.every((j) => isTerminalState(j.state));
  const completedCount = jobs.filter((j) => j.state === 'completed').length;
  const progress = jobs.length > 0 ? Math.round((completedCount / jobs.length) * 100) : phase === 'done' ? 100 : 0;
  const canClose = phase === 'done' || phase === 'error';

  return (
    <Modal
      opened={opened}
      onClose={canClose ? onClose : () => undefined}
      title={`Pull all — ${workspaceName ?? 'workspace'}`}
      size="lg"
    >
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
            No linked tables found in this workspace.
          </Text>
        )}

        {(phase === 'polling' || phase === 'done') && jobs.length > 0 && (
          <>
            <Box>
              <Group justify="space-between" mb={4}>
                <Text size="xs" c="dimmed">
                  {completedCount} / {jobs.length} tables pulled
                </Text>
                {allDone && phase === 'done' && (
                  <Badge color="green" size="xs">
                    Complete
                  </Badge>
                )}
              </Group>
              <Progress value={progress} animated={phase === 'polling'} />
            </Box>

            <ScrollArea.Autosize mah={360}>
              <Table fz="xs" withRowBorders={false}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Table</Table.Th>
                    <Table.Th>Connection</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th style={{ textAlign: 'right' }}>Created</Table.Th>
                    <Table.Th style={{ textAlign: 'right' }}>Updated</Table.Th>
                    <Table.Th style={{ textAlign: 'right' }}>Deleted</Table.Th>
                    <Table.Th style={{ textAlign: 'right' }}>Total</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {jobs.map((job) => {
                    const prog = job.publicProgress as PullProgress | undefined;
                    const displayStatus = prog?.status ?? (job.state === 'active' ? 'active' : job.state);
                    return (
                      <Table.Tr key={job.bullJobId}>
                        <Table.Td>{prog?.folderName ?? job.bullJobId}</Table.Td>
                        <Table.Td c="dimmed">{prog?.connectionName ?? '—'}</Table.Td>
                        <Table.Td>
                          <Badge color={statusColor(displayStatus)} size="xs" variant="light">
                            {displayStatus}
                          </Badge>
                        </Table.Td>
                        <Table.Td style={{ textAlign: 'right' }}>{prog ? prog.createdPaths.length : '—'}</Table.Td>
                        <Table.Td style={{ textAlign: 'right' }}>{prog ? prog.updatedPaths.length : '—'}</Table.Td>
                        <Table.Td style={{ textAlign: 'right' }}>{prog ? prog.deletedPaths.length : '—'}</Table.Td>
                        <Table.Td style={{ textAlign: 'right' }}>
                          {prog ? prog.createdPaths.length + prog.updatedPaths.length + prog.deletedPaths.length : '—'}
                        </Table.Td>
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
