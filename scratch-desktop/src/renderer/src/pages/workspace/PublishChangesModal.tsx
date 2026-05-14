import {
  Alert,
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
import { notifications } from '@mantine/notifications';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ValidationStat } from '../../../../shared/validation-types';
import { LiveCommandOutput } from '../../components/LiveCommandOutput';
import { jobApi, type JobStatus } from '../../lib/job-api';

interface UnreviewedChangeEntry {
  connectionName: string;
  path: string;
  status: string;
}

interface LocalPublishPlan {
  planId: string;
  createdAt: string;
  connectionName: string;
  connectionId: string;
  summary: {
    edit: number;
    create: number;
    delete: number;
    backfill: number;
    rename: number;
  };
  tablePaths: string[];
}

type PublishMode = 'approval' | 'planning' | 'ready' | 'publishing' | 'complete' | 'error';

interface PublishChangesModalProps {
  opened: boolean;
  onClose: () => void;
  workspaceName?: string | null;
  localPath: string | null;
  autoStartPlanningOnOpen?: boolean;
  assumeUnreviewedApproved?: boolean;
  onDataRefresh: () => void;
  /** When set, scopes the publish plan to a single file (relative path within workspace). */
  filterPath?: string | null;
  /** The currently selected folder path in the workspace grid. */
  currentFolderPath?: string | null;
  /** Called when the user wants to view problems in the grid. */
  onViewProblems?: (folderPath: string) => void;
}

function isTerminalState(state: JobStatus['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled' || state === 'unknown';
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

type PublishFromGitProgress = {
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
};

function hasPublishFailures(job: JobStatus | undefined): boolean {
  const progress = job?.publicProgress as PublishFromGitProgress | undefined;
  return (progress?.failedCount ?? 0) > 0;
}

function getPublishFailureMessage(job: JobStatus): string {
  const progress = job.publicProgress as PublishFromGitProgress | undefined;
  const failedCount = progress?.failedCount ?? 0;
  const currentPhase = progress?.currentPhase;

  if (job.failedReason && failedCount > 0 && currentPhase) {
    return `${job.failedReason} (${failedCount} operation${failedCount === 1 ? '' : 's'} failed in ${currentPhase})`;
  }
  if (job.failedReason) {
    return job.failedReason;
  }
  if (failedCount > 0 && currentPhase) {
    return `${failedCount} operation${failedCount === 1 ? '' : 's'} failed in ${currentPhase}.`;
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
      // Phase is complete
      done = planned;
      remaining -= planned;
    } else if (idx === currentPhaseIdx) {
      // Current phase — consume remaining processedCount
      done = Math.min(remaining, planned);
      remaining = 0;
    } else {
      done = 0;
    }

    return { phase, label: PHASE_LABELS[phase], planned, done };
  });
}

