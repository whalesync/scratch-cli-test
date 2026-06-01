import {
  Badge,
  Box,
  Button,
  Group,
  Loader,
  Modal,
  Popover,
  Select,
  Stack,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { PublishPlanRecordRow } from '@spinner/shared-types';
import { AlertTriangleIcon, ChevronDownIcon, ChevronRightIcon, Maximize2Icon, RotateCcwIcon } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { Text12Book, Text12Medium, Text12Regular } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import {
  PlanRecordDiffMode,
  usePublishPlanPostDiffersFromCurrent,
  usePublishPlanRecordDiff,
} from '../../hooks/use-publish-plan-record-diff';
import { PHASE_ICONS } from '../../lib/publish-plan-icons';
import { SideBySideDiff } from './diff-renderers';

const DIFF_MODE_LABELS: Record<PlanRecordDiffMode, { left: string; right: string }> = {
  'before-vs-after': { left: 'Before Publish', right: 'After Publish' },
  'after-vs-current': { left: 'After Publish', right: 'Current' },
  'before-vs-approved': { left: 'Before Publish', right: 'Approved Changes' },
};

const DIFF_MODE_OPTIONS: { value: PlanRecordDiffMode; label: string }[] = [
  { value: 'before-vs-after', label: 'Before / After Publish' },
  { value: 'after-vs-current', label: 'After Publish / Current' },
  { value: 'before-vs-approved', label: 'Before Publish / Approved' },
];

type RecordStatus = 'added' | 'modified' | 'deleted';

const STATUS_BORDER: Record<RecordStatus, string> = {
  added: 'var(--mantine-color-green-7)',
  deleted: 'var(--mantine-color-red-6)',
  modified: 'var(--mantine-color-orange-6)',
};

function deriveStatus(phases: string[]): RecordStatus {
  if (phases.includes('create')) return 'added';
  if (phases.includes('delete')) return 'deleted';
  return 'modified';
}

function splitPath(path: string): { folder: string; filename: string } {
  const lastSlash = path.lastIndexOf('/');
  if (lastSlash === -1) return { folder: '', filename: path };
  return { folder: path.substring(0, lastSlash + 1), filename: path.substring(lastSlash + 1) };
}

interface PhaseBadgesProps {
  phases: string[];
  onClickPhase: (phase: string) => void;
  size?: 'sm' | 'xs';
}

function PhaseBadges({ phases, onClickPhase, size = 'sm' }: PhaseBadgesProps) {
  return (
    <Group gap={4} wrap="nowrap">
      {phases.map((phase) => {
        const meta = PHASE_ICONS[phase];
        return (
          <Tooltip key={phase} label="View changed fields" withArrow>
            <Badge
              size={size}
              variant="light"
              color={meta?.color ?? 'gray'}
              leftSection={
                meta?.Icon ? (
                  <Box style={{ display: 'inline-flex', alignItems: 'center' }}>
                    <StyledLucideIcon Icon={meta.Icon} size={10} centerInText />
                  </Box>
                ) : undefined
              }
              style={{ cursor: 'pointer' }}
              onClick={() => onClickPhase(phase)}
            >
              {meta?.label ?? phase}
            </Badge>
          </Tooltip>
        );
      })}
    </Group>
  );
}

/** Inline "No manual edits (?)" label with a click-to-open explainer. */
function NoManualEditsHelp() {
  const [opened, setOpened] = useState(false);
  return (
    <Group gap={4} align="center" wrap="nowrap">
      <Text12Regular c="var(--fg-muted)">No manual edits</Text12Regular>
      <Popover opened={opened} onChange={setOpened} width={320} position="bottom-start" withArrow>
        <Popover.Target>
          <UnstyledButton
            onClick={() => setOpened((v) => !v)}
            style={{ color: 'var(--mantine-color-blue-6)', textDecoration: 'underline', fontSize: 12 }}
          >
            (?)
          </UnstyledButton>
        </Popover.Target>
        <Popover.Dropdown>
          <Text12Regular>
            Scratch can edit a record on your behalf when it has to. The common case is when a related record is being
            deleted: the foreign key on the dependent record gets cleared first so the database lets the delete go
            through. That shows up here as an edit operation with no visible diff.
          </Text12Regular>
        </Popover.Dropdown>
      </Popover>
    </Group>
  );
}

/** Column-label strip above a side-by-side diff. Matches the
 * `SideBySideDiff` grid (`1fr 1px 1fr`). Optional `leftActions` slot
 * hosts the Roll-back link in the full-diff modal. */
function DiffColumnHeader({
  leftLabel,
  rightLabel,
  isNoUserDiff,
  leftActions,
}: {
  leftLabel: string;
  rightLabel: string;
  isNoUserDiff: boolean;
  leftActions?: React.ReactNode;
}) {
  return (
    <Box
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1px 1fr',
        background: 'var(--bg-panel)',
        borderBottom: '0.5px solid var(--fg-divider)',
      }}
    >
      <Group px="sm" py={4} wrap="nowrap" align="center" gap="xs">
        <Text12Regular c="var(--fg-muted)" fw={500}>
          {leftLabel}
        </Text12Regular>
        {leftActions && (
          <>
            <Text12Regular c="var(--fg-muted)">·</Text12Regular>
            {leftActions}
          </>
        )}
      </Group>
      <Box style={{ backgroundColor: 'var(--fg-divider)' }} />
      <Group px="sm" py={4} wrap="nowrap" align="center" gap="sm">
        <Text12Regular c="var(--fg-muted)" fw={500}>
          {rightLabel}
        </Text12Regular>
        {isNoUserDiff && <NoManualEditsHelp />}
      </Group>
    </Box>
  );
}

