import { Badge, Box, Center, Group, Loader, Modal, Progress, ScrollArea, Stack, Table } from '@mantine/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Text12Regular, Text13Regular } from '../../components/base/text';
import { useCurrentUser } from '../../hooks/use-current-user';
import { jobApi, type JobStatus } from '../../lib/job-api';
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

interface PullInProgressModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: string;
  localPath: string;
  onDataRefresh: () => void;
}

/**
 * Monitors active pull jobs for a workspace and blocks the UI until they complete.
 * Unlike PullAllModal, this does NOT start new pull jobs — it watches existing ones.
 * Once all pulls finish, it triggers a CLI files download to sync locally.
 */
export function PullInProgressModal({
  opened,
  onClose,
  workbookId,
  localPath,
  onDataRefresh,
}: PullInProgressModalProps) {
  const { user } = useCurrentUser();
  const [phase, setPhase] = useState<'loading' | 'polling' | 'downloading' | 'done' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const [trackedJobIds, setTrackedJobIds] = useState<string[]>([]);
  const pollingIntervalRef = useRef<number | null>(null);
  const showJobDebug = user?.isAdmin === true;

  const clearPolling = useCallback(() => {
    if (pollingIntervalRef.current !== null) {
      window.clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    setPhase('loading');
    setError(null);
    setJobs([]);
    setTrackedJobIds([]);
    clearPolling();
  }, [clearPolling]);

  // Fetch active jobs when modal opens
  useEffect(() => {
    if (!opened) {
      return;
    }
    reset();

    let cancelled = false;

    jobApi
      .getActiveJobs(workbookId)
      .then((activeJobs) => {
        if (cancelled) return;
        const pullJobs = activeJobs.filter(
          (j: JobStatus) => j.type === 'RefreshRecords' || j.type === 'pull-linked-folder-files',
        );
        if (pullJobs.length === 0) {
          // No active pull jobs — skip straight to done
          setPhase('done');
        } else {
          const ids = pullJobs.map((j) => j.bullJobId).filter((id): id is string => id != null);
          setJobs(pullJobs);
          setTrackedJobIds(ids);
          setPhase('polling');
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPhase('error');
        setError(err instanceof Error ? err.message : 'Failed to fetch active jobs');
      });

    return () => {
      cancelled = true;
    };
  }, [opened, workbookId, reset]);

  // Poll job statuses
  useEffect(() => {
    if (phase !== 'polling' || trackedJobIds.length === 0) {
      clearPolling();
      return;
    }

    let cancelled = false;

    const poll = async () => {
      try {
        const statuses = await jobApi.getJobsStatus(trackedJobIds);
        if (cancelled) return;

        const byId = new Map(statuses.map((job) => [job.bullJobId ?? '', job]));
        const hydrated = trackedJobIds.map(
          (jobId) =>
            byId.get(jobId) ?? { bullJobId: jobId, state: 'active' as const, type: 'pull-linked-folder-files' },
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
  }, [phase, trackedJobIds, clearPolling]);

  // Download files after all pull jobs complete
  useEffect(() => {
    if (phase !== 'downloading') return;

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
        console.debug('[PullInProgressModal] Post-pull download failed:', err);
        setPhase('done');
        onDataRefresh();
      });

    return () => {
      cancelled = true;
    };
  }, [phase, localPath, onDataRefresh]);

  const completedCount = jobs.filter((j) => j.state === 'completed').length;
  const progress = jobs.length > 0 ? Math.round((completedCount / jobs.length) * 100) : phase === 'done' ? 100 : 0;
  const canClose = phase === 'done' || phase === 'error';

  return (
    <Modal
      opened={opened}
      onClose={canClose ? onClose : () => undefined}
      title="Pulling files"
      size="lg"
      closeOnClickOutside={false}
      closeOnEscape={false}
      withCloseButton={canClose}
    >
      <Stack gap="md">
        {phase === 'loading' && (
          <Center py="xl">
            <Stack align="center" gap="sm">
              <Loader size="sm" />
              <Text13Regular c="dimmed">Checking for active pull jobs…</Text13Regular>
            </Stack>
          </Center>
        )}

        {phase === 'error' && <Text13Regular c="var(--mantine-color-red-6)">{error}</Text13Regular>}

        {phase === 'done' && jobs.length === 0 && <Text13Regular c="dimmed">No active pull jobs found.</Text13Regular>}

        {phase === 'downloading' && (
          <Center py="sm">
            <Stack align="center" gap="sm">
              <Loader size="sm" />
              <Text13Regular c="dimmed">Downloading files to local workspace…</Text13Regular>
            </Stack>
          </Center>
        )}

        {(phase === 'polling' || phase === 'downloading' || phase === 'done') && jobs.length > 0 && (
          <>
            <Box>
              <Group justify="space-between" mb={4}>
                <Text12Regular c="dimmed">
                  {completedCount.toLocaleString()} / {jobs.length.toLocaleString()} pull jobs complete
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
                    const displayStatus = prog?.status ?? (job.state === 'active' ? 'active' : job.state);
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
