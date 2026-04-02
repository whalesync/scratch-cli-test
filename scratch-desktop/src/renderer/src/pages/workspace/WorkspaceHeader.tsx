import { ButtonPrimaryLight, IconButtonGhost } from '@/components/base/buttons';
import { Text13Medium } from '@/components/base/text';
import { Box, Group } from '@mantine/core';
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
import { ButtonDangerLight, ButtonSecondaryGhost } from '../../components/base/buttons';
import { Workspace } from '../../types/workspace';

interface WorkspaceHeaderProps {
  workspace: Workspace;
  localPath: string | null;
  isDownloaded: boolean;
  downloading: boolean;
  onDownload: () => void;
  deleting: boolean;
  onDelete: () => void;
  onPublishAll: () => void;
}

export function WorkspaceHeader({
  workspace,
  localPath,
  isDownloaded,
  downloading,
  onDownload,
  deleting,
  onDelete,
  onPublishAll,
}: WorkspaceHeaderProps) {
  const navigate = useNavigate();

  return (
    <Group
      h={40}
      pr="xs"
      justify="space-between"
      style={{
        borderBottom: '1px solid var(--fg-divider)',
        flexShrink: 0,
      }}
    >
      {/* Back button + Workspace selector */}
      <Group gap="xs">
        <IconButtonGhost onClick={() => void navigate('/')}>
          <ArrowLeft size={12} />
        </IconButtonGhost>
        <Box style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <Text13Medium>{workspace.name || 'Untitled Workspace'}</Text13Medium>
          <ChevronDown size={14} color="var(--fg-muted)" />
        </Box>
      </Group>

      {/* Action buttons */}
      <Group gap="xs">
        {!isDownloaded && (
          <ButtonPrimaryLight
            size="compact-xs"
            leftSection={<DownloadIcon size={12} />}
            loading={downloading}
            onClick={() => void onDownload()}
          >
            Download
          </ButtonPrimaryLight>
        )}
        <ButtonSecondaryGhost
          size="compact-xs"
          leftSection={<FolderOpen size={12} />}
          disabled={!localPath}
          onClick={() => void (localPath && window.scratchDesktop.showInFolder(localPath))}
        >
          Show in Finder
        </ButtonSecondaryGhost>
        <ButtonSecondaryGhost
          size="compact-xs"
          leftSection={<Terminal size={12} />}
          disabled={!localPath}
          onClick={() => void (localPath && window.scratchDesktop.openInTerminal(localPath))}
        >
          Open in Terminal
        </ButtonSecondaryGhost>
        <ButtonSecondaryGhost size="compact-xs" leftSection={<Download size={12} />}>
          Pull All
        </ButtonSecondaryGhost>
        {isDownloaded && (
          <ButtonSecondaryGhost
            size="compact-xs"
            leftSection={<Upload size={12} />}
            onClick={() => void onPublishAll()}
          >
            Publish All
          </ButtonSecondaryGhost>
        )}
        {isDownloaded && (
          <ButtonDangerLight
            size="compact-xs"
            leftSection={<Trash2 size={12} />}
            loading={deleting}
            onClick={() => void onDelete()}
          >
            Delete Local Copy
          </ButtonDangerLight>
        )}
      </Group>
    </Group>
  );
}
