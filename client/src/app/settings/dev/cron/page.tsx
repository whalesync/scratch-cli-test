'use client';

import MainContent from '@/app/components/layouts/MainContent';
import { useCronDevTools } from '@/hooks/use-cron-dev-tools';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { Badge, Button, Center, Code, Group, Loader, Stack, Table, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { TriggerCronJobResponseDto } from '@spinner/shared-types';
import { ClockIcon, PlayIcon } from 'lucide-react';
import { useState } from 'react';

const TITLE = 'Cron Jobs';

export default function CronJobsDevPage() {
  const { isAdmin, isLoading: isUserLoading } = useScratchPadUser();
  const { jobs, isLoading, error } = useCronDevTools();
  const [triggeringSlugs, setTriggeringSlugs] = useState<Set<string>>(new Set());
  const [lastResultBySlug, setLastResultBySlug] = useState<Map<string, TriggerCronJobResponseDto>>(new Map());

  const handleTrigger = async (slug: string) => {
    setTriggeringSlugs((prev) => new Set(prev).add(slug));
    try {
      const result = await scratchApiClient.devTools.triggerCronJob(slug);
      setLastResultBySlug((prev) => new Map(prev).set(slug, result));
      notifications.show({
        title: result.ran ? 'Cron job completed' : 'Cron job failed',
        message: result.ran ? `${slug} ran in ${result.durationMs}ms` : `${slug}: ${result.error ?? 'Unknown error'}`,
        color: result.ran ? 'green' : 'red',
      });
    } catch {
      notifications.show({ title: 'Error', message: `Failed to trigger ${slug}`, color: 'red' });
    } finally {
      setTriggeringSlugs((prev) => {
        const next = new Set(prev);
        next.delete(slug);
        return next;
      });
    }
  };

  if (isUserLoading) {
    return (
      <MainContent>
        <MainContent.BasicHeader title={TITLE} Icon={ClockIcon} />
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
        <MainContent.BasicHeader title={TITLE} Icon={ClockIcon} />
        <MainContent.Body>
          <Center h="100%">
            <Text c="red">You do not have permission to view this page. Admin access is required.</Text>
          </Center>
        </MainContent.Body>
      </MainContent>
    );
  }

  return (
    <MainContent>
      <MainContent.BasicHeader title={TITLE} Icon={ClockIcon} />
      <MainContent.Body>
        <Stack gap="md">
          <Text c="dimmed" size="sm">
            Manually trigger a scheduled cron job to run now. The job runs synchronously and the outcome is reported
            below — intended for testing.
          </Text>

          {error && <Text c="red">Failed to load cron jobs: {error.message}</Text>}

          {isLoading && jobs.length === 0 ? (
            <Center h={200}>
              <Group>
                <Loader size="sm" />
                <Text>Loading cron jobs...</Text>
              </Group>
            </Center>
          ) : (
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Job</Table.Th>
                  <Table.Th>Schedule</Table.Th>
                  <Table.Th>Last manual run</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {jobs.map((job) => {
                  const lastResult = lastResultBySlug.get(job.slug);
                  return (
                    <Table.Tr key={job.slug}>
                      <Table.Td>
                        <Stack gap={2}>
                          <Code>{job.slug}</Code>
                          <Text size="xs" c="dimmed">
                            {job.description}
                          </Text>
                        </Stack>
                      </Table.Td>
                      <Table.Td>
                        <Badge variant="light" color="gray">
                          {job.schedule}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        {lastResult === undefined ? (
                          <Text size="xs" c="dimmed">
                            —
                          </Text>
                        ) : lastResult.ran ? (
                          <Text size="xs" c="green">
                            Ran in {lastResult.durationMs}ms
                          </Text>
                        ) : (
                          <Text size="xs" c="red">
                            Failed: {lastResult.error ?? 'Unknown error'}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Button
                          size="xs"
                          leftSection={<PlayIcon size={14} />}
                          loading={triggeringSlugs.has(job.slug)}
                          onClick={() => handleTrigger(job.slug)}
                        >
                          Trigger
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
                {jobs.length === 0 && !isLoading && (
                  <Table.Tr>
                    <Table.Td colSpan={4}>
                      <Text c="dimmed" ta="center">
                        No cron jobs registered.
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          )}
        </Stack>
      </MainContent.Body>
    </MainContent>
  );
}
