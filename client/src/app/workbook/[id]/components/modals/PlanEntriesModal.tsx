'use client';

import { workbookApi } from '@/lib/api/workbook';
import { json } from '@codemirror/lang-json';
import { EditorView } from '@codemirror/view';
import {
  Badge,
  Button,
  Group,
  Modal,
  ScrollArea,
  Stack,
  Table,
  Text,
  Title,
  useMantineColorScheme,
} from '@mantine/core';
import { PublishPlanEntryEntity, WorkbookId } from '@spinner/shared-types';
import CodeMirror from '@uiw/react-codemirror';
import { AlertTriangleIcon, CodeIcon, ListIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RecordPlanModal } from './RecordPlanModal';

type PlanEntry = PublishPlanEntryEntity;

type SortField = 'phase' | 'filePath';
type SortDir = 'asc' | 'desc';

const PHASE_ORDER: Record<string, number> = { edit: 0, create: 1, delete: 2, backfill: 3 };

const PHASE_COLOR: Record<string, string> = {
  create: 'green',
  edit: 'blue',
  delete: 'red',
  backfill: 'orange',
};

interface PlanEntriesModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
  pipelineId: string;
}

function JsonViewerModal({ entry, onClose }: { entry: PlanEntry; onClose: () => void }) {
  const { colorScheme } = useMantineColorScheme();
  const extensions = useMemo(() => [json(), EditorView.lineWrapping, EditorView.editable.of(false)], []);
  const content = JSON.stringify(entry.content, null, 2);

  return (
    <Modal
      opened
      onClose={onClose}
      title={
        <Group gap="xs">
          <CodeIcon size={18} />
          <Title order={5}>Operation JSON</Title>
          <Badge color={PHASE_COLOR[entry.phase] ?? 'gray'} size="sm">
            {entry.phase}
          </Badge>
          <Text size="xs" c="dimmed" ff="monospace">
            {entry.filePath}
          </Text>
        </Group>
      }
      size="xl"
      zIndex={310}
    >
      <CodeMirror
        value={content}
        extensions={extensions}
        theme={colorScheme === 'dark' ? 'dark' : 'light'}
        height="500px"
        editable={false}
      />
    </Modal>
  );
}

export function PlanEntriesModal({ opened, onClose, workbookId, pipelineId }: PlanEntriesModalProps) {
  const [entries, setEntries] = useState<PlanEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [sortField, setSortField] = useState<SortField>('phase');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [viewingEntry, setViewingEntry] = useState<PlanEntry | null>(null);
  const [viewingError, setViewingError] = useState<string | null>(null);
  const [viewingRecordPath, setViewingRecordPath] = useState<string | null>(null);

  const fetchEntries = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await workbookApi.listPublishPlanEntries(workbookId, pipelineId);
      setEntries(data);
    } catch (error) {
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  }, [workbookId, pipelineId]);

  useEffect(() => {
    if (opened) {
      fetchEntries();
    }
  }, [opened, fetchEntries]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const sorted = [...entries].sort((a, b) => {
    let cmp = 0;
    if (sortField === 'phase') {
      cmp = (PHASE_ORDER[a.phase] ?? 99) - (PHASE_ORDER[b.phase] ?? 99);
    } else {
      cmp = a.filePath.localeCompare(b.filePath);
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const sortIndicator = (field: SortField) => {
    if (sortField !== field) return ' ↕';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  };

  return (
    <>
      <Modal
        opened={opened}
        onClose={onClose}
        closeOnEscape={!viewingEntry && !viewingError && !viewingRecordPath}
        title={
          <Group gap="xs">
            <ListIcon size={20} />
            <Title order={4}>Plan Entries</Title>
            <Text size="sm" c="dimmed" ff="monospace">
              {pipelineId.substring(0, 8)}...
            </Text>
          </Group>
        }
        size="xl"
        zIndex={300}
      >
        <Stack>
          {isLoading ? (
            <Text size="sm" c="dimmed" ta="center" py="md">
              Loading...
            </Text>
          ) : (
            <ScrollArea h={480}>
              <Table stickyHeader highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th
                      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
                      onClick={() => handleSort('phase')}
                    >
                      Phase{sortIndicator('phase')}
                    </Table.Th>
                    <Table.Th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => handleSort('filePath')}>
                      File{sortIndicator('filePath')}
                    </Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th>Error</Table.Th>
                    <Table.Th>Operation</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {sorted.length === 0 ? (
                    <Table.Tr>
                      <Table.Td colSpan={5}>
                        <Text size="sm" c="dimmed" ta="center" py="md">
                          No entries found.
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ) : (
                    sorted.map((entry) => (
                      <Table.Tr key={entry.id}>
                        <Table.Td>
                          <Badge color={PHASE_COLOR[entry.phase] ?? 'gray'} size="sm">
                            {entry.phase}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          <Text
                            size="xs"
                            ff="monospace"
                            c="blue"
                            style={{ cursor: 'pointer', textDecoration: 'underline' }}
                            onClick={() => setViewingRecordPath(entry.filePath)}
                          >
                            {entry.filePath}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Badge
                            color={entry.status === 'success' ? 'green' : entry.status === 'failed' ? 'red' : 'gray'}
                            variant="outline"
                            size="sm"
                          >
                            {entry.status}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          {entry.error && (
                            <Button
                              size="xs"
                              variant="subtle"
                              color="red"
                              leftSection={<AlertTriangleIcon size={12} />}
                              onClick={() => setViewingError(entry.error!)}
                            >
                              View Error
                            </Button>
                          )}
                        </Table.Td>
                        <Table.Td>
                          <Button
                            size="xs"
                            variant="subtle"
                            leftSection={<CodeIcon size={12} />}
                            onClick={() => setViewingEntry(entry)}
                          >
                            View JSON
                          </Button>
                        </Table.Td>
                      </Table.Tr>
                    ))
                  )}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          )}
        </Stack>
      </Modal>

      {viewingEntry && <JsonViewerModal entry={viewingEntry} onClose={() => setViewingEntry(null)} />}

      {viewingError && (
        <Modal
          opened
          onClose={() => setViewingError(null)}
          title={
            <Group gap="xs">
              <AlertTriangleIcon size={18} color="var(--mantine-color-red-6)" />
              <Title order={5} c="red">
                Error Details
              </Title>
            </Group>
          }
          size="lg"
          zIndex={310}
        >
          <ScrollArea h={300}>
            <Text size="sm" ff="monospace" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {viewingError}
            </Text>
          </ScrollArea>
        </Modal>
      )}

      {viewingRecordPath && (
        <RecordPlanModal
          opened
          onClose={() => setViewingRecordPath(null)}
          workbookId={workbookId}
          pipelineId={pipelineId}
          filePath={viewingRecordPath}
        />
      )}
    </>
  );
}
