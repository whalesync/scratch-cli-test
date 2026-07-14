'use client';

import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { Text12Medium, Text12Regular, TextMono12Regular } from '@/app/components/base/text';
import { JobProgressDetail, JobStatLine } from '@/app/components/jobs/JobProgressDetail';
import { useDevTools } from '@/hooks/use-dev-tools';
import { useRoutineRun, useRoutineRuns } from '@/hooks/use-routine-runs';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { trackRoutineRunCancelled } from '@/lib/posthog';
import { ActionIcon, Badge, Box, Collapse, Group, Loader, Stack, Tooltip, type MantineColor } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type {
  RoutineRun,
  RoutineRunStatus,
  RoutineRunStep,
  RoutineRunStepStatus,
  WorkbookId,
} from '@spinner/shared-types';
import { ChevronDownIcon, ChevronRightIcon, XCircleIcon } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

interface RoutineRunHistoryProps {
  workbookId: WorkbookId;
  routineFilePath: string;
}

const RUN_STATUS_COLOR: Record<RoutineRunStatus, MantineColor> = {
  pending: 'gray',
  running: 'blue',
  completed: 'green',
  failed: 'red',
  cancelled: 'gray',
};

const STEP_STATUS_COLOR: Record<RoutineRunStepStatus, MantineColor> = {
  pending: 'gray',
  running: 'blue',
  completed: 'green',
  failed: 'red',
  skipped: 'gray',
};

const ACTIVE_RUN_STATUSES = new Set<RoutineRunStatus>(['pending', 'running']);

