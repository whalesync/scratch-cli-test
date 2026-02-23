'use client';

import MainContent from '@/app/components/layouts/MainContent';
import { useJobsDevTools } from '@/hooks/use-jobs-dev-tools';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { jobApi } from '@/lib/api/job';
import { formatDate, timeAgo } from '@/utils/helpers';
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Group,
  JsonInput,
  Loader,
  Modal,
  Stack,
  Table,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { BriefcaseIcon, Check, ChevronLeft, ChevronRight, Circle, Code, Dot, SquareIcon, X } from 'lucide-react';
import { useEffect, useState } from 'react';

const CANCELABLE_STATES = new Set(['created', 'active']);

const getStatusIcon = (status: string) => {
  switch (status) {
    case 'pending':
      return (
        <ThemeIcon size="sm" variant="outline" color="gray">
          <Circle size={12} />
        </ThemeIcon>
      );
    case 'active':
      return (
        <ThemeIcon size="sm" color="blue">
          <Dot size={12} />
        </ThemeIcon>
      );
    case 'completed':
      return (
        <ThemeIcon size="sm" color="green">
          <Check size={12} />
        </ThemeIcon>
      );
    case 'failed':
    case 'canceled':
      return (
        <ThemeIcon size="sm" color="red">
          <X size={12} />
        </ThemeIcon>
      );
    default:
      return (
        <ThemeIcon size="sm" variant="outline" color="gray">
          <Circle size={12} />
        </ThemeIcon>
      );
  }
};

const getStatusColor = (status: string) => {
  switch (status) {
    case 'pending':
      return 'gray';
    case 'active':
      return 'blue';
    case 'completed':
      return 'green';
    case 'failed':
      return 'red';
    case 'canceled':
      return 'orange';
    default:
      return 'gray';
  }
};

const PAGE_SIZE = 100;
const ALL_STATUSES = ['created', 'active', 'completed', 'failed', 'canceled'] as const;

