import { ButtonPrimaryLight, IconButtonGhost } from '@/components/base/buttons';
import { Text12Medium, Text12Regular } from '@/components/base/text';
import { WorkspaceSwitcher } from '@/components/workspace-switcher';
import { Badge, Group, HoverCard, Indicator, Loader, Stack, Tooltip } from '@mantine/core';
import { useViewportSize } from '@mantine/hooks';
import { Workspace } from '@spinner/shared-types';
import {
  Check,
  ChevronDown,
  CloudDownload,
  CloudUpload,
  Download,
  HardDriveDownload as DownloadIcon,
  EllipsisVertical,
  ExternalLink,
  TriangleAlert,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import logoColor from '../../assets/logo-color.svg';
import { ButtonSecondaryGhost } from '../../components/base/buttons';
import { useDevTools } from '../../hooks/use-dev-tools';
import type { ApprovedPublishConnectionBreakdown } from './review-publish-breakdown';
import type { PullTracker } from './use-pull-tracker';

interface WorkspaceHeaderProps {
  workspace: Workspace;
  localPath: string | null;
  /**
   * The folder the user is currently focused on, as a workspace-relative POSIX
   * path (no leading slash). Its first segment is the connection/service
   * directory. Null when nothing folder-scoped is selected. Used to scope the
   * "Open in Claude/Codex" deep-link prompt to the right service folder.
   */
  selectedFolderRelativePath: string | null;
  isDownloaded: boolean;
  downloading: boolean;
  reDownloading: boolean;
  publishingAll: boolean;
  /**
   * Workspace-wide count of records still needing review (working copy differs
   * from the approved value). These are NOT yet publishable — they gate publish.
   */
  unreviewedCount: number;
  /**
   * Workspace-wide count of records approved but not yet published (an entry in
   * `accepted-patches.json`). This is the "X to update" count surfaced on
   * "Publish all" (DEV-10449).
   */
  approvedPendingPublishCount: number;
  /**
   * Per-connection / per-folder breakdown of the approved-but-unpublished records,
   * shown in the "Publish all" hover popover. Empty when nothing is pending.
   */
  approvedPublishBreakdown: ApprovedPublishConnectionBreakdown[];
  /** Background pull tracker — drives the non-blocking pull-progress pill (DEV-10501). */
  pull: PullTracker;
  /** Reopen the pull-progress detail modal. */
  onShowPullProgress: () => void;
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
  selectedFolderRelativePath,
  isDownloaded,
  downloading,
  reDownloading,
  publishingAll,
  unreviewedCount,
  approvedPendingPublishCount,
  approvedPublishBreakdown,
  pull,
  onShowPullProgress,
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

  const pullingAll = pull.isActive;
  const anyRunning = reDownloading || pullingAll || publishingAll;

  const handleDevMenu = () => {
    window.scratchDesktop.showNativeContextMenu(
      [
        { id: 'toggle-watching', label: 'Watching files', checked: !!watchingEnabled },
        { id: 'sep', label: '', type: 'separator' },
        { id: 'debug', label: 'Debug Viewer' },
      ],
      (id) => {
        if (id === 'toggle-watching') onToggleWatching?.();
        if (id === 'debug') void navigate(`/workspace/${workspace.id}/debug`);
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
            const prompt = buildAgentPrompt(workspace.name, localPath, 'CLAUDE.md', selectedFolderRelativePath);
            const claudeUrl = `claude://${product}/new?q=${encodeURIComponent(prompt)}&folder=${encodeURIComponent(localPath)}`;
            void window.scratchAuth.openExternal(claudeUrl).catch(() => {
              void window.scratchAuth.openExternal('https://claude.ai/download');
            });
            break;
          }

          case 'codex': {
            // TODO: There's also originUrl that can be used to try to match an existing workspace.
            const prompt = buildAgentPrompt(workspace.name, localPath, 'AGENTS.md', selectedFolderRelativePath);
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
        {pull.phase !== 'idle' && <PullProgressPill pull={pull} onClick={onShowPullProgress} />}
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
        {isDownloaded && (
          <>
            {/* "Needs review" signpost — the prior step. These records aren't publishable
                until accepted, so they get their own count distinct from the publish CTA. */}
            {unreviewedCount > 0 && (
              <Tooltip
                label={`${unreviewedCount.toLocaleString()} change${unreviewedCount === 1 ? '' : 's'} still need review before they can be published`}
              >
                <Badge
                  size="sm"
                  radius="sm"
                  styles={{
                    root: {
                      backgroundColor: 'var(--modified-needs-review-bg)',
                      color: 'var(--modified-needs-review-stroke)',
                      textTransform: 'none',
                      fontWeight: 500,
                      cursor: 'default',
                    },
                  }}
                >
                  {compact ? formatHeaderCount(unreviewedCount) : `${formatHeaderCount(unreviewedCount)} to review`}
                </Badge>
              </Tooltip>
            )}
            {/* "Publish all" — carries the pending-to-publish count ("X to update", DEV-10449),
                is promoted to the primary CTA when there's something approved, and reveals a
                per-connection / per-folder breakdown of what it will ship on hover. */}
            <PublishAllControl
              compact={compact}
              publishingAll={publishingAll}
              anyRunning={anyRunning}
              approvedPendingPublishCount={approvedPendingPublishCount}
              approvedPublishBreakdown={approvedPublishBreakdown}
              onPublishAll={onPublishAll}
            />
          </>
        )}
        {isDevToolsEnabled && localPath && (
          <IconButtonGhost size="compact-xs" c="var(--mantine-color-devTool-9)" onClick={handleDevMenu}>
            <EllipsisVertical size={14} />
          </IconButtonGhost>
        )}
      </Group>
    </Group>
  );
}

/** Keep review/publish counts from blowing out the 40px header; cap the display at 999+. */
function formatHeaderCount(count: number): string {
  return count > 999 ? '999+' : String(count);
}

interface PublishAllControlProps {
  compact: boolean;
  publishingAll: boolean;
  anyRunning: boolean;
  approvedPendingPublishCount: number;
  approvedPublishBreakdown: ApprovedPublishConnectionBreakdown[];
  onPublishAll: () => void;
}

/**
 * The header "Publish all" action. Shows the pending-to-publish count, promotes
 * itself to the primary CTA when there's something approved, and — whenever there
 * is — swaps its plain tooltip for a hover popover that breaks the pending changes
 * down by connection and data folder (DEV-10449).
 */
function PublishAllControl({
  compact,
  publishingAll,
  anyRunning,
  approvedPendingPublishCount,
  approvedPublishBreakdown,
  onPublishAll,
}: PublishAllControlProps) {
  const icon = publishingAll ? <Loader size={12} /> : <CloudUpload size={12} />;
  const hasApproved = approvedPendingPublishCount > 0;

  const button = compact ? (
    <Indicator
      label={formatHeaderCount(approvedPendingPublishCount)}
      size={16}
      offset={4}
      disabled={!hasApproved}
      color="var(--highlight-border)"
      styles={{ indicator: { color: 'var(--highlight-text)', fontWeight: 600, fontSize: '10px' } }}
    >
      <IconButtonGhost size="compact-xs" disabled={anyRunning} onClick={() => void onPublishAll()}>
        {icon}
      </IconButtonGhost>
    </Indicator>
  ) : hasApproved ? (
    <ButtonPrimaryLight size="compact-xs" leftSection={icon} disabled={anyRunning} onClick={() => void onPublishAll()}>
      {`Publish all · ${formatHeaderCount(approvedPendingPublishCount)}`}
    </ButtonPrimaryLight>
  ) : (
    <ButtonSecondaryGhost
      size="compact-xs"
      leftSection={icon}
      disabled={anyRunning}
      onClick={() => void onPublishAll()}
    >
      Publish all
    </ButtonSecondaryGhost>
  );

  // Nothing approved → keep the plain explanatory tooltip.
  if (!hasApproved) {
    return <Tooltip label={PUBLISH_ALL_TOOLTIP}>{button}</Tooltip>;
  }

  // Something to publish → reveal the per-connection / per-folder breakdown on hover.
  return (
    <HoverCard width={320} position="bottom-end" withArrow shadow="md" openDelay={120} closeDelay={80}>
      <HoverCard.Target>{button}</HoverCard.Target>
      <HoverCard.Dropdown p="sm">
        <PublishBreakdown total={approvedPendingPublishCount} breakdown={approvedPublishBreakdown} />
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

/** The hover-popover body: total + a connection → data-folder breakdown of what "Publish all" ships. */
function PublishBreakdown({ total, breakdown }: { total: number; breakdown: ApprovedPublishConnectionBreakdown[] }) {
  return (
    <Stack gap="xs">
      <Text12Medium c="var(--fg-primary)">
        {total.toLocaleString()} approved change{total === 1 ? '' : 's'} to publish
      </Text12Medium>
      <Stack gap={10} style={{ maxHeight: 320, overflowY: 'auto' }}>
        {breakdown.map((connection) => (
          <Stack key={connection.connection} gap={2}>
            <Group justify="space-between" gap="sm" wrap="nowrap">
              <Text12Medium c="var(--fg-primary)" truncate>
                {connection.connection}
              </Text12Medium>
              <Text12Regular c="var(--fg-muted)">{connection.total.toLocaleString()}</Text12Regular>
            </Group>
            {connection.folders.map((folder) => (
              <Group key={folder.folderPath} justify="space-between" gap="sm" wrap="nowrap" pl="sm">
                <Text12Regular c="var(--fg-secondary)" truncate>
                  {folder.folderPath}
                </Text12Regular>
                <Text12Regular c="var(--fg-muted)">{folder.count.toLocaleString()}</Text12Regular>
              </Group>
            ))}
          </Stack>
        ))}
      </Stack>
    </Stack>
  );
}

function buildAgentPrompt(
  workspaceName: string | null,
  localPath: string,
  agentFile: string,
  selectedFolderRelativePath: string | null,
): string {
  let prompt = `I'm working on my Scratch workspace, "${workspaceName ?? ''}". It is described at \`${localPath}/${agentFile}\`.  `;

  // When the user opened the agent from a specific folder, scope it to that
  // service folder so it works on the Scratch files there instead of drifting
  // out of scope (e.g. reaching for the browser). The first path segment is the
  // connection/service directory; the full relative path is the table/folder.
  if (selectedFolderRelativePath) {
    const serviceFolderName = selectedFolderRelativePath.split('/')[0];
    prompt +=
      `I opened this from the \`${serviceFolderName}\` service — specifically the \`${selectedFolderRelativePath}\` folder ` +
      `(at \`${localPath}/${selectedFolderRelativePath}\`). Please focus your work on the Scratch files in that folder and ` +
      `stay scoped to the \`${serviceFolderName}\` service unless I tell you otherwise.`;
  }

  return prompt;
}

/**
 * Ambient, non-blocking indicator that a pull is running (or just finished /
 * failed) in the background. Clicking it reopens the detail modal. (DEV-10501)
 */
function PullProgressPill({ pull, onClick }: { pull: PullTracker; onClick: () => void }) {
  const { phase, completedCount, totalCount } = pull;

  let leftSection: ReactNode;
  let label: string;
  let colorProps: { c?: string; color?: string } = {};
  let tooltip = 'Show pull progress';

  if (phase === 'done') {
    leftSection = <Check size={12} />;
    label = 'Pull complete';
    colorProps = { c: 'green.7', color: 'green.7' };
  } else if (phase === 'error' || phase === 'download-error') {
    leftSection = <TriangleAlert size={12} />;
    label = 'Pull failed';
    colorProps = { c: 'red.6', color: 'red.6' };
    tooltip = 'Show pull error';
  } else {
    leftSection = <Loader size={12} />;
    label = totalCount > 0 ? `Pulling… ${completedCount.toLocaleString()}/${totalCount.toLocaleString()}` : 'Pulling…';
  }

  return (
    <Tooltip label={tooltip}>
      <ButtonSecondaryGhost size="compact-xs" leftSection={leftSection} onClick={onClick} {...colorProps}>
        {label}
      </ButtonSecondaryGhost>
    </Tooltip>
  );
}
