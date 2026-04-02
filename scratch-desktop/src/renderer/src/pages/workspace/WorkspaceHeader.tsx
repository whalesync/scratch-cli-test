import { ActionIcon, Box, Button, Group, Text } from '@mantine/core';
import {
  ArrowLeft,
  ChevronDown,
  Download,
  HardDriveDownload as DownloadIcon,
  FolderOpen,
  Terminal,
  Trash2,
  Upload,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Workspace } from '../../types/workspace';

interface WorkspaceHeaderProps {
  workspace: Workspace;
  isDownloaded: boolean;
  downloading: boolean;
  onDownload: () => void;
  deleting: boolean;
  onDelete: () => void;
}

export function WorkspaceHeader({
  workspace,
  isDownloaded,
  downloading,
  onDownload,
  deleting,
  onDelete,
}: WorkspaceHeaderProps) {
  const navigate = useNavigate();

  return (
    <Group
      h={60}
      px="md"
      justify="space-between"
      style={{
        borderBottom: '1px solid var(--fg-divider)',
        flexShrink: 0,
      }}
    >
      {/* Back button + Workspace selector */}
      <Group gap="sm">
        <ActionIcon variant="subtle" size="sm" onClick={() => void navigate('/')}>
          <ArrowLeft size={16} />
        </ActionIcon>
        <Box style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <Text fw={600} size="sm">
            {workspace.name || 'Untitled Workspace'}
          </Text>
          <ChevronDown size={14} color="var(--fg-muted)" />
        </Box>
      </Group>

      {/* Action buttons */}
      <Group gap="xs">
        {!isDownloaded && (
          <Button
            variant="filled"
            size="xs"
            leftSection={<DownloadIcon size={14} />}
            loading={downloading}
            onClick={() => void onDownload()}
          >
            Download
          </Button>
        )}
        <Button variant="subtle" size="xs" leftSection={<FolderOpen size={14} />}>
          Open in Finder
        </Button>
        <Button variant="subtle" size="xs" leftSection={<Terminal size={14} />}>
          Open in Terminal
        </Button>
        <Button variant="subtle" size="xs" leftSection={<Download size={14} />}>
          Pull All
        </Button>
        <Button variant="subtle" size="xs" leftSection={<Upload size={14} />}>
          Publish All
        </Button>
        {isDownloaded && (
          <Button
            variant="subtle"
            color="red"
            size="xs"
            leftSection={<Trash2 size={14} />}
            loading={deleting}
            onClick={() => void onDelete()}
          >
            Delete Local Copy
          </Button>
        )}
      </Group>
    </Group>
  );
}
