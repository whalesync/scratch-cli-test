'use client';

import { IconButtonToolbar } from '@/app/components/base/buttons';
import {
  Text12Medium,
  Text12Regular,
  Text13Medium,
  Text13Regular,
  TextMono12Regular,
} from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { useDevTools } from '@/hooks/use-dev-tools';
import { useJobs } from '@/hooks/use-jobs';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { jobApi } from '@/lib/api/job';
import { workbookApi } from '@/lib/api/workbook';
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
import { PublishPlanEntity } from '@spinner/shared-types';
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
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
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

export function RunsView() {
  const params = useParams<{ id: string }>();
  const workbookId = params.id as WorkbookId;
  const searchParams = useSearchParams();
  const { jobs, error, isLoading, mutate, cancelJob } = useJobs(50, 0, workbookId);
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
        <Text13Medium>Recent Runs</Text13Medium>
        <Group gap="xs">
          <Text12Regular c="dimmed">{jobs.length} jobs</Text12Regular>
          <IconButtonToolbar onClick={() => mutate()} title="Refresh">
            <StyledLucideIcon Icon={RefreshCwIcon} size="sm" c="var(--fg-secondary)" />
          </IconButtonToolbar>
        </Group>
      </Group>

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
            {description}
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
  const [publishPlan, setPublishPlan] = useState<PublishPlanEntity | null>(null);
  const [loading, setLoading] = useState(true);
  const [operationsModalPublishPlanId, setOperationsModalPublishPlanId] = useState<string | null>(null);
  const [operationsModalHasErrorFilter, setOperationsModalHasErrorFilter] = useState(false);

  useEffect(() => {
    if (!job.bullJobId) {
      setLoading(false);
      return;
    }
    workbookApi
      .getPublishPlanByJobId(workbookId, job.bullJobId)
      .then((res) => {
        setPublishPlan(res);
      })
      .catch((err) => {
        console.error('Failed to load publish plan', err);
      })
      .finally(() => setLoading(false));
  }, [workbookId, job.bullJobId]);

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

  return (
    <Box px="md" py="sm" style={{ background: 'var(--bg-panel)' }}>
      <Table withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>State</Table.Th>
            <Table.Th>ID</Table.Th>
            <Table.Th>Connection</Table.Th>
            <Table.Th>Phase</Table.Th>
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
            {(['edits', 'creates', 'deletes', 'backfills', 'renameFiles'] as const).map((phaseKey) => {
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
  if (!progress.folders || !Array.isArray(progress.folders)) return null;
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

function PullProgressTable({ progress }: { progress: Record<string, unknown> }) {
  const folderName = progress.folderName as string | undefined;
  const connector = progress.connector as string | undefined;
  const totalFiles = (progress.totalFiles ?? progress.totalRequested) as number | undefined;
  const status = progress.status as string | undefined;
  if (!folderName && totalFiles === undefined) return null;

  const affectedFiles = collectAffectedFiles([
    {
      refreshedPaths: (progress.createdPaths ?? progress.updatedPaths) as string[] | undefined,
    },
  ]);

  return (
    <>
      <Table striped highlightOnHover withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Folder</Table.Th>
            <Table.Th>Source</Table.Th>
            <Table.Th>Files</Table.Th>
            <Table.Th>Status</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          <Table.Tr>
            <Table.Td>{folderName || 'Folder'}</Table.Td>
            <Table.Td>{connector ?? '-'}</Table.Td>
            <Table.Td>{totalFiles ?? 0}</Table.Td>
            <Table.Td>{status ?? '-'}</Table.Td>
          </Table.Tr>
        </Table.Tbody>
      </Table>
      <AffectedFilesTable files={affectedFiles} />
    </>
  );
}
