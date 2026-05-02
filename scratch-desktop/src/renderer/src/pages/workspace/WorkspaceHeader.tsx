import { ButtonPrimaryLight, IconButtonGhost } from '@/components/base/buttons';
import { WorkspaceSwitcher } from '@/components/workspace-switcher';
import { Group, Tooltip } from '@mantine/core';
import { useViewportSize } from '@mantine/hooks';
import { CloudDownload, CloudUpload, HardDriveDownload as DownloadIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import logoColor from '../../assets/logo-color.svg';
import { ButtonSecondaryGhost } from '../../components/base/buttons';
import { Workspace } from '../../types/workspace';

interface WorkspaceHeaderProps {
  workspace: Workspace;
  isDownloaded: boolean;
  downloading: boolean;
  onDownload: () => void;
  onPublishAll: () => void;
  onPullAll: () => void;
}

export function WorkspaceHeader({
  workspace,
  isDownloaded,
  downloading,
  onDownload,
  onPublishAll,
  onPullAll,
}: WorkspaceHeaderProps) {
  const navigate = useNavigate();
  const { width } = useViewportSize();
  const compact = width > 0 && width < 800;

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
      {/* Back button (logo) + Workspace selector */}
      <Group gap="xs">
        <IconButtonGhost onClick={() => void navigate('/')} px="6" w={48}>
          <img src={logoColor} alt="Scratch" width={32} height={32} />
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
          <Tooltip label="Pull All">
            <IconButtonGhost size="compact-xs" disabled={!isDownloaded} onClick={() => void onPullAll()}>
              <CloudDownload size={12} />
            </IconButtonGhost>
          </Tooltip>
        ) : (
          <ButtonSecondaryGhost
            size="compact-xs"
            leftSection={<CloudDownload size={12} />}
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
                <CloudUpload size={12} />
              </IconButtonGhost>
            </Tooltip>
          ) : (
            <ButtonSecondaryGhost
              size="compact-xs"
              leftSection={<CloudUpload size={12} />}
              onClick={() => void onPublishAll()}
            >
              Publish All
            </ButtonSecondaryGhost>
          ))}
      </Group>
    </Group>
  );
}
