'use client';

import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { Text12Medium, Text12Regular } from '@/app/components/base/text';
import { useRoutines } from '@/hooks/use-routines';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { useRoutineDraftStore } from '@/stores/routine-draft-store';
import { Badge, Box, Group, ScrollArea, Stack, Tooltip, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { Routine, RoutineRunStatus, WorkbookId } from '@spinner/shared-types';
import { AlertCircleIcon, AlertTriangleIcon, ClockIcon, PlusIcon, RefreshCwIcon, WorkflowIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';

interface RoutinesListProps {
  workbookId: WorkbookId;
}

/** The route segment for a routine is its bare file name (routines live flat under `routines/`). */
function routineFileName(filePath: string): string {
  return filePath.includes('/') ? filePath.slice(filePath.lastIndexOf('/') + 1) : filePath;
}

/** Colour for a run-status dot. Wired now; stays unused until the routine runner produces runs. */
const RUN_STATUS_COLOR: Record<RoutineRunStatus, string> = {
  pending: 'var(--mantine-color-gray-5)',
  running: 'var(--mantine-color-blue-6)',
  completed: 'var(--mantine-color-green-6)',
  failed: 'var(--mantine-color-red-6)',
  cancelled: 'var(--mantine-color-gray-5)',
};

export function RoutinesList({ workbookId }: RoutinesListProps) {
  const { routines, isLoading, refresh } = useRoutines(workbookId);
  const params = useParams<{ fileName?: string }>();
  const router = useRouter();
  const [isReloading, setIsReloading] = useState(false);

  // The editor publishes the projected file name while a new routine is being authored.
  const draftFileName = useRoutineDraftStore((state) => state.draftFileName);
  const isCreating = params.fileName === 'new';

  const handleReload = async () => {
    setIsReloading(true);
    try {
      await scratchApiClient.routine.reload(workbookId);
      await refresh();
      notifications.show({
        title: 'Routines reloaded',
        message: 'Routines re-read from the workbook repo',
        color: 'green',
      });
    } catch {
      notifications.show({
        title: 'Failed to reload routines',
        message: 'Could not reload routines. Please try again.',
        color: 'red',
      });
    } finally {
      setIsReloading(false);
    }
  };

  const handleCreateNew = () => {
    router.push(`/workbook/${workbookId}/routines/new`);
  };

  if (isLoading && routines.length === 0) {
    return (
      <Box p="md">
        <Text12Regular c="dimmed">Loading routines...</Text12Regular>
      </Box>
    );
  }

  return (
    <ScrollArea h="100%" type="auto" offsetScrollbars>
      <Stack gap={0} py="xs">
        {/* Create New Routine */}
        <UnstyledButton
          onClick={handleCreateNew}
          px="sm"
          py={6}
          style={{ width: '100%', backgroundColor: 'transparent' }}
        >
          <Group gap={6} wrap="nowrap">
            <StyledLucideIcon Icon={PlusIcon} size="sm" c="var(--mantine-color-blue-6)" />
            <Text12Regular c="var(--mantine-color-blue-6)">New Routine</Text12Regular>
          </Group>
        </UnstyledButton>

        {/* Reload routines from git */}
        <Tooltip label="Re-read routine files from the workbook repo" position="right">
          <UnstyledButton
            onClick={handleReload}
            disabled={isReloading}
            px="sm"
            py={6}
            style={{ width: '100%', backgroundColor: 'transparent', opacity: isReloading ? 0.5 : 1 }}
          >
            <Group gap={6} wrap="nowrap">
              <StyledLucideIcon Icon={RefreshCwIcon} size="sm" c="var(--fg-secondary)" />
              <Text12Regular c="var(--fg-secondary)">{isReloading ? 'Reloading...' : 'Reload routines'}</Text12Regular>
            </Group>
          </UnstyledButton>
        </Tooltip>

        {/* Divider */}
        {(routines.length > 0 || isCreating) && (
          <Box my="xs" mx="sm" style={{ borderBottom: '1px solid var(--fg-divider)' }} />
        )}

        {/* Routine list */}
        {routines.map((routine) => (
          <RoutineItem
            key={routine.filePath}
            routine={routine}
            workbookId={workbookId}
            isActive={params.fileName === routineFileName(routine.filePath)}
          />
        ))}

        {/* Draft preview — the routine being authored in the editor, not yet saved. Always sorts last. */}
        {isCreating && <DraftRoutineItem draftFileName={draftFileName} />}

        {/* Empty state */}
        {routines.length === 0 && !isCreating && (
          <Box p="md">
            <Text12Regular c="dimmed">No routines yet</Text12Regular>
          </Box>
        )}
      </Stack>
    </ScrollArea>
  );
}

/** The in-progress routine shown while the editor is in create mode, before it has been saved. */
function DraftRoutineItem({ draftFileName }: { draftFileName: string | null }) {
  return (
    <Box
      px="sm"
      py={6}
      style={{
        width: '100%',
        backgroundColor: 'var(--bg-selected)',
        borderLeft: '3px solid var(--mantine-primary-color-filled)',
      }}
    >
      <Group gap={8} wrap="nowrap" justify="space-between">
        <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
          <StyledLucideIcon Icon={WorkflowIcon} size="sm" c="var(--fg-secondary)" />
          <Text12Medium c={draftFileName ? 'var(--fg-primary)' : 'var(--fg-muted)'} truncate style={{ flex: 1 }}>
            {draftFileName ?? 'Untitled routine'}
          </Text12Medium>
        </Group>
        <Badge size="xs" variant="light" color="blue" style={{ flexShrink: 0 }}>
          Draft
        </Badge>
      </Group>
    </Box>
  );
}

interface RoutineItemProps {
  routine: Routine;
  workbookId: WorkbookId;
  isActive: boolean;
}

function RoutineItem({ routine, workbookId, isActive }: RoutineItemProps) {
  const fileName = routineFileName(routine.filePath);
  const href = `/workbook/${workbookId}/routines/${fileName}`;
  const displayName = routine.name ?? fileName;

  return (
    <Link href={href} style={{ textDecoration: 'none' }}>
      <UnstyledButton
        px="sm"
        py={6}
        style={{
          width: '100%',
          backgroundColor: isActive ? 'var(--bg-selected)' : 'transparent',
          borderLeft: isActive ? '3px solid var(--mantine-primary-color-filled)' : '3px solid transparent',
        }}
      >
        <Group gap={8} wrap="nowrap" justify="space-between">
          <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
            <StyledLucideIcon Icon={WorkflowIcon} size="sm" c="var(--fg-secondary)" />
            <Text12Medium c="var(--fg-primary)" truncate style={{ flex: 1 }}>
              {displayName}
            </Text12Medium>
          </Group>

          {/* Parse-error indicator — the file exists but the YAML is invalid. */}
          {routine.parseError && (
            <Tooltip label={routine.parseError} position="right" multiline w={240}>
              <Box style={{ display: 'flex', flexShrink: 0 }}>
                <StyledLucideIcon Icon={AlertTriangleIcon} size="sm" c="var(--mantine-color-red-6)" />
              </Box>
            </Tooltip>
          )}

          {/* Reference-warning indicator — the YAML parses, but a folder/connection it references is
              gone (e.g. deleted after the routine was saved). Distinct from a parse error: amber, not red. */}
          {!routine.parseError && routine.referenceWarnings.length > 0 && (
            <Tooltip label={routine.referenceWarnings.join('; ')} position="right" multiline w={240}>
              <Box style={{ display: 'flex', flexShrink: 0 }}>
                <StyledLucideIcon Icon={AlertCircleIcon} size="sm" c="var(--mantine-color-yellow-7)" />
              </Box>
            </Tooltip>
          )}

          {/* Schedule indicator. */}
          {routine.schedule && (
            <Tooltip label={`Scheduled: ${routine.schedule}`} position="right">
              <Box style={{ display: 'flex', flexShrink: 0 }}>
                <ClockIcon size={10} color="var(--fg-muted)" />
              </Box>
            </Tooltip>
          )}

          {/* Last-run status dot. `latestRun` is null until the routine runner lands (separate branch). */}
          {routine.latestRun && (
            <Tooltip label={`Last run: ${routine.latestRun.status}`} position="right">
              <Box
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  backgroundColor: RUN_STATUS_COLOR[routine.latestRun.status],
                  flexShrink: 0,
                }}
              />
            </Tooltip>
          )}
        </Group>
      </UnstyledButton>
    </Link>
  );
}
