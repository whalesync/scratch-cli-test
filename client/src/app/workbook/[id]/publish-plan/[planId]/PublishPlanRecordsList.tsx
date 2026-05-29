'use client';

import { Text12Medium, Text12Regular } from '@/app/components/base/text';
import { PlanRecordDiffMode, usePublishPlanRecordDiff } from '@/hooks/use-publish-plan-record-diff';
import { json } from '@codemirror/lang-json';
import { unifiedMergeView } from '@codemirror/merge';
import { EditorView } from '@codemirror/view';
import {
  Badge,
  Box,
  Code,
  Group,
  Loader,
  Modal,
  Popover,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { PublishPlanRecordRow, WorkbookId } from '@spinner/shared-types';
import CodeMirror from '@uiw/react-codemirror';
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloudUploadIcon,
  FilePenLineIcon,
  Maximize2Icon,
  MoveIcon,
  PlusCircleIcon,
  RepeatIcon,
  Trash2Icon,
} from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { MergeEditor } from '../../components/shared/MergeEditor';

const PHASE_ICONS: Record<string, { Icon: typeof FilePenLineIcon; label: string; color: string }> = {
  edit: { Icon: FilePenLineIcon, label: 'Edit', color: 'blue' },
  create: { Icon: PlusCircleIcon, label: 'Create', color: 'green' },
  delete: { Icon: Trash2Icon, label: 'Delete', color: 'red' },
  backfill: { Icon: RepeatIcon, label: 'Backfill', color: 'grape' },
  'asset-upload': { Icon: CloudUploadIcon, label: 'Asset upload', color: 'cyan' },
  'rename-files': { Icon: MoveIcon, label: 'Rename', color: 'orange' },
};

type RecordStatus = 'added' | 'modified' | 'deleted';

const STATUS_COLOR: Record<RecordStatus, string> = {
  added: 'var(--mantine-color-green-7)',
  deleted: 'var(--mantine-color-red-6)',
  modified: 'var(--mantine-color-orange-6)',
};

function deriveStatus(phases: string[]): RecordStatus {
  if (phases.includes('create')) return 'added';
  if (phases.includes('delete')) return 'deleted';
  return 'modified';
}

function formatFilePath(path: string) {
  const lastSlash = path.lastIndexOf('/');
  if (lastSlash === -1) return { folder: '', filename: path };
  return { folder: path.substring(0, lastSlash + 1), filename: path.substring(lastSlash + 1) };
}

function computeDiffCounts(original: string | null, modified: string | null): { added: number; removed: number } {
  const origLines = (original ?? '').split('\n');
  const modLines = (modified ?? '').split('\n');
  const origCounts = new Map<string, number>();
  for (const line of origLines) origCounts.set(line, (origCounts.get(line) ?? 0) + 1);
  const modCounts = new Map<string, number>();
  for (const line of modLines) modCounts.set(line, (modCounts.get(line) ?? 0) + 1);

  let removed = 0;
  for (const [line, count] of origCounts) {
    removed += Math.max(0, count - (modCounts.get(line) ?? 0));
  }
  let added = 0;
  for (const [line, count] of modCounts) {
    added += Math.max(0, count - (origCounts.get(line) ?? 0));
  }
  return { added, removed };
}

function PhaseIcons({ phases, onClickPhase }: { phases: string[]; onClickPhase: (phase: string) => void }) {
  return (
    <Group gap={4} wrap="nowrap">
      {phases.map((phase) => {
        const meta = PHASE_ICONS[phase];
        if (!meta) {
          return (
            <Tooltip key={phase} label={phase} withArrow>
              <UnstyledButton onClick={() => onClickPhase(phase)} c="var(--fg-muted)" style={{ display: 'flex' }}>
                <span style={{ fontSize: 10, fontWeight: 500 }}>{phase.slice(0, 2)}</span>
              </UnstyledButton>
            </Tooltip>
          );
        }
        const { Icon, label, color } = meta;
        return (
          <Tooltip key={phase} label={`${label} — click for details`} withArrow>
            <UnstyledButton
              onClick={() => onClickPhase(phase)}
              c={`var(--mantine-color-${color}-7)`}
              style={{ display: 'flex' }}
            >
              <Icon size={14} />
            </UnstyledButton>
          </Tooltip>
        );
      })}
    </Group>
  );
}

function NoUserDiffBanner() {
  const [opened, setOpened] = useState(false);
  return (
    <Box
      px="sm"
      py={4}
      style={{
        background: 'var(--bg-panel)',
        borderBottom: '0.5px solid var(--fg-divider)',
      }}
    >
      <Group gap={4}>
        <Text size="xs" c="dimmed">
          No manual edits
        </Text>
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
            <Text size="xs">
              Scratch can edit a record on your behalf when it has to. The common case is when a related record is being
              deleted: the foreign key on the dependent record gets cleared first so the database lets the delete go
              through. That shows up here as an edit operation with no visible diff.
            </Text>
          </Popover.Dropdown>
        </Popover>
      </Group>
    </Box>
  );
}

