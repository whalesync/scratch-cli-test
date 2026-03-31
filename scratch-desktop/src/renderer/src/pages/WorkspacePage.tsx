import { ActionIcon, Alert, Box, Center, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { workspacesApi } from '../lib/workspaces-api';
import { Workspace } from '../types/workspace';

export function WorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchWorkspace = useCallback(async () => {
    if (!id) return;
    try {
      setLoading(true);
      setError(null);
      const data = await workspacesApi.detail(id);
      setWorkspace(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspace');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void fetchWorkspace();
  }, [fetchWorkspace]);

  if (loading) {
    return (
      <Center h="100%">
        <Loader size="sm" />
      </Center>
    );
  }

  if (error || !workspace) {
    return (
      <Stack p="xl">
        <Alert color="red" title="Error">
          {error || 'Workspace not found'}
        </Alert>
      </Stack>
    );
  }

  const folderCount = workspace.dataFolders?.length ?? 0;

  return (
    <Stack p="xl" gap="lg">
      <Group gap="sm">
        <ActionIcon variant="subtle" onClick={() => void navigate('/')}>
          <ArrowLeft size={18} />
        </ActionIcon>
        <Title order={2}>{workspace.name || 'Untitled Workspace'}</Title>
      </Group>

      <Box>
        <Text size="sm" c="dimmed">
          ID: {workspace.id}
        </Text>
        <Text size="sm" c="dimmed">
          Created: {new Date(workspace.createdAt).toLocaleDateString()}
        </Text>
        <Text size="sm" c="dimmed">
          Folders: {folderCount}
        </Text>
      </Box>

      {folderCount > 0 && (
        <Stack gap="xs">
          <Title order={4}>Data Folders</Title>
          {workspace.dataFolders?.map((df) => (
            <Group key={df.id} gap="xs">
              <Text size="sm" ff="monospace">
                {df.path || '/'}
              </Text>
              <Text size="xs" c="dimmed">
                {df.name}
              </Text>
              {df.connectorDisplayName && (
                <Text size="xs" c="dimmed">
                  ({df.connectorDisplayName})
                </Text>
              )}
            </Group>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
