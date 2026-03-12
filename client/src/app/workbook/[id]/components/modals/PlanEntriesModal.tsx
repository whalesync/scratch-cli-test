'use client';

import { workbookApi } from '@/lib/api/workbook';
import { json } from '@codemirror/lang-json';
import { EditorView } from '@codemirror/view';
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Modal,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  Title,
  useMantineColorScheme,
} from '@mantine/core';
import { PublishPlanOperationEntity, WorkbookId } from '@spinner/shared-types';
import CodeMirror from '@uiw/react-codemirror';
import {
  AlertTriangleIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CodeIcon,
  ExternalLinkIcon,
  ListIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RecordPlanModal } from './RecordPlanModal';

type PlanOperation = PublishPlanOperationEntity;

const PHASE_COLOR: Record<string, string> = {
  'asset-upload': 'cyan',
  create: 'green',
  edit: 'blue',
  delete: 'red',
  backfill: 'orange',
  'rename-files': 'violet',
};

const PHASE_LABEL: Record<string, string> = {
  'asset-upload': 'Upload',
  'rename-files': 'Rename Files',
};

const PHASE_OPTIONS = [
  { value: '', label: 'All Phases' },
  { value: 'asset-upload', label: 'Asset Upload' },
  { value: 'edit', label: 'Edit' },
  { value: 'create', label: 'Create' },
  { value: 'delete', label: 'Delete' },
  { value: 'backfill', label: 'Backfill' },
  { value: 'rename-files', label: 'Rename Files' },
];

interface PlanEntriesModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
  publishPlanId: string;
  initialHasErrorFilter?: boolean;
  initialPhaseFilter?: string;
}