/** Formats the elapsed time between two ISO timestamps (or to now) as e.g. "12s" / "1m 5s". */
function formatDuration(startedAt: string | null, finishedAt: string | null): string | null {
  if (!startedAt) {
    return null;
  }
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - new Date(startedAt).getTime()) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Run history for one routine, below the editor. Polls while a run is active (via the hooks). */
export function RoutineRunHistory({ workbookId, routineFilePath }: RoutineRunHistoryProps) {
  const { runs, isLoading } = useRoutineRuns(workbookId, routineFilePath);
  // A `?runId=` query param deep-links a specific run: the matching row starts expanded and scrolls
  // into view. The param is copied verbatim into the address bar as rows are expanded/collapsed
  // (see `RoutineRunRow`), so the currently-focused run is always shareable.
  const deepLinkedRunId = useSearchParams().get('runId');

  return (
    <Stack gap={0}>
      <Box px="sm" py={6} style={{ borderBottom: '0.5px solid var(--fg-divider)' }}>
        <Text12Medium c="var(--fg-secondary)">Run history</Text12Medium>
      </Box>

      {isLoading && runs.length === 0 ? (
        <Box p="sm">
          <Text12Regular c="dimmed">Loading runs…</Text12Regular>
        </Box>
      ) : runs.length === 0 ? (
        <Box p="sm">
          <Text12Regular c="dimmed">No runs yet — press Run to start one.</Text12Regular>
        </Box>
      ) : (
        <Stack gap={0}>
          {runs.map((run) => (
            <RoutineRunRow key={run.id} workbookId={workbookId} run={run} isDeepLinked={run.id === deepLinkedRunId} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function RoutineRunRow({
  workbookId,
  run: listRun,
  isDeepLinked,
}: {
  workbookId: WorkbookId;
  run: RoutineRun;
  isDeepLinked: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rowRef = useRef<HTMLDivElement>(null);
  // A run reached via `?runId=` starts expanded; otherwise rows start collapsed.
  const [expanded, setExpanded] = useState(isDeepLinked);
  const [isCancelling, setIsCancelling] = useState(false);

  // Scroll the deep-linked run into view once, on mount, so it isn't buried below a long history.
  useEffect(() => {
    if (isDeepLinked) {
      rowRef.current?.scrollIntoView({ block: 'nearest' });
    }
    // Run only on mount: subsequent expand/collapse shouldn't hijack scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Expanding a run writes its id to `?runId=` so the URL is a copyable deep link; collapsing the
  // run that currently owns the param clears it. Preserves any other query params (e.g. filters).
  const toggleExpanded = () => {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    const params = new URLSearchParams(searchParams.toString());
    if (nextExpanded) {
      params.set('runId', listRun.id);
    } else if (params.get('runId') === listRun.id) {
      params.delete('runId');
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  // When expanded, the detail fetch (which carries the steps) is the SINGLE source of truth for both
  // the status badge AND the per-step rows. The list (`useRoutineRuns`) and the detail are polled
  // independently, so without this the badge could flip to "completed" a poll cycle before the steps
  // below catch up. `detailRun` wins once loaded; the list row is the fallback while collapsed/loading.
  const { run: detailRun } = useRoutineRun(workbookId, expanded ? listRun.id : null, true);
  const run = detailRun ?? listRun;

  const isActive = ACTIVE_RUN_STATUSES.has(run.status);
  const duration = formatDuration(run.startedAt, run.finishedAt);
  // A run that COMPLETED but carries a `resultWarning` finished "completed with warnings" (e.g. a step
  // whose publish had connector-rejected records). Mirror the per-step treatment: a yellow "completed*"
  // badge instead of the plain green check, so the whole run doesn't read as a clean success.
  const isWarning = run.status === 'completed' && !!run.resultWarning;
  // The end-result message: the new resultSummary, falling back to the deprecated error column.
  const resultMessage = run.resultSummary ?? run.error;

  const handleCancel = async (event: React.MouseEvent) => {
    event.stopPropagation();
    setIsCancelling(true);
    try {
      await scratchApiClient.routine.cancelRun(workbookId, run.id);
      trackRoutineRunCancelled(workbookId, run.id);
      notifications.show({ title: 'Run cancelled', message: `Run ${run.id}`, color: 'gray' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to cancel run.';
      notifications.show({ title: 'Could not cancel run', message, color: 'red' });
    } finally {
      setIsCancelling(false);
    }
  };

  return (
    <Box ref={rowRef} style={{ borderBottom: '0.5px solid var(--fg-divider)' }}>
      <Group gap={8} wrap="nowrap" px="sm" py={6} style={{ cursor: 'pointer' }} onClick={toggleExpanded}>
        <StyledLucideIcon Icon={expanded ? ChevronDownIcon : ChevronRightIcon} size="sm" c="var(--fg-muted)" />
        <Badge
          size="xs"
          variant="light"
          color={isWarning ? 'yellow' : RUN_STATUS_COLOR[run.status]}
          style={{ flexShrink: 0 }}
        >
          {isWarning ? 'completed*' : run.status}
        </Badge>
        <Text12Regular c="var(--fg-secondary)" style={{ flexShrink: 0 }}>
          {run.trigger}
        </Text12Regular>
        {resultMessage ? (
          <Text12Regular
            c={run.status === 'failed' ? 'var(--mantine-color-red-6)' : 'dimmed'}
            truncate
            style={{ flex: 1 }}
          >
            {resultMessage}
          </Text12Regular>
        ) : (
          <Box style={{ flex: 1 }} />
        )}
        <Text12Regular c="dimmed" style={{ flexShrink: 0 }}>
          {new Date(run.createdAt).toLocaleString()}
          {duration ? ` · ${duration}` : ''}
        </Text12Regular>
        {isActive && (
          <Tooltip label="Cancel run" position="left">
            <ActionIcon size="sm" variant="subtle" color="red" loading={isCancelling} onClick={handleCancel}>
              <XCircleIcon size={14} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>

      {/* Steps come from the SAME `detailRun` fetch as the badge above, so they never disagree. */}
      <Collapse in={expanded}>{expanded && <RoutineRunSteps run={detailRun} />}</Collapse>
    </Box>
  );
}

function RoutineRunSteps({ run }: { run: RoutineRun | undefined }) {
  if (!run) {
    return (
      <Group gap={6} px="lg" py={6}>
        <Loader size="xs" />
        <Text12Regular c="dimmed">Loading steps…</Text12Regular>
      </Group>
    );
  }

  const steps = run.steps ?? [];
  // The end-result message: the new resultSummary, falling back to the deprecated error column.
  const resultMessage = run.resultSummary ?? run.error;
  return (
    <Stack gap={0} pb={4} style={{ backgroundColor: 'var(--bg-base)' }}>
      {resultMessage && (
        <Box px="lg" py={4}>
          <Text12Regular c={run.status === 'failed' ? 'var(--mantine-color-red-6)' : 'var(--fg-secondary)'}>
            {resultMessage}
          </Text12Regular>
        </Box>
      )}
      {steps.map((step) => (
        <RoutineStepRow key={step.id} step={step} />
      ))}
      {steps.length === 0 && (
        <Box px="lg" py={4}>
          <Text12Regular c="dimmed">No steps recorded.</Text12Regular>
        </Box>
      )}
    </Stack>
  );
}

function RoutineStepRow({ step }: { step: RoutineRunStep }) {
  const [expanded, setExpanded] = useState(false);
  // Pull steps target a list of folders; everything else targets a single folder, a sync, or a connection.
  const folderTarget = step.folders.length > 0 ? step.folders.join(', ') : step.folder;
  const target = step.sync ?? folderTarget ?? step.connection ?? 'all';
  // A completed step with a non-null `error` is a "completed with warnings" (e.g. publish rejections).
  const isWarning = step.status === 'completed' && !!step.error;
  // The step's own headline result ("Pulled 3 records across 2 folders"), computed server-side. Falls
  // back to the target (folder/sync/connection) when the step hasn't produced a result yet.
  const stepSummary = step.result?.summary || target;

  return (
    <Box>
      <Group
        gap={8}
        wrap="nowrap"
        px="lg"
        py={4}
        style={{ cursor: 'pointer' }}
        onClick={() => setExpanded((value) => !value)}
      >
        <StyledLucideIcon Icon={expanded ? ChevronDownIcon : ChevronRightIcon} size="sm" c="var(--fg-muted)" />
        <Text12Regular c="dimmed" style={{ width: 16, flexShrink: 0 }}>
          {step.stepIndex + 1}
        </Text12Regular>
        <Badge
          size="xs"
          variant="light"
          color={isWarning ? 'yellow' : STEP_STATUS_COLOR[step.status]}
          style={{ flexShrink: 0 }}
        >
          {isWarning ? 'completed*' : step.status}
        </Badge>
        <Text12Medium c="var(--fg-primary)" style={{ flexShrink: 0 }}>
          {step.displayName ?? step.action}
        </Text12Medium>
        <Text12Regular c="dimmed" truncate style={{ flex: 1 }}>
          {stepSummary}
          {step.error ? ` — ${step.error}` : ''}
        </Text12Regular>
      </Group>

      <Collapse in={expanded}>
        <RoutineStepDetail step={step} />
      </Collapse>
    </Box>
  );
}

/** Expanded detail for one step: snapshot metadata not shown in the row, plus its job's progress. */
function RoutineStepDetail({ step }: { step: RoutineRunStep }) {
  const { isDevToolsEnabled } = useDevTools();

  const duration = formatDuration(step.startedAt, step.finishedAt);
  // Only metadata not already visible in the step row; each row is rendered only when it has a value.
  const metadataRows: Array<{ label: string; value: string; mono?: boolean }> = [];
  if (step.startedAt) metadataRows.push({ label: 'Started', value: new Date(step.startedAt).toLocaleString() });
  // if (step.finishedAt) metadataRows.push({ label: 'Finished', value: new Date(step.finishedAt).toLocaleString() });
  if (duration) metadataRows.push({ label: 'Duration', value: duration });
  if (isDevToolsEnabled) {
    if (step.timeoutSeconds != null) metadataRows.push({ label: 'Timeout', value: `${step.timeoutSeconds}s` });
    if (step.options?.fullPull) metadataRows.push({ label: 'Full pull', value: 'yes' });
    if (step.pipelineId) metadataRows.push({ label: 'Publish plan', value: step.pipelineId, mono: true });
    if (step.jobId) metadataRows.push({ label: 'Job ID', value: step.jobId, mono: true });
  }

  return (
    <Box style={{ backgroundColor: 'var(--bg-base)' }}>
      {metadataRows.length > 0 && (
        <Stack gap={2} px="lg" py={6}>
          {metadataRows.map((row) => (
            <Group key={row.label} gap={8} wrap="nowrap" align="flex-start">
              <Text12Medium c="var(--fg-secondary)" style={{ width: 96, flexShrink: 0 }}>
                {row.label}
              </Text12Medium>
              {row.mono ? (
                <TextMono12Regular c="var(--fg-secondary)" style={{ wordBreak: 'break-all' }}>
                  {row.value}
                </TextMono12Regular>
              ) : (
                <Text12Regular c="var(--fg-secondary)" style={{ wordBreak: 'break-all' }}>
                  {row.value}
                </Text12Regular>
              )}
            </Group>
          ))}
        </Stack>
      )}
      {/* Persisted headline counters ("3 Created · 0 Updated …"). Survive the job aging out of
          retention, so they show even when the live job detail below is gone. */}
      {step.result && step.result.stats.length > 0 && (
        <Box px="lg" py={6}>
          <JobStatLine stats={step.result.stats} />
        </Box>
      )}
      {step.job ? (
        <JobProgressDetail job={step.job} />
      ) : (
        <Text12Regular c="dimmed" px="lg" pb={6}>
          No job recorded for this step.
        </Text12Regular>
      )}
    </Box>
  );
}
