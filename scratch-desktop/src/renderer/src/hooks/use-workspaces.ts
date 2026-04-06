import { notifications } from '@mantine/notifications';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listLocalWorkspaces } from '../lib/local-workspaces';
import { logPerf } from '../lib/perf';
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
  fetchWorkspaces: () => Promise<void>;
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

  const fetchWorkspaces = useCallback(async () => {
    const start = performance.now();
    try {
      setLoading(true);
      setError(null);
      const [data, localWorkspaces] = await Promise.all([workspacesApi.list(), listLocalWorkspaces()]);
      setWorkspaces(data);
      setDownloadedWorkspaceIds(new Set(localWorkspaces.map((workspace) => workspace.id)));
      setLocalFileCountById(new Map(localWorkspaces.map((w) => [w.id, w.fileCount])));
      setLocalPathById(new Map(localWorkspaces.map((w) => [w.id, w.path])));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspaces');
    } finally {
      logPerf('useWorkspaces fetchWorkspaces', performance.now() - start);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchWorkspaces();
  }, [fetchWorkspaces]);

  const handleDownloadAndOpen = useCallback(
    async (workspace: Workspace) => {
      try {
        const parentFolder = await window.scratchDesktop.pickParentFolder();
        if (!parentFolder) return;

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
    fetchWorkspaces,
    handleDownloadAndOpen,
  };
}
