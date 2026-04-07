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

export function PublishChangesModal({
  opened,
  onClose,
  workspaceName,
  localPath,
  autoStartPlanningOnOpen = false,
  assumeUnreviewedApproved = false,
}: PublishChangesModalProps) {
  const planningSessionIdRef = useRef<string | null>(null);
  const pollingIntervalRef = useRef<number | null>(null);
  const [mode, setMode] = useState<PublishMode>('approval');
  const [initializing, setInitializing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unreviewedEntries, setUnreviewedEntries] = useState<UnreviewedChangeEntry[]>([]);
  const [plans, setPlans] = useState<LocalPublishPlan[]>([]);
  const [planSource, setPlanSource] = useState<'existing' | 'new' | null>(null);
  const [planningOutput, setPlanningOutput] = useState('');
  const [planningRunning, setPlanningRunning] = useState(false);
  const [planningExitCode, setPlanningExitCode] = useState<number | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [jobIds, setJobIds] = useState<string[]>([]);
  const [jobs, setJobs] = useState<JobStatus[]>([]);

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
      setPlanningOutput('');
      setPlanningExitCode(null);
      setPlanningRunning(true);
      setMode('planning');
      const { sessionId } = await window.scratchDesktop.startPlanPublish(localPath);
      planningSessionIdRef.current = sessionId;
    } catch (err) {
      setPlanningRunning(false);
      setMode('error');
      setError(err instanceof Error ? err.message : 'Failed to start publish plan');
    }
  }, [localPath]);

  const loadInitialState = useCallback(async () => {
    if (!opened || !localPath) {
      return;
    }

    setInitializing(true);
    setError(null);
    setPlanningOutput('');
    setPlanningExitCode(null);
    setPlanningRunning(false);
    setPublishing(false);
    setJobIds([]);
    setJobs([]);
    planningSessionIdRef.current = null;

    try {
      const [nextUnreviewed, nextPlans] = await Promise.all([
        window.scratchDesktop.listUnreviewedChanges(localPath),
        window.scratchDesktop.listLocalPublishPlans(localPath),
      ]);

      setUnreviewedEntries(nextUnreviewed);
      setPlans(nextPlans);

      if (autoStartPlanningOnOpen) {
        setPlanSource('new');
        await startPlanning();
        return;
      }

      if (!assumeUnreviewedApproved && nextUnreviewed.length > 0) {
        setPlanSource(nextPlans.length > 0 ? 'existing' : null);
        setMode('approval');
        return;
      }

      if (nextPlans.length > 0) {
        setPlanSource('existing');
        setMode('ready');
        return;
      }

      setPlanSource('new');
      await startPlanning();
    } catch (err) {
      setMode('error');
      setError(err instanceof Error ? err.message : 'Failed to load publish state');
    } finally {
      setInitializing(false);
    }
  }, [assumeUnreviewedApproved, autoStartPlanningOnOpen, localPath, opened, startPlanning]);

  const continueAfterApproval = useCallback(() => {
    if (plans.length > 0) {
      setPlanSource('existing');
      setMode('ready');
      return;
    }

    setPlanSource('new');
    void startPlanning();
  }, [plans.length, startPlanning]);

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
      await window.scratchDesktop.pushWorkspaceChanges(localPath);
      const result = await window.scratchDesktop.triggerPublishFromGit(localPath);

      if (result.jobIds.length === 0) {
        setPublishing(false);
        setMode('error');
        setError(result.stdout.trim() || 'No publish jobs were queued.');
        return;
      }

      setJobIds(result.jobIds);
    } catch (err) {
      setPublishing(false);
      setMode('error');
      setError(err instanceof Error ? err.message : 'Failed to trigger publish-from-git');
    }
  }, [localPath]);

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
          setPlanSource('new');
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

        if (hydrated.every((job) => isTerminalState(job.state))) {
          setPublishing(false);
          if (pollingIntervalRef.current !== null) {
            window.clearInterval(pollingIntervalRef.current);
            pollingIntervalRef.current = null;
          }

          if (hydrated.every((job) => job.state === 'completed')) {
            setMode('complete');
            if (localPath) {
              window.scratchDesktop.pullWorkspaceChanges(localPath).catch((err) => {
                console.debug('Post-publish pull failed:', err);
              });
            }
            return;
          }

          setMode('error');
          setError('One or more publish jobs did not complete successfully.');
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
  }, [jobIds, localPath, mode]);

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

  const canClose = !planningRunning && !publishing;

  return (
    <Modal opened={opened} onClose={canClose ? onClose : () => undefined} title="Publish changes" size="lg">
      <Stack gap="md">
        {initializing ? (
          <Center py="md">
            <Loader size="sm" />
          </Center>
        ) : (
          <>
            {mode === 'approval' && (
              <>
                <Text size="sm">
                  {unreviewedEntries.length} records contain unreviewed changes that will not be published.
                </Text>
                <Text size="sm" c="dimmed">
                  Continue to plan and publish from the reviewed local dirty branch, or cancel and review those edits
                  first.
                </Text>
                <Group justify="flex-end">
                  <Button variant="default" onClick={onClose}>
                    Cancel
                  </Button>
                  <Button onClick={() => continueAfterApproval()}>Continue</Button>
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
                      {planSource === 'existing'
                        ? 'An existing local publish plan was found. You can continue with it or rebuild it.'
                        : 'The publish plan is ready. Review the summary below, then publish when ready.'}
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
                      <Button variant="default" onClick={onClose}>
                        Cancel
                      </Button>
                      <Group>
                        <Button variant="default" onClick={() => void startPlanning()}>
                          Start new plan
                        </Button>
                        <Button onClick={() => void triggerPublish()}>
                          {planSource === 'existing' ? 'Continue publish plan' : 'Publish now'}
                        </Button>
                      </Group>
                    </Group>
                  </>
                ) : (
                  <>
                    <Text size="sm">Nothing needs to be published.</Text>
                    <Group justify="flex-end">
                      <Button onClick={onClose}>Close</Button>
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
                  <Button onClick={onClose}>Close</Button>
                </Group>
              </>
            )}

            {mode === 'error' && (
              <>
                <Alert color="red" title="Publish failed">
                  {error || 'Something went wrong while publishing changes.'}
                </Alert>
                {jobs.length > 0 && (
                  <Stack gap="sm">
                    {jobs.map((job) => (
                      <Group key={job.bullJobId ?? job.dbJobId ?? job.type} justify="space-between">
                        <Code>{job.bullJobId ?? job.dbJobId ?? job.type}</Code>
                        <Badge color={statusColor(job.state)}>{job.state}</Badge>
                      </Group>
                    ))}
                  </Stack>
                )}
                <Group justify="flex-end">
                  <Button onClick={onClose}>Close</Button>
                </Group>
              </>
            )}
          </>
        )}
      </Stack>
    </Modal>
  );
}