export default function JobsDevPage() {
  const { isAdmin, isLoading: isUserLoading } = useScratchPadUser();
  const [offset, setOffset] = useState(0);
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>([]);
  const [userIdFilter, setUserIdFilter] = useState('');
  const { jobs, total, isLoading, error, mutate } = useJobsDevTools({
    limit: PAGE_SIZE,
    offset,
    statuses: selectedStatuses.length > 0 ? selectedStatuses : undefined,
    userId: userIdFilter.trim().length > 4 && userIdFilter.trim().startsWith('usr_') ? userIdFilter.trim() : undefined,
    autoRefresh: true,
  });
  const [cancelingJobIds, setCancelingJobIds] = useState<Set<string>>(new Set());

  const toggleStatus = (status: string) => {
    setOffset(0);
    setSelectedStatuses((prev) => (prev.includes(status) ? prev.filter((s) => s !== status) : [...prev, status]));
  };
  const [viewRawJobId, setViewRawJobId] = useState<string | null>(null);

  const handleCancelJob = async (bullJobId: string) => {
    setCancelingJobIds((prev) => new Set(prev).add(bullJobId));
    try {
      await jobApi.cancelJob(bullJobId);
      await mutate();
    } catch {
      notifications.show({
        title: 'Error',
        message: 'Failed to cancel job',
        color: 'red',
      });
    }
  };

  if (isUserLoading) {
    return (
      <MainContent>
        <MainContent.BasicHeader title="Jobs Manager" Icon={BriefcaseIcon} />
        <MainContent.Body>
          <Center h="100%">
            <Group>
              <Loader size="sm" />
              <Text>Loading...</Text>
            </Group>
          </Center>
        </MainContent.Body>
      </MainContent>
    );
  }

  if (!isAdmin) {
    return (
      <MainContent>
        <MainContent.BasicHeader title="Jobs Manager" Icon={BriefcaseIcon} />
        <MainContent.Body>
          <Center h="100%">
            <Text c="red">You do not have permission to view this page. Admin access is required.</Text>
          </Center>
        </MainContent.Body>
      </MainContent>
    );
  }

  if (isLoading && jobs.length === 0) {
    return (
      <MainContent>
        <MainContent.BasicHeader title="Jobs Manager" Icon={BriefcaseIcon} />
        <MainContent.Body>
          <Center h="100%">
            <Group>
              <Loader size="sm" />
              <Text>Loading jobs...</Text>
            </Group>
          </Center>
        </MainContent.Body>
      </MainContent>
    );
  }

  if (error) {
    return (
      <MainContent>
        <MainContent.BasicHeader title="Jobs Manager" Icon={BriefcaseIcon} />
        <MainContent.Body>
          <Center h="100%">
            <Text c="red">Error loading jobs: {error.message}</Text>
          </Center>
        </MainContent.Body>
      </MainContent>
    );
  }

  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <MainContent>
      <MainContent.BasicHeader title="Jobs Manager" Icon={BriefcaseIcon} />
      <MainContent.Body>
        <Group w="100%" justify="space-between">
          <Group gap="xs">
            <TextInput
              placeholder="Filter by User ID"
              size="xs"
              value={userIdFilter}
              onChange={(e) => {
                setUserIdFilter(e.currentTarget.value);
                setOffset(0);
              }}
              style={{ width: 280 }}
            />
            {ALL_STATUSES.map((status) => (
              <Badge
                key={status}
                color={selectedStatuses.includes(status) ? getStatusColor(status) : 'gray'}
                variant={selectedStatuses.includes(status) ? 'filled' : 'outline'}
                size="xs"
                style={{ cursor: 'pointer' }}
                onClick={() => toggleStatus(status)}
              >
                {status}
              </Badge>
            ))}
            {selectedStatuses.length > 0 && (
              <Button
                size="xs"
                variant="subtle"
                color="gray"
                onClick={() => {
                  setSelectedStatuses([]);
                  setOffset(0);
                }}
              >
                Clear
              </Button>
            )}
          </Group>

          <Group justify="justify-end" gap="xl">
            <Text size="sm" c="dimmed">
              {total > 0
                ? `Showing ${offset + 1}-${Math.min(offset + PAGE_SIZE, total)} of ${total} jobs`
                : 'No jobs found'}
            </Text>
            <Group gap="xs">
              <ActionIcon variant="subtle" disabled={offset === 0} onClick={() => setOffset((o) => o - PAGE_SIZE)}>
                <ChevronLeft size={16} />
              </ActionIcon>
              <Text size="sm">
                Page {currentPage} of {totalPages || 1}
              </Text>
              <ActionIcon
                variant="subtle"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset((o) => o + PAGE_SIZE)}
              >
                <ChevronRight size={16} />
              </ActionIcon>
            </Group>
          </Group>
        </Group>
        {jobs.length === 0 ? (
          <Center h="50vh">
            <Text c="dimmed">No jobs found</Text>
          </Center>
        ) : (
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Job ID</Table.Th>
                <Table.Th>User ID</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Type</Table.Th>
                <Table.Th>Created</Table.Th>
                <Table.Th>Started</Table.Th>
                <Table.Th>Duration</Table.Th>
                <Table.Th>Error</Table.Th>
                <Table.Th>Actions</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {jobs.map((job) => {
                let duration: string | null = null;
                if (job.processedOn && job.finishedOn) {
                  const diff = new Date(job.finishedOn).getTime() - new Date(job.processedOn).getTime();
                  const seconds = diff / 1000;
                  duration = seconds >= 10 ? `${Math.floor(seconds)}s` : `${seconds.toFixed(3)}s`;
                }

                return (
                  <Table.Tr key={job.dbJobId}>
                    <Table.Td>
                      <Stack gap={2}>
                        <Text size="xs" c="dimmed" style={{ fontFamily: 'monospace' }}>
                          {job.dbJobId || '-'}
                        </Text>
                        <Text size="xs" c="dimmed" style={{ fontFamily: 'monospace' }}>
                          {job.bullJobId || '-'}
                        </Text>
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed" style={{ fontFamily: 'monospace' }}>
                        {job.userId}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs">
                        {getStatusIcon(job.state)}
                        <Badge color={getStatusColor(job.state)} size="sm">
                          {job.state}
                        </Badge>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{job.type}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Tooltip label={formatDate(job.createdAt)}>
                        <Text size="sm" c="dimmed">
                          {timeAgo(job.createdAt)}
                        </Text>
                      </Tooltip>
                    </Table.Td>
                    <Table.Td>
                      {job.processedOn ? (
                        <Tooltip label={formatDate(job.processedOn)}>
                          <Text size="sm" c="dimmed">
                            {timeAgo(job.processedOn)}
                          </Text>
                        </Tooltip>
                      ) : (
                        '-'
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed" style={{ fontFamily: 'monospace' }}>
                        {duration || '-'}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {job.failedReason ? (
                        <Text size="sm" c="red" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {job.failedReason}
                        </Text>
                      ) : (
                        '-'
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap">
                        <Tooltip label="View Raw JSON">
                          <ActionIcon
                            variant="subtle"
                            color="gray"
                            onClick={() => setViewRawJobId(job.bullJobId || job.dbJobId || null)}
                          >
                            <Code size={16} />
                          </ActionIcon>
                        </Tooltip>
                        {CANCELABLE_STATES.has(job.state) && job.bullJobId && (
                          <Tooltip label="Cancel Job">
                            <ActionIcon
                              variant="subtle"
                              color="red"
                              disabled={cancelingJobIds.has(job.bullJobId)}
                              onClick={() => handleCancelJob(job.bullJobId!)}
                            >
                              <SquareIcon size={16} />
                            </ActionIcon>
                          </Tooltip>
                        )}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        )}
      </MainContent.Body>

      <JobRawModal jobId={viewRawJobId} onClose={() => setViewRawJobId(null)} />
    </MainContent>
  );
}

function JobRawModal({ jobId, onClose }: { jobId: string | null; onClose: () => void }) {
  const [data, setData] = useState<object | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (jobId) {
      setLoading(true);
      jobApi
        .getJobRaw(jobId)
        .then(setData)
        .catch((err) => {
          console.debug(err);
          setData({ error: 'Failed to fetch' });
        })
        .finally(() => setLoading(false));
    } else {
      setData(null);
    }
  }, [jobId]);

  return (
    <Modal opened={!!jobId} onClose={onClose} title="Raw Job Data" size="xl">
      {loading ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : (
        <JsonInput value={JSON.stringify(data, null, 2)} formatOnBlur autosize minRows={10} readOnly />
      )}
    </Modal>
  );
}