function DiffView({
  original,
  modified,
  isLoading,
}: {
  original: string | null;
  modified: string | null;
  isLoading: boolean;
}) {
  // Only show the centered loader on a cold start (no data at all yet).
  // During mode switches with `keepPreviousData`, SWR flips `isLoading`
  // true while still returning the previous response — falling back to
  // the loader here would blank out a diff we could otherwise leave
  // visible until the new data arrives.
  if (isLoading && original === null && modified === null) {
    return (
      <Box p="sm" style={{ display: 'flex', justifyContent: 'center' }}>
        <Loader size={14} />
      </Box>
    );
  }

  return <SideBySideDiff fromValue={original ?? ''} value={modified ?? ''} diffKind="unpublished" />;
}

function isNoUserDiff(original: string | null, modified: string | null): boolean {
  return original !== null && modified !== null && original === modified;
}

interface RecordRowProps {
  record: PublishPlanRecordRow;
  workspaceId: string;
  planId: string;
  connectorAccountId: string | null;
  onClickPhase: (filePath: string, phase: string) => void;
  onOpenFullDiff: (filePath: string) => void;
  /** If non-null, the inline expand shows a "Rollback this record" link
   * in the Before-Publish column header that fires this callback. */
  onRequestRollback: ((filePath: string) => void) | null;
}

