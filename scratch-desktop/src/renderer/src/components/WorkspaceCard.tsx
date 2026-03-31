import { Card, Group, Text } from '@mantine/core';
import { useNavigate } from 'react-router-dom';
import { Workspace } from '../types/workspace';

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

export function WorkspaceCard({ workspace }: { workspace: Workspace }) {
  const navigate = useNavigate();
  const folderCount = workspace.dataFolders?.length ?? 0;

  return (
    <Card
      shadow="xs"
      padding="md"
      radius="md"
      withBorder
      style={{ cursor: 'pointer' }}
      onClick={() => void navigate(`/workspace/${workspace.id}`)}
    >
      <Text fw={500} size="sm" lineClamp={1}>
        {workspace.name || 'Untitled Workspace'}
      </Text>
      <Group gap="xs" mt={4}>
        <Text size="xs" c="dimmed">
          {folderCount} {folderCount === 1 ? 'folder' : 'folders'}
        </Text>
      </Group>
      <Text size="xs" c="dimmed" mt={2}>
        Updated {formatRelativeTime(workspace.updatedAt)}
      </Text>
    </Card>
  );
}
