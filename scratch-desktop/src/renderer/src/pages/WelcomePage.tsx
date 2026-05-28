import { Alert, Box, Center, Group, Loader, Stack } from '@mantine/core';
import { Cloud, Download } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ButtonPrimaryLight } from '../components/base/buttons';
import { Text12Medium, Text12Regular, Text13Regular, Text16Medium, TextTitle1 } from '../components/base/text';
import { ConnectorIcon } from '../components/ConnectorIcon';
import { StyledLucideIcon } from '../components/icons/StyledLucideIcon';
import { getConnectorLogoUrl, useConnectorsMetadata } from '../hooks/use-connectors-metadata';
import { trackCancelPickParentFolder, trackFirstRunDownload } from '../lib/posthog';
import { workspacesApi } from '../lib/workspaces-api';
import { Workspace } from '../types/workspace';

function WorkspaceServiceIcons({ workspace }: { workspace: Workspace }) {
  const { data: connectorsMetadata } = useConnectorsMetadata();
  const services: string[] = [];
  const seen = new Set<string>();
  for (const f of workspace.dataFolders ?? []) {
    const s = f.connectorService;
    if (s && !seen.has(s)) {
      seen.add(s);
      services.push(s);
    }
  }
  if (services.length === 0) return null;
  return (
    <Group gap={6}>
      {services.map((service) => (
        <ConnectorIcon
          key={service}
          connector={service}
          src={getConnectorLogoUrl(connectorsMetadata, service)}
          size={18}
        />
      ))}
    </Group>
  );
}

export function WelcomePage() {
  const navigate = useNavigate();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const workspaces = await workspacesApi.list();
        if (workspaces.length === 0) {
          void navigate('/', { replace: true });
          return;
        }
        setWorkspace(workspaces[0]);
      } catch {
        void navigate('/', { replace: true });
        return;
      }
      setLoading(false);
    })();
  }, [navigate]);

  const handleDownload = useCallback(async () => {
    if (!workspace) return;
    setError(null);
    try {
      const parentFolder = await window.scratchDesktop.pickParentFolder();
      if (!parentFolder) {
        void trackCancelPickParentFolder(workspace.id, 'download');
        return;
      }

      setDownloading(true);
      void trackFirstRunDownload(workspace.id);
      await window.scratchDesktop.initWorkspace(workspace.id, parentFolder);
      void window.scratchPreferences.setCurrentWorkspaceId(workspace.id);
      void navigate(`/workspace/${workspace.id}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed. Check the folder is writable and try again.');
    } finally {
      setDownloading(false);
    }
  }, [workspace, navigate]);

  if (loading || !workspace) {
    return (
      <Center h="100vh">
        <Loader size="sm" />
      </Center>
    );
  }

  const workspaceName = workspace.name || 'Untitled Workspace';

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

        <TextTitle1>Download your workspace</TextTitle1>

        <Text13Regular c="dimmed">
          Scratch keeps <span style={{ fontWeight: 600 }}>{workspaceName}</span> on your computer, powered by our
          servers. Pick a folder to download it into — your agents will work with your data right there.
        </Text13Regular>

        {/* Static workspace card — mirrors CloudWorkspaceCard visual style */}
        <Box
          style={{
            borderRadius: 10,
            padding: '14px 18px',
            background: '#fff',
            border: '1px solid var(--mantine-color-gray-2)',
            boxShadow: '0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04)',
          }}
        >
          <Group justify="space-between" align="center" wrap="nowrap" mb={8}>
            <Text16Medium lineClamp={1} style={{ minWidth: 0 }}>
              {workspaceName}
            </Text16Medium>
            <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
              <StyledLucideIcon Icon={Cloud} size="sm" c="dimmed" />
              <Text12Regular c="dimmed">In the cloud</Text12Regular>
            </Group>
          </Group>
          <WorkspaceServiceIcons workspace={workspace} />
        </Box>

        <ButtonPrimaryLight
          fullWidth
          size="md"
          leftSection={
            downloading ? <Loader size="xs" color="white" /> : <StyledLucideIcon Icon={Download} size="sm" />
          }
          onClick={() => void handleDownload()}
          disabled={downloading}
        >
          {downloading ? 'Downloading\u2026' : 'Choose folder & download'}
        </ButtonPrimaryLight>

        {error && (
          <Alert color="red" variant="light" radius="md">
            {error}
          </Alert>
        )}
      </Stack>
    </Box>
  );
}