const RecordRow = memo(function RecordRow({
  record,
  workspaceId,
  planId,
  connectorAccountId,
  onClickPhase,
  onOpenFullDiff,
  onRequestRollback,
}: RecordRowProps) {
  const [expanded, setExpanded] = useState(false);
  // Inline expand always shows "main before publish → main after publish" — the
  // narrowest "what this publish committed to the canonical state" diff. The
  // expand-full-diff modal lets the user switch to the edits view if they
  // want.
  const { original, modified, isLoading } = usePublishPlanRecordDiff(
    workspaceId,
    planId,
    connectorAccountId,
    record.filePath,
    expanded,
    'before-vs-after',
  );

  const status = deriveStatus(record.phases);
  const { folder, filename } = splitPath(record.filePath);
  const borderColor = STATUS_BORDER[status];

  return (
    <Box style={{ borderBottom: '0.5px solid var(--fg-divider)' }}>
      <Group
        wrap="nowrap"
        gap="sm"
        pr="md"
        pl={6}
        py={7}
        style={{ borderLeft: `3px solid ${borderColor}`, cursor: 'pointer' }}
        onClick={() => setExpanded((v) => !v)}
      >
        <Box style={{ flexShrink: 0, display: 'flex', color: 'var(--fg-muted)' }}>
          <StyledLucideIcon Icon={expanded ? ChevronDownIcon : ChevronRightIcon} size={12} c="var(--fg-muted)" />
        </Box>

        {record.hasError && (
          <Tooltip label="One or more operations failed" withArrow>
            <Box style={{ display: 'inline-flex', flexShrink: 0 }}>
              <StyledLucideIcon Icon={AlertTriangleIcon} size={14} c="var(--mantine-color-red-7)" />
            </Box>
          </Tooltip>
        )}

        <Group gap={0} wrap="nowrap" style={{ minWidth: 0, flexShrink: 1 }}>
          {folder && (
            <Text12Regular c="var(--fg-muted)" truncate style={{ flexShrink: 1 }}>
              {folder}
            </Text12Regular>
          )}
          <Text12Medium c="var(--fg-primary)" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
            {filename}
          </Text12Medium>
        </Group>

        <Box style={{ flex: 1 }} />

        <Box style={{ flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
          <PhaseBadges phases={record.phases} onClickPhase={(p) => onClickPhase(record.filePath, p)} size="xs" />
        </Box>

        <Tooltip label="Expand full diff" position="left" withArrow>
          <UnstyledButton
            onClick={(e) => {
              e.stopPropagation();
              onOpenFullDiff(record.filePath);
            }}
            style={{ flexShrink: 0, display: 'flex', color: 'var(--fg-muted)', padding: 2 }}
          >
            <StyledLucideIcon Icon={Maximize2Icon} size={12} c="var(--fg-muted)" />
          </UnstyledButton>
        </Tooltip>
      </Group>

      {expanded && (
        <Box mx="md" mb={4} style={{ border: '0.5px solid var(--fg-divider)', borderRadius: 3, overflow: 'hidden' }}>
          <DiffColumnHeader
            leftLabel={DIFF_MODE_LABELS['before-vs-after'].left}
            rightLabel={DIFF_MODE_LABELS['before-vs-after'].right}
            isNoUserDiff={isNoUserDiff(original, modified)}
            leftActions={
              onRequestRollback &&
              original !== null && (
                <UnstyledButton
                  onClick={(e) => {
                    e.stopPropagation();
                    onRequestRollback(record.filePath);
                  }}
                  style={{ color: 'var(--mantine-color-red-7)' }}
                >
                  <Group gap={3} wrap="nowrap" align="center">
                    <StyledLucideIcon Icon={RotateCcwIcon} size={11} c="var(--mantine-color-red-7)" />
                    <Text12Book style={{ color: 'var(--mantine-color-red-7)', textDecoration: 'underline' }}>
                      Rollback this record
                    </Text12Book>
                  </Group>
                </UnstyledButton>
              )
            }
          />
          <DiffView original={original} modified={modified} isLoading={isLoading} />
        </Box>
      )}
    </Box>
  );
});

interface PublishPlanRecordsListProps {
  workspaceId: string;
  planId: string;
  connectorAccountId: string | null;
  records: PublishPlanRecordRow[];
  onClickPhase: (filePath: string, phase: string) => void;
  /** Absolute on-disk path to the workspace root. When non-null, the
   * full-diff modal exposes a "Revert to this value" action that writes the
   * old-master content back to the local working file as a pending edit. */
  workspacePath: string | null;
}

/**
 * Records list inside a publish plan detail page. Each row expands inline to a
 * side-by-side diff between the two refs (`main_pre_plan_*` and either
 * `dirty_plan_*` or `main_plan_*` depending on the diff source). Clicking
 * "Expand full diff" opens a modal with the same diff and a connection to
 * the operation-detail sub-modal via `onClickPhase`.
 */
export function PublishPlanRecordsList({
  workspaceId,
  planId,
  connectorAccountId,
  records,
  onClickPhase,
  workspacePath,
}: PublishPlanRecordsListProps) {
  const [fullDiffPath, setFullDiffPath] = useState<string | null>(null);
  // SegmentedControl on the operations row picks which two refs the
  // modal diffs. Default is the canonical "what this publish committed"
  // view; the other two are diagnostic.
  const [diffMode, setDiffMode] = useState<PlanRecordDiffMode>('before-vs-after');
  // Roll-back state: when non-null, the confirmation modal opens for
  // this filePath. Triggered from both the full-diff modal AND the
  // inline row expand.
  const [rollbackPath, setRollbackPath] = useState<string | null>(null);
  const [rollingBack, setRollingBack] = useState(false);

  const handleRollback = async () => {
    if (!workspacePath || !connectorAccountId || !rollbackPath) return;
    setRollingBack(true);
    try {
      // Same CLI path as the bulk roll back, scoped to one file. The CLI
      // reads the pre-publish blob from the local bare repo (no per-record
      // network call) and writes/re-anchors it.
      const res = await window.scratchFiles.revertPlan(workspacePath, planId, { filePath: rollbackPath });
      if ('error' in res) throw new Error(res.error);
      notifications.show({
        title: 'Rolled back',
        message: 'Local value rolled back. Publish the record to apply the change.',
        color: 'green',
      });
      const wasFullDiff = rollbackPath === fullDiffPath;
      setRollbackPath(null);
      if (wasFullDiff) setFullDiffPath(null);
    } catch (err) {
      console.debug('Roll back failed', err);
      notifications.show({ title: 'Roll back failed', message: String(err), color: 'red' });
    } finally {
      setRollingBack(false);
    }
  };

  const canRollback = !!workspacePath && !!connectorAccountId;

  const sortedRecords = useMemo(() => [...records].sort((a, b) => a.filePath.localeCompare(b.filePath)), [records]);

  const fullDiffRecord = useMemo(
    () => (fullDiffPath ? (sortedRecords.find((r) => r.filePath === fullDiffPath) ?? null) : null),
    [fullDiffPath, sortedRecords],
  );

  const { original, modified, isLoading, isValidating } = usePublishPlanRecordDiff(
    workspaceId,
    planId,
    connectorAccountId,
    fullDiffPath ?? undefined,
    !!fullDiffPath,
    diffMode,
  );
  // Show a small spinner during refetches when we already have content
  // visible (keepPreviousData). The cold-start case shows the centered
  // loader inside DiffView and we don't want a redundant spinner there.
  const showInlineDiffSpinner = isValidating && !!original;

  // Only meaningful in the default mode — warns the user that the After
  // Publish blob they're staring at is no longer the canonical value
  // (the record has changed on main since this publish landed).
  const { differs: postDiffersFromCurrent } = usePublishPlanPostDiffersFromCurrent(
    workspaceId,
    planId,
    connectorAccountId,
    fullDiffPath ?? undefined,
    !!fullDiffPath && diffMode === 'before-vs-after',
  );

  if (records.length === 0) {
    return (
      <Box py="md" px="md">
        <Text12Regular c="var(--fg-muted)">No records.</Text12Regular>
      </Box>
    );
  }

  const fullDiffFilename = fullDiffPath ? splitPath(fullDiffPath).filename : '';
  const fullDiffFolder = fullDiffPath ? splitPath(fullDiffPath).folder : '';
  const isFullDiffNoUserDiff = isNoUserDiff(original, modified);

  return (
    <>
      <Box>
        {sortedRecords.map((r) => (
          <RecordRow
            key={r.filePath}
            record={r}
            workspaceId={workspaceId}
            planId={planId}
            connectorAccountId={connectorAccountId}
            onClickPhase={onClickPhase}
            onOpenFullDiff={(p) => setFullDiffPath(p)}
            onRequestRollback={canRollback ? (p) => setRollbackPath(p) : null}
          />
        ))}
      </Box>

      <Modal
        opened={!!fullDiffPath}
        onClose={() => setFullDiffPath(null)}
        size="90%"
        title={
          fullDiffPath ? (
            <Group gap={4}>
              <Text12Regular c="var(--fg-muted)">{fullDiffFolder}</Text12Regular>
              <Text12Medium>{fullDiffFilename}</Text12Medium>
            </Group>
          ) : null
        }
      >
        <Stack gap="sm">
          <Group gap="sm" align="center" wrap="nowrap" justify="space-between">
            <Group gap="xs" align="center" wrap="nowrap" style={{ minWidth: 0 }}>
              <Text12Regular fw={500}>Operations:</Text12Regular>
              {fullDiffRecord && fullDiffRecord.phases.length > 0 && (
                <PhaseBadges
                  phases={fullDiffRecord.phases}
                  onClickPhase={(p) => fullDiffPath && onClickPhase(fullDiffPath, p)}
                />
              )}
            </Group>
            <Group gap={6} wrap="nowrap" align="center">
              {showInlineDiffSpinner && <Loader size={12} />}
              {/* Unstyled select: reads as plain text + chevron so it
                  doesn't compete with the operations badges for attention.
                  Diff mode is a power-user toggle, not the headline. */}
              <Select
                size="xs"
                variant="unstyled"
                allowDeselect={false}
                withCheckIcon={false}
                value={diffMode}
                onChange={(v) => v && setDiffMode(v as PlanRecordDiffMode)}
                data={DIFF_MODE_OPTIONS}
                w={200}
                styles={{
                  input: {
                    color: 'var(--fg-muted)',
                    textAlign: 'right',
                    paddingRight: 18,
                    fontSize: 12,
                  },
                }}
              />
            </Group>
          </Group>

          {diffMode === 'before-vs-after' && postDiffersFromCurrent === true && (
            <Group
              gap="xs"
              align="center"
              wrap="nowrap"
              px="sm"
              py={4}
              style={{
                border: '0.5px solid var(--mantine-color-yellow-4)',
                background: 'var(--mantine-color-yellow-0)',
                borderRadius: 3,
              }}
            >
              <StyledLucideIcon Icon={AlertTriangleIcon} size={12} c="var(--mantine-color-yellow-8)" />
              <Text12Regular c="var(--mantine-color-yellow-8)">
                The latest known value of this record is different.
              </Text12Regular>
            </Group>
          )}

          <Box style={{ border: '0.5px solid var(--fg-divider)', borderRadius: 3, overflow: 'hidden' }}>
            <DiffColumnHeader
              leftLabel={DIFF_MODE_LABELS[diffMode].left}
              rightLabel={DIFF_MODE_LABELS[diffMode].right}
              isNoUserDiff={isFullDiffNoUserDiff}
              leftActions={
                canRollback &&
                fullDiffPath &&
                original !== null && (
                  <UnstyledButton
                    onClick={() => setRollbackPath(fullDiffPath)}
                    style={{ color: 'var(--mantine-color-red-7)' }}
                  >
                    <Group gap={3} wrap="nowrap" align="center">
                      <StyledLucideIcon Icon={RotateCcwIcon} size={11} c="var(--mantine-color-red-7)" />
                      <Text12Book style={{ color: 'var(--mantine-color-red-7)', textDecoration: 'underline' }}>
                        Rollback this record
                      </Text12Book>
                    </Group>
                  </UnstyledButton>
                )
              }
            />
            <DiffView original={original} modified={modified} isLoading={isLoading} />
          </Box>
        </Stack>
      </Modal>

      <Modal
        opened={!!rollbackPath}
        onClose={() => (rollingBack ? undefined : setRollbackPath(null))}
        title={<Text12Medium>Roll back local value</Text12Medium>}
        size="md"
        zIndex={1100}
        closeOnClickOutside={!rollingBack}
        closeOnEscape={!rollingBack}
      >
        <Stack gap="md">
          <Text12Regular>
            The local value of the record will roll back to this value. You will need to publish the record for the
            change to take effect.
          </Text12Regular>
          <Group justify="flex-end" gap="xs">
            <Button size="xs" variant="default" onClick={() => setRollbackPath(null)} disabled={rollingBack}>
              Cancel
            </Button>
            <Button
              size="xs"
              color="red"
              loading={rollingBack}
              onClick={() => void handleRollback()}
              leftSection={<StyledLucideIcon Icon={RotateCcwIcon} size={12} c="white" />}
            >
              Roll back
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
