import { notifications } from '@mantine/notifications';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { isServerConnectionError } from '../lib/is-server-connection-error';
import { listLocalWorkspaces } from '../lib/local-workspaces';
import { logPerf } from '../lib/perf';
import { trackCancelPickParentFolder, trackDownloadWorkspace } from '../lib/posthog';
import { workspacesApi } from '../lib/workspaces-api';
import { Workspace } from '../types/workspace';

export interface UseWorkspacesResult {
  workspaces: Workspace[];
  downloadedWorkspaceIds: Set<string>;
  localFileCountById: Map<string, number>;
  localPathById: Map<string, string>;
  localWorkspaces: Workspace[];
  remoteWorkspaces: Workspace[];
  loading: boolean;
  error: string | null;
  /** True when the remote workspace list could not be reached (network / gateway). */
  isConnectionError: boolean;
  fetchWorkspaces: (options?: { silent?: boolean }) => Promise<void>;
  handleDownloadAndOpen: (workspace: Workspace) => Promise<void>;
}

export function useWorkspaces(): UseWorkspacesResult {
  const navigate = useNavigate();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [downloadedWorkspaceIds, setDownloadedWorkspaceIds] = useState<Set<string>>(new Set());
  const [localFileCountById, setLocalFileCountById] = useState<Map<string, number>>(new Map());
  const [localPathById, setLocalPathById] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isConnectionError, setIsConnectionError] = useState(false);

  const fetchWorkspaces = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    const start = performance.now();
    try {
      if (!silent) {
        setLoading(true);
        setError(null);
        setIsConnectionError(false);
      }
      const [data, localWorkspaces] = await Promise.all([workspacesApi.list(), listLocalWorkspaces()]);
      setWorkspaces(data);
      setDownloadedWorkspaceIds(new Set(localWorkspaces.map((workspace) => workspace.id)));
      setLocalFileCountById(new Map(localWorkspaces.map((w) => [w.id, w.fileCount])));
      setLocalPathById(new Map(localWorkspaces.map((w) => [w.id, w.path])));
    } catch (err) {
      if (!silent) {
        setIsConnectionError(isServerConnectionError(err));
        setError(err instanceof Error ? err.message : 'Failed to load workspaces');
      } else {
        console.debug('[useWorkspaces] silent fetchWorkspaces failed:', err);
      }
    } finally {
      logPerf('useWorkspaces fetchWorkspaces', performance.now() - start);
      if (!silent) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void fetchWorkspaces();
  }, [fetchWorkspaces]);

  const handleDownloadAndOpen = useCallback(
    async (workspace: Workspace) => {
      try {
        const parentFolder = await window.scratchDesktop.pickParentFolder();
        if (!parentFolder) {
          void trackCancelPickParentFolder(workspace.id, 'download');
          return;
        }

        void trackDownloadWorkspace(workspace.id);
        await window.scratchDesktop.initWorkspace(workspace.id, parentFolder);
        notifications.show({
          title: 'Download complete',
          message: `${workspace.name || 'Workspace'} is now available locally.`,
          color: 'green',
        });
        void navigate(`/workspace/${workspace.id}`);
      } catch (err) {
        notifications.show({
          title: 'Download failed',
          message: err instanceof Error ? err.message : 'Failed to download workspace',
          color: 'red',
        });
      }
    },
    [navigate],
  );

  const sortByName = (a: Workspace, b: Workspace) =>
    (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });

  const localWorkspaces = useMemo(
    () => workspaces.filter((ws) => downloadedWorkspaceIds.has(ws.id)).sort(sortByName),
    [workspaces, downloadedWorkspaceIds],
  );
  const remoteWorkspaces = useMemo(
    () => workspaces.filter((ws) => !downloadedWorkspaceIds.has(ws.id)).sort(sortByName),
    [workspaces, downloadedWorkspaceIds],
  );

  return {
    workspaces,
    downloadedWorkspaceIds,
    localFileCountById,
    localPathById,
    localWorkspaces,
    remoteWorkspaces,
    loading,
    error,
    isConnectionError,
    fetchWorkspaces,
    handleDownloadAndOpen,
  };
}
