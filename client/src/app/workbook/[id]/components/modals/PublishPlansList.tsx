import { useConnectorAccounts } from '@/hooks/use-connector-account';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { progressApi } from '@/lib/api/progress';
import { workbookApi } from '@/lib/api/workbook';
import { publishPlanStatusBadgeColor } from '@/utils/job-helpers';
import {
  Badge,
  Button,
  Checkbox,
  Code,
  Group,
  Menu,
  Popover,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { useInterval } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { ConnectorAccount, PublishPlanEntity, PublishPlanStatus, WorkbookId } from '@spinner/shared-types';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import {
  ChevronDownIcon,
  CloudUploadIcon,
  ExternalLinkIcon,
  FilePenLineIcon,
  InfoIcon,
  MoveIcon,
  PlayIcon,
  PlusCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  RepeatIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

dayjs.extend(relativeTime);

interface PublishPlansListProps {
  workbookId: WorkbookId;
  /** When false, polling stops. Defaults to true. */
  enabled?: boolean;
  /** Height of the scroll area in pixels. */
  height?: number;
  /** When false, hides the Plan and Run Publish button group. Defaults to true. */
  showPlanAndRunButton?: boolean;
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

export function PublishPlansList({
  workbookId,
  enabled = true,
  height = 400,
  showPlanAndRunButton = true,
}: PublishPlansListProps) {
  const [publishPlans, setPublishPlans] = useState<PublishPlanEntity[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isPlanning, setIsPlanning] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [showAdminUI, setShowAdminUI] = useState(false);
  const [connectionFilter, setConnectionFilter] = useState<string | null>(null);
  // Hide non-essential columns on the history-view mode (when the plan/run controls are hidden).
  const showAdminColumns = showPlanAndRunButton;

  const { isAdmin } = useScratchPadUser();
  const adminMode = isAdmin && showAdminUI;
  const { connectorAccounts } = useConnectorAccounts(enabled ? workbookId : undefined);

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
    if (enabled) {
      fetchPublishPlans();
      start();
    } else {
      stop();
    }
    return stop;
  }, [enabled, fetchPublishPlans, start, stop]);

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
  const filteredPublishPlans = connectionFilter
    ? publishPlans.filter((p) => p.connectorAccountId === connectionFilter)
    : publishPlans;

  return (
    <>
      <Stack p="md">
        <Group justify="space-between">
          <Group gap="xs">
            {accounts.length > 0 && (
              <Select
                size="xs"
                placeholder="All connections"
                clearable
                value={connectionFilter}
                onChange={setConnectionFilter}
                data={accounts.map((ca) => ({ value: ca.id, label: ca.displayName }))}
                w={200}
              />
            )}
          </Group>
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

            {showPlanAndRunButton && (
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
            )}
          </Group>
        </Group>

        <ScrollArea h={height}>
          <Table stickyHeader>
            <Table.Thead>
              <Table.Tr>
                <Table.Th style={{ width: 280 }}>Date</Table.Th>
                <Table.Th style={{ width: 110 }}>Status</Table.Th>
                <Table.Th>Connection</Table.Th>
                <Table.Th style={{ width: 180 }}>Author</Table.Th>
                {showAdminColumns && <Table.Th>ID</Table.Th>}
                {showAdminColumns && <Table.Th>Phase</Table.Th>}
                <Table.Th style={{ width: 48, textAlign: 'center' }}>
                  <Tooltip label="Uploads" withArrow>
                    <CloudUploadIcon size={12} />
                  </Tooltip>
                </Table.Th>
                <Table.Th style={{ width: 48, textAlign: 'center' }}>
                  <Tooltip label="Edits" withArrow>
                    <FilePenLineIcon size={12} />
                  </Tooltip>
                </Table.Th>
                <Table.Th style={{ width: 48, textAlign: 'center' }}>
                  <Tooltip label="Creates" withArrow>
                    <PlusCircleIcon size={12} />
                  </Tooltip>
                </Table.Th>
                <Table.Th style={{ width: 48, textAlign: 'center' }}>
                  <Tooltip label="Deletes" withArrow>
                    <Trash2Icon size={12} />
                  </Tooltip>
                </Table.Th>
                <Table.Th style={{ width: 48, textAlign: 'center' }}>
                  <Tooltip label="Backfills" withArrow>
                    <RepeatIcon size={12} />
                  </Tooltip>
                </Table.Th>
                <Table.Th style={{ width: 48, textAlign: 'center' }}>
                  <Tooltip label="Renames" withArrow>
                    <MoveIcon size={12} />
                  </Tooltip>
                </Table.Th>
                <Table.Th style={{ width: 160 }}>Actions</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {filteredPublishPlans.length === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={showAdminColumns ? 12 : 10}>
                    <Text size="sm" c="dimmed" ta="center" py="md">
                      {connectionFilter
                        ? 'No publish plans for this connection.'
                        : showPlanAndRunButton
                          ? 'No publish plans found. Click Plan and Run Publish to start one.'
                          : 'No publish plans yet.'}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ) : (
                filteredPublishPlans.map((p) => {
                  const hasActiveJob = !!p.activeJobId && !!p.job && JOB_ACTIVE_STATUSES.has(p.job.status);
                  const detailHref = `/workbook/${workbookId}/publish-plan/${p.id}`;
                  return (
                    <Table.Tr key={p.id}>
                      <Table.Td>
                        <Link
                          href={detailHref}
                          style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
                        >
                          <Group gap={6} wrap="nowrap">
                            <Text size="xs" fw={500}>
                              {dayjs(p.createdAt).format('MMM D, YYYY h:mm A')}
                            </Text>
                            <Text size="xs" c="dimmed">
                              · {dayjs(p.createdAt).fromNow()}
                            </Text>
                          </Group>
                        </Link>
                      </Table.Td>
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
                      {showAdminColumns && (
                        <Table.Td>
                          <Text size="xs" ff="monospace">
                            {p.id.substring(0, 8)}...
                          </Text>
                        </Table.Td>
                      )}
                      <Table.Td>
                        <Group gap="xs" wrap="nowrap">
                          <Text size="xs" c={p.connectorAccountId ? undefined : 'dimmed'}>
                            {p.connectorAccountId
                              ? (connectorMap.get(p.connectorAccountId)?.displayName ??
                                p.connectorAccountId.substring(0, 8) + '…')
                              : 'All'}
                          </Text>
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        {p.author ? (
                          <Text size="xs">{p.author.name ?? p.author.email ?? 'Unknown'}</Text>
                        ) : (
                          <Text size="xs" c="dimmed">
                            System
                          </Text>
                        )}
                      </Table.Td>
                      {showAdminColumns && (
                        <Table.Td>
                          <Badge color={publishPlanStatusBadgeColor(p.status)} size="sm">
                            {p.status}
                          </Badge>
                        </Table.Td>
                      )}
                      {(['assetUploads', 'edits', 'creates', 'deletes', 'backfills', 'renameFiles'] as const).map(
                        (phaseKey) => {
                          const executedKey = `${phaseKey}Executed` as
                            | 'assetUploadsExecuted'
                            | 'editsExecuted'
                            | 'createsExecuted'
                            | 'deletesExecuted'
                            | 'backfillsExecuted'
                            | 'renameFilesExecuted';
                          const plannedKey = `${phaseKey}Planned` as
                            | 'assetUploadsPlanned'
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
                        },
                      )}
                      <Table.Td>
                        <Group gap={6} wrap="nowrap" justify="flex-end">
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

                          {p.status === PublishPlanStatus.Canceled && !hasActiveJob && (
                            <Tooltip label="Resume" position="top" withArrow>
                              <Button
                                size="xs"
                                variant="light"
                                color="grape"
                                px={6}
                                loading={runningId === p.id || isPlanning}
                                onClick={() => {
                                  if ((p._count?.operations ?? 0) > 0) {
                                    void handleRun(p.id);
                                  } else {
                                    void handlePlanOne(p.connectorAccountId ?? '', true);
                                  }
                                }}
                                disabled={isPlanning || (runningId !== null && runningId !== p.id)}
                              >
                                <PlayIcon size={14} />
                              </Button>
                            </Tooltip>
                          )}

                          {!hasActiveJob &&
                            p.status !== PublishPlanStatus.Completed &&
                            p.status !== PublishPlanStatus.CompletedWithErrors &&
                            p.status !== PublishPlanStatus.Canceled &&
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

                          <Tooltip label="Open" position="top" withArrow>
                            <Button
                              component={Link}
                              href={detailHref}
                              size="xs"
                              variant="light"
                              color="gray"
                              px={6}
                            >
                              <ExternalLinkIcon size={14} />
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
    </>
  );
}
