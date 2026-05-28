import {
  Badge,
  Box,
  Button,
  Group,
  Loader,
  Modal,
  Popover,
  Stack,
  Switch,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { PublishPlanRecordRow } from '@spinner/shared-types';
import { AlertTriangleIcon, ChevronDownIcon, ChevronRightIcon, Maximize2Icon } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { Text12Medium, Text12Regular } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import { PlanRecordDiffMode, usePublishPlanRecordDiff } from '../../hooks/use-publish-plan-record-diff';
import { PHASE_ICONS } from '../../lib/publish-plan-icons';
import { SideBySideDiff } from './diff-renderers';

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

function NoUserDiffBanner() {
  return (
    <Box px="sm" py={4} style={{ background: 'var(--bg-panel)', borderBottom: '0.5px solid var(--fg-divider)' }}>
      <NoManualEditsHelp />
    </Box>
  );
}

function DiffView({
  original,
  modified,
  isLoading,
  hideNoUserDiffBanner = false,
}: {
  original: string | null;
  modified: string | null;
  isLoading: boolean;
  /** Suppress the inline "No manual edits" banner — the modal renders the
   * same indicator in the column header instead so the banner would be
   * redundant. */
  hideNoUserDiffBanner?: boolean;
}) {
  if (isLoading) {
    return (
      <Box p="sm" style={{ display: 'flex', justifyContent: 'center' }}>
        <Loader size={14} />
      </Box>
    );
  }

  const isNoUserDiff = original !== null && modified !== null && original === modified;

  return (
    <>
      {isNoUserDiff && !hideNoUserDiffBanner && <NoUserDiffBanner />}
      <SideBySideDiff fromValue={original ?? ''} value={modified ?? ''} diffKind="unpublished" />
    </>
  );
}

interface RecordRowProps {
  record: PublishPlanRecordRow;
  workspaceId: string;
  planId: string;
  connectorAccountId: string | null;
  onClickPhase: (filePath: string, phase: string) => void;
  onOpenFullDiff: (filePath: string) => void;
}

const RecordRow = memo(function RecordRow({
  record,
  workspaceId,
  planId,
  connectorAccountId,
  onClickPhase,
  onOpenFullDiff,
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
    'old-vs-new',
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
  // Default diff is "main old → main new" (what the publish committed).
  // The "Show Edited Value" switch flips the right side to the user's
  // pre-publish dirty edits instead, for diagnosing publish transforms.
  const [showEditedValue, setShowEditedValue] = useState(false);
  const diffSource: PlanRecordDiffMode = showEditedValue ? 'old-vs-edits' : 'old-vs-new';
  const [revertConfirmOpen, setRevertConfirmOpen] = useState(false);
  const [reverting, setReverting] = useState(false);

  const handleRevert = async () => {
    if (!workspacePath || !connectorAccountId || !fullDiffPath || original === null) return;
    setReverting(true);
    try {
      // `record.filePath` is connection-relative (e.g. `/posts/post-102.json`);
      // the main process resolves it against the connection's `dirName`
      // from `.scratchmd` to get the absolute on-disk path.
      const res = await window.scratchFiles.revertRecordFile(workspacePath, connectorAccountId, fullDiffPath, original);
      if ('error' in res) throw new Error(res.error);
      notifications.show({
        title: 'Reverted',
        message: 'Local value reverted. Publish the record to apply the change.',
        color: 'green',
      });
      setRevertConfirmOpen(false);
      setFullDiffPath(null);
    } catch (err) {
      console.debug('Revert failed', err);
      notifications.show({ title: 'Revert failed', message: String(err), color: 'red' });
    } finally {
      setReverting(false);
    }
  };

  const sortedRecords = useMemo(() => [...records].sort((a, b) => a.filePath.localeCompare(b.filePath)), [records]);

  const fullDiffRecord = useMemo(
    () => (fullDiffPath ? (sortedRecords.find((r) => r.filePath === fullDiffPath) ?? null) : null),
    [fullDiffPath, sortedRecords],
  );

  const { original, modified, isLoading } = usePublishPlanRecordDiff(
    workspaceId,
    planId,
    connectorAccountId,
    fullDiffPath ?? undefined,
    !!fullDiffPath,
    diffSource,
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
  const isFullDiffNoUserDiff = original !== null && modified !== null && original === modified;

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
          <Group gap="xs" align="center" wrap="nowrap">
            <Text12Regular fw={500}>Operations:</Text12Regular>
            {fullDiffRecord && fullDiffRecord.phases.length > 0 && (
              <PhaseBadges
                phases={fullDiffRecord.phases}
                onClickPhase={(p) => fullDiffPath && onClickPhase(fullDiffPath, p)}
              />
            )}
          </Group>

          <Box style={{ border: '0.5px solid var(--fg-divider)', borderRadius: 3, overflow: 'hidden' }}>
            {/* Column-label strip: matches the SideBySideDiff grid (1fr 1px 1fr).
                Right column header hosts the Switch + the "No manual edits"
                indicator so they share one row with the column label. */}
            <Box
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1px 1fr',
                background: 'var(--bg-panel)',
                borderBottom: '0.5px solid var(--fg-divider)',
              }}
            >
              <Group px="sm" py={4} justify="space-between" wrap="nowrap" align="center" gap="sm">
                <Text12Regular c="var(--fg-muted)" fw={500}>
                  Old value
                </Text12Regular>
                {workspacePath && connectorAccountId && original !== null && (
                  <UnstyledButton
                    onClick={() => setRevertConfirmOpen(true)}
                    style={{
                      color: 'var(--mantine-color-red-7)',
                      textDecoration: 'underline',
                      fontSize: 12,
                    }}
                  >
                    Revert to this value
                  </UnstyledButton>
                )}
              </Group>
              <Box style={{ backgroundColor: 'var(--fg-divider)' }} />
              <Group px="sm" py={4} justify="space-between" wrap="nowrap" align="center" gap="sm">
                <Group gap="sm" wrap="nowrap" align="center">
                  <Text12Regular c="var(--fg-muted)" fw={500}>
                    New value
                  </Text12Regular>
                  {isFullDiffNoUserDiff && <NoManualEditsHelp />}
                </Group>
                <Switch
                  size="xs"
                  labelPosition="left"
                  label="Show Edited Value"
                  checked={showEditedValue}
                  onChange={(e) => setShowEditedValue(e.currentTarget.checked)}
                />
              </Group>
            </Box>

            <DiffView original={original} modified={modified} isLoading={isLoading} hideNoUserDiffBanner />
          </Box>
        </Stack>
      </Modal>

      <Modal
        opened={revertConfirmOpen}
        onClose={() => (reverting ? undefined : setRevertConfirmOpen(false))}
        title={<Text12Medium>Revert local value</Text12Medium>}
        size="md"
        zIndex={1100}
        closeOnClickOutside={!reverting}
        closeOnEscape={!reverting}
      >
        <Stack gap="md">
          <Text12Regular>
            The local value of the record will revert to this value. You will need to publish the record for the change
            to take effect.
          </Text12Regular>
          <Group justify="flex-end" gap="xs">
            <Button size="xs" variant="default" onClick={() => setRevertConfirmOpen(false)} disabled={reverting}>
              Cancel
            </Button>
            <Button size="xs" color="red" loading={reverting} onClick={() => void handleRevert()}>
              Revert
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
