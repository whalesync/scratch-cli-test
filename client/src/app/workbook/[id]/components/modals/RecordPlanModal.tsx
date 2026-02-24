'use client';

import { workbookApi } from '@/lib/api/workbook';
import { json } from '@codemirror/lang-json';
import { unifiedMergeView } from '@codemirror/merge';
import { EditorView, lineNumbers } from '@codemirror/view';
import { Badge, Group, Loader, Modal, ScrollArea, SegmentedControl, Stack, Text, Title } from '@mantine/core';
import { PublishPlanEntryEntity, WorkbookId } from '@spinner/shared-types';
import { Change, diffJson, diffLines } from 'diff';
import { GitCompareIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MergeEditor } from '../shared/MergeEditor';

/* ================================================================
   Types
   ================================================================ */

type PlanEntry = PublishPlanEntryEntity;

type DiffTab = 'userEdit' | 'edit' | 'delete' | 'create' | 'backfill';
type DiffLayout = 'inline' | 'sideBySide';
type DiffEngine = 'json' | 'text';

interface RecordPlanModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
  pipelineId: string;
  filePath: string;
}

/* ================================================================
   Diff computation helpers
   ================================================================ */

interface DiffLine {
  content: string;
  type: 'add' | 'remove' | 'equal';
}

function jsonDiff(left: string, right: string): Change[] {
  // Use JSON-aware diff to avoid spurious comma/whitespace changes.
  // Falls back to line-based diff for non-JSON content.
  try {
    if (left && right) {
      return diffJson(JSON.parse(left), JSON.parse(right));
    }
  } catch {
    // not valid JSON on one or both sides
  }
  return diffLines(left ?? '', right ?? '');
}

function computeDiffLines(left: string, right: string, useJsonDiff = true): DiffLine[] {
  const changes = useJsonDiff ? jsonDiff(left, right) : diffLines(left, right);
  const lines: DiffLine[] = [];
  for (const change of changes) {
    const text = change.value.endsWith('\n') ? change.value.slice(0, -1) : change.value;
    const subLines = text.split('\n');
    for (const line of subLines) {
      if (change.added) {
        lines.push({ content: line, type: 'add' });
      } else if (change.removed) {
        lines.push({ content: line, type: 'remove' });
      } else {
        lines.push({ content: line, type: 'equal' });
      }
    }
  }
  return lines;
}

function computeSideBySide(left: string, right: string, useJsonDiff = true) {
  const changes = useJsonDiff ? jsonDiff(left, right) : diffLines(left, right);
  const leftLines: { content: string; type: 'remove' | 'equal' | 'empty' }[] = [];
  const rightLines: { content: string; type: 'add' | 'equal' | 'empty' }[] = [];

  for (const change of changes) {
    const text = change.value.endsWith('\n') ? change.value.slice(0, -1) : change.value;
    const subLines = text.split('\n');

    if (change.added) {
      for (const line of subLines) {
        leftLines.push({ content: '', type: 'empty' });
        rightLines.push({ content: line, type: 'add' });
      }
    } else if (change.removed) {
      for (const line of subLines) {
        leftLines.push({ content: line, type: 'remove' });
        rightLines.push({ content: '', type: 'empty' });
      }
    } else {
      for (const line of subLines) {
        leftLines.push({ content: line, type: 'equal' });
        rightLines.push({ content: line, type: 'equal' });
      }
    }
  }

  return { leftLines, rightLines };
}

/* ================================================================
   Diff Renderers
   ================================================================ */

const LINE_STYLE: Record<string, React.CSSProperties> = {
  add: { backgroundColor: 'rgba(46, 160, 67, 0.15)', color: 'var(--mantine-color-green-4)' },
  remove: { backgroundColor: 'rgba(248, 81, 73, 0.15)', color: 'var(--mantine-color-red-4)' },
  equal: {},
  empty: { backgroundColor: 'rgba(128,128,128,0.05)' },
};

const MONO_STYLE: React.CSSProperties = {
  fontFamily: 'monospace',
  fontSize: 12,
  lineHeight: '20px',
  whiteSpace: 'pre',
  padding: '0 8px',
  minHeight: 20,
};

