import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Center,
  Checkbox,
  Code,
  Group,
  Loader,
  Modal,
  Radio,
  ScrollArea,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { LiveCommandOutput } from '../components/LiveCommandOutput';
import { listLocalWorkspaces } from '../lib/local-workspaces';
import { workspacesApi } from '../lib/workspaces-api';
import { Workspace } from '../types/workspace';

interface SyncValidationResult {
  syncName: string;
  status: 'pending' | 'running' | 'success' | 'error';
  stdout: string;
  stderr: string;
}

export function WorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [localPath, setLocalPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [validateModalOpen, setValidateModalOpen] = useState(false);
  const [runModalOpen, setRunModalOpen] = useState(false);
  const [publishPlanModalOpen, setPublishPlanModalOpen] = useState(false);
  const [localSyncs, setLocalSyncs] = useState<string[]>([]);
  const [selectedSyncs, setSelectedSyncs] = useState<string[]>([]);
  const [loadingSyncs, setLoadingSyncs] = useState(false);
  const [validatingSyncs, setValidatingSyncs] = useState(false);
  const [syncValidationResults, setSyncValidationResults] = useState<SyncValidationResult[]>([]);
  const [runSyncs, setRunSyncs] = useState<string[]>([]);
  const [loadingRunSyncs, setLoadingRunSyncs] = useState(false);
  const [selectedRunSync, setSelectedRunSync] = useState<string | null>(null);
  const [startingRunSync, setStartingRunSync] = useState(false);
  const [runningRunSync, setRunningRunSync] = useState(false);
  const [runSyncOutput, setRunSyncOutput] = useState('');
  const [runSyncExitCode, setRunSyncExitCode] = useState<number | null>(null);
  const [runSyncError, setRunSyncError] = useState<string | null>(null);
  const [startingPublishPlan, setStartingPublishPlan] = useState(false);
  const [runningPublishPlan, setRunningPublishPlan] = useState(false);
  const [publishPlanOutput, setPublishPlanOutput] = useState('');
  const [publishPlanExitCode, setPublishPlanExitCode] = useState<number | null>(null);
  const [publishPlanError, setPublishPlanError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runSyncSessionIdRef = useRef<string | null>(null);
  const publishPlanSessionIdRef = useRef<string | null>(null);

  const fetchWorkspace = useCallback(async () => {
    if (!id) return;
    try {
      setLoading(true);
      setError(null);
      const [data, localWorkspaces] = await Promise.all([workspacesApi.detail(id), listLocalWorkspaces()]);
      const localWorkspace = localWorkspaces.find((entry) => entry.id === id) ?? null;
      setWorkspace(data);
      setLocalPath(localWorkspace?.path ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspace');
    } finally {
      setLoading(false);
    }
  }, [id]);

  const handleDownloadRecords = useCallback(async () => {
    if (!workspace) {
      return;
    }

    try {
      setDownloading(true);
      const parentFolder = await window.scratchDesktop.pickParentFolder();
      if (!parentFolder) {
        return;
      }

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

  const handleDelete = useCallback(async () => {
    if (!workspace) {
      return;
    }

    const confirmed = window.confirm(
      'This will remove the local files only. The remote repo and remote workspace will stay. Continue?',
    );
    if (!confirmed) {
      return;
    }

    try {
      setDeleting(true);
      await window.scratchDesktop.removeWorkspace(workspace.id);
      setLocalPath(null);
      notifications.show({
        title: 'Local copy deleted',
        message: `${workspace.name || 'Workspace'} was removed from this machine.`,
        color: 'green',
      });
    } catch (err) {
      notifications.show({
        title: 'Delete failed',
        message: err instanceof Error ? err.message : 'Failed to remove local workspace',
        color: 'red',
      });
    } finally {
      setDeleting(false);
    }
  }, [workspace]);

  const handlePushChanges = useCallback(async () => {
    if (!workspace || !localPath) {
      return;
    }

    try {
      setPushing(true);
      await window.scratchDesktop.pushWorkspaceChanges(localPath);
      notifications.show({
        title: 'Upload complete',
        message: `${workspace.name || 'Workspace'} files were uploaded.`,
        color: 'green',
      });
    } catch (err) {
      notifications.show({
        title: 'Upload failed',
        message: err instanceof Error ? err.message : 'Failed to upload files',
        color: 'red',
      });
    } finally {
      setPushing(false);
    }
  }, [localPath, workspace]);

  const handleOpenValidateSyncs = useCallback(async () => {
    if (!localPath) {
      return;
    }

    try {
      setValidateModalOpen(true);
      setLoadingSyncs(true);
      setSyncValidationResults([]);
      const syncs = await window.scratchDesktop.listLocalSyncs(localPath);
      setLocalSyncs(syncs);
      setSelectedSyncs(syncs);
    } catch (err) {
      notifications.show({
        title: 'Could not load syncs',
        message: err instanceof Error ? err.message : 'Failed to list local sync files',
        color: 'red',
      });
    } finally {
      setLoadingSyncs(false);
    }
  }, [localPath]);

  const handleOpenRunSync = useCallback(async () => {
    if (!localPath) {
      return;
    }

    try {
      setRunModalOpen(true);
      setLoadingRunSyncs(true);
      setRunSyncOutput('');
      setRunSyncExitCode(null);
      setRunSyncError(null);
      runSyncSessionIdRef.current = null;

      const syncs = await window.scratchDesktop.listLocalSyncs(localPath);
      setRunSyncs(syncs);
      setSelectedRunSync(syncs[0] ?? null);
    } catch (err) {
      notifications.show({
        title: 'Could not load syncs',
        message: err instanceof Error ? err.message : 'Failed to list local sync files',
        color: 'red',
      });
    } finally {
      setLoadingRunSyncs(false);
    }
  }, [localPath]);

  const handleValidateSelectedSyncs = useCallback(async () => {
    if (!localPath || selectedSyncs.length === 0) {
      return;
    }

    try {
      setValidatingSyncs(true);
      const initialResults = selectedSyncs.map((syncName) => ({
        syncName,
        status: 'pending' as const,
        stdout: '',
        stderr: '',
      }));
      setSyncValidationResults(initialResults);

      for (const syncName of selectedSyncs) {
        setSyncValidationResults((current) =>
          current.map((result) => (result.syncName === syncName ? { ...result, status: 'running' } : result)),
        );

        try {
          const output = await window.scratchDesktop.validateLocalSync(localPath, syncName);
          setSyncValidationResults((current) =>
            current.map((result) =>
              result.syncName === syncName
                ? {
                    ...result,
                    status: output.exitCode === 0 ? 'success' : 'error',
                    stdout: output.stdout,
                    stderr: output.stderr,
                  }
                : result,
            ),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Validation failed';
          setSyncValidationResults((current) =>
            current.map((result) =>
              result.syncName === syncName
                ? {
                    ...result,
                    status: 'error',
                    stdout: '',
                    stderr: message,
                  }
                : result,
            ),
          );
        }
      }
    } finally {
      setValidatingSyncs(false);
    }
  }, [localPath, selectedSyncs]);

  const handleRunSelectedSync = useCallback(async () => {
    if (!localPath || !selectedRunSync) {
      return;
    }

    try {
      setStartingRunSync(true);
      setRunningRunSync(true);
      setRunSyncOutput('');
      setRunSyncExitCode(null);
      setRunSyncError(null);
      const { sessionId } = await window.scratchDesktop.startRunLocalSync(localPath, selectedRunSync);
      runSyncSessionIdRef.current = sessionId;
    } catch (err) {
      setRunningRunSync(false);
      setRunSyncError(err instanceof Error ? err.message : 'Failed to start sync');
      notifications.show({
        title: 'Run failed',
        message: err instanceof Error ? err.message : 'Failed to start sync',
        color: 'red',
      });
    } finally {
      setStartingRunSync(false);
    }
  }, [localPath, selectedRunSync]);

  const handleOpenPublishPlan = useCallback(() => {
    setPublishPlanModalOpen(true);
    setPublishPlanOutput('');
    setPublishPlanExitCode(null);
    setPublishPlanError(null);
    publishPlanSessionIdRef.current = null;
  }, []);

  const handleCreatePublishPlan = useCallback(async () => {
    if (!localPath) {
      return;
    }

    try {
      setStartingPublishPlan(true);
      setRunningPublishPlan(true);
      setPublishPlanOutput('');
      setPublishPlanExitCode(null);
      setPublishPlanError(null);
      const { sessionId } = await window.scratchDesktop.startPlanPublish(localPath);
      publishPlanSessionIdRef.current = sessionId;
    } catch (err) {
      setRunningPublishPlan(false);
      setPublishPlanError(err instanceof Error ? err.message : 'Failed to create publish plan');
      notifications.show({
        title: 'Publish plan failed',
        message: err instanceof Error ? err.message : 'Failed to create publish plan',
        color: 'red',
      });
    } finally {
      setStartingPublishPlan(false);
    }
  }, [localPath]);

  useEffect(() => {
    void fetchWorkspace();
  }, [fetchWorkspace]);

  useEffect(() => {
    const unsubscribe = window.scratchDesktop.onCommandEvent((event) => {
      if (runSyncSessionIdRef.current !== event.sessionId) {
        if (publishPlanSessionIdRef.current !== event.sessionId) {
          return;
        }

        if (event.type === 'chunk') {
          setPublishPlanOutput((current) => current + event.chunk);
          return;
        }

        setRunningPublishPlan(false);
        setPublishPlanExitCode(event.exitCode);
        if (event.error) {
          setPublishPlanError(event.error);
        }

        if (event.exitCode === 0) {
          notifications.show({
            title: 'Publish plan complete',
            message: 'The workspace publish plan was created successfully.',
            color: 'green',
          });
        } else {
          notifications.show({
            title: 'Publish plan finished with issues',
            message: event.error || `scratchmd exited with code ${event.exitCode}`,
            color: 'red',
          });
        }
        return;
      }

      if (event.type === 'chunk') {
        setRunSyncOutput((current) => current + event.chunk);
        return;
      }

      setRunningRunSync(false);
      setRunSyncExitCode(event.exitCode);
      if (event.error) {
        setRunSyncError(event.error);
      }

      if (event.exitCode === 0) {
        notifications.show({
          title: 'Sync completed',
          message: 'The local sync run finished successfully.',
          color: 'green',
        });
      } else {
        notifications.show({
          title: 'Sync finished with issues',
          message: event.error || `scratchmd exited with code ${event.exitCode}`,
          color: 'red',
        });
      }
    });

    return unsubscribe;
  }, []);

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
      <Modal
        opened={validateModalOpen}
        onClose={() => {
          if (!validatingSyncs) {
            setValidateModalOpen(false);
          }
        }}
        title="Validate local syncs"
        size="lg"
      >
        <Stack gap="md">
          {loadingSyncs ? (
            <Center py="md">
              <Loader size="sm" />
            </Center>
          ) : localSyncs.length === 0 ? (
            <Text c="dimmed" size="sm">
              No local sync JSON files found in `.scratch/workspace/syncs`.
            </Text>
          ) : (
            <>
              <Stack gap="xs">
                {localSyncs.map((syncName) => (
                  <Checkbox
                    key={syncName}
                    label={syncName}
                    checked={selectedSyncs.includes(syncName)}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setSelectedSyncs((current) =>
                        checked
                          ? current.includes(syncName)
                            ? current
                            : [...current, syncName]
                          : current.filter((value) => value !== syncName),
                      );
                    }}
                  />
                ))}
              </Stack>

              <Group justify="flex-end">
                <Button
                  onClick={() => void handleValidateSelectedSyncs()}
                  loading={validatingSyncs}
                  disabled={selectedSyncs.length === 0}
                >
                  Validate selected
                </Button>
              </Group>
            </>
          )}

          {syncValidationResults.length > 0 && (
            <ScrollArea.Autosize mah={320}>
              <Stack gap="sm">
                {syncValidationResults.map((result) => (
                  <Box key={result.syncName} p="sm" style={{ border: '1px solid var(--mantine-color-gray-3)' }}>
                    <Group justify="space-between" align="flex-start">
                      <Text fw={500} size="sm">
                        {result.syncName}
                      </Text>
                      <Text
                        size="xs"
                        c={result.status === 'error' ? 'red' : result.status === 'success' ? 'green' : 'dimmed'}
                      >
                        {result.status}
                      </Text>
                    </Group>

                    {result.stdout && (
                      <Stack gap={4} mt="xs">
                        <Text size="xs" c="dimmed">
                          stdout
                        </Text>
                        <Code block>{result.stdout}</Code>
                      </Stack>
                    )}

                    {result.stderr && (
                      <Stack gap={4} mt="xs">
                        <Text size="xs" c="dimmed">
                          stderr
                        </Text>
                        <Code block>{result.stderr}</Code>
                      </Stack>
                    )}
                  </Box>
                ))}
              </Stack>
            </ScrollArea.Autosize>
          )}
        </Stack>
      </Modal>

      <Modal
        opened={runModalOpen}
        onClose={() => {
          if (!runningRunSync && !startingRunSync) {
            setRunModalOpen(false);
          }
        }}
        title="Run local sync"
        size="lg"
      >
        <Stack gap="md">
          {runSyncError && (
            <Alert color="red" title="Error">
              {runSyncError}
            </Alert>
          )}

          {loadingRunSyncs ? (
            <Center py="md">
              <Loader size="sm" />
            </Center>
          ) : runSyncs.length === 0 ? (
            <Text c="dimmed" size="sm">
              No local sync JSON files found in `.scratch/workspace/syncs`.
            </Text>
          ) : (
            <>
              <Radio.Group
                value={selectedRunSync ?? ''}
                onChange={(value) => setSelectedRunSync(value)}
                name="run-local-sync"
              >
                <Stack gap="xs">
                  {runSyncs.map((syncName) => (
                    <Radio
                      key={syncName}
                      value={syncName}
                      label={syncName}
                      disabled={runningRunSync || startingRunSync}
                    />
                  ))}
                </Stack>
              </Radio.Group>

              <Group justify="flex-end">
                <Button
                  onClick={() => void handleRunSelectedSync()}
                  loading={startingRunSync}
                  disabled={!selectedRunSync || runningRunSync}
                >
                  Run sync
                </Button>
              </Group>
            </>
          )}

          <LiveCommandOutput
            output={runSyncOutput}
            running={runningRunSync || startingRunSync}
            exitCode={runSyncExitCode}
            emptyMessage="Choose a sync and run it to watch the output stream here."
          />
        </Stack>
      </Modal>

      <Modal
        opened={publishPlanModalOpen}
        onClose={() => {
          if (!runningPublishPlan && !startingPublishPlan) {
            setPublishPlanModalOpen(false);
          }
        }}
        title="Create publish plan"
        size="lg"
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            This will build a publish plan for the full local workspace.
          </Text>

          {publishPlanError && (
            <Alert color="red" title="Error">
              {publishPlanError}
            </Alert>
          )}

          <Group justify="flex-end">
            <Button
              onClick={() => void handleCreatePublishPlan()}
              loading={startingPublishPlan}
              disabled={runningPublishPlan}
            >
              Create publish plan
            </Button>
          </Group>

          <LiveCommandOutput
            output={publishPlanOutput}
            running={runningPublishPlan || startingPublishPlan}
            exitCode={publishPlanExitCode}
            emptyMessage="Run publish plan to watch the workspace-level output here."
          />
        </Stack>
      </Modal>

      <Group gap="sm">
        <ActionIcon variant="subtle" onClick={() => void navigate('/')}>
          <ArrowLeft size={18} />
        </ActionIcon>
        <Title order={2}>{workspace.name || 'Untitled Workspace'}</Title>
      </Group>

      <Group justify="space-between" align="flex-start">
        <Box>
          <Text size="sm" c="dimmed">
            Local copy: {localPath ? `Downloaded at ${localPath}` : 'Not downloaded'}
          </Text>
        </Box>

        {!localPath && (
          <Button onClick={() => void handleDownloadRecords()} loading={downloading}>
            Download
          </Button>
        )}

        {localPath && (
          <Group>
            <Button variant="light" onClick={() => void handleOpenRunSync()}>
              Run sync
            </Button>
            <Button variant="light" onClick={() => void handleOpenValidateSyncs()}>
              Validate syncs
            </Button>
            <Button variant="light" onClick={() => void handleOpenPublishPlan()}>
              Create publish plan
            </Button>
            <Button onClick={() => void handlePushChanges()} loading={pushing}>
              Upload files
            </Button>
            <Button color="red" variant="light" onClick={() => void handleDelete()} loading={deleting}>
              Delete
            </Button>
          </Group>
        )}
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