function JsonViewerModal({ operation, onClose }: { operation: PlanOperation; onClose: () => void }) {
  const { colorScheme } = useMantineColorScheme();
  const extensions = useMemo(() => [json(), EditorView.lineWrapping, EditorView.editable.of(false)], []);
  const displayContent =
    (operation.phase === 'edit' || operation.phase === 'backfill') && operation.changedFields
      ? operation.changedFields
      : operation.content;
  const content = JSON.stringify(displayContent, null, 2);

  return (
    <Modal
      opened
      onClose={onClose}
      title={
        <Group gap="xs">
          <CodeIcon size={18} />
          <Title order={5}>Operation JSON</Title>
          <Badge color={PHASE_COLOR[operation.phase] ?? 'gray'} size="sm">
            {PHASE_LABEL[operation.phase] ?? operation.phase}
          </Badge>
          <Text size="xs" c="dimmed" ff="monospace">
            {operation.filePath}
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

export function PlanEntriesModal({
  opened,
  onClose,
  workbookId,
  publishPlanId,
  initialHasErrorFilter = false,
  initialPhaseFilter = '',
}: PlanEntriesModalProps) {
  const [operations, setOperations] = useState<PlanOperation[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);
  const [isLoading, setIsLoading] = useState(false);
  const [phaseFilter, setPhaseFilter] = useState(initialPhaseFilter);
  const [hasErrorFilter, setHasErrorFilter] = useState(initialHasErrorFilter);
  const [viewingOperation, setViewingOperation] = useState<PlanOperation | null>(null);
  const [viewingError, setViewingError] = useState<string | null>(null);
  const [viewingRecordPath, setViewingRecordPath] = useState<string | null>(null);

  const fetchOperations = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await workbookApi.listPublishPlanOperations(workbookId, publishPlanId, {
        page,
        pageSize,
        phase: phaseFilter || undefined,
        hasError: hasErrorFilter || undefined,
      });
      setOperations(result.data);
      setTotal(result.total);
    } catch (error) {
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  }, [workbookId, publishPlanId, page, pageSize, phaseFilter, hasErrorFilter]);

  useEffect(() => {
    if (opened) {
      fetchOperations();
    }
  }, [opened, fetchOperations]);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [phaseFilter, hasErrorFilter]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <Modal
        opened={opened}
        onClose={onClose}
        closeOnEscape={!viewingOperation && !viewingError && !viewingRecordPath}
        title={
          <Group gap="xs">
            <ListIcon size={20} />
            <Title order={4}>Plan Operations</Title>
            <Text size="sm" c="dimmed" ff="monospace">
              {publishPlanId.substring(0, 8)}...
            </Text>
          </Group>
        }
        size="xl"
        zIndex={300}
      >
        <Stack>
          {/* Filters */}
          <Group gap="sm">
            <Select
              size="xs"
              w={160}
              data={PHASE_OPTIONS}
              value={phaseFilter}
              onChange={(v) => setPhaseFilter(v ?? '')}
              placeholder="Filter by phase"
              clearable={false}
            />
            <Switch
              size="xs"
              label="Has Error"
              checked={hasErrorFilter}
              onChange={(e) => setHasErrorFilter(e.currentTarget.checked)}
            />
            <Text size="xs" c="dimmed" ml="auto">
              {total} operations
            </Text>
          </Group>

          {isLoading ? (
            <Text size="sm" c="dimmed" ta="center" py="md">
              Loading...
            </Text>
          ) : (
            <ScrollArea h={420}>
              <Table stickyHeader highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w={120} style={{ whiteSpace: 'nowrap' }}>
                      Phase
                    </Table.Th>
                    <Table.Th>File</Table.Th>
                    <Table.Th w={100}>Status</Table.Th>
                    <Table.Th>Error</Table.Th>
                    <Table.Th>Operation</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {operations.length === 0 ? (
                    <Table.Tr>
                      <Table.Td colSpan={5}>
                        <Text size="sm" c="dimmed" ta="center" py="md">
                          No operations found.
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ) : (
                    operations.map((operation) => (
                      <Table.Tr key={operation.id}>
                        <Table.Td>
                          <Badge color={PHASE_COLOR[operation.phase] ?? 'gray'} size="sm">
                            {PHASE_LABEL[operation.phase] ?? operation.phase}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          {operation.phase === 'asset-upload' &&
                          (operation.content as { rehostedUrl?: string })?.rehostedUrl ? (
                            <Text
                              size="xs"
                              ff="monospace"
                              c="blue"
                              component="a"
                              href={(operation.content as { rehostedUrl: string }).rehostedUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ textDecoration: 'underline' }}
                            >
                              {operation.filePath} <ExternalLinkIcon size={10} style={{ display: 'inline' }} />
                            </Text>
                          ) : (
                            <Text
                              size="xs"
                              ff="monospace"
                              c="blue"
                              style={{ cursor: 'pointer', textDecoration: 'underline' }}
                              onClick={() => setViewingRecordPath(operation.filePath)}
                            >
                              {operation.filePath}
                            </Text>
                          )}
                        </Table.Td>
                        <Table.Td>
                          <Badge
                            color={
                              operation.status === 'success' ? 'green' : operation.status === 'failed' ? 'red' : 'gray'
                            }
                            variant="outline"
                            size="sm"
                          >
                            {operation.status}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          {operation.error && (
                            <Button
                              size="xs"
                              variant="subtle"
                              color="red"
                              leftSection={<AlertTriangleIcon size={12} />}
                              onClick={() => setViewingError(operation.error!)}
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
                            onClick={() => setViewingOperation(operation)}
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

          {/* Pagination */}
          {totalPages > 1 && (
            <Group justify="center" gap="sm">
              <ActionIcon
                variant="subtle"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeftIcon size={14} />
              </ActionIcon>
              <Text size="xs" c="dimmed">
                Page {page} of {totalPages}
              </Text>
              <ActionIcon
                variant="subtle"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                <ChevronRightIcon size={14} />
              </ActionIcon>
            </Group>
          )}
        </Stack>
      </Modal>

      {viewingOperation && <JsonViewerModal operation={viewingOperation} onClose={() => setViewingOperation(null)} />}

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
          publishPlanId={publishPlanId}
          filePath={viewingRecordPath}
        />
      )}
    </>
  );
}
