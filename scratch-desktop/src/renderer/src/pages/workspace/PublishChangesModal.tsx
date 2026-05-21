import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Center,
  Code,
  Group,
  Loader,
  Modal,
  Progress,
  ScrollArea,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ValidationStat } from '../../../../shared/validation-types';
import { jobApi, type JobStatus } from '../../lib/job-api';
import {
  trackPublishCompleted,
  trackPublishReviewOnWeb,
  trackPublishStarted,
  trackPublishUploadCompleted,
  trackPublishUploadStarted,
} from '../../lib/posthog';
import { publishApi } from '../../lib/publish-api';

interface UnreviewedChangeEntry {
  connectionName: string;
  path: string;
  status: string;
}

type PublishMode = 'approval' | 'uploading' | 'uploaded' | 'publishing' | 'complete' | 'error';

type UploadResult = Awaited<ReturnType<typeof window.scratchDesktop.uploadWorkspaceChanges>>;
type UploadConnection = UploadResult['connections'][number];

interface ConnectionPublishState {
  connectionId: string;
  connectionName: string;
  /**
   * `planning` — POST plan-job, then poll until plan-job is terminal.
   * `plan-no-diff` — server's dirty matches main; nothing to publish for this connection.
   * `running` — plan-job done, run-job enqueued and being polled.
   * `completed` — run-job terminal with no failures.
   * `failed` — plan-job or run-job failed, or run-job's progress reports failures.
   */
  status: 'pending' | 'planning' | 'plan-no-diff' | 'running' | 'completed' | 'failed';
  planJobId?: string;
  runJobId?: string;
  pipelineId?: string;
  failureMessage?: string;
}

interface PublishChangesModalProps {
  opened: boolean;
  onClose: () => void;
  workspaceName?: string | null;
  workspaceId?: string | null;
  localPath: string | null;
  autoStartUploadOnOpen?: boolean;
  assumeUnreviewedApproved?: boolean;
  onDataRefresh: () => void;
  /** The currently selected folder path in the workspace grid. */
  currentFolderPath?: string | null;
  /** Called when the user wants to view problems in the grid. */
  onViewProblems?: (folderPath: string) => void;
}