function DiffView({
  original,
  modified,
  isLoading,
  mode = 'unified',
}: {
  original: string | null;
  modified: string | null;
  isLoading: boolean;
  mode?: 'unified' | 'side-by-side';
}) {
  const unifiedExtensions = useMemo(
    () => [
      json(),
      EditorView.editable.of(false),
      EditorView.lineWrapping,
      unifiedMergeView({
        original: original ?? '',
        mergeControls: false,
        highlightChanges: true,
      }),
    ],
    [original],
  );

  const sideBySideExtensions = useMemo(() => [json()], []);

  if (isLoading) {
    return (
      <Box p="sm" style={{ display: 'flex', justifyContent: 'center' }}>
        <Loader size={14} />
      </Box>
    );
  }

  const isNoUserDiff = original !== null && modified !== null && original === modified;
  const noUserDiffBanner = isNoUserDiff ? <NoUserDiffBanner /> : null;

  if (mode === 'side-by-side') {
    return (
      <Box style={{ display: 'flex', flexDirection: 'column', height: 500 }}>
        {noUserDiffBanner}
        <Box style={{ flex: 1, minHeight: 0 }}>
          <MergeEditor original={original ?? ''} modified={modified ?? ''} extensions={sideBySideExtensions} />
        </Box>
      </Box>
    );
  }

  return (
    <>
      {noUserDiffBanner}
      <CodeMirror
        value={modified ?? ''}
        extensions={unifiedExtensions}
        editable={false}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
        }}
        style={{ fontSize: '12px' }}
      />
    </>
  );
}

interface RecordRowProps {
  record: PublishPlanRecordRow;
  workbookId: WorkbookId;
  planId: string;
  connectorAccountId: string | null;
  onClickPhase: (filePath: string, phase: string) => void;
  onOpenFullDiff: (filePath: string) => void;
}

