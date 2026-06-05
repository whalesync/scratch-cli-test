import { ButtonPrimaryLight, IconButtonGhost } from '@/components/base/buttons';
import { WorkspaceSwitcher } from '@/components/workspace-switcher';
import { Group, Loader, Tooltip } from '@mantine/core';
import { useViewportSize } from '@mantine/hooks';
import {
  ChevronDown,
  CloudDownload,
  CloudUpload,
  Download,
  HardDriveDownload as DownloadIcon,
  EllipsisVertical,
  ExternalLink,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import logoColor from '../../assets/logo-color.svg';
import { ButtonSecondaryGhost } from '../../components/base/buttons';
import { useDevTools } from '../../hooks/use-dev-tools';
import { Workspace } from '../../types/workspace';

interface WorkspaceHeaderProps {
  workspace: Workspace;
  localPath: string | null;
  isDownloaded: boolean;
  downloading: boolean;
  reDownloading: boolean;
  pullingAll: boolean;
  publishingAll: boolean;
  onDownload: () => void;
  onReDownload: () => void;
  onPublishAll: () => void;
  onPullAll: (mode: 'full' | 'incremental') => void;
  watchingEnabled?: boolean;
  onToggleWatching?: () => void;
}

const isMac = window.electron?.process?.platform === 'darwin';

const RE_DOWNLOAD_TOOLTIP = 'Re-download latest file updates from Scratch Web';
const PULL_ALL_TOOLTIP = 'Pull data from all connected services';
const PUBLISH_ALL_TOOLTIP = 'Publish all pending local changes to connected services';

export function WorkspaceHeader({
  workspace,
  localPath,
  isDownloaded,
  downloading,
  reDownloading,
  pullingAll,
  publishingAll,
  onDownload,
  onReDownload,
  onPublishAll,
  onPullAll,
  watchingEnabled,
  onToggleWatching,
}: WorkspaceHeaderProps) {
  const navigate = useNavigate();
  const { width } = useViewportSize();
  const compact = width > 0 && width < 800;
  const { isDevToolsEnabled } = useDevTools();

  const anyRunning = reDownloading || pullingAll || publishingAll;

  const handleDevMenu = () => {
    window.scratchDesktop.showNativeContextMenu(
      [{ id: 'toggle-watching', label: 'Watching files', checked: !!watchingEnabled }],
      (id) => {
        if (id === 'toggle-watching') onToggleWatching?.();
      },
    );
  };

  const handlePullAllMenu = () => {
    window.scratchDesktop.showNativeContextMenu(
      [
        { id: 'pull-incremental', label: 'Pull recent changes' },
        { id: 'pull-full', label: 'Full refresh' },
      ],
      (id) => {
        if (id === 'pull-incremental') onPullAll('incremental');
        if (id === 'pull-full') onPullAll('full');
      },
    );
  };

  const handleOpenIn = () => {
    if (!localPath) return;
    window.scratchDesktop.showNativeContextMenu(
      [
        { id: 'reveal', label: isMac ? 'Finder' : 'Explorer' },
        { id: 'terminal', label: isMac ? 'Terminal' : 'PowerShell' },
        { id: 'sep', label: '', type: 'separator' },
        { id: 'claude-cowork', label: 'Claude Cowork' },
        { id: 'claude-code', label: 'Claude Code' },
        { id: 'codex', label: 'Codex' },
      ],
      (id) => {
        switch (id) {
          case 'reveal': {
            void window.scratchDesktop.showInFolder(localPath);
            break;
          }

          case 'terminal': {
            void window.scratchDesktop.openInTerminal(localPath);
            break;
          }

          case 'claude-cowork':
          case 'claude-code': {
            const product = id === 'claude-cowork' ? 'cowork' : 'code';
            const prompt = buildAgentPrompt(workspace.name, localPath, 'CLAUDE.md');
            const claudeUrl = `claude://${product}/new?q=${encodeURIComponent(prompt)}&folder=${encodeURIComponent(localPath)}`;
            void window.scratchAuth.openExternal(claudeUrl).catch(() => {
              void window.scratchAuth.openExternal('https://claude.ai/download');
            });
            break;
          }

          case 'codex': {
            // TODO: There's also originUrl that can be used to try to match an existing workspace.
            const prompt = buildAgentPrompt(workspace.name, localPath, 'AGENTS.md');
            const codexUrl = `codex://new?prompt=${encodeURIComponent(prompt)}&path=${encodeURIComponent(localPath)}`;
            void window.scratchAuth.openExternal(codexUrl).catch(() => {
              void window.scratchAuth.openExternal('https://openai.com/codex/');
            });
            break;
          }
        }
      },
    );
  };

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
        {localPath &&
          (compact ? (
            <Tooltip label="Open in...">
              <IconButtonGhost size="compact-xs" onClick={handleOpenIn}>
                <ExternalLink size={12} />
              </IconButtonGhost>
            </Tooltip>
          ) : (
            <ButtonSecondaryGhost size="compact-xs" leftSection={<ExternalLink size={12} />} onClick={handleOpenIn}>
              Open in...
            </ButtonSecondaryGhost>
          ))}
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
            <IconButtonGhost
              size="compact-xs"
              disabled={!isDownloaded || anyRunning}
              onClick={handlePullAllMenu}
              aria-label="Pull all"
            >
              {pullingAll ? <Loader size={12} /> : <CloudDownload size={12} />}
            </IconButtonGhost>
          </Tooltip>
        ) : (
          <Tooltip label={PULL_ALL_TOOLTIP}>
            <ButtonSecondaryGhost
              size="compact-xs"
              leftSection={pullingAll ? <Loader size={12} /> : <CloudDownload size={12} />}
              rightSection={<ChevronDown size={12} />}
              disabled={!isDownloaded || anyRunning}
              onClick={handlePullAllMenu}
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
        {isDevToolsEnabled && localPath && (
          <IconButtonGhost size="compact-xs" c="var(--mantine-color-devTool-9)" onClick={handleDevMenu}>
            <EllipsisVertical size={14} />
          </IconButtonGhost>
        )}
      </Group>
    </Group>
  );
}

function buildAgentPrompt(workspaceName: string | null, localPath: string, agentFile: string): string {
  return `I'm working on my Scratch workspace, "${workspaceName ?? ''}". It is described at \`${localPath}/${agentFile}\`.  `;
}
