import { useConnectorAccounts } from '@/hooks/use-connector-account';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { progressApi } from '@/lib/api/progress';
import { workbookApi } from '@/lib/api/workbook';
import {
  Badge,
  Button,
  Checkbox,
  Code,
  Group,
  Menu,
  Modal,
  Popover,
  ScrollArea,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { useInterval } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { ConnectorAccount, WorkbookId } from '@spinner/shared-types';
import {
  ChevronDownIcon,
  InfoIcon,
  ListIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  RocketIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { PlanEntriesModal } from './PlanEntriesModal';

interface TestPublishV2ModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
}

interface PipelineJob {
  status: string;
  type: string;
  progress?: unknown;
}

// Define interface locally for now as it matches server return
interface PublishPipeline {
  id: string;
  status: string;
  createdAt: string;
  connectorAccountId?: string;
  activeJobId?: string | null;
  job?: PipelineJob | null;
  _count?: { entries: number };
}

const PHASES = ['edit', 'create', 'delete', 'backfill'] as const;

const JOB_ACTIVE_STATUSES = new Set(['created', 'active', 'waiting']);

function jobStatusBadgeColor(status: string): string {
  if (status === 'active') return 'blue';
  if (status === 'completed') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'canceled') return 'grape';
  return 'gray';
}

