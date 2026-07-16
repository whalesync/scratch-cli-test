'use client';

import { IconButtonToolbar } from '@/app/components/base/buttons';
import { Text12Medium, Text12Regular, Text13Regular, TextMono12Regular } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { ProgressDetails } from '@/app/components/jobs/JobProgressDetail';
import { useDataFolders } from '@/hooks/use-data-folders';
import { useDevTools } from '@/hooks/use-dev-tools';
import { useJobs } from '@/hooks/use-jobs';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { useSyncStore } from '@/stores/sync-store';
import { useWorkbookUIStore } from '@/stores/workbook-ui-store';
import { formatNumber, timeAgo } from '@/utils/helpers';
import { getJobDescription, getJobType, getTypeLabel, JobType, publishPlanStatusBadgeColor } from '@/utils/job-helpers';
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
  SegmentedControl,
  Stack,
  Table,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import type { Job, WorkbookId } from '@spinner/shared-types';
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

type EffectiveState = Job['state'] | 'completed-with-warnings';

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

const formatDuration = (processedOn?: string | Date | null, finishedOn?: string | Date | null): string => {
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

const formatTimestamp = (date?: string | Date | null): string => {
  if (!date) return '-';
  return new Date(date).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

/** Derive the effective state for a job, checking sync table-level failures and warnings in progress. */
const getEffectiveState = (job: Job): EffectiveState => {
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

const getJobKey = (job: Job): string => `${job.bullJobId}`;

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

  const setTypeFilter = useCallback(
    (type: string) => {
      const next = new URLSearchParams(searchParams.toString());
      if (type === 'all') {
        next.delete('type');
      } else {
        next.set('type', type);
      }
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

  // When there are no jobs and no filters, show a full-screen empty state. When a filter
  // yields no results we fall through to the normal layout instead, so the header (and its
  // type filter) stays visible and the user can switch back to "All".
  if (jobs.length === 0 && !hasFilters) {
    return (
      <Center h="100%">
        <Stack align="center" gap="xs">
          <ClockIcon size={24} color="var(--mantine-color-gray-5)" />
          <Text c="dimmed">No runs yet</Text>
          <Text12Regular c="dimmed">Jobs will appear here when you run syncs or publish changes</Text12Regular>
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
        justify="space-between"
        style={{
          borderBottom: '1px solid var(--fg-divider)',
          flexShrink: 0,
        }}
      >
        <SegmentedControl
          size="xs"
          value={runsParams.type ?? 'all'}
          onChange={setTypeFilter}
          data={[
            { value: 'all', label: 'All' },
            { value: 'pull', label: 'Pull' },
            { value: 'publish', label: 'Publish' },
            { value: 'sync', label: 'Sync' },
          ]}
        />
        <Group gap="xs">
          <Text12Regular c="dimmed">{jobs.length} jobs</Text12Regular>
          <IconButtonToolbar onClick={() => mutate()} title="Refresh">
            <StyledLucideIcon Icon={RefreshCwIcon} size="sm" c="var(--fg-secondary)" />
          </IconButtonToolbar>
        </Group>
      </Group>

      {/* Filter chips (type is controlled by the SegmentedControl in the header) */}
      {(runsParams.syncId || runsParams.dataFolderId) && (
        <Group px="md" py={8} gap="xs" style={{ borderBottom: '1px solid var(--fg-divider)', flexShrink: 0 }}>
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
        {jobs.length === 0 && (
          <Center py={48}>
            <Stack align="center" gap="xs">
              <ClockIcon size={24} color="var(--mantine-color-gray-5)" />
              <Text c="dimmed">No matching runs</Text>
              <Text12Regular c="dimmed">Try a different type or remove a filter to see more results</Text12Regular>
            </Stack>
          </Center>
        )}
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
                    onCancel={job.bullJobId ? () => job.bullJobId && handleCancelJob(job.bullJobId) : undefined}
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
  job: Job;
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

function ExpandedJobDetails({ job, isDevToolsEnabled }: { job: Job; isDevToolsEnabled: boolean }) {
  const [rawData, setRawData] = useState<object | null>(null);
  const [rawLoading, setRawLoading] = useState(false);
  const [rawExpanded, setRawExpanded] = useState(false);

  const loadRawData = useCallback(() => {
    if (!job.bullJobId || rawData) return;
    setRawLoading(true);
    scratchApiClient.job
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
        {progress && <ProgressDetails type={job.type} progress={progress} />}

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
  return formatNumber(count);
}

function ExpandedPublishJobDetails({ job, isDevToolsEnabled }: { job: Job; isDevToolsEnabled: boolean }) {
  const { isAdmin } = useScratchPadUser();
  const params = useParams<{ id: string }>();
  const workbookId = params.id as WorkbookId;
  const isJobActive = ACTIVE_STATES.has(job.state);
  const { data: publishPlan, isLoading: loading } = useSWR(
    job.bullJobId ? ['publish-plan', workbookId, job.bullJobId] : null,
    () => (job.bullJobId ? scratchApiClient.publish.getPublishPlanByJobId(workbookId, job.bullJobId) : undefined),
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
            {formatNumber(liveProgress.processedCount ?? 0)} / {formatNumber(liveProgress.totalCount)} records
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
