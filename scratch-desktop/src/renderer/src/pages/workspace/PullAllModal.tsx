import { PullFoldersModal } from './PullFoldersModal';

interface PullAllModalProps {
  opened: boolean;
  onClose: () => void;
  localPath: string | null;
  workspaceId: string;
  workspaceName?: string | null;
  invalidateWorkspaceLevelData: () => void;
  /** Pull mode for the workspace-wide pull. Defaults to incremental at the call site. */
  pullMode?: 'full' | 'incremental';
}

export function PullAllModal({
  opened,
  onClose,
  localPath,
  workspaceId,
  workspaceName,
  invalidateWorkspaceLevelData,
  pullMode,
}: PullAllModalProps) {
  const modeLabel = pullMode === 'full' ? ' (Full)' : pullMode === 'incremental' ? ' (Incremental)' : '';
  return (
    <PullFoldersModal
      opened={opened}
      onClose={onClose}
      localPath={localPath}
      workspaceId={workspaceId}
      title={`Pull all${modeLabel} — ${workspaceName ?? 'workspace'}`}
      emptyStateMessage="No linked tables found in this workspace."
      invalidateWorkspaceLevelData={invalidateWorkspaceLevelData}
      pullMode={pullMode}
    />
  );
}
