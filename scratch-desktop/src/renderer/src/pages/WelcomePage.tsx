import { Alert, Box, Center, Loader, Stack } from '@mantine/core';
import { Workspace } from '@spinner/shared-types';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Text12Medium, Text13Regular, TextTitle1 } from '../components/base/text';
import { CloudWorkspaceCard, DownloadingWorkspaceCard } from '../components/WorkspaceCard';
import { trackCancelPickParentFolder, trackFirstRunDownload } from '../lib/posthog';
import { scratchApiClient } from '../lib/scratch-api-client';

export function WelcomePage() {
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloadingWorkspaceId, setDownloadingWorkspaceId] = useState<Workspace['id'] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const remoteWorkspaces = await scratchApiClient.workspaces.list(undefined, 'updatedAt', 'desc');
        if (remoteWorkspaces.length === 0) {
          void navigate('/', { replace: true });
          return;
        }
        setWorkspaces(remoteWorkspaces);
      } catch {
        void navigate('/', { replace: true });
        return;
      }
      setLoading(false);
    })();
  }, [navigate]);

  const handleDownload = useCallback(
    async (workspace: Workspace) => {
      // Ignore extra clicks once a download is in flight.
      if (downloadingWorkspaceId) return;
      setError(null);
      try {
        const parentFolder = await window.scratchDesktop.pickParentFolder();
        if (!parentFolder) {
          void trackCancelPickParentFolder(workspace.id, 'download');
          return;
        }

        setDownloadingWorkspaceId(workspace.id);
        void trackFirstRunDownload(workspace.id);
        await window.scratchDesktop.initWorkspace(workspace.id, parentFolder);
        void window.scratchPreferences.setCurrentWorkspaceId(workspace.id);
        void navigate(`/workspace/${workspace.id}`, { replace: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Download failed. Check the folder is writable and try again.');
        setDownloadingWorkspaceId(null);
      }
    },
    [downloadingWorkspaceId, navigate],
  );

  if (loading) {
    return (
      <Center h="100vh">
        <Loader size="sm" />
      </Center>
    );
  }

  return (
    <Box
      style={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      <Stack gap="lg" maw={460} w="100%" px="xl">
        <Text12Medium c="var(--fg-muted)" style={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          One quick step
        </Text12Medium>

        <TextTitle1>Download a workspace</TextTitle1>

        <Text13Regular c="dimmed">
          Scratch keeps your workspaces on your computer, powered by our servers. Pick one to download — your agents
          will work with its data right there. You can download the others anytime from the home screen.
        </Text13Regular>

        <Stack gap={0}>
          {workspaces.map((workspace) =>
            downloadingWorkspaceId === workspace.id ? (
              <DownloadingWorkspaceCard key={workspace.id} workspace={workspace} />
            ) : (
              <CloudWorkspaceCard
                key={workspace.id}
                workspace={workspace}
                fileCount={workspace.recordCount ?? 0}
                onDownload={() => void handleDownload(workspace)}
              />
            ),
          )}
        </Stack>

        {error && (
          <Alert color="red" variant="light" radius="md">
            {error}
          </Alert>
        )}
      </Stack>
    </Box>
  );
}
