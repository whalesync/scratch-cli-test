import { ButtonPrimaryLight, IconButtonGhost } from '@/components/base/buttons';
import { WorkspaceSwitcher } from '@/components/workspace-switcher';
import { Group, Loader, Tooltip } from '@mantine/core';
import { useViewportSize } from '@mantine/hooks';
import { CloudDownload, CloudUpload, Download, HardDriveDownload as DownloadIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import logoColor from '../../assets/logo-color.svg';
import { ButtonSecondaryGhost } from '../../components/base/buttons';
import { Workspace } from '../../types/workspace';

interface WorkspaceHeaderProps {
  workspace: Workspace;
  isDownloaded: boolean;
  downloading: boolean;
  reDownloading: boolean;
  pullingAll: boolean;
  publishingAll: boolean;
  onDownload: () => void;
  onReDownload: () => void;
  onPublishAll: () => void;
  onPullAll: () => void;
}

const RE_DOWNLOAD_TOOLTIP = 'Re-download latest file updates from Scratch Web';
const PULL_ALL_TOOLTIP = 'Pull the latest data from all connected services';
const PUBLISH_ALL_TOOLTIP = 'Publish all pending local changes to connected services';

export function WorkspaceHeader({
  workspace,
  isDownloaded,
  downloading,
  reDownloading,
  pullingAll,
  publishingAll,
  onDownload,
  onReDownload,
  onPublishAll,
  onPullAll,
}: WorkspaceHeaderProps) {
  const navigate = useNavigate();
  const { width } = useViewportSize();
  const compact = width > 0 && width < 800;

  const anyRunning = reDownloading || pullingAll || publishingAll;

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
        {isDownloaded &&
          (compact ? (
            <Tooltip label={RE_DOWNLOAD_TOOLTIP}>
              <IconButtonGhost size="compact-xs" disabled={anyRunning} onClick={() => void onReDownload()}>
                {reDownloading ? <Loader size={12} /> : <Download size={12} />}
              </IconButtonGhost>
            </Tooltip>
          ) : (
            <Tooltip label={RE_DOWNLOAD_TOOLTIP}>
              <ButtonSecondaryGhost
                size="compact-xs"
                leftSection={reDownloading ? <Loader size={12} /> : <Download size={12} />}
                disabled={anyRunning}
                onClick={() => void onReDownload()}
              >
                Re-download files
              </ButtonSecondaryGhost>
            </Tooltip>
          ))}
        {compact ? (
          <Tooltip label={PULL_ALL_TOOLTIP}>
            <IconButtonGhost size="compact-xs" disabled={!isDownloaded || anyRunning} onClick={() => void onPullAll()}>
              {pullingAll ? <Loader size={12} /> : <CloudDownload size={12} />}
            </IconButtonGhost>
          </Tooltip>
        ) : (
          <Tooltip label={PULL_ALL_TOOLTIP}>
            <ButtonSecondaryGhost
              size="compact-xs"
              leftSection={pullingAll ? <Loader size={12} /> : <CloudDownload size={12} />}
              disabled={!isDownloaded || anyRunning}
              onClick={() => void onPullAll()}
            >
              Pull all
            </ButtonSecondaryGhost>
          </Tooltip>
        )}
        {isDownloaded &&
          (compact ? (
            <Tooltip label={PUBLISH_ALL_TOOLTIP}>
              <IconButtonGhost size="compact-xs" disabled={anyRunning} onClick={() => void onPublishAll()}>
                {publishingAll ? <Loader size={12} /> : <CloudUpload size={12} />}
              </IconButtonGhost>
            </Tooltip>
          ) : (
            <Tooltip label={PUBLISH_ALL_TOOLTIP}>
              <ButtonSecondaryGhost
                size="compact-xs"
                leftSection={publishingAll ? <Loader size={12} /> : <CloudUpload size={12} />}
                disabled={anyRunning}
                onClick={() => void onPublishAll()}
              >
                Publish all
              </ButtonSecondaryGhost>
            </Tooltip>
          ))}
      </Group>
    </Group>
  );
}
