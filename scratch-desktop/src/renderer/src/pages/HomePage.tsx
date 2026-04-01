import { Alert, Box, Center, Group, Loader, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useCallback, useEffect, useState } from 'react';
import { UserMenu } from '../components/user-menu';
import { WorkspaceCard } from '../components/WorkspaceCard';
import { listLocalWorkspaces } from '../lib/local-workspaces';
import { logPerf } from '../lib/perf';
import { workspacesApi } from '../lib/workspaces-api';
import { Workspace } from '../types/workspace';

export function HomePage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [downloadedWorkspaceIds, setDownloadedWorkspaceIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchWorkspaces = useCallback(async () => {
    const start = performance.now();
    try {
      setLoading(true);
      setError(null);
      const [data, localWorkspaces] = await Promise.all([workspacesApi.list(), listLocalWorkspaces()]);
      setWorkspaces(data);
      setDownloadedWorkspaceIds(new Set(localWorkspaces.map((workspace) => workspace.id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspaces');
    } finally {
      logPerf('homePage fetchWorkspaces', performance.now() - start);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchWorkspaces();
  }, [fetchWorkspaces]);

  if (loading) {
    return (
      <Center h="100%">
        <Loader size="sm" />
      </Center>
    );
  }

  if (error) {
    return (
      <Stack p="xl">
        <Alert color="red" title="Error">
          {error}
        </Alert>
      </Stack>
    );
  }

  return (
    <Box h="100%" style={{ display: 'flex', flexDirection: 'column' }}>
      <Stack p="xl" gap="lg" style={{ flex: 1 }}>
        <Title order={2}>Your Workspaces</Title>

        {workspaces.length === 0 ? (
          <Text c="dimmed">No workspaces found.</Text>
        ) : (
          <SimpleGrid cols={{ base: 1, xs: 2, sm: 3, md: 4 }} spacing="md">
            {workspaces.map((ws) => (
              <WorkspaceCard key={ws.id} workspace={ws} isDownloaded={downloadedWorkspaceIds.has(ws.id)} />
            ))}
          </SimpleGrid>
        )}
      </Stack>

      <Group h={40} px="md" justify="flex-start" style={{ flexShrink: 0 }}>
        <UserMenu />
      </Group>
    </Box>
  );
}
