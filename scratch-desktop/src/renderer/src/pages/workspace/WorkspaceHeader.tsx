import { ButtonPrimaryLight, IconButtonGhost } from '@/components/base/buttons';
import { WorkspaceSwitcher } from '@/components/workspace-switcher';
import { Group, Tooltip } from '@mantine/core';
import { useViewportSize } from '@mantine/hooks';
import {
  Download,
  HardDriveDownload as DownloadIcon,
  FolderOpen,
  HomeIcon,
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
  selectedFolderPath: string | null;
  isDownloaded: boolean;
  downloading: boolean;
  onDownload: () => void;
  deleting: boolean;
  onDelete: () => void;
  onPublishAll: () => void;
  onPullAll: () => void;
}

export function WorkspaceHeader({
  workspace,
  localPath,
  selectedFolderPath,
  isDownloaded,
  downloading,
  onDownload,
  deleting,
  onDelete,
  onPublishAll,
  onPullAll,
}: WorkspaceHeaderProps) {
  const navigate = useNavigate();
  const { width } = useViewportSize();
  const compact = width > 0 && width < 800;
  const targetPath = selectedFolderPath ?? localPath;

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
          <HomeIcon size={12} />
        </IconButtonGhost>
        <WorkspaceSwitcher currentWorkspaceId={workspace.id} currentWorkspaceName={workspace.name} />
      </Group>

      {/* Action buttons */}
      <Group gap="xs">
        {!isDownloaded &&
          (compact ? (
            <Tooltip label="Download">
              <IconButtonGhost
                size="compact-xs"
                color="green.8"
                c="green.8"
                loading={downloading}
                onClick={() => void onDownload()}
              >
                <DownloadIcon size={12} />
              </IconButtonGhost>
            </Tooltip>
          ) : (
            <ButtonPrimaryLight
              size="compact-xs"
              leftSection={<DownloadIcon size={12} />}
              loading={downloading}
              onClick={() => void onDownload()}
            >
              Download
            </ButtonPrimaryLight>
          ))}
        {compact ? (
          <Tooltip label="Show in Finder">
            <IconButtonGhost
              size="compact-xs"
              disabled={!targetPath}
              onClick={() => void (targetPath && window.scratchDesktop.showInFolder(targetPath))}
            >
              <FolderOpen size={12} />
            </IconButtonGhost>
          </Tooltip>
        ) : (
          <ButtonSecondaryGhost
            size="compact-xs"
            leftSection={<FolderOpen size={12} />}
            disabled={!targetPath}
            onClick={() => void (targetPath && window.scratchDesktop.showInFolder(targetPath))}
          >
            Show in Finder
          </ButtonSecondaryGhost>
        )}
        {compact ? (
          <Tooltip label="Open in Terminal">
            <IconButtonGhost
              size="compact-xs"
              disabled={!targetPath}
              onClick={() => void (targetPath && window.scratchDesktop.openInTerminal(targetPath))}
            >
              <Terminal size={12} />
            </IconButtonGhost>
          </Tooltip>
        ) : (
          <ButtonSecondaryGhost
            size="compact-xs"
            leftSection={<Terminal size={12} />}
            disabled={!targetPath}
            onClick={() => void (targetPath && window.scratchDesktop.openInTerminal(targetPath))}
          >
            Open in Terminal
          </ButtonSecondaryGhost>
        )}
        {compact ? (
          <Tooltip label="Pull All">
            <IconButtonGhost size="compact-xs" disabled={!isDownloaded} onClick={() => void onPullAll()}>
              <Download size={12} />
            </IconButtonGhost>
          </Tooltip>
        ) : (
          <ButtonSecondaryGhost
            size="compact-xs"
            leftSection={<Download size={12} />}
            disabled={!isDownloaded}
            onClick={() => void onPullAll()}
          >
            Pull All
          </ButtonSecondaryGhost>
        )}
        {isDownloaded &&
          (compact ? (
            <Tooltip label="Publish All">
              <IconButtonGhost size="compact-xs" onClick={() => void onPublishAll()}>
                <Upload size={12} />
              </IconButtonGhost>
            </Tooltip>
          ) : (
            <ButtonSecondaryGhost
              size="compact-xs"
              leftSection={<Upload size={12} />}
              onClick={() => void onPublishAll()}
            >
              Publish All
            </ButtonSecondaryGhost>
          ))}
        {isDownloaded &&
          (compact ? (
            <Tooltip label="Delete Local Copy">
              <IconButtonGhost
                size="compact-xs"
                color="red.6"
                c="red.6"
                loading={deleting}
                onClick={() => void onDelete()}
              >
                <Trash2 size={12} />
              </IconButtonGhost>
            </Tooltip>
          ) : (
            <ButtonDangerLight
              size="compact-xs"
              leftSection={<Trash2 size={12} />}
              loading={deleting}
              onClick={() => void onDelete()}
            >
              Delete Local Copy
            </ButtonDangerLight>
          ))}
      </Group>
    </Group>
  );
}
