'use client';

import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { Text12Medium, Text12Regular } from '@/app/components/base/text';
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
import { useState } from 'react';

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
            <RoutineRunRow key={run.id} workbookId={workbookId} run={run} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function RoutineRunRow({ workbookId, run: listRun }: { workbookId: WorkbookId; run: RoutineRun }) {
  const [expanded, setExpanded] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  // When expanded, the detail fetch (which carries the steps) is the SINGLE source of truth for both
  // the status badge AND the per-step rows. The list (`useRoutineRuns`) and the detail are polled
  // independently, so without this the badge could flip to "completed" a poll cycle before the steps
  // below catch up. `detailRun` wins once loaded; the list row is the fallback while collapsed/loading.
  const { run: detailRun } = useRoutineRun(workbookId, expanded ? listRun.id : null);
  const run = detailRun ?? listRun;

  const isActive = ACTIVE_RUN_STATUSES.has(run.status);
  const duration = formatDuration(run.startedAt, run.finishedAt);

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
    <Box style={{ borderBottom: '0.5px solid var(--fg-divider)' }}>
      <Group
        gap={8}
        wrap="nowrap"
        px="sm"
        py={6}
        style={{ cursor: 'pointer' }}
        onClick={() => setExpanded((value) => !value)}
      >
        <StyledLucideIcon Icon={expanded ? ChevronDownIcon : ChevronRightIcon} size="sm" c="var(--fg-muted)" />
        <Badge size="xs" variant="light" color={RUN_STATUS_COLOR[run.status]} style={{ flexShrink: 0 }}>
          {run.status}
        </Badge>
        <Text12Regular c="var(--fg-secondary)" style={{ flexShrink: 0 }}>
          {run.trigger}
        </Text12Regular>
        <Text12Regular c="dimmed" truncate style={{ flex: 1 }}>
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
  return (
    <Stack gap={0} pb={4} style={{ backgroundColor: 'var(--bg-base)' }}>
      {run.error && (
        <Box px="lg" py={4}>
          <Text12Regular c="var(--mantine-color-red-6)">{run.error}</Text12Regular>
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
  const target = step.sync ?? step.folder ?? step.connection ?? 'all';
  // A completed step with a non-null `error` is a "completed with warnings" (e.g. publish rejections).
  const isWarning = step.status === 'completed' && !!step.error;

  return (
    <Group gap={8} wrap="nowrap" px="lg" py={4}>
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
        {step.action}
      </Text12Medium>
      <Text12Regular c="dimmed" truncate style={{ flex: 1 }}>
        {target}
        {step.error ? ` — ${step.error}` : ''}
      </Text12Regular>
    </Group>
  );
}
