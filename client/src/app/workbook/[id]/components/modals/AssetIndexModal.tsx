'use client';

import { workbookApi } from '@/lib/api/workbook';
import { Anchor, Badge, Group, Modal, ScrollArea, Table, Text, Title } from '@mantine/core';
import { DataFolderId, WorkbookId } from '@spinner/shared-types';
import { ImageIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

interface AssetEntry {
  id: string;
  workbookId: string;
  dataFolderId: string | null;
  service: string;
  remoteAssetId: string;
  url: string | null;
  filename: string | null;
  mimeType: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  altText: string | null;
  mediaType: string | null;
  urlExpiresAt: string | null;
  lastSeenAt: string | null;
  rehostedUrl: string | null;
  rehostedAt: string | null;
  updatedAt: string;
}

interface AssetIndexModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
  dataFolderId: DataFolderId;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function abbreviateUrl(url: string, maxLen = 50): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    const abbrev =
      parsed.host +
      (path.length > maxLen - parsed.host.length ? path.slice(0, maxLen - parsed.host.length) + '...' : path);
    return abbrev;
  } catch {
    return url.length > maxLen ? url.slice(0, maxLen) + '...' : url;
  }
}

function isExpired(urlExpiresAt: string | null): boolean {
  if (!urlExpiresAt) return false;
  return new Date(urlExpiresAt) < new Date();
}

export function AssetIndexModal({ opened, onClose, workbookId, dataFolderId }: AssetIndexModalProps) {
  const [rows, setRows] = useState<AssetEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!opened) return;
    setIsLoading(true);
    workbookApi
      .listAssetIndex(workbookId, dataFolderId)
      .then((data) => setRows(data as AssetEntry[]))
      .catch(console.error)
      .finally(() => setIsLoading(false));
  }, [opened, workbookId, dataFolderId]);

  const expiredCount = useMemo(() => rows.filter((r) => isExpired(r.urlExpiresAt)).length, [rows]);
  const rehostedCount = useMemo(() => rows.filter((r) => r.rehostedUrl != null).length, [rows]);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          <ImageIcon size={18} />
          <Title order={4}>Asset Index</Title>
          <Text size="sm" c="dimmed">
            ({rows.length} entries)
          </Text>
          {rehostedCount > 0 && (
            <Badge color="teal" size="sm">
              {rehostedCount} rehosted
            </Badge>
          )}
          {expiredCount > 0 && (
            <Badge color="red" size="sm">
              {expiredCount} expired
            </Badge>
          )}
        </Group>
      }
      size="95%"
    >
      {isLoading ? (
        <Text size="sm" c="dimmed" ta="center" py="md">
          Loading...
        </Text>
      ) : rows.length === 0 ? (
        <Text size="sm" c="dimmed" ta="center" py="md">
          No assets.
        </Text>
      ) : (
        <ScrollArea h={600}>
          <Table highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th tt="none">Filename</Table.Th>
                <Table.Th tt="none">Field</Table.Th>
                <Table.Th tt="none">Type</Table.Th>
                <Table.Th tt="none">Size</Table.Th>
                <Table.Th tt="none">Dimensions</Table.Th>
                <Table.Th tt="none">URL</Table.Th>
                <Table.Th tt="none">URL Status</Table.Th>
                <Table.Th tt="none">Rehosted</Table.Th>
                <Table.Th tt="none">Last Seen</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((r) => {
                const expired = isExpired(r.urlExpiresAt);
                return (
                  <Table.Tr key={r.id} bg={expired ? 'var(--mantine-color-red-0)' : undefined}>
                    <Table.Td>
                      <Text size="xs" ff="monospace">
                        {r.filename ?? '—'}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" ff="monospace" lineClamp={1} maw={150}>
                        {r.remoteAssetId}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs">{r.mediaType ?? r.mimeType ?? '—'}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs">{r.size != null ? formatBytes(Number(r.size)) : '—'}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs">{r.width != null && r.height != null ? `${r.width}x${r.height}` : '—'}</Text>
                    </Table.Td>
                    <Table.Td>
                      {(() => {
                        const displayUrl = r.rehostedUrl ?? r.url;
                        return displayUrl ? (
                          <Anchor href={displayUrl} target="_blank" size="xs" ff="monospace">
                            {abbreviateUrl(displayUrl)}
                          </Anchor>
                        ) : (
                          <Text size="xs" c="dimmed">
                            —
                          </Text>
                        );
                      })()}
                    </Table.Td>
                    <Table.Td>
                      {r.urlExpiresAt == null ? (
                        <Badge size="xs" color="gray" variant="light">
                          permanent
                        </Badge>
                      ) : expired ? (
                        <Badge size="xs" color="red">
                          expired
                        </Badge>
                      ) : (
                        <Badge size="xs" color="green" variant="light">
                          valid
                        </Badge>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {r.rehostedUrl ? (
                        <Anchor href={r.rehostedUrl} target="_blank" size="xs">
                          <Badge size="xs" color="teal" variant="light">
                            yes
                          </Badge>
                        </Anchor>
                      ) : (
                        <Badge size="xs" color="gray" variant="light">
                          no
                        </Badge>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleString() : '—'}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      )}
    </Modal>
  );
}