const RecordRow = memo(function RecordRow({
  record,
  workbookId,
  planId,
  connectorAccountId,
  onClickPhase,
  onOpenFullDiff,
}: RecordRowProps) {
  const [expanded, setExpanded] = useState(false);

  const { original, modified, isLoading } = usePublishPlanRecordDiff(
    workbookId,
    planId,
    connectorAccountId,
    record.filePath,
    expanded,
  );

  const status = deriveStatus(record.phases);
  const { folder, filename } = formatFilePath(record.filePath);
  const borderColor = STATUS_COLOR[status];

  const diffCounts = useMemo(() => {
    if (!expanded || isLoading) return null;
    return computeDiffCounts(original, modified);
  }, [expanded, isLoading, original, modified]);

  return (
    <Box style={{ borderBottom: '0.5px solid var(--fg-divider)' }}>
      <Group
        wrap="nowrap"
        gap="sm"
        pr="md"
        pl={6}
        py={7}
        style={{
          borderLeft: `3px solid ${borderColor}`,
          cursor: 'pointer',
        }}
        onClick={() => setExpanded((v) => !v)}
      >
        <Box style={{ flexShrink: 0, color: 'var(--fg-muted)', display: 'flex' }}>
          {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        </Box>

        {record.hasError && (
          <Tooltip label="One or more operations failed" withArrow>
            <Box c="var(--mantine-color-red-7)" style={{ display: 'flex', flexShrink: 0 }}>
              <AlertTriangleIcon size={14} />
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

        {diffCounts && (diffCounts.added > 0 || diffCounts.removed > 0) && (
          <Text12Regular c="var(--fg-muted)" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
            {diffCounts.added > 0 && <span style={{ color: 'var(--mantine-color-green-7)' }}>+{diffCounts.added}</span>}
            {diffCounts.added > 0 && diffCounts.removed > 0 && ' / '}
            {diffCounts.removed > 0 && (
              <span style={{ color: 'var(--mantine-color-red-6)' }}>-{diffCounts.removed}</span>
            )}
          </Text12Regular>
        )}

        <Box style={{ flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
          <PhaseIcons phases={record.phases} onClickPhase={(p) => onClickPhase(record.filePath, p)} />
        </Box>

        <Tooltip label="Expand full diff" position="left" withArrow>
          <UnstyledButton
            onClick={(e) => {
              e.stopPropagation();
              onOpenFullDiff(record.filePath);
            }}
            style={{ flexShrink: 0, display: 'flex', color: 'var(--fg-muted)', padding: 2 }}
          >
            <Maximize2Icon size={12} />
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
  workbookId: WorkbookId;
  planId: string;
  connectorAccountId: string | null;
  records: PublishPlanRecordRow[];
  preDirtyCommitSha?: string | null;
  preMainCommitSha?: string | null;
  postMainCommitSha?: string | null;
  onClickPhase: (filePath: string, phase: string) => void;
}

export function PublishPlanRecordsList({
  workbookId,
  planId,
  connectorAccountId,
  records,
  preDirtyCommitSha,
  preMainCommitSha,
  postMainCommitSha,
  onClickPhase,
}: PublishPlanRecordsListProps) {
  const [fullDiffPath, setFullDiffPath] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<'unified' | 'side-by-side'>('unified');
  const [diffSource, setDiffSource] = useState<PlanRecordDiffMode>('old-vs-edits');

  const sortedRecords = useMemo(() => [...records].sort((a, b) => a.filePath.localeCompare(b.filePath)), [records]);

  const fullDiffRecord = useMemo(
    () => (fullDiffPath ? (sortedRecords.find((r) => r.filePath === fullDiffPath) ?? null) : null),
    [fullDiffPath, sortedRecords],
  );

  const { original, modified, isLoading } = usePublishPlanRecordDiff(
    workbookId,
    planId,
    connectorAccountId,
    fullDiffPath ?? undefined,
    !!fullDiffPath,
    diffSource,
  );

  const isOldVsNew = diffSource === 'old-vs-new';
  const rightRefName = isOldVsNew ? `main_plan_${planId}` : `dirty_plan_${planId}`;
  const rightSha = isOldVsNew ? postMainCommitSha : preDirtyCommitSha;
  const rightTooltip = isOldVsNew
    ? 'Main after the publish committed (what got shipped)'
    : "User's local edits being published (dirty branch)";

  if (records.length === 0) {
    return (
      <Box py="md" px="md">
        <Text12Regular c="dimmed">No records.</Text12Regular>
      </Box>
    );
  }

  const fullDiffFilename = fullDiffPath ? formatFilePath(fullDiffPath).filename : '';

  return (
    <>
      <Box>
        {sortedRecords.map((r) => (
          <RecordRow
            key={r.filePath}
            record={r}
            workbookId={workbookId}
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
              <Text12Regular c="var(--fg-muted)">{formatFilePath(fullDiffPath).folder}</Text12Regular>
              <Text12Medium>{fullDiffFilename}</Text12Medium>
            </Group>
          ) : null
        }
      >
        <Stack gap="sm">
          <Group justify="space-between" align="flex-end">
            <Stack gap={4}>
              <Group gap="xs" align="center">
                <Text size="xs" fw={500}>
                  Diff
                </Text>
                <Select
                  size="xs"
                  value={diffSource}
                  onChange={(v) => v && setDiffSource(v as PlanRecordDiffMode)}
                  allowDeselect={false}
                  data={[
                    { value: 'old-vs-edits', label: 'Old value vs Edits' },
                    { value: 'old-vs-new', label: 'Old value vs New value' },
                  ]}
                  w={220}
                />
                {fullDiffRecord && fullDiffRecord.phases.length > 0 && (
                  <Group gap={4} wrap="wrap">
                    {fullDiffRecord.phases.map((phase) => {
                      const meta = PHASE_ICONS[phase];
                      const Icon = meta?.Icon;
                      return (
                        <Tooltip key={phase} label="View changed fields" withArrow>
                          <Badge
                            size="sm"
                            variant="light"
                            color={meta?.color ?? 'gray'}
                            leftSection={Icon ? <Icon size={10} /> : undefined}
                            style={{ cursor: 'pointer' }}
                            onClick={() => fullDiffPath && onClickPhase(fullDiffPath, phase)}
                          >
                            {meta?.label ?? phase}
                          </Badge>
                        </Tooltip>
                      );
                    })}
                  </Group>
                )}
              </Group>
              <Group gap={6} wrap="wrap">
                <Tooltip label="Canonical state before publish (main branch)" withArrow>
                  <Code style={{ fontSize: 10 }}>main_pre_plan_{planId}</Code>
                </Tooltip>
                {preMainCommitSha && (
                  <Text size="xs" c="dimmed" ff="monospace">
                    ({preMainCommitSha.substring(0, 8)})
                  </Text>
                )}
                <Text size="xs" c="dimmed">
                  →
                </Text>
                <Tooltip label={rightTooltip} withArrow>
                  <Code style={{ fontSize: 10 }}>{rightRefName}</Code>
                </Tooltip>
                {rightSha && (
                  <Text size="xs" c="dimmed" ff="monospace">
                    ({rightSha.substring(0, 8)})
                  </Text>
                )}
              </Group>
            </Stack>
            <SegmentedControl
              size="xs"
              value={diffMode}
              onChange={(v) => setDiffMode(v as 'unified' | 'side-by-side')}
              data={[
                { value: 'unified', label: 'Unified' },
                { value: 'side-by-side', label: 'Side by side' },
              ]}
            />
          </Group>

          <Box style={{ border: '0.5px solid var(--fg-divider)', borderRadius: 3, overflow: 'hidden' }}>
            <DiffView original={original} modified={modified} isLoading={isLoading} mode={diffMode} />
          </Box>
        </Stack>
      </Modal>
    </>
  );
}
