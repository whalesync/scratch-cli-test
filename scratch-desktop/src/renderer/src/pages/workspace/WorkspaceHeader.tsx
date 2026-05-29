import { ButtonPrimaryLight, IconButtonGhost } from '@/components/base/buttons';
import { WorkspaceSwitcher } from '@/components/workspace-switcher';
import { Group, Loader, Tooltip } from '@mantine/core';
import { useViewportSize } from '@mantine/hooks';
import {
  CloudDownload,
  CloudUpload,
  Download,
  HardDriveDownload as DownloadIcon,
  ExternalLink,
  Eye,
  EyeOff,
  ShieldCheck,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { ValidationStat } from '../../../../shared/validation-types';
import logoColor from '../../assets/logo-color.svg';
import { ButtonSecondaryGhost } from '../../components/base/buttons';
import { useCurrentUser } from '../../hooks/use-current-user';
import { useWorkspaceUiStore } from '../../stores/workspace-ui-store';
import { Workspace } from '../../types/workspace';
import { ValidationStatsDrawer } from './ValidationStatsDrawer';

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
  onPullAll: () => void;
  watchingEnabled?: boolean;
  onToggleWatching?: () => void;
  validationStats?: ValidationStat[];
  validationStatsLoading?: boolean;
}

const isMac = window.electron?.process?.platform === 'darwin';

const RE_DOWNLOAD_TOOLTIP = 'Re-download latest file updates from Scratch Web';
const PULL_ALL_TOOLTIP = 'Pull the latest data from all connected services';
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
  validationStats,
  validationStatsLoading,
}: WorkspaceHeaderProps) {
  const navigate = useNavigate();
  const { user } = useCurrentUser();
  const validateEnabled = useWorkspaceUiStore((s) => s.validateEnabled);
  const setValidateEnabled = useWorkspaceUiStore((s) => s.setValidateEnabled);
  const { width } = useViewportSize();
  const compact = width > 0 && width < 800;

  const anyRunning = reDownloading || pullingAll || publishingAll;

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
        {user?.isAdmin && localPath && (
          <ValidationStatsDrawer
            workspacePath={localPath}
            stats={validationStats}
            statsLoading={validationStatsLoading}
          />
        )}
        {localPath && onToggleWatching !== undefined && (
          <Tooltip
            label={watchingEnabled ? 'Watching files (click to stop)' : 'Not watching files (click to start)'}
            position="bottom"
          >
            <IconButtonGhost size="compact-xs" onClick={() => void onToggleWatching()}>
              {watchingEnabled ? <Eye size={12} /> : <EyeOff size={12} />}
            </IconButtonGhost>
          </Tooltip>
        )}
        {localPath && (
          <Tooltip
            label={validateEnabled ? 'Validation on (click to disable)' : 'Validation off (click to enable)'}
            position="bottom"
          >
            <IconButtonGhost
              size="compact-xs"
              onClick={() => setValidateEnabled(!validateEnabled)}
              c={validateEnabled ? 'blue' : undefined}
            >
              <ShieldCheck size={12} />
            </IconButtonGhost>
          </Tooltip>
        )}
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

function buildAgentPrompt(workspaceName: string | null, localPath: string, agentFile: string): string {
  return `I'm working on my Scratch workspace, "${workspaceName ?? ''}". It is described at \`${localPath}/${agentFile}\`.  `;
}
