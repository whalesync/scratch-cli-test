import { ButtonPrimaryLight } from '@/components/base/buttons';
import { scratchApiClient } from '@/lib/scratch-api-client';
import { Badge, Box, Center, Group, Loader, Modal, Progress, ScrollArea, Stack, Table } from '@mantine/core';
import type { Job } from '@spinner/shared-types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Text12Regular, Text13Regular, TextMono12Regular } from '../../components/base/text';
import { useCurrentUser } from '../../hooks/use-current-user';
import { JobRawJsonButton } from './JobRawJsonButton';

/**
 * Total download attempts before surfacing the error (initial + retries). A
 * brand-new connection's git repo can still be settling the instant its pull
 * job reports complete — `scratchmd files download` then skips it with only a
 * stderr warning (and still exits 0), so its folders never reach disk. A couple
 * of automatic retries usually materialize them without bothering the user.
 * (DEV-10421)
 */
const MAX_DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAY_MS = 1500;

/**
 * Substring `scratchmd files download` logs to stderr when it can't set up a
 * connection it discovered server-side (e.g. its repo isn't clonable yet). The
 * command still exits 0, so we scan its output to catch this otherwise-silent
 * failure and retry. Must match the CLI's wording in
 * `scratch-git-2/src/cli/commands/files.rs` (`sync_workspace_structure`).
 */
const CONNECTION_SETUP_FAILURE_MARKER = 'failed to set up connection';

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

function isTerminalState(state: Job['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled' || state === 'unknown';
}

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

interface PullInProgressModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: string;
  localPath: string;
  invalidateWorkspaceLevelData: () => void;
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
  invalidateWorkspaceLevelData,
}: PullInProgressModalProps) {
  const { user } = useCurrentUser();
  const [phase, setPhase] = useState<'loading' | 'polling' | 'downloading' | 'done' | 'error' | 'download-error'>(
    'loading',
  );
  const [error, setError] = useState<string | null>(null);
  // The scratchmd error from a failed local download, shown so the user
  // understands why files that pulled on the server didn't reach their machine.
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadAttempt, setDownloadAttempt] = useState(0);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [trackedJobIds, setTrackedJobIds] = useState<string[]>([]);
  const pollingIntervalRef = useRef<number | null>(null);
  const downloadRetryTimeoutRef = useRef<number | null>(null);
  const showJobDebug = user?.isAdmin === true;

  const clearPolling = useCallback(() => {
    if (pollingIntervalRef.current !== null) {
      window.clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
  }, []);

  const clearDownloadRetry = useCallback(() => {
    if (downloadRetryTimeoutRef.current !== null) {
      window.clearTimeout(downloadRetryTimeoutRef.current);
      downloadRetryTimeoutRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    setPhase('loading');
    setError(null);
    setDownloadError(null);
    setDownloadAttempt(0);
    setJobs([]);
    setTrackedJobIds([]);
    clearPolling();
    clearDownloadRetry();
  }, [clearPolling, clearDownloadRetry]);

  // Re-run the local download from scratch (used by the "Try again" button after
  // a surfaced failure).
  const retryDownload = useCallback(() => {
    clearDownloadRetry();
    setDownloadError(null);
    setDownloadAttempt(0);
    setPhase('downloading');
  }, [clearDownloadRetry]);

  // Fetch active jobs when modal opens
  useEffect(() => {
    if (!opened) {
      return;
    }
    reset();

    let cancelled = false;

    scratchApiClient.job
      .getActiveJobsByWorkbook(workbookId)
      .then((activeJobs) => {
        if (cancelled) return;
        const pullJobs = activeJobs.filter(
          (j: Job) => j.type === 'RefreshRecords' || j.type === 'pull-linked-folder-files',
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
        const statuses = await scratchApiClient.job.getJobsStatus(trackedJobIds);
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

  // Download files after all pull jobs complete. The records are already on the
  // server; this materializes the new connection's folders into the local
  // workspace so they show up in the file tree. Failures are surfaced (never
  // reported as a phantom success), with one automatic retry for a repo that's
  // still settling right after its pull job finished.
  useEffect(() => {
    if (phase !== 'downloading') return;

    let cancelled = false;

    // Either auto-retry (a settling repo usually clones on the next attempt) or,
    // once the budget is exhausted, surface the failure instead of pretending
    // the pull reached the local workspace.
    const onDownloadIncomplete = (message: string) => {
      if (cancelled) return;
      // Best-effort refresh so any folders that did download still appear.
      invalidateWorkspaceLevelData();
      if (downloadAttempt + 1 < MAX_DOWNLOAD_ATTEMPTS) {
        downloadRetryTimeoutRef.current = window.setTimeout(() => {
          if (cancelled) return;
          setDownloadAttempt((attempt) => attempt + 1);
        }, DOWNLOAD_RETRY_DELAY_MS);
      } else {
        setDownloadError(message);
        setPhase('download-error');
      }
    };

    window.scratchDesktop
      .pullWorkspaceChanges(localPath, { onDelete: 'remove' })
      .then((result) => {
        if (cancelled) return;
        // `files download` exits 0 even when it couldn't set up a newly added
        // connection (it only logs a warning), which would otherwise leave the
        // new folders silently missing. Treat that warning as a retriable
        // failure rather than reporting success.
        const output = `${result?.stderr ?? ''}\n${result?.stdout ?? ''}`;
        if (output.includes(CONNECTION_SETUP_FAILURE_MARKER)) {
          console.debug('[PullInProgressModal] download reported a connection setup failure:', output);
          onDownloadIncomplete("A new connection's files couldn't be set up on this computer yet.");
          return;
        }
        setPhase('done');
        invalidateWorkspaceLevelData();
      })
      .catch((err) => {
        if (cancelled) return;
        console.debug('[PullInProgressModal] Post-pull download failed:', err);
        onDownloadIncomplete(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      clearDownloadRetry();
    };
  }, [phase, downloadAttempt, localPath, invalidateWorkspaceLevelData, clearDownloadRetry]);

  const completedCount = jobs.filter((j) => j.state === 'completed').length;
  const progress = jobs.length > 0 ? Math.round((completedCount / jobs.length) * 100) : phase === 'done' ? 100 : 0;
  const canClose = phase === 'done' || phase === 'error' || phase === 'download-error';

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

        {phase === 'download-error' && (
          <Stack gap="sm">
            <Text13Regular c="var(--mantine-color-red-6)">
              The pull finished on the server, but downloading the files to this computer didn't complete, so the new
              folders may not appear yet.
            </Text13Regular>
            {downloadError && <TextMono12Regular c="dimmed">{downloadError}</TextMono12Regular>}
            <Group justify="flex-end">
              <ButtonPrimaryLight onClick={retryDownload}>Try again</ButtonPrimaryLight>
            </Group>
          </Stack>
        )}

        {phase === 'done' && jobs.length === 0 && <Text13Regular c="dimmed">No active pull jobs found.</Text13Regular>}

        {phase === 'downloading' && (
          <Center py="sm">
            <Stack align="center" gap="sm">
              <Loader size="sm" />
              <Text13Regular c="dimmed">Downloading files to local workspace…</Text13Regular>
            </Stack>
          </Center>
        )}

        {(phase === 'polling' || phase === 'downloading' || phase === 'done' || phase === 'download-error') &&
          jobs.length > 0 && (
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
