import { ModalWrapper } from '@/app/components/ModalWrapper';
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
  Popover,
  ScrollArea,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { useInterval } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { ConnectorAccount, PublishPlanEntity, WorkbookId } from '@spinner/shared-types';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import {
  ChevronDownIcon,
  FilePenLineIcon,
  InfoIcon,
  ListIcon,
  MoveIcon,
  PlayIcon,
  PlusCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  RepeatIcon,
  RocketIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { PlanEntriesModal } from './PlanEntriesModal';

dayjs.extend(relativeTime);

interface PublishPlansModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
}

const JOB_ACTIVE_STATUSES = new Set(['created', 'active', 'waiting']);

function jobStatusBadgeColor(status: string): string {
  if (status === 'active') return 'blue';
  if (status === 'completed') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'canceled') return 'grape';
  return 'gray';
}

function formatCount(count: number): string {
  if (count >= 10000) {
    return (count / 1000).toFixed(1) + 'K';
  }
  return count.toString();
}

export function PublishPlansModal({ opened, onClose, workbookId }: PublishPlansModalProps) {
  const [publishPlans, setPublishPlans] = useState<PublishPlanEntity[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isPlanning, setIsPlanning] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [operationsModalPublishPlanId, setOperationsModalPublishPlanId] = useState<string | null>(null);
  const [showAdminUI, setShowAdminUI] = useState(false);

  const { isAdmin } = useScratchPadUser();
  const adminMode = isAdmin && showAdminUI;
  const { connectorAccounts } = useConnectorAccounts(opened ? workbookId : undefined);

  const connectorMap = new Map<string, ConnectorAccount>((connectorAccounts ?? []).map((ca) => [ca.id, ca]));

  const fetchPublishPlans = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await workbookApi.listPublishPlans(workbookId);
      setPublishPlans(data);
    } catch (error) {
      console.error(error);
      notifications.show({
        title: 'Error',
        message: 'Failed to list publish plans',
        color: 'red',
      });
    } finally {
      setIsLoading(false);
    }
  }, [workbookId]);

  const { start, stop } = useInterval(fetchPublishPlans, 2000);

  useEffect(() => {
    if (opened) {
      fetchPublishPlans();
      start();
    } else {
      stop();
    }
    return stop;
  }, [opened, fetchPublishPlans, start, stop]);

  const handlePlanAll = async (runAfterPlan: boolean) => {
    setIsPlanning(true);
    try {
      const accounts = connectorAccounts ?? [];
      let anyChanges = false;
      if (accounts.length === 0) {
        const res = await workbookApi.planPublishV2(workbookId, undefined, runAfterPlan);
        if (res.jobId) anyChanges = true;
      } else {
        for (const ca of accounts) {
          const res = await workbookApi.planPublishV2(workbookId, ca.id, runAfterPlan);
          if (res.jobId) anyChanges = true;
        }
      }

      if (!anyChanges) {
        notifications.show({ title: 'Notice', message: 'No changes detected', color: 'yellow' });
      } else {
        const message = runAfterPlan
          ? 'Planning and run started for all connections'
          : 'Planning started for all connections';
        notifications.show({ title: 'Success', message, color: 'green' });
        fetchPublishPlans();
      }
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
      const res = await workbookApi.planPublishV2(workbookId, connectorAccountId, runAfterPlan);
      if (!res.jobId) {
        notifications.show({ title: 'Notice', message: 'No changes detected', color: 'yellow' });
      } else {
        const name = connectorMap.get(connectorAccountId)?.displayName ?? connectorAccountId;
        const message = runAfterPlan ? `Planning and run started for ${name}` : `Planning started for ${name}`;
        notifications.show({ title: 'Success', message, color: 'green' });
        fetchPublishPlans();
      }
    } catch (error) {
      console.error(error);
      notifications.show({ title: 'Error', message: 'Failed to plan publish', color: 'red' });
    } finally {
      setIsPlanning(false);
    }
  };

  const handleRun = async (publishPlanId: string, executeSinglePhase?: boolean) => {
    setRunningId(publishPlanId);
    try {
      await workbookApi.runPublishV2(workbookId, publishPlanId, executeSinglePhase);
      notifications.show({
        title: 'Success',
        message: executeSinglePhase ? `Running 1 phase` : 'Running all phases',
        color: 'green',
      });
      setTimeout(fetchPublishPlans, 1000);
    } catch (error) {
      console.error(error);
      notifications.show({ title: 'Error', message: 'Failed to run publish', color: 'red' });
    } finally {
      setRunningId(null);
    }
  };

  const handleCancel = async (publishPlan: PublishPlanEntity) => {
    if (!publishPlan.activeJobId) return;
    setCancelingId(publishPlan.id);
    try {
      const result = await progressApi.cancelJob(publishPlan.activeJobId);
      if (result.success) {
        notifications.show({ title: 'Canceled', message: 'Cancellation signal sent', color: 'orange' });
        setTimeout(fetchPublishPlans, 1000);
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
      <ModalWrapper
        opened={opened}
        onClose={onClose}
        closeOnEscape={!operationsModalPublishPlanId}
        title={
          <Group gap="xs">
            <RocketIcon size={20} />
            <Title order={4}>Publish Plans</Title>
          </Group>
        }
        size="90%"
        customProps={{ footer: null, noBodyPadding: true }}
      >
        <Stack p="md">
          <Group justify="space-between">
            <Text size="sm" c="dimmed"></Text>
            <Group>
              <Button
                variant="default"
                size="xs"
                leftSection={<RefreshCwIcon size={14} />}
                loading={isLoading}
                onClick={fetchPublishPlans}
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
                    borderTopRightRadius: 0,
                    borderBottomRightRadius: 0,
                  }}
                >
                  Plan and Run Publish
                </Button>
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
                    <Menu.Label>Publish Actions</Menu.Label>
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
              </Group>
            </Group>
          </Group>

          <ScrollArea h={400}>
            <Table stickyHeader>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>State</Table.Th>
                  <Table.Th>ID</Table.Th>
                  <Table.Th>Connection</Table.Th>
                  <Table.Th>Phase</Table.Th>
                  <Table.Th>
                    <Group gap={4} wrap="nowrap">
                      <FilePenLineIcon size={12} />
                      Edits
                    </Group>
                  </Table.Th>
                  <Table.Th>
                    <Group gap={4} wrap="nowrap">
                      <PlusCircleIcon size={12} />
                      Creates
                    </Group>
                  </Table.Th>
                  <Table.Th>
                    <Group gap={4} wrap="nowrap">
                      <Trash2Icon size={12} />
                      Deletes
                    </Group>
                  </Table.Th>
                  <Table.Th>
                    <Group gap={4} wrap="nowrap">
                      <RepeatIcon size={12} />
                      Backfills
                    </Group>
                  </Table.Th>
                  <Table.Th>
                    <Group gap={4} wrap="nowrap">
                      <MoveIcon size={12} />
                      Renames
                    </Group>
                  </Table.Th>
                  <Table.Th>Created At</Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {publishPlans.length === 0 ? (
                  <Table.Tr>
                    <Table.Td colSpan={11}>
                      <Text size="sm" c="dimmed" ta="center" py="md">
                        No publish plans found. Click Plan and Run Publish to start one.
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ) : (
                  publishPlans.map((p) => {
                    const hasActiveJob = !!p.activeJobId && !!p.job && JOB_ACTIVE_STATUSES.has(p.job.status);
                    return (
                      <Table.Tr key={p.id}>
                        <Table.Td>
                          {p.job ? (
                            <Group gap={4} wrap="nowrap">
                              <Badge color={jobStatusBadgeColor(p.job.status)} size="sm" variant="outline">
                                {p.job.status}
                              </Badge>
                              {p.job.type === 'publish-plan' &&
                                (p.job.progress as { publicProgress?: { step?: string } })?.publicProgress?.step && (
                                  <Text
                                    size="xs"
                                    c="dimmed"
                                    style={{
                                      whiteSpace: 'nowrap',
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      maxWidth: '200px',
                                    }}
                                  >
                                    {(p.job.progress as { publicProgress?: { step?: string } }).publicProgress!.step}
                                  </Text>
                                )}
                              {adminMode && p.bullJob && (
                                <Popover position="bottom-start" withinPortal shadow="md" width={340}>
                                  <Popover.Target>
                                    <Tooltip label="BullMQ Job Data" position="top">
                                      <Button size="compact-xs" variant="subtle" color="gray" px={2}>
                                        <InfoIcon size={12} />
                                      </Button>
                                    </Tooltip>
                                  </Popover.Target>
                                  <Popover.Dropdown>
                                    <ScrollArea h={200}>
                                      <Code block style={{ fontSize: 11 }}>
                                        {JSON.stringify(p.bullJob, null, 2)}
                                      </Code>
                                    </ScrollArea>
                                  </Popover.Dropdown>
                                </Popover>
                              )}
                              {adminMode && p.dbJob && (
                                <Popover position="bottom-start" withinPortal shadow="md" width={340}>
                                  <Popover.Target>
                                    <Tooltip label="DB Job Data" position="top">
                                      <Button size="compact-xs" variant="subtle" color="blue" px={2}>
                                        <InfoIcon size={12} />
                                      </Button>
                                    </Tooltip>
                                  </Popover.Target>
                                  <Popover.Dropdown>
                                    <ScrollArea h={200}>
                                      <Code block style={{ fontSize: 11 }}>
                                        {JSON.stringify(p.dbJob, null, 2)}
                                      </Code>
                                    </ScrollArea>
                                  </Popover.Dropdown>
                                </Popover>
                              )}
                            </Group>
                          ) : (
                            <Text size="xs" c="dimmed">
                              —
                            </Text>
                          )}
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" ff="monospace">
                            {p.id.substring(0, 8)}...
                          </Text>
                        </Table.Td>
                        <Table.Td>
                          <Group gap="xs" wrap="nowrap">
                            {/* {p.connectorAccount?.service ? getServiceIcon(p.connectorAccount.service, 14) : null} */}
                            <Text size="xs" c={p.connectorAccountId ? undefined : 'dimmed'}>
                              {p.connectorAccountId
                                ? (connectorMap.get(p.connectorAccountId)?.displayName ??
                                  p.connectorAccountId.substring(0, 8) + '…')
                                : 'All'}
                            </Text>

                            {/* {p.filePath ? (
                              <Tooltip label={`Scoped to file: ${p.filePath}`} position="top" withArrow>
                                <FileIcon size={14} color="gray" />
                              </Tooltip>
                            ) : p.folderPath ? (
                              <Tooltip label={`Scoped to folder: ${p.folderPath}`} position="top" withArrow>
                                <FolderIcon size={14} color="gray" />
                              </Tooltip>
                            ) : null} */}
                          </Group>
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
                        {(['edits', 'creates', 'deletes', 'backfills', 'renameFiles'] as const).map((phaseKey) => {
                          const executedKey = `${phaseKey}Executed` as
                            | 'editsExecuted'
                            | 'createsExecuted'
                            | 'deletesExecuted'
                            | 'backfillsExecuted'
                            | 'renameFilesExecuted';
                          const plannedKey = `${phaseKey}Planned` as
                            | 'editsPlanned'
                            | 'createsPlanned'
                            | 'deletesPlanned'
                            | 'backfillsPlanned'
                            | 'renameFilesPlanned';
                          const pub = p.job?.progress as { publicProgress?: Record<string, number> } | undefined;
                          const completed = pub?.publicProgress?.[executedKey] ?? 0;
                          const total = pub?.publicProgress?.[plannedKey] ?? 0;
                          return (
                            <Table.Td key={phaseKey}>
                              {total > 0 ? (
                                <Text size="xs" c={completed < total ? 'blue' : completed > 0 ? 'green' : undefined}>
                                  {formatCount(completed)}/{formatCount(total)}
                                </Text>
                              ) : completed > 0 ? (
                                <Text size="xs" c="green">
                                  {formatCount(completed)}
                                </Text>
                              ) : (
                                <Text size="xs" c="dimmed">
                                  —
                                </Text>
                              )}
                            </Table.Td>
                          );
                        })}
                        <Table.Td>
                          <Tooltip label={dayjs(p.createdAt).format('MMMM D, YYYY h:mm A')} withArrow>
                            <Text size="xs" style={{ cursor: 'help' }}>
                              {dayjs(p.createdAt).fromNow()}
                            </Text>
                          </Tooltip>
                        </Table.Td>
                        <Table.Td>
                          <Group gap={6} wrap="nowrap">
                            <Tooltip label="View Operations" position="top" withArrow>
                              <Button
                                size="xs"
                                variant="light"
                                px={6}
                                onClick={() => setOperationsModalPublishPlanId(p.id)}
                              >
                                <ListIcon size={14} />
                              </Button>
                            </Tooltip>

                            {/* Cancel button — shown to all users when a job is active */}
                            {hasActiveJob && (
                              <Tooltip label="Cancel" position="top" withArrow>
                                <Button
                                  size="xs"
                                  variant="light"
                                  color="red"
                                  px={6}
                                  loading={cancelingId === p.id}
                                  onClick={() => handleCancel(p)}
                                  disabled={cancelingId !== null && cancelingId !== p.id}
                                >
                                  <XIcon size={14} />
                                </Button>
                              </Tooltip>
                            )}

                            {/* Resume button — visible to all users for canceled publish plans with no active job.
                                If operations exist it was a canceled run (resumable); if no operations it was a
                                canceled plan (re-plan using the existing connector scope). */}
                            {p.status === 'canceled' && !hasActiveJob && (
                              <Tooltip label="Resume" position="top" withArrow>
                                <Button
                                  size="xs"
                                  variant="light"
                                  color="grape"
                                  px={6}
                                  loading={runningId === p.id || isPlanning}
                                  onClick={() => {
                                    if ((p._count?.operations ?? 0) > 0) {
                                      // Canceled run — resume from where it left off
                                      void handleRun(p.id);
                                    } else {
                                      // Canceled plan — re-plan (operations were wiped, start fresh)
                                      void handlePlanOne(p.connectorAccountId ?? '', true);
                                    }
                                  }}
                                  disabled={isPlanning || (runningId !== null && runningId !== p.id)}
                                >
                                  <PlayIcon size={14} />
                                </Button>
                              </Tooltip>
                            )}

                            {/* Run button group — for non-canceled non-completed publish plans */}
                            {!hasActiveJob &&
                              p.status !== 'completed' &&
                              p.status !== 'completed-with-errors' &&
                              p.status !== 'canceled' &&
                              !p.status.endsWith('-running') && (
                                <Group gap={0} wrap="nowrap">
                                  <Tooltip label="Run All" position="top" withArrow>
                                    <Button
                                      size="xs"
                                      variant="light"
                                      color="green"
                                      px={6}
                                      loading={runningId === p.id}
                                      onClick={() => handleRun(p.id)}
                                      disabled={isPlanning || (runningId !== null && runningId !== p.id)}
                                      style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
                                    >
                                      <PlayIcon size={14} />
                                    </Button>
                                  </Tooltip>
                                  <Menu position="bottom-end" withinPortal>
                                    <Menu.Target>
                                      <Button
                                        size="xs"
                                        variant="light"
                                        color="green"
                                        px={4}
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
                                      <Menu.Label>Run options</Menu.Label>
                                      <Menu.Item
                                        onClick={() => handleRun(p.id, true)}
                                        leftSection={<PlayIcon size={12} />}
                                      >
                                        Execute 1 Phase
                                      </Menu.Item>
                                    </Menu.Dropdown>
                                  </Menu>
                                </Group>
                              )}

                            <Tooltip label="Delete Publish Plan" position="top" withArrow>
                              <Button
                                size="xs"
                                variant="subtle"
                                color="red"
                                px={6}
                                onClick={async () => {
                                  if (confirm('Are you sure you want to delete this publish plan?')) {
                                    await workbookApi.deletePublishPlan(workbookId, p.id);
                                    fetchPublishPlans();
                                  }
                                }}
                              >
                                <Trash2Icon size={14} />
                              </Button>
                            </Tooltip>
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
      </ModalWrapper>

      {operationsModalPublishPlanId && (
        <PlanEntriesModal
          opened={!!operationsModalPublishPlanId}
          onClose={() => setOperationsModalPublishPlanId(null)}
          workbookId={workbookId}
          publishPlanId={operationsModalPublishPlanId}
        />
      )}
    </>
  );
}
