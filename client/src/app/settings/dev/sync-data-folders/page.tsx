'use client';

import MainContent from '@/app/components/layouts/MainContent';
import { API_CONFIG } from '@/lib/api/config';
import { Alert, Button, Card, Code, Group, Stack, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { AlertCircle, CheckCircle2, FolderSync, FolderSyncIcon, Play } from 'lucide-react';
import { useState } from 'react';

interface JobResult {
  success: boolean;
  jobId: string;
  message: string;
}

export default function SyncDataFoldersDevPage() {
  const [workbookId, setWorkbookId] = useState('');
  const [syncId, setSyncId] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [lastResult, setLastResult] = useState<JobResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRunJob = async () => {
    // Validate inputs
    if (!workbookId.trim()) {
      notifications.show({
        title: 'Error',
        message: 'Please provide a workspace ID',
        color: 'red',
      });
      return;
    }

    if (!syncId.trim()) {
      notifications.show({
        title: 'Error',
        message: 'Please provide a sync ID',
        color: 'red',
      });
      return;
    }

    setIsRunning(true);
    setError(null);

    try {
      const response = await API_CONFIG.getAxiosInstance().post<JobResult>('/dev-tools/jobs/sync-data-folders', {
        workbookId: workbookId.trim(),
        syncId: syncId.trim(),
      });

      setLastResult(response.data);

      notifications.show({
        title: 'Job queued',
        message: `Sync data folders job queued with ID: ${response.data.jobId}`,
        color: 'green',
      });
    } catch (err) {
      console.error('Failed to queue job:', err);
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      setError(errorMessage);
      notifications.show({
        title: 'Failed to queue job',
        message: errorMessage,
        color: 'red',
      });
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <MainContent>
      <MainContent.BasicHeader title="Sync Data Folders Job" Icon={FolderSyncIcon} />
      <MainContent.Body>
        <Stack gap="lg" maw={600}>
          <Alert icon={<AlertCircle size={16} />} color="blue">
            <Text size="sm">
              Trigger a sync-data-folders job to sync data between connected data folders based on a sync configuration.
            </Text>
          </Alert>

          <Card shadow="sm" padding="lg" radius="md" withBorder>
            <Stack gap="md">
              <Group gap="sm">
                <FolderSync size={20} />
                <Title order={3}>Job Parameters</Title>
              </Group>

              <TextInput
                label="Workspace ID"
                description="The ID of the workspace (e.g., wbk_...)"
                placeholder="wbk_abc123"
                value={workbookId}
                onChange={(e) => setWorkbookId(e.currentTarget.value)}
                disabled={isRunning}
                required
              />

              <TextInput
                label="Sync ID"
                description="The ID of the sync configuration (e.g., syn_...)"
                placeholder="syn_abc123"
                value={syncId}
                onChange={(e) => setSyncId(e.currentTarget.value)}
                disabled={isRunning}
                required
              />

              <Group>
                <Button
                  onClick={handleRunJob}
                  loading={isRunning}
                  disabled={!workbookId || !syncId}
                  leftSection={<Play size={16} />}
                >
                  Run Job
                </Button>
              </Group>
            </Stack>
          </Card>

          {error && (
            <Card shadow="sm" padding="lg" radius="md" withBorder bg="red.0">
              <Stack gap="sm">
                <Group gap="sm">
                  <AlertCircle size={20} color="red" />
                  <Title order={4}>Error</Title>
                </Group>
                <Text size="sm" c="red">
                  {error}
                </Text>
              </Stack>
            </Card>
          )}

          {lastResult && (
            <Card shadow="sm" padding="lg" radius="md" withBorder bg="green.0">
              <Stack gap="sm">
                <Group gap="sm">
                  <CheckCircle2 size={20} color="green" />
                  <Title order={4}>Job Queued Successfully</Title>
                </Group>
                <Group gap="md">
                  <div>
                    <Text size="xs" c="dimmed">
                      Job ID
                    </Text>
                    <Code>{lastResult.jobId}</Code>
                  </div>
                </Group>
                <Text size="sm" c="dimmed">
                  {lastResult.message}
                </Text>
                <Text size="xs" c="dimmed">
                  View progress on the Jobs page.
                </Text>
              </Stack>
            </Card>
          )}
        </Stack>
      </MainContent.Body>
    </MainContent>
  );
}
