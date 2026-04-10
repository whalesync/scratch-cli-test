import { Alert, Box, Center, Loader, Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ServerConnectionSplash } from '../components/ServerConnectionSplash';
import { isServerConnectionError } from '../lib/is-server-connection-error';
import { listLocalWorkspaces } from '../lib/local-workspaces';
import { parentDirectoryPath } from '../lib/parent-path';
import { workspacesApi } from '../lib/workspaces-api';
import { Workspace } from '../types/workspace';
import { PublishChangesModal } from './workspace/PublishChangesModal';
import { PullAllModal } from './workspace/PullAllModal';
import { PullInProgressModal } from './workspace/PullInProgressModal';
import { WorkspaceContent } from './workspace/WorkspaceContent';
import { WorkspaceHeader } from './workspace/WorkspaceHeader';

function isNoConnectionsScratchmdError(message: string): boolean {
  return message.toLowerCase().includes('no connections found');
}

export function WorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [localPath, setLocalPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);

  const [publishModalOpen, setPublishModalOpen] = useState(false);
  const [publishFilePath, setPublishFilePath] = useState<string | null>(null);
  const [pullAllModalOpen, setPullAllModalOpen] = useState(false);
  const [pullInProgressModalOpen, setPullInProgressModalOpen] = useState(false);
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);
  const [dataRefreshKey, setDataRefreshKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState(false);

  const focusSyncBootAtRef = useRef(0);
  const previousFolderCountRef = useRef<number | null>(null);
  const previousConnectionCountRef = useRef<number | null>(null);

  const fetchWorkspace = useCallback(
    async (options?: {
      silent?: boolean;
    }): Promise<
      | {
          localPath: string | null;
          serverDataFolderCount: number;
          connectionCount: number;
          hasPullLock: boolean;
        }
      | undefined
    > => {
      if (!id) {
        return undefined;
      }
      const silent = options?.silent ?? false;
      try {
        if (!silent) {
          setLoading(true);
          setError(null);
          setConnectionError(false);
        }
        const [data, localWorkspaces] = await Promise.all([workspacesApi.detail(id), listLocalWorkspaces()]);
        const localWorkspace = localWorkspaces.find((entry) => entry.id === id) ?? null;
        setWorkspace(data);
        const nextLocalPath = localWorkspace?.path ?? null;
        setLocalPath(nextLocalPath);
        const uniqueConnections = new Set((data.dataFolders ?? []).map((f) => f.connectorAccountId).filter(Boolean));
        return {
          localPath: nextLocalPath,
          serverDataFolderCount: data.dataFolders?.length ?? 0,
          connectionCount: uniqueConnections.size,
          hasPullLock: (data.dataFolders ?? []).some((f) => f.lock === 'pull'),
        };
      } catch (err) {
        if (!silent) {
          if (isServerConnectionError(err)) {
            setConnectionError(true);
            setError(null);
          } else {
            setConnectionError(false);
            setError(err instanceof Error ? err.message : 'Failed to load workspace');
          }
        } else {
          console.debug('[workspace] silent fetchWorkspace failed:', err);
        }
        return undefined;
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [id],
  );

  const handleDownload = useCallback(async () => {
    if (!workspace) return;

    try {
      setDownloading(true);
      const parentFolder = await window.scratchDesktop.pickParentFolder();
      if (!parentFolder) return;

      await window.scratchDesktop.initWorkspace(workspace.id, parentFolder);
      const localWorkspaces = await listLocalWorkspaces();
      const localWorkspace = localWorkspaces.find((entry) => entry.id === workspace.id) ?? null;
      setLocalPath(localWorkspace?.path ?? null);
      notifications.show({
        title: 'Download complete',
        message: `${workspace.name || 'Workspace'} is now available locally.`,
        color: 'green',
      });
    } catch (err) {
      notifications.show({
        title: 'Download failed',
        message: err instanceof Error ? err.message : 'Failed to download records',
        color: 'red',
      });
    } finally {
      setDownloading(false);
    }
  }, [workspace]);

  const handleDataRefresh = useCallback(() => {
    setDataRefreshKey((current) => current + 1);
  }, []);

  useEffect(() => {
    focusSyncBootAtRef.current = performance.now();
  }, [id]);

  useEffect(() => {
    void fetchWorkspace().then((snapshot) => {
      if (snapshot) {
        previousFolderCountRef.current = snapshot.serverDataFolderCount;
        previousConnectionCountRef.current = snapshot.connectionCount;
      }
    });
  }, [fetchWorkspace]);

  const workspaceId = workspace?.id;

  useEffect(() => {
    if (!id || !workspaceId || workspaceId !== id) {
      return;
    }

    const handleWindowFocus = (): void => {
      if (performance.now() - focusSyncBootAtRef.current < 1500) {
        return;
      }
      void (async () => {
        const snapshot = await fetchWorkspace({ silent: true });
        if (!snapshot?.localPath) {
          return;
        }

        // Check if any data folders have an active pull lock
        if (snapshot.hasPullLock) {
          // Show the pull-in-progress modal — it will handle polling and local download
          setPullInProgressModalOpen(true);
          return;
        }

        // Check if folders or connections changed — trigger pull with --on-delete remove
        const prevFolderCount = previousFolderCountRef.current;
        const prevConnectionCount = previousConnectionCountRef.current;
        const folderCountChanged = prevFolderCount !== null && prevFolderCount !== snapshot.serverDataFolderCount;
        const connectionCountChanged = prevConnectionCount !== null && prevConnectionCount !== snapshot.connectionCount;
        previousFolderCountRef.current = snapshot.serverDataFolderCount;
        previousConnectionCountRef.current = snapshot.connectionCount;

        try {
          if (folderCountChanged || connectionCountChanged) {
            await window.scratchDesktop.pullWorkspaceChanges(snapshot.localPath, { onDelete: 'remove' });
          } else {
            await window.scratchDesktop.pullWorkspaceChanges(snapshot.localPath, { onDelete: 'remove' });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (isNoConnectionsScratchmdError(message) && snapshot.serverDataFolderCount > 0) {
            try {
              const parentDir = parentDirectoryPath(snapshot.localPath);
              await window.scratchDesktop.initWorkspace(workspaceId, parentDir, { force: true });
              const localWorkspaces = await listLocalWorkspaces();
              const pathAfterInit = localWorkspaces.find((entry) => entry.id === id)?.path ?? snapshot.localPath;
              setLocalPath(pathAfterInit);
              await window.scratchDesktop.pullWorkspaceChanges(pathAfterInit);
            } catch (recoveryErr) {
              console.debug('[workspace] focus sync recovery failed:', recoveryErr);
            }
          } else {
            console.debug('[workspace] focus pull failed:', err);
          }
        }
        handleDataRefresh();
      })();
    };

    window.addEventListener('focus', handleWindowFocus);
    return () => {
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [id, workspaceId, fetchWorkspace, handleDataRefresh]);

  if (loading) {
    return (
      <Center h="100%">
        <Loader size="sm" />
      </Center>
    );
  }

  if (connectionError) {
    return <ServerConnectionSplash />;
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

  return (
    <Box h="100%" style={{ display: 'flex', flexDirection: 'column' }}>
      <PublishChangesModal
        opened={publishModalOpen}
        onClose={() => {
          setPublishModalOpen(false);
          setPublishFilePath(null);
        }}
        workspaceName={workspace.name}
        localPath={localPath}
        onDataRefresh={handleDataRefresh}
        filterPath={publishFilePath}
      />
      <PullAllModal
        opened={pullAllModalOpen}
        onClose={() => setPullAllModalOpen(false)}
        workspaceName={workspace.name}
        localPath={localPath}
        onDataRefresh={handleDataRefresh}
      />
      {localPath && (
        <PullInProgressModal
          opened={pullInProgressModalOpen}
          onClose={() => setPullInProgressModalOpen(false)}
          workbookId={workspace.id}
          localPath={localPath}
          onDataRefresh={handleDataRefresh}
        />
      )}
      <WorkspaceHeader
        workspace={workspace}
        isDownloaded={localPath !== null}
        downloading={downloading}
        onDownload={() => void handleDownload()}
        onPublishAll={() => setPublishModalOpen(true)}
        onPullAll={() => setPullAllModalOpen(true)}
      />
      <WorkspaceContent
        workspace={workspace}
        localPath={localPath}
        selectedFolderPath={selectedFolderPath}
        onSelectFolder={setSelectedFolderPath}
        dataRefreshKey={dataRefreshKey}
        onPublishFile={(relativePath: string) => {
          setPublishFilePath(relativePath);
          setPublishModalOpen(true);
        }}
      />
    </Box>
  );
}