function isTerminalState(state: JobStatus['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled' || state === 'unknown';
}

function formatDiffSummary(created: number, updated: number, deleted: number): string {
  const parts: string[] = [];
  if (created > 0) parts.push(`${created} added`);
  if (updated > 0) parts.push(`${updated} modified`);
  if (deleted > 0) parts.push(`${deleted} deleted`);
  return parts.length > 0 ? parts.join(' · ') : 'No changes';
}

function modeTitle(mode: PublishMode): string {
  switch (mode) {
    case 'approval':
      return 'Publish changes';
    case 'uploading':
      return 'Uploading changes';
    case 'uploaded':
      return 'Ready to publish';
    case 'publishing':
      return 'Publishing changes';
    case 'complete':
      return 'Published';
    case 'error':
      return 'Publish failed';
  }
}

function statusColor(state: JobStatus['state']): string {
  switch (state) {
    case 'completed':
      return 'green';
    case 'failed':
    case 'canceled':
      return 'red';
    case 'active':
      return 'blue';
    default:
      return 'gray';
  }
}

interface PublishFromGitProgress {
  status?: string;
  processedCount?: number;
  totalCount?: number;
  currentPhase?: string;
  currentTableName?: string;
  successCount?: number;
  failedCount?: number;
  editsPlanned?: number;
  createsPlanned?: number;
  deletesPlanned?: number;
  backfillsPlanned?: number;
  renameFilesPlanned?: number;
}

function hasPublishFailures(job: JobStatus | undefined): boolean {
  const progress = job?.publicProgress as PublishFromGitProgress | undefined;
  return (progress?.failedCount ?? 0) > 0;
}

function getPublishFailureMessage(job: JobStatus): string {
  const progress = job.publicProgress as PublishFromGitProgress | undefined;
  const failedCount = progress?.failedCount ?? 0;
  const currentPhase = progress?.currentPhase;

  if (job.failedReason && failedCount > 0 && currentPhase) {
    return `${job.failedReason} (${failedCount.toLocaleString()} operation${failedCount === 1 ? '' : 's'} failed in ${currentPhase})`;
  }
  if (job.failedReason) {
    return job.failedReason;
  }
  if (failedCount > 0 && currentPhase) {
    return `${failedCount.toLocaleString()} operation${failedCount === 1 ? '' : 's'} failed in ${currentPhase}.`;
  }
  return 'One or more publish jobs did not complete successfully.';
}

const PHASE_ORDER = ['edit', 'create', 'delete', 'backfill', 'rename'] as const;
type Phase = (typeof PHASE_ORDER)[number];

const PHASE_LABELS: Record<Phase, string> = {
  edit: 'Edits',
  create: 'Creates',
  delete: 'Deletes',
  backfill: 'Backfills',
  rename: 'Renames',
};

const PHASE_PLANNED_KEY: Record<Phase, keyof PublishFromGitProgress> = {
  edit: 'editsPlanned',
  create: 'createsPlanned',
  delete: 'deletesPlanned',
  backfill: 'backfillsPlanned',
  rename: 'renameFilesPlanned',
};

function computePhaseRows(progress: PublishFromGitProgress) {
  const currentPhaseIdx = PHASE_ORDER.indexOf((progress.currentPhase ?? '') as Phase);
  let remaining = progress.processedCount ?? 0;

  return PHASE_ORDER.map((phase, idx) => {
    const planned = (progress[PHASE_PLANNED_KEY[phase]] as number | undefined) ?? 0;
    let done: number;

    if (idx < currentPhaseIdx) {
      done = planned;
      remaining -= planned;
    } else if (idx === currentPhaseIdx) {
      done = Math.min(remaining, planned);
      remaining = 0;
    } else {
      done = 0;
    }

    return { phase, label: PHASE_LABELS[phase], planned, done };
  });
}

function ConnectionPublishRow({ connection, job }: { connection: ConnectionPublishState; job: JobStatus | undefined }) {
  const progress = job?.publicProgress as PublishFromGitProgress | undefined;
  const total = progress?.totalCount ?? 0;
  const processed = progress?.processedCount ?? 0;
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  const hasProgress = total > 0;
  const rows = progress ? computePhaseRows(progress) : null;
  const currentTable = progress?.currentTableName;

  const statusLabel = (() => {
    switch (connection.status) {
      case 'pending':
        return 'Waiting…';
      case 'planning':
        return 'Planning…';
      case 'plan-no-diff':
        return 'No changes to publish';
      case 'running':
        return job?.state === 'active' ? 'Publishing…' : (job?.state ?? 'queued');
      case 'completed':
        return 'Complete';
      case 'failed':
        return 'Failed';
    }
  })();

  const statusBadgeColor = (() => {
    switch (connection.status) {
      case 'completed':
        return 'green';
      case 'failed':
        return 'red';
      case 'plan-no-diff':
        return 'gray';
      case 'running':
        return statusColor(job?.state ?? 'created');
      default:
        return 'blue';
    }
  })();

  return (
    <Box>
      <Group justify="space-between" mb={4}>
        <Group gap="xs">
          {(connection.status === 'planning' || (connection.status === 'running' && !hasProgress)) && (
            <Loader size={12} />
          )}
          <Text size="sm" fw={600}>
            {connection.connectionName}
          </Text>
          {currentTable && (
            <Text size="xs" c="dimmed">
              {currentTable}
            </Text>
          )}
        </Group>
        <Badge color={statusBadgeColor} size="sm">
          {hasProgress && connection.status === 'running' ? `${processed} / ${total}` : statusLabel}
        </Badge>
      </Group>

      {hasProgress && connection.status === 'running' && (
        <>
          <Progress value={pct} size="sm" mb="sm" animated={job?.state === 'active'} />

          {((progress?.successCount ?? 0) > 0 || (progress?.failedCount ?? 0) > 0) && (
            <Group gap="xs" mb="xs">
              <Badge color="green" variant="light">
                {(progress?.successCount ?? 0).toLocaleString()} succeeded
              </Badge>
              <Badge color="red" variant="light">
                {(progress?.failedCount ?? 0).toLocaleString()} failed
              </Badge>
            </Group>
          )}

          <Table withColumnBorders fz="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Operation</Table.Th>
                <Table.Th>Planned</Table.Th>
                <Table.Th>Done</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows!.map(({ phase, label, planned, done }) => {
                const isActive = phase === progress?.currentPhase;
                const isComplete = done > 0 && done >= planned && planned > 0;
                return (
                  <Table.Tr key={phase} bg={isActive ? 'var(--mantine-color-blue-light)' : undefined}>
                    <Table.Td>
                      <Group gap={4}>
                        {isActive && <Loader size={10} />}
                        <Text size="xs" fw={isActive ? 600 : 400} c={planned === 0 ? 'dimmed' : undefined}>
                          {label}
                        </Text>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c={planned === 0 ? 'dimmed' : undefined}>
                        {planned === 0 ? '—' : planned.toLocaleString()}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c={isComplete ? 'green' : isActive ? 'blue' : 'dimmed'}>
                        {planned === 0 ? '—' : done.toLocaleString()}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </>
      )}

      {connection.status === 'failed' && connection.failureMessage && (
        <Alert color="red" mt="sm" title="Failure details">
          {connection.failureMessage}
        </Alert>
      )}
    </Box>
  );
}

async function loadValidationCounts(
  localPath: string,
): Promise<{ errors: number; warnings: number; records: number; stats: ValidationStat[] } | null> {
  try {
    const stats: ValidationStat[] = await window.scratchFiles.getValidationStats(localPath);
    return {
      errors: stats.reduce((s, r) => s + r.errors, 0),
      warnings: stats.reduce((s, r) => s + r.warnings, 0),
      records: stats.reduce((s, r) => s + r.records, 0),
      stats,
    };
  } catch {
    return null;
  }
}

export function PublishChangesModal({
  opened,
  onClose,
  workspaceName,
  workspaceId,
  localPath,
  autoStartUploadOnOpen = false,
  assumeUnreviewedApproved = false,
  onDataRefresh,
  currentFolderPath,
  onViewProblems,
}: PublishChangesModalProps) {
  const pollingIntervalRef = useRef<number | null>(null);
  const loggedCompleteJobIdsRef = useRef<Set<string>>(new Set());
  /**
   * Pending waits for jobs to reach a terminal state. A single shared poller
   * (see useEffect below) makes ONE `/jobs/bulk-status` call per second for
   * every job ID registered here and resolves the matching Promise when its
   * job finishes. This replaces the per-job + page-level pollers that used
   * to race each other against the rate-limited bulk-status endpoint.
   */
  const pendingWaitsRef = useRef<Map<string, (status: JobStatus) => void>>(new Map());
  const [mode, setMode] = useState<PublishMode>('approval');
  const [initializing, setInitializing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unreviewedEntries, setUnreviewedEntries] = useState<UnreviewedChangeEntry[]>([]);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [stalenessBannerDismissed, setStalenessBannerDismissed] = useState(false);
  const [publishConnections, setPublishConnections] = useState<ConnectionPublishState[]>([]);
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const [publishErrorDetails, setPublishErrorDetails] = useState<string[]>([]);
  const [closing, setClosing] = useState(false);
  const [validationCounts, setValidationCounts] = useState<{
    errors: number;
    warnings: number;
    records: number;
  } | null>(null);
  const [validationStats, setValidationStats] = useState<ValidationStat[]>([]);

  const stalenessWarning = uploadResult?.stalenessWarning ?? null;

  const startUpload = useCallback(async () => {
    if (!localPath || !workspaceId) {
      return;
    }

    try {
      setError(null);
      setMode('uploading');
      setUploadResult(null);
      setStalenessBannerDismissed(false);
      await trackPublishUploadStarted(workspaceId);

      const result = await window.scratchDesktop.uploadWorkspaceChanges(localPath);
      setUploadResult(result);

      const connectionsWithDiff = result.connections.filter((c) => c.status === 'uploaded');
      await trackPublishUploadCompleted(workspaceId, {
        filesCreated: result.filesCreated,
        filesUpdated: result.filesUpdated,
        filesDeleted: result.filesDeleted,
        connectionCount: connectionsWithDiff.length,
      });

      if (result.status === 'no_changes' || result.status === 'up_to_date') {
        setMode('complete');
        return;
      }

      setMode('uploaded');
    } catch (err) {
      setMode('error');
      setError(err instanceof Error ? err.message : 'Failed to upload workspace changes');
    }
  }, [localPath, workspaceId]);

  const loadInitialState = useCallback(async () => {
    if (!opened || !localPath) {
      return;
    }

    setInitializing(true);
    setError(null);
    setClosing(false);
    setUnreviewedEntries([]);
    setUploadResult(null);
    setStalenessBannerDismissed(false);
    setPublishConnections([]);
    setJobs([]);
    setPublishErrorDetails([]);
    setValidationCounts(null);
    setValidationStats([]);

    try {
      const [nextUnreviewed, counts] = await Promise.all([
        window.scratchDesktop.listUnreviewedChanges(localPath),
        loadValidationCounts(localPath),
      ]);

      setUnreviewedEntries(nextUnreviewed);
      setValidationCounts(
        counts ? { errors: counts.errors, warnings: counts.warnings, records: counts.records } : null,
      );
      setValidationStats(counts?.stats ?? []);

      if (autoStartUploadOnOpen) {
        await startUpload();
        return;
      }

      const hasValidationProblems = counts !== null && counts.records > 0;
      const hasUnreviewed = !assumeUnreviewedApproved && nextUnreviewed.length > 0;

      if (hasUnreviewed || hasValidationProblems) {
        setMode('approval');
        return;
      }

      await startUpload();
    } catch (err) {
      setMode('error');
      setError(err instanceof Error ? err.message : 'Failed to load publish state');
    } finally {
      setInitializing(false);
    }
  }, [assumeUnreviewedApproved, autoStartUploadOnOpen, localPath, opened, startUpload]);

  const continueAfterApproval = useCallback(() => {
    void startUpload();
  }, [startUpload]);

  /**
   * When unreviewed working-tree edits exist at modal-open, the user can't
   * just "Continue to upload" — the CLI's `files publish` pre-flight refuses
   * with `blocked_unreviewed`, so we'd hit that wall later anyway. Force the
   * choice up front: accept the edits (they ride along) or discard them
   * (they don't), then proceed straight into upload. Symmetric with pull's
   * three-button "Accept all and refresh / Discard all and refresh / Cancel"
   * modal.
   */
  const handleAcceptAllAndUpload = useCallback(async () => {
    if (!localPath) return;
    try {
      setError(null);
      setInitializing(true);
      const result = await window.scratchDesktop.acceptAllChanges(localPath);
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || 'scratchmd files accept-all failed');
      }
      setUnreviewedEntries([]);
      await startUpload();
    } catch (err) {
      setMode('error');
      setError(err instanceof Error ? err.message : 'Failed to accept unreviewed changes');
    } finally {
      setInitializing(false);
    }
  }, [localPath, startUpload]);

  const handleDiscardAllAndUpload = useCallback(async () => {
    if (!localPath) return;
    try {
      setError(null);
      setInitializing(true);
      const result = await window.scratchDesktop.discardAllChanges(localPath);
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || 'scratchmd files discard-all failed');
      }
      setUnreviewedEntries([]);
      await startUpload();
    } catch (err) {
      setMode('error');
      setError(err instanceof Error ? err.message : 'Failed to discard unreviewed changes');
    } finally {
      setInitializing(false);
    }
  }, [localPath, startUpload]);

  const handleViewProblems = useCallback(() => {
    if (!localPath || !onViewProblems) return;
    const statsWithProblems = validationStats.filter((s) => s.records > 0);
    if (statsWithProblems.length === 0) return;

    let targetStat = statsWithProblems[0];

    if (currentFolderPath) {
      const rel = currentFolderPath.startsWith(localPath + '/')
        ? currentFolderPath.slice(localPath.length + 1)
        : currentFolderPath;
      const parts = rel.split('/');
      const currentConnection = parts[0];
      const currentFolderRelPath = parts.slice(1).join('/');

      const sameFolder = statsWithProblems.find(
        (s) => s.connection === currentConnection && s.folder_path === currentFolderRelPath,
      );
      const sameConnection = statsWithProblems.find((s) => s.connection === currentConnection);
      targetStat = sameFolder ?? sameConnection ?? statsWithProblems[0];
    }

    onViewProblems(`${localPath}/${targetStat.connection}/${targetStat.folder_path}`);
  }, [currentFolderPath, localPath, onViewProblems, validationStats]);

  const handleClose = useCallback(() => {
    if (closing) {
      return;
    }
    setClosing(true);
    setClosing(false);
    onClose();
  }, [closing, onClose]);

  const handleReviewOnWeb = useCallback(() => {
    if (!workspaceId) return;
    const webUrl = (import.meta.env.VITE_SCRATCH_WEB_URL as string) || 'http://localhost:3000';
    void window.scratchAuth.openExternal(`${webUrl}/workbook/${workspaceId}/review`);
    void trackPublishReviewOnWeb(workspaceId);
  }, [workspaceId]);

  const pollJobToTerminal = useCallback((jobId: string): Promise<JobStatus> => {
    // Register the job in the shared pending-waits map. The single poller in
    // the useEffect below resolves this Promise on the tick that observes
    // the job in a terminal state.
    return new Promise<JobStatus>((resolve) => {
      pendingWaitsRef.current.set(jobId, resolve);
    });
  }, []);

  /**
   * Run plan-job → run-job for a single connection, updating
   * `publishConnections` and `jobs` state as each phase progresses.
   */
  const runConnectionPublish = useCallback(
    async (wbId: string, conn: ConnectionPublishState) => {
      const updateConn = (next: Partial<ConnectionPublishState>) => {
        setPublishConnections((prev) =>
          prev.map((c) => (c.connectionId === conn.connectionId ? { ...c, ...next } : c)),
        );
      };

      try {
        updateConn({ status: 'planning' });
        const plan = await publishApi.startPlanJob(wbId, conn.connectionId);
        if (!plan.jobId || !plan.pipelineId) {
          updateConn({ status: 'plan-no-diff' });
          return;
        }
        const planJobId = String(plan.jobId);
        updateConn({ planJobId, pipelineId: plan.pipelineId });
        await pollJobToTerminal(planJobId);

        updateConn({ status: 'running' });
        const run = await publishApi.startRunJob(wbId, plan.pipelineId);
        if (!run.jobId) {
          updateConn({ status: 'failed', failureMessage: 'run-job did not return a job id' });
          return;
        }
        const runJobId = String(run.jobId);
        updateConn({ runJobId });
        const finalJob = await pollJobToTerminal(runJobId);

        if (finalJob.state !== 'completed' || hasPublishFailures(finalJob)) {
          updateConn({
            status: 'failed',
            failureMessage: getPublishFailureMessage(finalJob),
          });
          return;
        }

        updateConn({ status: 'completed' });
      } catch (err) {
        updateConn({
          status: 'failed',
          failureMessage: err instanceof Error ? err.message : 'Unknown error while publishing',
        });
      }
    },
    [pollJobToTerminal],
  );

  const triggerPublish = useCallback(async () => {
    if (!localPath || !workspaceId || !uploadResult) {
      return;
    }

    try {
      setError(null);
      setPublishErrorDetails([]);
      setMode('publishing');

      const connectionsWithDiff = uploadResult.connections.filter((c) => c.status === 'uploaded');

      // workspaceConfig maps connection name → connectionId (the connector account ID).
      const cfg = await window.scratchFiles.workspaceConfig(localPath);
      const idByName = new Map(cfg.connections.map((c) => [c.dirName, c.id]));

      const initial: ConnectionPublishState[] = connectionsWithDiff.map((c) => {
        const connectionId = idByName.get(c.connectionName);
        if (!connectionId) {
          return {
            connectionId: '',
            connectionName: c.connectionName,
            status: 'failed',
            failureMessage: `Could not resolve connection id for "${c.connectionName}"`,
          };
        }
        return {
          connectionId,
          connectionName: c.connectionName,
          status: 'pending',
        };
      });
      setPublishConnections(initial);
      await trackPublishStarted(workspaceId, initial.length);

      // Fan out plan-job → run-job per connection in parallel.
      await Promise.allSettled(
        initial.map(async (conn) => {
          if (conn.status === 'failed') return;
          await runConnectionPublish(workspaceId, conn);
        }),
      );
    } catch (err) {
      setMode('error');
      setError(err instanceof Error ? err.message : 'Failed to start publish');
    }
  }, [localPath, uploadResult, workspaceId, runConnectionPublish]);

  useEffect(() => {
    if (!opened) {
      return;
    }
    void loadInitialState();
  }, [loadInitialState, opened]);

  // Single consolidated poller. One `/jobs/bulk-status` request per second
  // for every job ID registered in `pendingWaitsRef`, regardless of how many
  // connections are publishing in parallel. Drives BOTH:
  //   (a) the `jobs` state for `<ConnectionPublishRow>` to render live progress
  //   (b) the per-connection `pollJobToTerminal` Promises (resolved when each
  //       job hits a terminal state)
  useEffect(() => {
    if (mode !== 'publishing') {
      if (pollingIntervalRef.current !== null) {
        window.clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
      return;
    }

    let cancelled = false;

    const poll = async () => {
      const activeJobIds = Array.from(pendingWaitsRef.current.keys());
      if (activeJobIds.length === 0) {
        return;
      }

      try {
        const statuses = await jobApi.getJobsStatus(activeJobIds);
        if (cancelled) return;
        const byId = new Map(statuses.map((s) => [s.bullJobId ?? '', s]));
        const hydrated = activeJobIds.map(
          (id) => byId.get(id) ?? { bullJobId: id, state: 'created' as const, type: 'unknown' },
        );
        setJobs(hydrated);

        for (const job of hydrated) {
          const jobId = job.bullJobId ?? '';
          if (!jobId || !isTerminalState(job.state)) continue;

          // Resolve the waiter so the per-connection state machine advances.
          const resolveWaiter = pendingWaitsRef.current.get(jobId);
          if (resolveWaiter) {
            pendingWaitsRef.current.delete(jobId);
            resolveWaiter(job);
          }

          // Log completion exactly once per terminal job.
          if (localPath && !loggedCompleteJobIdsRef.current.has(jobId)) {
            loggedCompleteJobIdsRef.current.add(jobId);
            const failed = job.state !== 'completed' || hasPublishFailures(job);
            const progress = job.publicProgress as PublishFromGitProgress | undefined;
            const summary = progress
              ? {
                  edit: progress.editsPlanned ?? 0,
                  create: progress.createsPlanned ?? 0,
                  delete: progress.deletesPlanned ?? 0,
                  backfill: progress.backfillsPlanned ?? 0,
                  rename: progress.renameFilesPlanned ?? 0,
                }
              : undefined;
            window.scratchDesktop.logPublishJob(localPath, {
              event: 'complete',
              jobId,
              state: job.state,
              successCount: progress?.successCount,
              failedCount: progress?.failedCount,
              summary,
              errorSummary: failed ? getPublishFailureMessage(job) : undefined,
            });
          }
        }
      } catch (err) {
        console.debug('Publish poll failed:', err);
      }
    };

    void poll();
    pollingIntervalRef.current = window.setInterval(() => {
      void poll();
    }, 1000);

    return () => {
      cancelled = true;
      if (pollingIntervalRef.current !== null) {
        window.clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    };
  }, [mode, localPath]);

  // When all per-connection publishes reach a terminal state, transition
  // mode → complete | error and refresh local data.
  useEffect(() => {
    if (mode !== 'publishing' || publishConnections.length === 0) {
      return;
    }
    const allTerminal = publishConnections.every(
      (c) => c.status === 'completed' || c.status === 'failed' || c.status === 'plan-no-diff',
    );
    if (!allTerminal) return;

    const failedConnections = publishConnections.filter((c) => c.status === 'failed');
    const completedCount = publishConnections.filter((c) => c.status === 'completed').length;
    const noDiffCount = publishConnections.filter((c) => c.status === 'plan-no-diff').length;

    if (workspaceId) {
      void trackPublishCompleted(workspaceId, {
        successCount: completedCount,
        failedCount: failedConnections.length,
        noDiffCount,
      });
    }

    const refreshLocal = async () => {
      if (!localPath) return;
      try {
        await window.scratchDesktop.pullWorkspaceChanges(localPath);
        onDataRefresh();
      } catch (err) {
        console.debug('Post-publish pull failed:', err);
      }
    };

    void refreshLocal();

    if (failedConnections.length === 0) {
      setMode('complete');
      return;
    }
    setPublishErrorDetails(failedConnections.map((c) => `${c.connectionName}: ${c.failureMessage ?? 'failed'}`));
    setMode('error');
    setError(failedConnections.map((c) => `${c.connectionName} failed`).join('; '));
  }, [mode, publishConnections, workspaceId, localPath, onDataRefresh]);

  const aggregateTotals = useMemo(() => {
    if (!uploadResult) {
      return { created: 0, updated: 0, deleted: 0 };
    }
    return {
      created: uploadResult.filesCreated,
      updated: uploadResult.filesUpdated,
      deleted: uploadResult.filesDeleted,
    };
  }, [uploadResult]);

  const showStalenessBanner = !!stalenessWarning && !stalenessBannerDismissed;
  const canClose = !closing && mode !== 'uploading' && mode !== 'publishing';

  return (
    <Modal opened={opened} onClose={canClose ? () => handleClose() : () => undefined} title={modeTitle(mode)} size="lg">
      <Stack gap="md">
        {showStalenessBanner && stalenessWarning && (
          <Alert color="yellow" withCloseButton onClose={() => setStalenessBannerDismissed(true)}>
            The server has more recent changes ({stalenessWarning.newHead.slice(0, 7)}) than what&apos;s on your
            computer. Your edits were still uploaded; refresh after publishing finishes to pull them down.
          </Alert>
        )}

        {initializing ? (
          <Center py="md">
            <Loader size="sm" />
          </Center>
        ) : (
          <>
            {mode === 'approval' && (
              <>
                {validationCounts && validationCounts.records > 0 && (
                  <Text size="sm" c={validationCounts.errors > 0 ? 'red' : 'orange'}>
                    {validationCounts.records} record{validationCounts.records === 1 ? '' : 's'} contain validation
                    problems that may prevent them from publishing.
                  </Text>
                )}
                {unreviewedEntries.length > 0 && (
                  <>
                    <Text size="sm">
                      {unreviewedEntries.length.toLocaleString()} record{unreviewedEntries.length === 1 ? '' : 's'}{' '}
                      contain unreviewed local edits.
                    </Text>
                    <Text size="sm" c="dimmed">
                      Publishing is blocked until you decide what to do with these edits. Accept them to publish the new
                      values, or discard them to revert to the last accepted state.
                    </Text>
                  </>
                )}
                <Group justify="flex-end">
                  {onViewProblems && validationCounts && validationCounts.records > 0 && (
                    <Button variant="outline" color="red" onClick={handleViewProblems} disabled={closing}>
                      View Problems
                    </Button>
                  )}
                  <Button variant="default" onClick={() => handleClose()} loading={closing}>
                    Cancel
                  </Button>
                  {unreviewedEntries.length > 0 ? (
                    <>
                      <Button
                        variant="outline"
                        onClick={() => void handleDiscardAllAndUpload()}
                        disabled={closing || initializing}
                      >
                        Discard and publish
                      </Button>
                      <Button onClick={() => void handleAcceptAllAndUpload()} disabled={closing || initializing}>
                        Accept and publish
                      </Button>
                    </>
                  ) : (
                    <Button onClick={() => continueAfterApproval()} disabled={closing}>
                      {validationCounts && validationCounts.records > 0 ? 'Ignore and Continue' : 'Continue'}
                    </Button>
                  )}
                </Group>
              </>
            )}

            {mode === 'uploading' && (
              <Stack gap="lg" align="center" py="xl">
                <Loader size="md" />
                <Stack gap={4} align="center">
                  <Text size="md" fw={500}>
                    Uploading changes to the server
                  </Text>
                  <Text size="sm" c="dimmed">
                    This usually takes a few seconds.
                  </Text>
                </Stack>
              </Stack>
            )}

            {mode === 'uploaded' && uploadResult && (
              <>
                <Text size="sm" c="dimmed">
                  Your changes were uploaded to the server. Click Publish to dispatch them through the connectors, or
                  review them on the web first.
                </Text>

                <Text size="sm" c="dimmed">
                  {formatDiffSummary(aggregateTotals.created, aggregateTotals.updated, aggregateTotals.deleted)}
                </Text>

                <ScrollArea.Autosize mah={320}>
                  <Stack gap="sm">
                    {uploadResult.connections
                      .filter((c) => c.status === 'uploaded')
                      .map((c: UploadConnection) => (
                        <Box
                          key={c.connectionName}
                          p="sm"
                          style={{ border: '1px solid var(--mantine-color-gray-3)', borderRadius: 8 }}
                        >
                          <Group justify="space-between" align="flex-start">
                            <Text fw={600} size="sm">
                              {c.connectionName}
                            </Text>
                            <Text size="sm" c="dimmed">
                              {formatDiffSummary(c.filesCreated, c.filesUpdated, c.filesDeleted)}
                            </Text>
                          </Group>
                          {(c.createdPaths.length > 0 || c.updatedPaths.length > 0 || c.deletedPaths.length > 0) && (
                            <Code block mt="xs">
                              {[...c.createdPaths, ...c.updatedPaths, ...c.deletedPaths].join('\n')}
                            </Code>
                          )}
                        </Box>
                      ))}
                  </Stack>
                </ScrollArea.Autosize>

                {workspaceId && (
                  <Group justify="space-between">
                    <Anchor onClick={handleReviewOnWeb} size="sm">
                      Review on web ↗
                    </Anchor>
                  </Group>
                )}

                <Group justify="space-between">
                  <Button variant="default" onClick={() => handleClose()} loading={closing}>
                    Cancel
                  </Button>
                  <Button onClick={() => void triggerPublish()} disabled={closing}>
                    Publish now
                  </Button>
                </Group>
              </>
            )}

            {mode === 'publishing' && (
              <Stack gap="md">
                {publishConnections.length === 0 ? (
                  <Stack gap="lg" align="center" py="xl">
                    <Loader size="md" />
                    <Stack gap={4} align="center">
                      <Text size="md" fw={500}>
                        Starting publish jobs
                      </Text>
                      <Text size="sm" c="dimmed">
                        Building a plan for each connection.
                      </Text>
                    </Stack>
                  </Stack>
                ) : (
                  publishConnections.map((conn) => {
                    const activeJobId = conn.runJobId ?? conn.planJobId;
                    const job = jobs.find((j) => j.bullJobId === activeJobId);
                    return (
                      <ConnectionPublishRow
                        key={conn.connectionId || conn.connectionName}
                        connection={conn}
                        job={job}
                      />
                    );
                  })
                )}
              </Stack>
            )}

            {mode === 'complete' && (
              <>
                <Alert color="green" title="All data published">
                  {workspaceName ? `${workspaceName} is now in sync.` : 'Your changes were published.'}
                </Alert>
                <Group justify="flex-end">
                  <Button onClick={() => handleClose()} loading={closing}>
                    Close
                  </Button>
                </Group>
              </>
            )}

            {mode === 'error' && (
              <>
                <Alert color="red" title="Publish failed">
                  {error || 'Something went wrong while publishing changes.'}
                </Alert>
                {publishErrorDetails.length > 0 && (
                  <Stack gap="xs">
                    {publishErrorDetails.map((message, index) => (
                      <Text key={`${index}-${message}`} size="sm">
                        {message}
                      </Text>
                    ))}
                  </Stack>
                )}
                <Stack gap="md">
                  {publishConnections.map((conn) => {
                    const activeJobId = conn.runJobId ?? conn.planJobId;
                    const job = jobs.find((j) => j.bullJobId === activeJobId);
                    return (
                      <ConnectionPublishRow
                        key={conn.connectionId || conn.connectionName}
                        connection={conn}
                        job={job}
                      />
                    );
                  })}
                </Stack>
                <Group justify="flex-end">
                  <Button onClick={() => handleClose()} loading={closing}>
                    Close
                  </Button>
                </Group>
              </>
            )}
          </>
        )}
      </Stack>
    </Modal>
  );
}
