import { ConnectorIcon } from '@/components/ConnectorIcon';
import { getConnectorLogoUrl, useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { Badge, Card, Group } from '@mantine/core';
import { useMemo } from 'react';
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
  localFileCount,
  onClick,
}: {
  workspace: Workspace;
  isDownloaded: boolean;
  /** Present when the workspace is downloaded locally; total record files on disk. */
  localFileCount?: number;
  onClick?: () => void;
}) {
  const navigate = useNavigate();
  const { data: connectorsMetadata } = useConnectorsMetadata();
  const folderCount = workspace.dataFolders?.length ?? 0;

  const uniqueConnectorServices = useMemo(() => {
    const folders = workspace.dataFolders ?? [];
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const f of folders) {
      const s = f.connectorService;
      if (s && !seen.has(s)) {
        seen.add(s);
        ordered.push(s);
      }
    }
    return ordered;
  }, [workspace.dataFolders]);

  return (
    <Card
      shadow="xs"
      padding="md"
      radius="md"
      withBorder
      style={{
        cursor: 'pointer',
        borderWidth: 1,
        position: 'relative',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--mantine-color-green-6)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = '';
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
        {isDownloaded && localFileCount !== undefined ? <Text12Regular c="dimmed">·</Text12Regular> : null}
        {isDownloaded && localFileCount !== undefined ? (
          <Text12Regular c="dimmed">
            {localFileCount.toLocaleString()} {localFileCount === 1 ? 'file' : 'files'}
          </Text12Regular>
        ) : null}
      </Group>
      <Group justify="space-between">
        <Text12Regular
          c="dimmed"
          mt={8}
          lineClamp={2}
          style={{
            paddingRight:
              uniqueConnectorServices.length > 0 ? Math.min(uniqueConnectorServices.length * 30 + 8, 160) : undefined,
          }}
        >
          Updated {formatRelativeTime(workspace.updatedAt)}
        </Text12Regular>
        {uniqueConnectorServices.length > 0 ? (
          <>
            <div style={{ height: 32 }} aria-hidden />
            <Group
              gap={6}
              justify="flex-end"
              wrap="wrap"
              style={{
                position: 'absolute',
                right: 'var(--mantine-spacing-md)',
                bottom: 'var(--mantine-spacing-md)',
                maxWidth: 168,
              }}
            >
              {uniqueConnectorServices.map((service) => (
                <ConnectorIcon
                  key={service}
                  connector={service}
                  src={getConnectorLogoUrl(connectorsMetadata, service)}
                />
              ))}
            </Group>
          </>
        ) : null}
      </Group>
    </Card>
  );
}
