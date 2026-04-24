'use client';

import { IconButtonToolbar } from '@/app/components/base/buttons';
import { Text12Medium, Text12Regular, Text13Regular, TextMono12Regular, TextTitle3 } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { useDataFolders } from '@/hooks/use-data-folders';
import { useDevTools } from '@/hooks/use-dev-tools';
import { useJobs } from '@/hooks/use-jobs';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { jobApi } from '@/lib/api/job';
import { workbookApi } from '@/lib/api/workbook';
import { useSyncStore } from '@/stores/sync-store';
import { useWorkbookUIStore } from '@/stores/workbook-ui-store';
import { JobEntity } from '@/types/server-entities/job';
import { timeAgo } from '@/utils/helpers';
import { getJobDescription, getJobType, getTypeLabel, JobType, publishPlanStatusBadgeColor } from '@/utils/job-helpers';
import { RouteUrls } from '@/utils/route-urls';
import {
  ActionIcon,
  Badge,
  Box,
  Center,
  Code,
  Collapse,
  CopyButton,
  Group,
  JsonInput,
  Loader,
  Popover,
  ScrollArea,
  Stack,
  Table,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import type { WorkbookId } from '@spinner/shared-types';
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  CopyIcon,
  InfoIcon,
  ListIcon,
  RefreshCwIcon,
  SquareIcon,
  XIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import { PlanEntriesModal } from '../modals/PlanEntriesModal';

const ACTIVE_STATES = new Set(['active', 'waiting', 'pending', 'delayed']);

const getTypeColor = (jobType: JobType): string => {
  switch (jobType) {
    case 'sync':
      return 'var(--mantine-color-yellow-5)';
    case 'publish':
      return 'var(--mantine-color-green-5)';
    case 'pull':
      return 'var(--mantine-color-cyan-5)';
    case 'rehost':
      return 'var(--mantine-color-teal-5)';
    default:
      return 'var(--mantine-color-gray-5)';
  }
};

type EffectiveState = JobEntity['state'] | 'completed-with-warnings';

const getStatusColor = (status: EffectiveState): string => {
  switch (status) {
    case 'completed':
      return 'var(--mantine-color-green-6)';
    case 'completed-with-warnings':
      return 'var(--mantine-color-orange-5)';
    case 'failed':
      return 'var(--mantine-color-red-6)';
    case 'active':
      return 'var(--mantine-color-yellow-5)';
    case 'canceled':
      return 'var(--mantine-color-orange-5)';
    default:
      return 'var(--mantine-color-gray-5)';
  }
};

const getStatusLabel = (status: EffectiveState): string => {
  switch (status) {
    case 'completed':
      return 'Success';
    case 'completed-with-warnings':
      return 'Warnings';
    case 'failed':
      return 'Failed';
    case 'active':
      return 'Running';
    case 'canceled':
      return 'Canceled';
    case 'pending':
    case 'waiting':
    case 'delayed':
      return 'Pending';
    default:
      return status;
  }
};

const formatDuration = (processedOn?: Date | null, finishedOn?: Date | null): string => {
  if (!processedOn) return '-';
  if (!finishedOn) return '-';

  const diff = new Date(finishedOn).getTime() - new Date(processedOn).getTime();
  const seconds = diff / 1000;

  if (seconds < 1) return `${Math.round(diff)}ms`;
  if (seconds < 60) return `${Math.round(seconds)}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
};

const formatTimestamp = (date?: Date | null): string => {
  if (!date) return '-';
  return new Date(date).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

/** Derive the effective state for a job, checking sync table-level failures and warnings in progress. */
const getEffectiveState = (job: JobEntity): EffectiveState => {
  if (job.state !== 'completed') return job.state;
  const progress = job.publicProgress as Record<string, unknown> | undefined;
  if (!progress?.tables || !Array.isArray(progress.tables)) return job.state;
  const tables = progress.tables as Array<{
    status?: string;
    warnings?: Array<{ sourceRemoteId: string; warning: string }>;
  }>;
  const hasTableFailure = tables.some((t) => t.status === 'failed');
  if (hasTableFailure) return 'failed';
  const hasWarnings = tables.some((t) => t.warnings && t.warnings.length > 0);
  if (hasWarnings) return 'completed-with-warnings';
  return job.state;
};

const getJobKey = (job: JobEntity): string => `${job.bullJobId}`;

// NOTE! We don't really paginate, we just increase the page size when the user wants to see more. Feel free to improve this.
const INITIAL_PAGE_SIZE = 50;
const LOAD_MORE_PAGE_SIZE = 100;

type RunsViewParams = {
  limit: number;
  type?: string;
  syncId?: string;
  dataFolderId?: string;
};

function parseRunsViewParams(searchParams: URLSearchParams): RunsViewParams {
  const rawLimit = Number(searchParams.get('limit'));
  return {
    limit: rawLimit >= INITIAL_PAGE_SIZE ? rawLimit : INITIAL_PAGE_SIZE,
    type: searchParams.get('type') || undefined,
    syncId: searchParams.get('syncId') || undefined,
    dataFolderId: searchParams.get('dataFolderId') || undefined,
  };
}

export function RunsView() {
  const params = useParams<{ id: string }>();
  const workbookId = params.id as WorkbookId;
  const searchParams = useSearchParams();
  const router = useRouter();
  const runsParams = parseRunsViewParams(searchParams);
  const filter =
    runsParams.type || runsParams.syncId || runsParams.dataFolderId
      ? { type: runsParams.type, syncId: runsParams.syncId, dataFolderId: runsParams.dataFolderId }
      : undefined;

  const { jobs, error, isLoading, mutate, cancelJob } = useJobs(runsParams.limit, 0, workbookId, filter);
  const hasMore = useMemo(() => jobs.length >= runsParams.limit, [jobs.length, runsParams.limit]);
  const syncs = useSyncStore((state) => state.syncs);
  const { folders } = useDataFolders();
  const hasFilters = !!(runsParams.type || runsParams.syncId || runsParams.dataFolderId);

  const removeFilter = useCallback(
    (key: string) => {
      const next = new URLSearchParams(searchParams.toString());
      next.delete(key);
      router.replace(`?${next.toString()}`, { scroll: false });
    },
    [searchParams, router],
  );

  const loadMore = useCallback(() => {
    const nextLimit = runsParams.limit + LOAD_MORE_PAGE_SIZE;
    const next = new URLSearchParams(searchParams.toString());
    next.set('limit', String(nextLimit));
    router.replace(`?${next.toString()}`, { scroll: false });
  }, [runsParams.limit, searchParams, router]);
  const { isDevToolsEnabled } = useDevTools();
  const setWorkbookError = useWorkbookUIStore((state) => state.setWorkbookError);
  const [cancelingJobIds, setCancelingJobIds] = useState<Set<string>>(new Set());
  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(() => {
    const jobId = searchParams.get('jobId');
    return jobId ? new Set([jobId]) : new Set();
  });

  const toggleExpanded = useCallback((key: string) => {
    setExpandedJobs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handleCancelJob = useCallback(
    async (jobId: string) => {
      setCancelingJobIds((prev) => new Set(prev).add(jobId));
      try {
        await cancelJob(jobId);
      } catch {
        setWorkbookError({
          scope: 'runs',
          description: 'Failed to cancel job. Please try again.',
        });
      }
    },
    [cancelJob, setWorkbookError],
  );

  if (isLoading && jobs.length === 0) {
    return (
      <Center h="100%">
        <Group gap="sm">
          <Loader size="sm" />
          <Text c="dimmed">Loading runs...</Text>
        </Group>
      </Center>
    );
  }

  if (error) {
    return (
      <Center h="100%">
        <Stack align="center" gap="xs">
          <AlertCircleIcon size={24} color="var(--mantine-color-red-6)" />
          <Text c="red">Failed to load runs</Text>
        </Stack>
      </Center>
    );
  }

  if (jobs.length === 0) {
    return (
      <Center h="100%">
        <Stack align="center" gap="xs">
          <ClockIcon size={24} color="var(--mantine-color-gray-5)" />
          <Text c="dimmed">{hasFilters ? 'No matching runs' : 'No runs yet'}</Text>
          <Text12Regular c="dimmed">
            {hasFilters
              ? 'Try removing a filter to see more results'
              : 'Jobs will appear here when you run syncs or publish changes'}
          </Text12Regular>
        </Stack>
      </Center>
    );
  }

  const activeJobs = jobs.filter((job) => ACTIVE_STATES.has(job.state));
  const completedJobs = jobs.filter((job) => !ACTIVE_STATES.has(job.state));

  return (
    <Stack h="100%" gap={0}>
      {/* Header */}
      <Group
        h={48}
        px="md"
        justify="flex-end"
        style={{
          borderBottom: '1px solid var(--fg-divider)',
          flexShrink: 0,
        }}
      >
        <Group gap="xs">
          <Text12Regular c="dimmed">{jobs.length} jobs</Text12Regular>
          <IconButtonToolbar onClick={() => mutate()} title="Refresh">
            <StyledLucideIcon Icon={RefreshCwIcon} size="sm" c="var(--fg-secondary)" />
          </IconButtonToolbar>
        </Group>
      </Group>

      {/* Filter chips */}
      {hasFilters && (
        <Group px="md" py={8} gap="xs" style={{ borderBottom: '1px solid var(--fg-divider)', flexShrink: 0 }}>
          {runsParams.type && (
            <Badge
              variant="light"
              size="sm"
              rightSection={
                <ActionIcon variant="transparent" size={14} onClick={() => removeFilter('type')}>
                  <XIcon size={10} />
                </ActionIcon>
              }
            >
              Type: {getTypeLabel(runsParams.type as JobType)}
            </Badge>
          )}
          {runsParams.syncId && (
            <Badge
              variant="light"
              size="sm"
              rightSection={
                <ActionIcon variant="transparent" size={14} onClick={() => removeFilter('syncId')}>
                  <XIcon size={10} />
                </ActionIcon>
              }
            >
              Sync: {syncs.find((s) => s.id === runsParams.syncId)?.displayName || runsParams.syncId.slice(0, 8)}
            </Badge>
          )}
          {runsParams.dataFolderId && (
            <Badge
              variant="light"
              size="sm"
              rightSection={
                <ActionIcon variant="transparent" size={14} onClick={() => removeFilter('dataFolderId')}>
                  <XIcon size={10} />
                </ActionIcon>
              }
            >
              Folder:{' '}
              {folders.find((f) => f.id === runsParams.dataFolderId)?.name || runsParams.dataFolderId.slice(0, 8)}
            </Badge>
          )}
        </Group>
      )}

      {/* Table */}
      <ScrollArea style={{ flex: 1 }}>
        {activeJobs.length > 0 && (
          <Box>
            <Box px="md" py={6}>
              <Text12Medium c="var(--fg-muted)">Active</Text12Medium>
            </Box>
            <Table>
              <Table.Tbody>
                {activeJobs.map((job) => (
                  <JobRow
                    key={getJobKey(job)}
                    job={job}
                    isActive
                    isExpanded={expandedJobs.has(getJobKey(job))}
                    onToggle={() => toggleExpanded(getJobKey(job))}
                    isDevToolsEnabled={isDevToolsEnabled}
                    isCanceling={job.bullJobId ? cancelingJobIds.has(job.bullJobId) : false}
                    onCancel={job.bullJobId ? () => handleCancelJob(job.bullJobId!) : undefined}
                  />
                ))}
              </Table.Tbody>
            </Table>
          </Box>
        )}

        <Box>
          {activeJobs.length > 0 && completedJobs.length > 0 && (
            <Box px="md" py={6}>
              <Text12Medium c="var(--fg-muted)">Recent</Text12Medium>
            </Box>
          )}
          {completedJobs.length > 0 && (
            <Table>
              <Table.Tbody>
                {completedJobs.map((job) => (
                  <JobRow
                    key={getJobKey(job)}
                    job={job}
                    isActive={false}
                    isExpanded={expandedJobs.has(getJobKey(job))}
                    onToggle={() => toggleExpanded(getJobKey(job))}
                    isDevToolsEnabled={isDevToolsEnabled}
                    isCanceling={false}
                  />
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Box>

        {hasMore && (
          <Center py="md">
            <UnstyledButton onClick={loadMore}>
              <Text12Medium c="var(--fg-secondary)" style={{ textDecoration: 'underline' }}>
                Load more
              </Text12Medium>
            </UnstyledButton>
          </Center>
        )}
      </ScrollArea>
    </Stack>
  );
}

function JobRow({
  job,
  isActive,
  isExpanded,
  onToggle,
  isDevToolsEnabled,
  isCanceling,
  onCancel,
}: {
  job: JobEntity;
  isActive: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  isDevToolsEnabled: boolean;
  isCanceling: boolean;
  onCancel?: () => void;
}) {
  const jobType = getJobType(job.type);
  const typeColor = getTypeColor(jobType);
  const effectiveState = getEffectiveState(job);
  const statusColor = getStatusColor(effectiveState);
  const description = getJobDescription(job);
  const duration = formatDuration(job.processedOn, job.finishedOn);
  const time = job.processedOn ? timeAgo(job.processedOn) : '-';

  return (
    <>
      <Table.Tr
        onClick={onToggle}
        style={{
          cursor: 'pointer',
          borderLeft: isActive ? '3px solid var(--mantine-color-yellow-5)' : '3px solid transparent',
        }}
      >
        {/* Chevron */}
        <Table.Td style={{ width: 32, paddingRight: 0 }}>
          <StyledLucideIcon Icon={isExpanded ? ChevronDownIcon : ChevronRightIcon} size="sm" c="var(--fg-secondary)" />
        </Table.Td>

        {/* Type */}
        <Table.Td style={{ width: 100 }}>
          <Text size="sm" fw={600} style={{ color: typeColor }}>
            {getTypeLabel(jobType)}
          </Text>
        </Table.Td>

        {/* Description */}
        <Table.Td>
          <Text
            size="sm"
            style={{
              maxWidth: 400,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {(() => {
              const match = description.match(/^(.+?)(\(\d+ failed\))$/);
              if (match) {
                return (
                  <>
                    {match[1]}
                    <Text span c="var(--mantine-color-red-6)" inherit>
                      {match[2]}
                    </Text>
                  </>
                );
              }
              return description;
            })()}
          </Text>
        </Table.Td>

        {/* Time */}
        <Table.Td style={{ width: 120 }}>
          <Tooltip label={`Started: ${formatTimestamp(job.processedOn)}`} disabled={!job.processedOn}>
            <Text size="sm" c="dimmed">
              {time}
            </Text>
          </Tooltip>
        </Table.Td>

        {/* Duration */}
        <Table.Td style={{ width: 80 }}>
          <Tooltip label={`Finished: ${formatTimestamp(job.finishedOn)}`} disabled={!job.finishedOn}>
            <Text size="sm" c="dimmed">
              {duration}
            </Text>
          </Tooltip>
        </Table.Td>

        {/* Status */}
        <Table.Td style={{ width: 120 }}>
          <Group gap={6} wrap="nowrap">
            {isActive ? (
              <Loader size={10} />
            ) : (
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  backgroundColor: statusColor,
                  flexShrink: 0,
                }}
              />
            )}
            <Text size="sm" style={{ color: statusColor }}>
              {getStatusLabel(effectiveState)}
            </Text>
            {isActive && onCancel && (
              <Tooltip label="Cancel run">
                <ActionIcon
                  variant="subtle"
                  size="xs"
                  color="red"
                  disabled={isCanceling}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCancel();
                  }}
                >
                  <SquareIcon size={12} />
                </ActionIcon>
              </Tooltip>
            )}
          </Group>
        </Table.Td>
      </Table.Tr>

      {/* Expanded details row */}
      <Table.Tr style={{ border: isExpanded ? undefined : 'none' }}>
        <Table.Td colSpan={6} p={0} style={{ border: isExpanded ? undefined : 'none' }}>
          <Collapse in={isExpanded}>
            {jobType === 'publish' ? (
              <ExpandedPublishJobDetails job={job} isDevToolsEnabled={isDevToolsEnabled} />
            ) : (
              <ExpandedJobDetails job={job} isDevToolsEnabled={isDevToolsEnabled} />
            )}
          </Collapse>
        </Table.Td>
      </Table.Tr>
    </>
  );
}

function ExpandedJobDetails({ job, isDevToolsEnabled }: { job: JobEntity; isDevToolsEnabled: boolean }) {
  const jobType = getJobType(job.type);
  const [rawData, setRawData] = useState<object | null>(null);
  const [rawLoading, setRawLoading] = useState(false);
  const [rawExpanded, setRawExpanded] = useState(false);

  const loadRawData = useCallback(() => {
    if (!job.bullJobId || rawData) return;
    setRawLoading(true);
    jobApi
      .getJobRaw(job.bullJobId)
      .then((data) => {
        const record = data as Record<string, unknown>;
        if (typeof record.data === 'string') {
          try {
            record.data = JSON.parse(record.data);
          } catch {
            // leave as-is
          }
        }
        setRawData(record);
      })
      .catch((err) => {
        console.debug(err);
        setRawData({ error: 'Failed to fetch' });
      })
      .finally(() => setRawLoading(false));
  }, [job.bullJobId, rawData]);

  const toggleRaw = useCallback(() => {
    if (!rawExpanded) {
      loadRawData();
    }
    setRawExpanded((prev) => !prev);
  }, [rawExpanded, loadRawData]);

  const progress =
    job.publicProgress && typeof job.publicProgress === 'object'
      ? (job.publicProgress as Record<string, unknown>)
      : null;

  const devToolColor = 'var(--mantine-color-devTool-6)';

  return (
    <Box px="md" py="sm" style={{ background: 'var(--bg-panel)' }}>
      <Stack gap="sm">
        {/* Failed reason */}
        {job.failedReason && (
          <Box>
            <Text12Medium c="var(--fg-secondary)" mb={4}>
              Failed Reason
            </Text12Medium>
            <Text13Regular c="var(--mantine-color-red-6)">{job.failedReason}</Text13Regular>
          </Box>
        )}

        {/* Progress details */}
        {progress && <ProgressDetails jobType={jobType} progress={progress} />}

        {/* Dev tools: Job ID */}
        {isDevToolsEnabled && job.bullJobId && (
          <Group gap={4}>
            <TextMono12Regular c={devToolColor}>{job.bullJobId}</TextMono12Regular>
            <CopyButton value={job.bullJobId} timeout={2000}>
              {({ copied, copy }) => (
                <ActionIcon variant="subtle" size="xs" onClick={copy} c={devToolColor}>
                  {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
                </ActionIcon>
              )}
            </CopyButton>
          </Group>
        )}

        {/* Dev tools: Raw data toggle */}
        {isDevToolsEnabled && job.bullJobId && (
          <Box>
            <UnstyledButton onClick={toggleRaw}>
              <Group gap={4}>
                <StyledLucideIcon Icon={rawExpanded ? ChevronDownIcon : ChevronRightIcon} size="sm" c={devToolColor} />
                <Text12Medium c={devToolColor}>Raw Job Data</Text12Medium>
              </Group>
            </UnstyledButton>
            <Collapse in={rawExpanded}>
              <Box mt="xs">
                {rawLoading ? (
                  <Center p="sm">
                    <Loader size="sm" />
                  </Center>
                ) : rawData ? (
                  <JsonInput
                    value={JSON.stringify(rawData, null, 2)}
                    formatOnBlur
                    autosize
                    minRows={4}
                    maxRows={20}
                    readOnly
                    styles={{ input: { fontFamily: 'monospace', fontSize: 12 } }}
                  />
                ) : null}
              </Box>
            </Collapse>
          </Box>
        )}
      </Stack>
    </Box>
  );
}

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

function ExpandedPublishJobDetails({ job, isDevToolsEnabled }: { job: JobEntity; isDevToolsEnabled: boolean }) {
  const { isAdmin } = useScratchPadUser();
  const params = useParams<{ id: string }>();
  const workbookId = params.id as WorkbookId;
  const isJobActive = ACTIVE_STATES.has(job.state);
  const { data: publishPlan, isLoading: loading } = useSWR(
    job.bullJobId ? ['publish-plan', workbookId, job.bullJobId] : null,
    () => workbookApi.getPublishPlanByJobId(workbookId, job.bullJobId!),
    { refreshInterval: isJobActive ? 2000 : 0 },
  );
  const [operationsModalPublishPlanId, setOperationsModalPublishPlanId] = useState<string | null>(null);
  const [operationsModalHasErrorFilter, setOperationsModalHasErrorFilter] = useState(false);

  if (loading) {
    return (
      <Box px="md" py="sm" style={{ background: 'var(--bg-panel)' }}>
        <Center>
          <Loader size="sm" />
        </Center>
      </Box>
    );
  }

  if (!publishPlan) {
    // Fallback to old progress view if plan not found
    return <ExpandedJobDetails job={job} isDevToolsEnabled={isDevToolsEnabled} />;
  }

  const p = publishPlan;
  const liveProgress = isJobActive
    ? (job.publicProgress as {
        processedCount?: number;
        totalCount?: number;
        currentPhase?: string;
        currentTableName?: string;
      } | null)
    : null;

  return (
    <Box px="md" py="sm" style={{ background: 'var(--bg-panel)' }}>
      {liveProgress && liveProgress.totalCount !== undefined && liveProgress.totalCount > 0 && (
        <Group gap="md" mb="sm">
          <Text12Regular c="var(--fg-secondary)">
            {liveProgress.processedCount ?? 0} / {liveProgress.totalCount} records
          </Text12Regular>
          {liveProgress.currentPhase && (
            <Text12Regular c="var(--fg-secondary)">Phase: {liveProgress.currentPhase}</Text12Regular>
          )}
          {liveProgress.currentTableName && (
            <Text12Regular c="var(--fg-secondary)">Table: {liveProgress.currentTableName}</Text12Regular>
          )}
        </Group>
      )}
      <Table withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>State</Table.Th>
            <Table.Th>ID</Table.Th>
            <Table.Th>Connection</Table.Th>
            <Table.Th>Phase</Table.Th>
            <Table.Th>Assets</Table.Th>
            <Table.Th>Edits</Table.Th>
            <Table.Th>Creates</Table.Th>
            <Table.Th>Deletes</Table.Th>
            <Table.Th>Backfills</Table.Th>
            <Table.Th>Renames</Table.Th>
            <Table.Th>Errors</Table.Th>
            <Table.Th>Created At</Table.Th>
            <Table.Th>Actions</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          <Table.Tr>
            <Table.Td>
              {p.job ? (
                <Group gap={4} wrap="nowrap">
                  <Badge color={jobStatusBadgeColor(p.job.status)} size="sm" variant="outline">
                    {p.job.status}
                  </Badge>
                  {isAdmin && (
                    <Popover position="bottom-start" withinPortal shadow="md" width={400}>
                      <Popover.Target>
                        <Tooltip label="Job Data" position="top">
                          <ActionIcon size="xs" variant="subtle" color="gray">
                            <InfoIcon size={12} />
                          </ActionIcon>
                        </Tooltip>
                      </Popover.Target>
                      <Popover.Dropdown>
                        <ScrollArea h={300}>
                          <Code block style={{ fontSize: 10 }}>
                            {JSON.stringify(job, null, 2)}
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
              <Text size="xs" c={p.connectorAccountId ? undefined : 'dimmed'}>
                {p.connectorAccountId ? p.connectorAccountId.substring(0, 8) + '…' : 'All'}
              </Text>
            </Table.Td>
            <Table.Td>
              <Badge color={publishPlanStatusBadgeColor(p.status)} size="sm">
                {p.status}
              </Badge>
            </Table.Td>
            {(['assetUploads', 'edits', 'creates', 'deletes', 'backfills', 'renameFiles'] as const).map((phaseKey) => {
              const executedKey = `${phaseKey}Executed` as keyof Record<string, number>;
              const plannedKey = `${phaseKey}Planned` as keyof Record<string, number>;
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
              {(() => {
                const pub = p.job?.progress as { publicProgress?: Record<string, number> } | undefined;
                const errorCount = pub?.publicProgress?.errorCount ?? 0;
                return errorCount > 0 ? (
                  <Text
                    size="xs"
                    c="red"
                    fw={600}
                    style={{ cursor: 'pointer', textDecoration: 'underline' }}
                    onClick={() => {
                      setOperationsModalHasErrorFilter(true);
                      setOperationsModalPublishPlanId(p.id);
                    }}
                  >
                    {formatCount(errorCount)}
                  </Text>
                ) : (
                  <Text size="xs" c="dimmed">
                    —
                  </Text>
                );
              })()}
            </Table.Td>
            <Table.Td>
              <Text size="xs">{new Date(p.createdAt).toLocaleDateString()}</Text>
            </Table.Td>
            <Table.Td>
              <Tooltip label="View operations">
                <ActionIcon
                  variant="light"
                  size="sm"
                  onClick={() => {
                    setOperationsModalHasErrorFilter(false);
                    setOperationsModalPublishPlanId(p.id);
                  }}
                >
                  <ListIcon size={14} />
                </ActionIcon>
              </Tooltip>
            </Table.Td>
          </Table.Tr>
        </Table.Tbody>
      </Table>

      {operationsModalPublishPlanId && (
        <PlanEntriesModal
          opened={!!operationsModalPublishPlanId}
          onClose={() => setOperationsModalPublishPlanId(null)}
          workbookId={workbookId}
          publishPlanId={operationsModalPublishPlanId}
          initialHasErrorFilter={operationsModalHasErrorFilter}
        />
      )}
    </Box>
  );
}

function ProgressDetails({ jobType, progress }: { jobType: JobType; progress: Record<string, unknown> }) {
  switch (jobType) {
    case 'sync':
      return <SyncProgressTable progress={progress} />;
    case 'publish':
      return <PublishProgressTable progress={progress} />;
    case 'pull':
      return <PullProgressTable progress={progress} />;
    case 'rehost':
      return <RehostProgressTable progress={progress} />;
    default:
      return null;
  }
}

type PathSource = {
  createdPaths?: string[];
  updatedPaths?: string[];
  deletedPaths?: string[];
  refreshedPaths?: string[];
};

function collectAffectedFiles(sources: PathSource[]): Array<{ path: string; operation: string }> {
  const files: Array<{ path: string; operation: string }> = [];
  for (const source of sources) {
    if (source.createdPaths) {
      for (const p of source.createdPaths) files.push({ path: p, operation: 'Created' });
    }
    if (source.updatedPaths) {
      for (const p of source.updatedPaths) files.push({ path: p, operation: 'Updated' });
    }
    if (source.deletedPaths) {
      for (const p of source.deletedPaths) files.push({ path: p, operation: 'Deleted' });
    }
    if (source.refreshedPaths) {
      for (const p of source.refreshedPaths) files.push({ path: p, operation: 'Refreshed' });
    }
  }
  return files;
}

function AffectedFilesTable({ files }: { files: Array<{ path: string; operation: string }> }) {
  const params = useParams<{ id: string }>();
  const workbookId = params.id;

  if (files.length === 0) return null;

  return (
    <Box mt="xs">
      <Text12Medium c="var(--fg-secondary)" mb={4}>
        Affected Files ({files.length})
      </Text12Medium>
      <Table striped highlightOnHover withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>File Path</Table.Th>
            <Table.Th>Operation</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {files.map((file, i) => (
            <Table.Tr key={i}>
              <Table.Td style={{ fontFamily: 'monospace', fontSize: 12 }}>
                <Link
                  href={RouteUrls.workbookFilesFileUrl(workbookId, file.path)}
                  style={{ color: 'inherit', textDecoration: 'underline' }}
                >
                  {file.path}
                </Link>
              </Table.Td>
              <Table.Td>{file.operation}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Box>
  );
}

function SyncProgressTable({ progress }: { progress: Record<string, unknown> }) {
  if (!progress.tables || !Array.isArray(progress.tables)) return null;
  const tables = progress.tables as Array<{
    name?: string;
    connector?: string;
    creates?: number;
    updates?: number;
    deletes?: number;
    skipped?: number;
    errorCount?: number;
    warningCount?: number;
    createdPaths?: string[];
    updatedPaths?: string[];
    deletedPaths?: string[];
    errors?: Array<{ sourceRemoteId?: string; error?: string }>;
    warnings?: Array<{ sourceRemoteId?: string; warning?: string }>;
    status?: string;
  }>;
  if (tables.length === 0) return null;

  const affectedFiles = collectAffectedFiles(tables);
  const hasSkipped = tables.some((t) => (t.skipped ?? 0) > 0);
  const hasErrors = tables.some((t) => (t.errorCount ?? t.errors?.length ?? 0) > 0);
  const hasWarnings = tables.some((t) => (t.warningCount ?? t.warnings?.length ?? 0) > 0);
  const allErrors = tables.flatMap((t) =>
    (t.errors ?? []).map((e) => ({ tableName: t.name, sourceRemoteId: e.sourceRemoteId, error: e.error })),
  );
  const allWarnings = tables.flatMap((t) =>
    (t.warnings ?? []).map((w) => ({ tableName: t.name, sourceRemoteId: w.sourceRemoteId, warning: w.warning })),
  );

  return (
    <>
      <Table striped highlightOnHover withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Table</Table.Th>
            <Table.Th>Source</Table.Th>
            <Table.Th>Creates</Table.Th>
            <Table.Th>Updates</Table.Th>
            <Table.Th>Deletes</Table.Th>
            {hasSkipped && <Table.Th>Skipped</Table.Th>}
            {hasErrors && <Table.Th>Errors</Table.Th>}
            {hasWarnings && <Table.Th>Warnings</Table.Th>}
            <Table.Th>Status</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {tables.map((table, i) => (
            <Table.Tr key={i}>
              <Table.Td>{table.name || `Table ${i + 1}`}</Table.Td>
              <Table.Td>{table.connector ?? '-'}</Table.Td>
              <Table.Td>{table.creates ?? 0}</Table.Td>
              <Table.Td>{table.updates ?? 0}</Table.Td>
              <Table.Td>{table.deletes ?? 0}</Table.Td>
              {hasSkipped && (
                <Table.Td>
                  <Text13Regular c="dimmed">{table.skipped ?? 0}</Text13Regular>
                </Table.Td>
              )}
              {hasErrors && (
                <Table.Td>
                  <Text13Regular c={table.errorCount ? 'var(--mantine-color-red-6)' : undefined}>
                    {table.errorCount ?? table.errors?.length ?? 0}
                  </Text13Regular>
                </Table.Td>
              )}
              {hasWarnings && (
                <Table.Td>
                  <Text13Regular
                    c={
                      (table.warningCount ?? table.warnings?.length ?? 0) > 0
                        ? 'var(--mantine-color-orange-6)'
                        : undefined
                    }
                  >
                    {table.warningCount ?? table.warnings?.length ?? 0}
                  </Text13Regular>
                </Table.Td>
              )}
              <Table.Td>{table.status ?? '-'}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {allErrors.length > 0 && <SyncErrorsTable errors={allErrors} />}
      {allWarnings.length > 0 && <SyncWarningsTable warnings={allWarnings} />}
      <AffectedFilesTable files={affectedFiles} />
    </>
  );
}

function SyncErrorsTable({
  errors,
}: {
  errors: Array<{ tableName?: string; sourceRemoteId?: string; error?: string }>;
}) {
  return (
    <Box mt="xs">
      <Text12Medium c="var(--mantine-color-red-6)" mb={4}>
        Errors ({errors.length >= 100 ? '100+' : errors.length})
      </Text12Medium>
      <Table striped highlightOnHover withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Table</Table.Th>
            <Table.Th>Source Record</Table.Th>
            <Table.Th>Error</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {errors.map((err, i) => (
            <Table.Tr key={i}>
              <Table.Td>{err.tableName ?? '-'}</Table.Td>
              <Table.Td style={{ fontFamily: 'monospace', fontSize: 12 }}>{err.sourceRemoteId ?? '-'}</Table.Td>
              <Table.Td>
                <Text13Regular c="var(--mantine-color-red-6)">{err.error ?? 'Unknown error'}</Text13Regular>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Box>
  );
}

function SyncWarningsTable({
  warnings,
}: {
  warnings: Array<{ tableName?: string; sourceRemoteId?: string; warning?: string }>;
}) {
  return (
    <Box mt="xs">
      <Text12Medium c="var(--mantine-color-orange-6)" mb={4}>
        Warnings ({warnings.length >= 100 ? '100+' : warnings.length})
      </Text12Medium>
      <Table striped highlightOnHover withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Table</Table.Th>
            <Table.Th>Source Record</Table.Th>
            <Table.Th>Warning</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {warnings.map((warn, i) => (
            <Table.Tr key={i}>
              <Table.Td>{warn.tableName ?? '-'}</Table.Td>
              <Table.Td style={{ fontFamily: 'monospace', fontSize: 12 }}>{warn.sourceRemoteId ?? '-'}</Table.Td>
              <Table.Td>
                <Text13Regular c="var(--mantine-color-orange-6)">{warn.warning ?? 'Unknown warning'}</Text13Regular>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Box>
  );
}

function PublishProgressTable({ progress }: { progress: Record<string, unknown> }) {
  if (!progress.folders || !Array.isArray(progress.folders)) {
    const connectionName = progress.connectionName as string | undefined;
    const tableName = progress.tableName as string | undefined;
    const currentTableName = progress.currentTableName as string | undefined;
    const tableCount = progress.tableCount as number | undefined;
    const currentPhase = progress.currentPhase as string | undefined;
    const processedCount = progress.processedCount as number | undefined;
    const totalCount = progress.totalCount as number | undefined;
    const successCount = progress.successCount as number | undefined;
    const failedCount = progress.failedCount as number | undefined;
    const status = progress.status as string | undefined;

    if (totalCount === undefined) return null;

    return (
      <>
        <Table striped highlightOnHover withColumnBorders>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Connection</Table.Th>
              <Table.Th>Scope</Table.Th>
              <Table.Th>Current Phase</Table.Th>
              <Table.Th>Processed</Table.Th>
              <Table.Th>Succeeded</Table.Th>
              <Table.Th>Failed</Table.Th>
              <Table.Th>Status</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            <Table.Tr>
              <Table.Td>{connectionName || '-'}</Table.Td>
              <Table.Td>{tableName || currentTableName || (tableCount ? `${tableCount} tables` : '-')}</Table.Td>
              <Table.Td>{currentPhase || '-'}</Table.Td>
              <Table.Td>
                {processedCount ?? 0} / {totalCount}
              </Table.Td>
              <Table.Td>{successCount ?? 0}</Table.Td>
              <Table.Td>
                <Text13Regular c={failedCount ? 'var(--mantine-color-red-6)' : undefined}>
                  {failedCount ?? 0}
                </Text13Regular>
              </Table.Td>
              <Table.Td>{status ?? '-'}</Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>
      </>
    );
  }
  const folders = progress.folders as Array<{
    name?: string;
    connector?: string;
    creates?: number;
    updates?: number;
    deletes?: number;
    expectedCreates?: number;
    expectedUpdates?: number;
    expectedDeletes?: number;
    createdPaths?: string[];
    updatedPaths?: string[];
    deletedPaths?: string[];
    status?: string;
  }>;
  if (folders.length === 0) return null;

  const affectedFiles = collectAffectedFiles(folders);

  return (
    <>
      <Table striped highlightOnHover withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Folder</Table.Th>
            <Table.Th>Source</Table.Th>
            <Table.Th>Creates</Table.Th>
            <Table.Th>Updates</Table.Th>
            <Table.Th>Deletes</Table.Th>
            <Table.Th>Status</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {folders.map((folder, i) => (
            <Table.Tr key={i}>
              <Table.Td>{folder.name || `Folder ${i + 1}`}</Table.Td>
              <Table.Td>{folder.connector ?? '-'}</Table.Td>
              <Table.Td>
                {folder.creates ?? 0} / {folder.expectedCreates ?? 0}
              </Table.Td>
              <Table.Td>
                {folder.updates ?? 0} / {folder.expectedUpdates ?? 0}
              </Table.Td>
              <Table.Td>
                {folder.deletes ?? 0} / {folder.expectedDeletes ?? 0}
              </Table.Td>
              <Table.Td>{folder.status ?? '-'}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <AffectedFilesTable files={affectedFiles} />
    </>
  );
}

function RehostProgressTable({ progress }: { progress: Record<string, unknown> }) {
  const dataFolderName = progress.dataFolderName as string | undefined;
  const totalAssets = progress.totalAssets as number | undefined;
  const succeeded = progress.succeeded as number | undefined;
  const failed = progress.failed as number | undefined;
  const status = progress.status as string | undefined;
  const failures =
    (progress.failures as Array<{ assetId: string; filename: string | null; error: string }> | undefined) ?? [];

  if (totalAssets === undefined) return null;

  return (
    <>
      <Table striped highlightOnHover withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Folder</Table.Th>
            <Table.Th>Total Assets</Table.Th>
            <Table.Th>Succeeded</Table.Th>
            <Table.Th>Failed</Table.Th>
            <Table.Th>Status</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          <Table.Tr>
            <Table.Td>{dataFolderName ?? '-'}</Table.Td>
            <Table.Td>{totalAssets}</Table.Td>
            <Table.Td>
              <Text13Regular c={succeeded ? 'var(--mantine-color-green-6)' : undefined}>{succeeded ?? 0}</Text13Regular>
            </Table.Td>
            <Table.Td>
              <Text13Regular c={failed ? 'var(--mantine-color-red-6)' : undefined}>{failed ?? 0}</Text13Regular>
            </Table.Td>
            <Table.Td>{status ?? '-'}</Table.Td>
          </Table.Tr>
        </Table.Tbody>
      </Table>
      {failures.length > 0 && (
        <Box mt="xs">
          <TextTitle3 c="var(--mantine-color-red-6)" mb={4}>
            Failures ({failures.length})
          </TextTitle3>
          <Table striped highlightOnHover withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Filename</Table.Th>
                <Table.Th>Error</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {failures.map((f, i) => (
                <Table.Tr key={i}>
                  <Table.Td style={{ fontFamily: 'monospace', fontSize: 12 }}>{f.filename ?? '—'}</Table.Td>
                  <Table.Td>
                    <Text13Regular c="var(--mantine-color-red-6)">{f.error}</Text13Regular>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Box>
      )}
    </>
  );
}

function PullProgressTable({ progress }: { progress: Record<string, unknown> }) {
  const folderName = progress.folderName as string | undefined;
  const connector = progress.connector as string | undefined;
  const totalFiles = (progress.totalFiles ?? progress.totalRequested) as number | undefined;
  const status = progress.status as string | undefined;
  const createdPaths = (progress.createdPaths as string[] | undefined) ?? [];
  const updatedPaths = (progress.updatedPaths as string[] | undefined) ?? [];
  const deletedPaths = (progress.deletedPaths as string[] | undefined) ?? [];
  // Prefer actual counts (not capped) when available; fall back to path array lengths
  const createdCount = (progress.createdCount as number | undefined) ?? createdPaths.length;
  const updatedCount = (progress.updatedCount as number | undefined) ?? updatedPaths.length;
  const deletedCount = (progress.deletedCount as number | undefined) ?? deletedPaths.length;
  const folderErrors = progress.folderErrors as Record<string, { folderName: string; message: string; details?: string }> | undefined;
  const folderErrorEntries = folderErrors ? Object.entries(folderErrors) : [];

  if (!folderName && totalFiles === undefined) return null;

  const affectedFiles = collectAffectedFiles([{ createdPaths, updatedPaths, deletedPaths }]);

  return (
    <>
      <Table striped highlightOnHover withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Folder</Table.Th>
            <Table.Th>Source</Table.Th>
            <Table.Th>Created</Table.Th>
            <Table.Th>Updated</Table.Th>
            {deletedCount > 0 && <Table.Th>Deleted</Table.Th>}
            <Table.Th>Fetched</Table.Th>
            <Table.Th>Status</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          <Table.Tr>
            <Table.Td>{folderName || 'Folder'}</Table.Td>
            <Table.Td>{connector ?? '-'}</Table.Td>
            <Table.Td>{createdCount}</Table.Td>
            <Table.Td>{updatedCount}</Table.Td>
            {deletedCount > 0 && <Table.Td>{deletedCount}</Table.Td>}
            <Table.Td>{totalFiles ?? 0}</Table.Td>
            <Table.Td>{status ?? '-'}</Table.Td>
          </Table.Tr>
          {folderErrorEntries.map(([folderId, folderError]) => (
            <Table.Tr key={folderId}>
              <Table.Td>{folderError.folderName}</Table.Td>
              <Table.Td>{connector ?? '-'}</Table.Td>
              <Table.Td colSpan={deletedCount > 0 ? 4 : 3}>
                <Stack gap={2}>
                  <Text13Regular c="var(--mantine-color-red-6)">{folderError.message}</Text13Regular>
                  {folderError.details && (
                    <Text13Regular c="dimmed">{folderError.details}</Text13Regular>
                  )}
                </Stack>
              </Table.Td>
              <Table.Td>
                <Text13Regular c="var(--mantine-color-red-6)">failed</Text13Regular>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <AffectedFilesTable files={affectedFiles} />
    </>
  );
}