function InlineDiffView({ left, right, useJsonDiff = true }: { left: string; right: string; useJsonDiff?: boolean }) {
  const lines = useMemo(() => computeDiffLines(left, right, useJsonDiff), [left, right, useJsonDiff]);
  return (
    <div style={{ overflow: 'auto' }}>
      {lines.map((line, i) => (
        <div key={i} style={{ ...MONO_STYLE, ...LINE_STYLE[line.type] }}>
          <span style={{ display: 'inline-block', width: 18, opacity: 0.5, userSelect: 'none' }}>
            {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
          </span>
          {line.content}
        </div>
      ))}
    </div>
  );
}

function UnifiedCodeDiffView({ left, right }: { left: string; right: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const view = new EditorView({
      doc: right,
      extensions: [
        json(),
        EditorView.editable.of(false),
        EditorView.lineWrapping,
        lineNumbers(),
        unifiedMergeView({
          original: left,
          mergeControls: false,
        }),
      ],
      parent: containerRef.current,
    });

    return () => view.destroy();
  }, [left, right]);

  return <div ref={containerRef} style={{ height: '100%', overflow: 'hidden' }} />;
}

function SideBySideDiffView({
  left,
  right,
  useJsonDiff = true,
}: {
  left: string;
  right: string;
  useJsonDiff?: boolean;
}) {
  const { leftLines, rightLines } = useMemo(
    () => computeSideBySide(left, right, useJsonDiff),
    [left, right, useJsonDiff],
  );
  return (
    <div style={{ display: 'flex', gap: 2, overflow: 'auto' }}>
      <div style={{ flex: 1, borderRight: '1px solid var(--mantine-color-dark-4)' }}>
        {leftLines.map((line, i) => (
          <div key={i} style={{ ...MONO_STYLE, ...LINE_STYLE[line.type] }}>
            {line.content || '\u00A0'}
          </div>
        ))}
      </div>
      <div style={{ flex: 1 }}>
        {rightLines.map((line, i) => (
          <div key={i} style={{ ...MONO_STYLE, ...LINE_STYLE[line.type] }}>
            {line.content || '\u00A0'}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ================================================================
   Tab Labels & Colors
   ================================================================ */

const TAB_META: Record<DiffTab, { label: string; color: string }> = {
  userEdit: { label: 'User Edit', color: 'violet' },
  edit: { label: 'Edit', color: 'blue' },
  delete: { label: 'Delete', color: 'red' },
  create: { label: 'Create', color: 'green' },
  backfill: { label: 'Backfill', color: 'orange' },
};

/* ================================================================
   Main Component
   ================================================================ */

export function RecordPlanModal({ opened, onClose, workbookId, pipelineId, filePath }: RecordPlanModalProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<DiffTab>('userEdit');
  const [layout, setLayout] = useState<DiffLayout>('inline');
  const [engine, setEngine] = useState<DiffEngine>('json');

  // Data
  const [masterJson, setMasterJson] = useState<string>('');
  const [dirtyJson, setDirtyJson] = useState<string>('');
  const [entries, setEntries] = useState<PlanEntry[]>([]);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      // Fetch master, dirty, and entries in parallel
      const [masterRes, dirtyRes, allEntries] = await Promise.allSettled([
        workbookApi.getRepoFile(workbookId, filePath, 'main'),
        workbookApi.getRepoFile(workbookId, filePath, 'dirty'),
        workbookApi.listPublishPlanEntries(workbookId, pipelineId),
      ]);

      setMasterJson(masterRes.status === 'fulfilled' ? formatJson(masterRes.value.content) : '');
      setDirtyJson(dirtyRes.status === 'fulfilled' ? formatJson(dirtyRes.value.content) : '');

      // Filter entries for this file only
      const fileEntries = (allEntries.status === 'fulfilled' ? allEntries.value : []) as PlanEntry[];
      setEntries(fileEntries.filter((e) => e.filePath === filePath));
    } catch (err) {
      console.error('RecordPlanModal: fetch failed', err);
    } finally {
      setIsLoading(false);
    }
  }, [workbookId, pipelineId, filePath]);

  useEffect(() => {
    if (opened) {
      fetchData();
    }
  }, [opened, fetchData]);

  // Get operation JSON for a given phase
  const getPhaseJson = useCallback(
    (phase: string): string | null => {
      const entry = entries.find((e) => e.phase === phase);
      if (!entry?.content) return null;
      return formatJson(JSON.stringify(entry.content));
    },
    [entries],
  );

  // Determine which tabs are available
  const availableTabs = useMemo((): DiffTab[] => {
    const tabs: DiffTab[] = ['userEdit']; // always show user edit
    for (const phase of ['edit', 'delete', 'create', 'backfill'] as const) {
      if (entries.some((e) => e.phase === phase)) {
        tabs.push(phase);
      }
    }
    return tabs;
  }, [entries]);

  // Auto-select first available tab when data loads, but prefer userEdit
  useEffect(() => {
    if (!availableTabs.includes(activeTab)) {
      setActiveTab(availableTabs[0] ?? 'userEdit');
    }
  }, [availableTabs, activeTab]);

  // Compute diff pair for the active tab
  const { left, right } = useMemo(() => {
    const editJson = getPhaseJson('edit');
    const createJson = getPhaseJson('create');
    const deleteJson = getPhaseJson('delete');
    const backfillJson = getPhaseJson('backfill');

    switch (activeTab) {
      case 'userEdit':
        // master → dirty
        return { left: masterJson, right: dirtyJson };

      case 'edit':
        // dirty → edit (if dirty was deleted, master → edit)
        if (dirtyJson) {
          return { left: dirtyJson, right: editJson ?? '' };
        }
        return { left: masterJson, right: editJson ?? '' };

      case 'delete':
        // if there's an edit, edit → delete; otherwise master → delete
        if (editJson) {
          return { left: editJson, right: deleteJson ?? '' };
        }
        return { left: masterJson, right: deleteJson ?? '' };

      case 'create':
        // empty → create
        return { left: '', right: createJson ?? '' };

      case 'backfill': {
        // last operation → backfill
        // Priority: create > edit > dirty
        const lastOp = createJson ?? editJson ?? dirtyJson;
        return { left: lastOp ?? '', right: backfillJson ?? '' };
      }

      default:
        return { left: '', right: '' };
    }
  }, [activeTab, masterJson, dirtyJson, getPhaseJson]);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          <GitCompareIcon size={18} />
          <Title order={5}>Record Plan</Title>
          <Text size="xs" c="dimmed" ff="monospace">
            {filePath}
          </Text>
        </Group>
      }
      size="90%"
      zIndex={310}
    >
      {isLoading ? (
        <Stack align="center" py="xl">
          <Loader size="md" />
          <Text size="sm" c="dimmed">
            Loading record data...
          </Text>
        </Stack>
      ) : (
        <Stack gap="sm">
          {/* Tab bar */}
          <Group gap="xs" justify="space-between">
            <Group gap={4}>
              {availableTabs.map((tab) => (
                <Badge
                  key={tab}
                  color={TAB_META[tab].color}
                  variant={activeTab === tab ? 'filled' : 'outline'}
                  size="lg"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setActiveTab(tab)}
                >
                  {TAB_META[tab].label}
                </Badge>
              ))}
            </Group>
            <Group gap="xs">
              <SegmentedControl
                size="xs"
                value={layout}
                onChange={(v) => setLayout(v as DiffLayout)}
                data={[
                  { label: 'Inline', value: 'inline' },
                  { label: 'Side by Side', value: 'sideBySide' },
                ]}
              />
              <SegmentedControl
                size="xs"
                value={engine}
                onChange={(v) => setEngine(v as DiffEngine)}
                data={[
                  { label: 'JSON', value: 'json' },
                  { label: 'Text', value: 'text' },
                ]}
              />
            </Group>
          </Group>

          {/* Diff view */}
          {left === '' && right === '' ? (
            <Text size="sm" c="dimmed" ta="center" py="xl">
              No data for this phase.
            </Text>
          ) : engine === 'text' ? (
            <div style={{ height: 500 }}>
              {layout === 'inline' ? (
                <UnifiedCodeDiffView left={left} right={right} />
              ) : (
                <MergeEditor original={left} modified={right} extensions={[json(), EditorView.editable.of(false)]} />
              )}
            </div>
          ) : (
            <ScrollArea h={500}>
              {layout === 'inline' ? (
                <InlineDiffView left={left} right={right} useJsonDiff />
              ) : (
                <SideBySideDiffView left={left} right={right} useJsonDiff />
              )}
            </ScrollArea>
          )}
        </Stack>
      )}
    </Modal>
  );
}

/* ================================================================
   Helpers
   ================================================================ */

function formatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