function PublishingProgress({ jobIds, jobs }: { jobIds: string[]; jobs: JobStatus[] }) {
  const waiting = jobIds.length === 0;

  if (waiting) {
    return (
      <Stack gap="sm" align="center" py="md">
        <Loader size="sm" />
        <Text size="sm" c="dimmed">
          Uploading reviewed files and starting the publish job…
        </Text>
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      {jobIds.map((jobId) => {
        const job = jobs.find((j) => j.bullJobId === jobId);
        const progress = job?.publicProgress as PublishFromGitProgress | undefined;
        const total = progress?.totalCount ?? 0;
        const processed = progress?.processedCount ?? 0;
        const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
        const hasProgress = total > 0;
        const rows = progress ? computePhaseRows(progress) : null;
        const currentTable = progress?.currentTableName;
        const failedReason = job?.failedReason;

        return (
          <Box key={jobId}>
            <Group justify="space-between" mb={4}>
              <Group gap="xs">
                {!hasProgress && <Loader size={12} />}
                <Text size="sm" fw={500}>
                  {job?.state === 'active' ? 'Publishing…' : (job?.state ?? 'waiting')}
                </Text>
                {currentTable && (
                  <Text size="xs" c="dimmed">
                    {currentTable}
                  </Text>
                )}
              </Group>
              <Badge color={statusColor(job?.state ?? 'created')} size="sm">
                {hasProgress ? `${processed} / ${total}` : (job?.state ?? 'waiting')}
              </Badge>
            </Group>

            {hasProgress && (
              <>
                <Progress value={pct} size="sm" mb="sm" animated={job?.state === 'active'} />

                {(progress?.successCount ?? 0) > 0 || (progress?.failedCount ?? 0) > 0 ? (
                  <Group gap="xs" mb="xs">
                    <Badge color="green" variant="light">
                      {(progress?.successCount ?? 0).toLocaleString()} succeeded
                    </Badge>
                    <Badge color="red" variant="light">
                      {(progress?.failedCount ?? 0).toLocaleString()} failed
                    </Badge>
                  </Group>
                ) : null}

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

                {failedReason && (
                  <Alert color="red" mt="sm" title="Failure details">
                    {failedReason}
                  </Alert>
                )}
              </>
            )}

            {!hasProgress && (
              <Text size="xs" c="dimmed">
                Waiting for job to start…
              </Text>
            )}
          </Box>
        );
      })}
    </Stack>
  );
}

async function loadValidationCounts(
  localPath: string,
  filterPath: string | null,
): Promise<{ errors: number; warnings: number; records: number; stats: ValidationStat[] } | null> {
  try {
    const stats: ValidationStat[] = await window.scratchFiles.getValidationStats(localPath);
    if (!filterPath) {
      return {
        errors: stats.reduce((s, r) => s + r.errors, 0),
        warnings: stats.reduce((s, r) => s + r.warnings, 0),
        records: stats.reduce((s, r) => s + r.records, 0),
        stats,
      };
    }
    const parts = filterPath.split('/');
    const connectionName = parts[0];
    const rest = parts.slice(1);
    const lastPart = rest[rest.length - 1];
    if (lastPart?.includes('.')) {
      // Single record.
      const folderAbsPath = `${localPath}/${connectionName}/${rest.slice(0, -1).join('/')}`;
      const rows = await window.scratchFiles.getValidationResults(localPath, folderAbsPath, lastPart);
      const errors = rows.filter((r) => r.level === 'error').length;
      const warnings = rows.filter((r) => r.level === 'warning').length;
      return { errors, warnings, records: errors + warnings > 0 ? 1 : 0, stats };
    }
    // Single table.
    const folderPath = rest.join('/');
    const folderStats = stats.filter((s) => s.connection === connectionName && s.folder_path === folderPath);
    return {
      errors: folderStats.reduce((s, r) => s + r.errors, 0),
      warnings: folderStats.reduce((s, r) => s + r.warnings, 0),
      records: folderStats.reduce((s, r) => s + r.records, 0),
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
  localPath,
  autoStartPlanningOnOpen = false,
  assumeUnreviewedApproved = false,
  onDataRefresh,
  filterPath,
  currentFolderPath,
  onViewProblems,
}: PublishChangesModalProps) {
  const planningSessionIdRef = useRef<string | null>(null);
  const pollingIntervalRef = useRef<number | null>(null);
  const loggedCompleteJobIdsRef = useRef<Set<string>>(new Set());
  const [mode, setMode] = useState<PublishMode>('approval');
  const [initializing, setInitializing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unreviewedEntries, setUnreviewedEntries] = useState<UnreviewedChangeEntry[]>([]);
  const [plans, setPlans] = useState<LocalPublishPlan[]>([]);
  const [planningOutput, setPlanningOutput] = useState('');
  const [planningRunning, setPlanningRunning] = useState(false);
  const [planningExitCode, setPlanningExitCode] = useState<number | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [closing, setClosing] = useState(false);
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const [publishErrorDetails, setPublishErrorDetails] = useState<string[]>([]);
  const [validationCounts, setValidationCounts] = useState<{
    errors: number;
    warnings: number;
    records: number;
  } | null>(null);
  const [validationStats, setValidationStats] = useState<ValidationStat[]>([]);

  const refreshPlans = useCallback(async (): Promise<LocalPublishPlan[]> => {
    if (!localPath) {
      return [];
    }
    const nextPlans = await window.scratchDesktop.listLocalPublishPlans(localPath);
    setPlans(nextPlans);
    return nextPlans;
  }, [localPath]);

  const startPlanning = useCallback(async () => {
    if (!localPath) {
      return;
    }

    try {
      setError(null);
      setPlans([]);
      setPlanningOutput('');
      setPlanningExitCode(null);
      setPlanningRunning(true);
      setMode('planning');
      await window.scratchDesktop.deleteLocalPublishPlans(localPath);
      const { sessionId } = await window.scratchDesktop.startPlanPublish(localPath, filterPath ?? undefined);
      planningSessionIdRef.current = sessionId;
    } catch (err) {
      setPlanningRunning(false);
      setMode('error');
      setError(err instanceof Error ? err.message : 'Failed to start publish plan');
    }
  }, [filterPath, localPath]);

  const loadInitialState = useCallback(async () => {
    if (!opened || !localPath) {
      return;
    }

    setInitializing(true);
    setError(null);
    setClosing(false);
    setUnreviewedEntries([]);
    setPlans([]);
    setPlanningOutput('');
    setPlanningExitCode(null);
    setPlanningRunning(false);
    setPublishing(false);
    setJobIds([]);
    setJobs([]);
    setPublishErrorDetails([]);
    setValidationCounts(null);
    setValidationStats([]);
    planningSessionIdRef.current = null;

    try {
      const [nextUnreviewed, counts] = await Promise.all([
        window.scratchDesktop.listUnreviewedChanges(localPath),
        loadValidationCounts(localPath, filterPath ?? null),
      ]);

      setUnreviewedEntries(nextUnreviewed);
      setValidationCounts(
        counts ? { errors: counts.errors, warnings: counts.warnings, records: counts.records } : null,
      );
      setValidationStats(counts?.stats ?? []);

      if (autoStartPlanningOnOpen || filterPath) {
        await startPlanning();
        return;
      }

      const hasValidationProblems = counts !== null && counts.records > 0;
      const hasUnreviewed = !assumeUnreviewedApproved && nextUnreviewed.length > 0;

      if (hasUnreviewed || hasValidationProblems) {
        setMode('approval');
        return;
      }

      await startPlanning();
    } catch (err) {
      setMode('error');
      setError(err instanceof Error ? err.message : 'Failed to load publish state');
    } finally {
      setInitializing(false);
    }
  }, [assumeUnreviewedApproved, autoStartPlanningOnOpen, filterPath, localPath, opened, startPlanning]);

  const continueAfterApproval = useCallback(() => {
    void startPlanning();
  }, [startPlanning]);

  const handleViewProblems = useCallback(() => {
    if (!localPath || !onViewProblems) return;
    const statsWithProblems = validationStats.filter((s) => s.records > 0);
    if (statsWithProblems.length === 0) return;

    let targetStat = statsWithProblems[0];

    if (currentFolderPath) {
      // Derive connection name from currentFolderPath relative to localPath
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

  const handleClose = useCallback(async () => {
    if (closing) {
      return;
    }

    setClosing(true);

    try {
      if (localPath) {
        await window.scratchDesktop.deleteLocalPublishPlans(localPath);
      }
    } catch (err) {
      console.debug('Failed to delete local publish plans on close:', err);
      notifications.show({
        title: 'Publish plan cleanup failed',
        message: err instanceof Error ? err.message : 'Failed to delete the local publish plan.',
        color: 'red',
      });
    }

    setClosing(false);
    onClose();
  }, [closing, localPath, onClose]);

  const triggerPublish = useCallback(async () => {
    if (!localPath) {
      return;
    }

    try {
      setError(null);
      setPublishing(true);
      setMode('publishing');
      setJobIds([]);
      setJobs([]);
      setPublishErrorDetails([]);
      await window.scratchDesktop.pushWorkspaceChanges(localPath);
      const result = await window.scratchDesktop.triggerPublishFromGit(localPath);

      if (result.jobIds.length === 0) {
        setPublishing(false);
        setMode('error');
        setError(result.stdout.trim() || 'No publish jobs were queued.');
        return;
      }

      loggedCompleteJobIdsRef.current = new Set();
      if (localPath) {
        const aggregateSummary = plans.reduce(
          (acc, plan) => ({
            edit: acc.edit + plan.summary.edit,
            create: acc.create + plan.summary.create,
            delete: acc.delete + plan.summary.delete,
            backfill: acc.backfill + plan.summary.backfill,
            rename: acc.rename + plan.summary.rename,
          }),
          { edit: 0, create: 0, delete: 0, backfill: 0, rename: 0 },
        );
        const tables = Array.from(new Set(plans.flatMap((plan) => plan.tablePaths)));
        window.scratchDesktop.logPublishJob(localPath, {
          event: 'start',
          jobIds: result.jobIds,
          tables,
          plans: plans.length,
          summary: aggregateSummary,
        });
      }
      setJobIds(result.jobIds);
    } catch (err) {
      setPublishing(false);
      setMode('error');
      setError(err instanceof Error ? err.message : 'Failed to trigger publish-from-git');
    }
  }, [localPath, plans]);

  useEffect(() => {
    if (!opened) {
      return;
    }
    void loadInitialState();
  }, [loadInitialState, opened]);

  useEffect(() => {
    const unsubscribe = window.scratchDesktop.onCommandEvent((event) => {
      if (planningSessionIdRef.current !== event.sessionId) {
        return;
      }

      if (event.type === 'chunk') {
        setPlanningOutput((current) => current + event.chunk);
        return;
      }

      planningSessionIdRef.current = null;
      setPlanningRunning(false);
      setPlanningExitCode(event.exitCode);

      if (event.exitCode !== 0) {
        setMode('error');
        setError(event.error || `scratchmd exited with code ${event.exitCode}`);
        return;
      }

      void refreshPlans()
        .then((nextPlans) => {
          setMode('ready');
          if (nextPlans.length === 0) {
            notifications.show({
              title: 'Nothing to publish',
              message: `${workspaceName || 'Workspace'} is already in sync.`,
              color: 'blue',
            });
          }
        })
        .catch((err) => {
          setMode('error');
          setError(err instanceof Error ? err.message : 'Failed to refresh publish plan state');
        });
    });

    return unsubscribe;
  }, [refreshPlans, workspaceName]);

  useEffect(() => {
    if (mode !== 'publishing' || jobIds.length === 0) {
      if (pollingIntervalRef.current !== null) {
        window.clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
      return;
    }

    let cancelled = false;

    const pullLatestWorkspaceState = async () => {
      if (!localPath) {
        return;
      }

      try {
        await window.scratchDesktop.pullWorkspaceChanges(localPath);
        onDataRefresh();
      } catch (err) {
        console.debug('Post-publish pull failed:', err);
      }
    };

    const poll = async () => {
      try {
        const statuses = await jobApi.getJobsStatus(jobIds);
        if (cancelled) {
          return;
        }

        const byId = new Map(statuses.map((job) => [job.bullJobId ?? '', job]));
        const hydrated = jobIds.map(
          (jobId) => byId.get(jobId) ?? { bullJobId: jobId, state: 'created' as const, type: 'publish-from-git' },
        );
        setJobs(hydrated);

        if (localPath) {
          for (const job of hydrated) {
            const jobId = job.bullJobId ?? '';
            if (!jobId || !isTerminalState(job.state) || loggedCompleteJobIdsRef.current.has(jobId)) {
              continue;
            }
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

        if (hydrated.every((job) => isTerminalState(job.state))) {
          if (pollingIntervalRef.current !== null) {
            window.clearInterval(pollingIntervalRef.current);
            pollingIntervalRef.current = null;
          }

          await pullLatestWorkspaceState();
          if (cancelled) {
            return;
          }

          setPublishing(false);
          const failedJobs = hydrated.filter((job) => job.state !== 'completed' || hasPublishFailures(job));

          if (failedJobs.length === 0) {
            setMode('complete');
            return;
          }

          setPublishErrorDetails(failedJobs.map((job) => getPublishFailureMessage(job)));
          setMode('error');
          setError(failedJobs.map((job) => getPublishFailureMessage(job)).join(' '));
        }
      } catch (err) {
        if (cancelled) {
          return;
        }
        setPublishing(false);
        setMode('error');
        setError(err instanceof Error ? err.message : 'Failed to poll publish jobs');
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
  }, [jobIds, localPath, mode, onDataRefresh]);

  const totals = useMemo(
    () =>
      plans.reduce(
        (acc, plan) => {
          acc.edit += plan.summary.edit;
          acc.create += plan.summary.create;
          acc.delete += plan.summary.delete;
          acc.backfill += plan.summary.backfill;
          acc.rename += plan.summary.rename;
          return acc;
        },
        { edit: 0, create: 0, delete: 0, backfill: 0, rename: 0 },
      ),
    [plans],
  );

  const canClose = !planningRunning && !publishing && !closing;

  return (
    <Modal
      opened={opened}
      onClose={canClose ? () => void handleClose() : () => undefined}
      title={filterPath ? 'Publish file' : 'Publish changes'}
      size="lg"
    >
      <Stack gap="md">
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
                      {unreviewedEntries.length} record{unreviewedEntries.length === 1 ? '' : 's'} contain unreviewed
                      changes that will not be published.
                    </Text>
                    <Text size="sm" c="dimmed">
                      Continue to plan and publish from the reviewed local dirty branch, or cancel and review those
                      edits first.
                    </Text>
                  </>
                )}
                <Group justify="flex-end">
                  {onViewProblems && validationCounts && validationCounts.records > 0 && (
                    <Button variant="outline" color="red" onClick={handleViewProblems} disabled={closing}>
                      View Problems
                    </Button>
                  )}
                  <Button variant="default" onClick={() => void handleClose()} loading={closing}>
                    Cancel
                  </Button>
                  <Button onClick={() => continueAfterApproval()} disabled={closing}>
                    {validationCounts && validationCounts.records > 0 ? 'Ignore and Continue' : 'Continue'}
                  </Button>
                </Group>
              </>
            )}

            {mode === 'planning' && (
              <>
                <Text size="sm" c="dimmed">
                  Building a publish plan from the reviewed local dirty branch.
                </Text>
                <LiveCommandOutput
                  output={planningOutput}
                  running={planningRunning}
                  exitCode={planningExitCode}
                  emptyMessage="Preparing publish plan..."
                />
              </>
            )}

            {mode === 'ready' && (
              <>
                {plans.length > 0 ? (
                  <>
                    <Text size="sm" c="dimmed">
                      The publish plan is ready. Review the summary below, then publish when ready.
                    </Text>

                    <Group gap="xs">
                      <Badge color="blue">{totals.edit} edit</Badge>
                      <Badge color="green">{totals.create} create</Badge>
                      <Badge color="red">{totals.delete} delete</Badge>
                      <Badge color="orange">{totals.backfill} backfill</Badge>
                      <Badge color="grape">{totals.rename} rename</Badge>
                    </Group>

                    <ScrollArea.Autosize mah={320}>
                      <Stack gap="sm">
                        {plans.map((plan) => (
                          <Box
                            key={`${plan.connectionId}:${plan.planId}`}
                            p="sm"
                            style={{ border: '1px solid var(--mantine-color-gray-3)', borderRadius: 8 }}
                          >
                            <Group justify="space-between" align="flex-start">
                              <Box>
                                <Text fw={600} size="sm">
                                  {plan.connectionName}
                                </Text>
                                <Text size="xs" c="dimmed">
                                  {new Date(plan.createdAt).toLocaleString()}
                                </Text>
                              </Box>
                              <Group gap={6}>
                                <Badge color="blue">{plan.summary.edit} edit</Badge>
                                <Badge color="green">{plan.summary.create} create</Badge>
                                <Badge color="red">{plan.summary.delete} delete</Badge>
                              </Group>
                            </Group>
                            {plan.tablePaths.length > 0 && (
                              <Code block mt="xs">
                                {plan.tablePaths.join('\n')}
                              </Code>
                            )}
                          </Box>
                        ))}
                      </Stack>
                    </ScrollArea.Autosize>

                    <Group justify="space-between">
                      <Button variant="default" onClick={() => void handleClose()} loading={closing}>
                        Cancel
                      </Button>
                      <Button onClick={() => void triggerPublish()} disabled={closing}>
                        Publish now
                      </Button>
                    </Group>
                  </>
                ) : (
                  <>
                    <Text size="sm">Nothing needs to be published.</Text>
                    <Group justify="flex-end">
                      <Button onClick={() => void handleClose()} loading={closing}>
                        Close
                      </Button>
                    </Group>
                  </>
                )}
              </>
            )}

            {mode === 'publishing' && <PublishingProgress jobIds={jobIds} jobs={jobs} />}

            {mode === 'complete' && (
              <>
                <Alert color="green" title="All data published">
                  All data published
                </Alert>
                <Group justify="flex-end">
                  <Button onClick={() => void handleClose()} loading={closing}>
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
                <PublishingProgress jobIds={jobIds} jobs={jobs} />
                {jobs.length > 0 && (
                  <Stack gap="sm">
                    {jobs.map((job) => (
                      <Stack key={job.bullJobId ?? job.dbJobId ?? job.type} gap={4}>
                        <Group justify="space-between">
                          <Code>{job.bullJobId ?? job.dbJobId ?? job.type}</Code>
                          <Badge color={statusColor(job.state)}>{job.state}</Badge>
                        </Group>
                        {job.failedReason && (
                          <Text size="xs" c="red">
                            {job.failedReason}
                          </Text>
                        )}
                      </Stack>
                    ))}
                  </Stack>
                )}
                <Group justify="flex-end">
                  <Button onClick={() => void handleClose()} loading={closing}>
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