export function TestPublishV2Modal({ opened, onClose, workbookId }: TestPublishV2ModalProps) {
  const [pipelines, setPipelines] = useState<PublishPipeline[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isPlanning, setIsPlanning] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [entriesModalPipelineId, setEntriesModalPipelineId] = useState<string | null>(null);
  const [showAdminUI, setShowAdminUI] = useState(false);

  const { isAdmin } = useScratchPadUser();
  const adminMode = isAdmin && showAdminUI;
  const { connectorAccounts } = useConnectorAccounts(opened ? workbookId : undefined);

  const connectorMap = new Map<string, ConnectorAccount>((connectorAccounts ?? []).map((ca) => [ca.id, ca]));

  const fetchPipelines = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await workbookApi.listPublishV2Pipelines(workbookId);
      setPipelines(data);
    } catch (error) {
      console.error(error);
      notifications.show({
        title: 'Error',
        message: 'Failed to list pipelines',
        color: 'red',
      });
    } finally {
      setIsLoading(false);
    }
  }, [workbookId]);

  const { start, stop } = useInterval(fetchPipelines, 2000);

  useEffect(() => {
    if (opened) {
      fetchPipelines();
      start();
    } else {
      stop();
    }
    return stop;
  }, [opened, fetchPipelines, start, stop]);

  const handlePlanAll = async (runAfterPlan: boolean) => {
    setIsPlanning(true);
    try {
      const accounts = connectorAccounts ?? [];
      if (accounts.length === 0) {
        await workbookApi.planPublishV2(workbookId, undefined, runAfterPlan);
      } else {
        for (const ca of accounts) {
          await workbookApi.planPublishV2(workbookId, ca.id, runAfterPlan);
        }
      }
      const message = runAfterPlan
        ? 'Planning and run started for all connections'
        : 'Planning started for all connections';
      notifications.show({ title: 'Success', message, color: 'green' });
      fetchPipelines();
    } catch (error) {
      console.error(error);
      notifications.show({ title: 'Error', message: 'Failed to plan publish', color: 'red' });
    } finally {
      setIsPlanning(false);
    }
  };

  const handlePlanOne = async (connectorAccountId: string, runAfterPlan: boolean) => {
    setIsPlanning(true);
    try {
      await workbookApi.planPublishV2(workbookId, connectorAccountId, runAfterPlan);
      const name = connectorMap.get(connectorAccountId)?.displayName ?? connectorAccountId;
      const message = runAfterPlan ? `Planning and run started for ${name}` : `Planning started for ${name}`;
      notifications.show({ title: 'Success', message, color: 'green' });
      fetchPipelines();
    } catch (error) {
      console.error(error);
      notifications.show({ title: 'Error', message: 'Failed to plan publish', color: 'red' });
    } finally {
      setIsPlanning(false);
    }
  };

  const handleRun = async (pipelineId: string, phase?: string) => {
    setRunningId(pipelineId);
    try {
      await workbookApi.runPublishV2(workbookId, pipelineId, phase);
      notifications.show({
        title: 'Success',
        message: phase ? `Running ${phase} phase` : 'Running all phases',
        color: 'green',
      });
      setTimeout(fetchPipelines, 1000);
    } catch (error) {
      console.error(error);
      notifications.show({ title: 'Error', message: 'Failed to run publish', color: 'red' });
    } finally {
      setRunningId(null);
    }
  };

  const handleCancel = async (pipeline: PublishPipeline) => {
    if (!pipeline.activeJobId) return;
    setCancelingId(pipeline.id);
    try {
      const result = await progressApi.cancelJob(pipeline.activeJobId);
      if (result.success) {
        notifications.show({ title: 'Canceled', message: 'Cancellation signal sent', color: 'orange' });
        setTimeout(fetchPipelines, 1000);
      } else {
        notifications.show({ title: 'Warning', message: result.message, color: 'yellow' });
      }
    } catch (error) {
      console.error(error);
      notifications.show({ title: 'Error', message: 'Failed to cancel job', color: 'red' });
    } finally {
      setCancelingId(null);
    }
  };

  const accounts = connectorAccounts ?? [];

  return (
    <>
      <Modal
        opened={opened}
        onClose={onClose}
        closeOnEscape={!entriesModalPipelineId}
        title={
          <Group gap="xs">
            <RocketIcon size={20} />
            <Title order={4}>Publish Pipelines</Title>
          </Group>
        }
        size="90%"
      >
        <Stack>
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              Manage publish pipelines (DB-backed V2)
            </Text>
            <Group>
              <Button
                variant="default"
                size="xs"
                leftSection={<RefreshCwIcon size={14} />}
                loading={isLoading}
                onClick={fetchPipelines}
              >
                Refresh
              </Button>

              {isAdmin && (
                <Checkbox
                  size="xs"
                  label="Show admin UI"
                  checked={showAdminUI}
                  onChange={(e) => setShowAdminUI(e.currentTarget.checked)}
                />
              )}

              {/* Plan and Run split button */}
              <Group gap={0}>
                <Button
                  size="xs"
                  leftSection={<PlusIcon size={14} />}
                  loading={isPlanning}
                  onClick={() => handlePlanAll(true)}
                  style={{
                    borderTopRightRadius: adminMode ? 0 : undefined,
                    borderBottomRightRadius: adminMode ? 0 : undefined,
                  }}
                >
                  Plan and Run Publish
                </Button>
                {adminMode && (
                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target>
                      <Button
                        size="xs"
                        px={6}
                        disabled={isPlanning}
                        style={{
                          borderTopLeftRadius: 0,
                          borderBottomLeftRadius: 0,
                          borderLeft: '1px solid var(--mantine-color-blue-light-hover)',
                        }}
                      >
                        <ChevronDownIcon size={12} />
                      </Button>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Label>Admin actions</Menu.Label>
                      <Menu.Item onClick={() => handlePlanAll(false)}>Plan Only (all connections)</Menu.Item>
                      {accounts.length > 0 && (
                        <>
                          <Menu.Divider />
                          <Menu.Label>Plan and run single connection</Menu.Label>
                          {accounts.map((ca) => (
                            <Menu.Item key={`run-${ca.id}`} onClick={() => handlePlanOne(ca.id, true)}>
                              {ca.displayName}
                            </Menu.Item>
                          ))}
                          <Menu.Divider />
                          <Menu.Label>Plan only single connection</Menu.Label>
                          {accounts.map((ca) => (
                            <Menu.Item key={`plan-${ca.id}`} onClick={() => handlePlanOne(ca.id, false)}>
                              {ca.displayName}
                            </Menu.Item>
                          ))}
                        </>
                      )}
                    </Menu.Dropdown>
                  </Menu>
                )}
              </Group>
            </Group>
          </Group>

          <ScrollArea h={400}>
            <Table stickyHeader>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>ID</Table.Th>
                  <Table.Th>Connection</Table.Th>
                  <Table.Th>Created At</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Job</Table.Th>
                  <Table.Th>Edits</Table.Th>
                  <Table.Th>Creates</Table.Th>
                  <Table.Th>Deletes</Table.Th>
                  <Table.Th>Backfills</Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {pipelines.length === 0 ? (
                  <Table.Tr>
                    <Table.Td colSpan={10}>
                      <Text size="sm" c="dimmed" ta="center" py="md">
                        No pipelines found. Click Plan and Run Publish to start one.
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ) : (
                  pipelines.map((p) => {
                    const hasActiveJob = !!p.activeJobId && !!p.job && JOB_ACTIVE_STATUSES.has(p.job.status);
                    return (
                      <Table.Tr key={p.id}>
                        <Table.Td>
                          <Text size="xs" ff="monospace">
                            {p.id.substring(0, 8)}...
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" c={p.connectorAccountId ? undefined : 'dimmed'}>
                            {p.connectorAccountId
                              ? (connectorMap.get(p.connectorAccountId)?.displayName ??
                                p.connectorAccountId.substring(0, 8) + '…')
                              : 'All'}
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs">{new Date(p.createdAt).toLocaleString()}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Badge
                            color={
                              p.status === 'completed'
                                ? 'green'
                                : p.status === 'completed-with-errors'
                                  ? 'orange'
                                  : p.status === 'failed'
                                    ? 'red'
                                    : p.status === 'canceled'
                                      ? 'grape'
                                      : p.status.endsWith('-running')
                                        ? 'blue'
                                        : p.status.endsWith('-completed')
                                          ? 'teal'
                                          : p.status === 'planned'
                                            ? 'yellow'
                                            : 'gray'
                            }
                            size="sm"
                          >
                            {p.status}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          {p.job ? (
                            <Group gap={4} wrap="nowrap">
                              <Badge color={jobStatusBadgeColor(p.job.status)} size="sm" variant="outline">
                                {p.job.type === 'publish-plan' ? 'planning' : 'running'} · {p.job.status}
                              </Badge>
                              <Popover position="bottom-start" withinPortal shadow="md" width={340}>
                                <Popover.Target>
                                  <Button size="compact-xs" variant="subtle" color="gray" px={2}>
                                    <InfoIcon size={12} />
                                  </Button>
                                </Popover.Target>
                                <Popover.Dropdown>
                                  <ScrollArea h={200}>
                                    <Code block style={{ fontSize: 11 }}>
                                      {JSON.stringify(p.job, null, 2)}
                                    </Code>
                                  </ScrollArea>
                                </Popover.Dropdown>
                              </Popover>
                            </Group>
                          ) : (
                            <Text size="xs" c="dimmed">
                              —
                            </Text>
                          )}
                        </Table.Td>
                        {(['edits', 'creates', 'deletes', 'backfills'] as const).map((phaseKey) => {
                          const totalKey = `total${phaseKey.charAt(0).toUpperCase() + phaseKey.slice(1)}` as
                            | 'totalEdits'
                            | 'totalCreates'
                            | 'totalDeletes'
                            | 'totalBackfills';
                          const pub = p.job?.progress as
                            | { publicProgress?: Record<string, number> }
                            | undefined;
                          const completed = pub?.publicProgress?.[phaseKey] ?? 0;
                          const total = pub?.publicProgress?.[totalKey] ?? 0;
                          return (
                            <Table.Td key={phaseKey}>
                              {total > 0 ? (
                                <Text size="xs" c={completed < total ? 'blue' : completed > 0 ? 'green' : undefined}>
                                  {completed}/{total}
                                </Text>
                              ) : completed > 0 ? (
                                <Text size="xs" c="green">{completed}</Text>
                              ) : (
                                <Text size="xs" c="dimmed">—</Text>
                              )}
                            </Table.Td>
                          );
                        })}
                        <Table.Td>
                          <Group gap="xs">
                            <Button
                              size="xs"
                              variant="light"
                              leftSection={<ListIcon size={12} />}
                              onClick={() => setEntriesModalPipelineId(p.id)}
                            >
                              View Entries
                            </Button>

                            {/* Cancel button — shown to all users when a job is active */}
                            {hasActiveJob && (
                              <Button
                                size="xs"
                                variant="light"
                                color="red"
                                leftSection={<XIcon size={12} />}
                                loading={cancelingId === p.id}
                                onClick={() => handleCancel(p)}
                                disabled={cancelingId !== null && cancelingId !== p.id}
                              >
                                Cancel
                              </Button>
                            )}

                            {/* Resume button — visible to all users for canceled pipelines with no active job.
                                If entries exist it was a canceled run (resumable); if no entries it was a
                                canceled plan (re-plan using the existing connector scope). */}
                            {p.status === 'canceled' && !hasActiveJob && (
                              <Button
                                size="xs"
                                variant="light"
                                color="grape"
                                leftSection={<PlayIcon size={12} />}
                                loading={runningId === p.id || isPlanning}
                                onClick={() => {
                                  if ((p._count?.entries ?? 0) > 0) {
                                    // Canceled run — resume from where it left off
                                    void handleRun(p.id);
                                  } else {
                                    // Canceled plan — re-plan (entries were wiped, start fresh)
                                    void handlePlanOne(p.connectorAccountId ?? '', true);
                                  }
                                }}
                                disabled={isPlanning || (runningId !== null && runningId !== p.id)}
                              >
                                Resume
                              </Button>
                            )}

                            {/* Run button group — admin only, for non-canceled non-completed pipelines */}
                            {adminMode &&
                              !hasActiveJob &&
                              p.status !== 'completed' &&
                              p.status !== 'completed-with-errors' &&
                              p.status !== 'canceled' &&
                              !p.status.endsWith('-running') && (
                                <Group gap={0}>
                                  <Button
                                    size="xs"
                                    variant="light"
                                    color="green"
                                    leftSection={<PlayIcon size={12} />}
                                    loading={runningId === p.id}
                                    onClick={() => handleRun(p.id)}
                                    disabled={isPlanning || (runningId !== null && runningId !== p.id)}
                                    style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
                                  >
                                    Run All
                                  </Button>
                                  <Menu position="bottom-end" withinPortal>
                                    <Menu.Target>
                                      <Button
                                        size="xs"
                                        variant="light"
                                        color="green"
                                        px={6}
                                        disabled={isPlanning || (runningId !== null && runningId !== p.id)}
                                        style={{
                                          borderTopLeftRadius: 0,
                                          borderBottomLeftRadius: 0,
                                          borderLeft: '1px solid var(--mantine-color-green-light-hover)',
                                        }}
                                      >
                                        <ChevronDownIcon size={12} />
                                      </Button>
                                    </Menu.Target>
                                    <Menu.Dropdown>
                                      <Menu.Label>Run single phase</Menu.Label>
                                      {PHASES.map((phase) => (
                                        <Menu.Item
                                          key={phase}
                                          onClick={() => handleRun(p.id, phase)}
                                          leftSection={<PlayIcon size={12} />}
                                        >
                                          {phase.charAt(0).toUpperCase() + phase.slice(1)}
                                        </Menu.Item>
                                      ))}
                                    </Menu.Dropdown>
                                  </Menu>
                                </Group>
                              )}

                            <Button
                              size="xs"
                              variant="subtle"
                              color="red"
                              leftSection={<Trash2Icon size={12} />}
                              onClick={async () => {
                                if (confirm('Are you sure you want to delete this pipeline?')) {
                                  await workbookApi.deletePublishV2Pipeline(workbookId, p.id);
                                  fetchPipelines();
                                }
                              }}
                            >
                              Delete
                            </Button>
                          </Group>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })
                )}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        </Stack>
      </Modal>

      {entriesModalPipelineId && (
        <PlanEntriesModal
          opened={!!entriesModalPipelineId}
          onClose={() => setEntriesModalPipelineId(null)}
          workbookId={workbookId}
          pipelineId={entriesModalPipelineId}
        />
      )}
    </>
  );
}
