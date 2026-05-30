import { PullFoldersModal } from './PullFoldersModal';

interface PullAllModalProps {
  opened: boolean;
  onClose: () => void;
  localPath: string | null;
  workspaceId: string;
  workspaceName?: string | null;
  invalidateWorkspaceLevelData: () => void;
}

export function PullAllModal({
  opened,
  onClose,
  localPath,
  workspaceId,
  workspaceName,
  invalidateWorkspaceLevelData,
}: PullAllModalProps) {
  return (
    <PullFoldersModal
      opened={opened}
      onClose={onClose}
      localPath={localPath}
      workspaceId={workspaceId}
      title={`Pull all — ${workspaceName ?? 'workspace'}`}
      emptyStateMessage="No linked tables found in this workspace."
      invalidateWorkspaceLevelData={invalidateWorkspaceLevelData}
    />
  );
}
