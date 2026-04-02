import { Badge, Card, Group } from '@mantine/core';
import { useNavigate } from 'react-router-dom';
import { Workspace } from '../types/workspace';
import { Text12Regular, Text13Medium } from './base/text';

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function WorkspaceCard({
  workspace,
  isDownloaded,
  onClick,
}: {
  workspace: Workspace;
  isDownloaded: boolean;
  onClick?: () => void;
}) {
  const navigate = useNavigate();
  const folderCount = workspace.dataFolders?.length ?? 0;

  return (
    <Card
      shadow="xs"
      padding="md"
      radius="md"
      withBorder
      style={{
        cursor: 'pointer',
        transition: 'border-width 0.15s ease, padding 0.15s ease',
        borderWidth: 1,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderWidth = '2px';
        e.currentTarget.style.padding = 'calc(var(--mantine-spacing-md) - 1px)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderWidth = '1px';
        e.currentTarget.style.padding = 'var(--mantine-spacing-md)';
      }}
      onClick={onClick ?? (() => void navigate(`/workspace/${workspace.id}`))}
    >
      <Group justify="space-between" align="flex-start" gap="sm">
        <Text13Medium lineClamp={1}>{workspace.name || 'Untitled Workspace'}</Text13Medium>
        <Badge color={isDownloaded ? 'green' : 'gray'} variant={isDownloaded ? 'light' : 'outline'}>
          {isDownloaded ? 'Downloaded' : 'Not downloaded'}
        </Badge>
      </Group>
      <Group gap="xs" mt={4}>
        <Text12Regular c="dimmed">
          {folderCount} {folderCount === 1 ? 'folder' : 'folders'}
        </Text12Regular>
      </Group>
      <Text12Regular c="dimmed" mt={2}>
        Updated {formatRelativeTime(workspace.updatedAt)}
      </Text12Regular>
    </Card>
  );
}
