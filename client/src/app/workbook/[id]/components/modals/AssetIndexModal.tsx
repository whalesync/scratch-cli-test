'use client';

import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { formatNumber } from '@/utils/helpers';
import { Anchor, Badge, Group, Modal, Pagination, ScrollArea, Table, Text, Title } from '@mantine/core';
import { DataFolderId, WorkbookId } from '@spinner/shared-types';
import { ImageIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import useSWR from 'swr';

interface AssetIndexModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
  dataFolderId: DataFolderId;
}

const PAGE_SIZE = 100;

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
  const [page, setPage] = useState(1);

  const { data, isLoading } = useSWR(
    opened ? SWR_KEYS.publishPlans.assetIndex(workbookId, dataFolderId, page) : null,
    () => scratchApiClient.publish.listAssetIndex(workbookId, { dataFolderId, page, pageSize: PAGE_SIZE }),
  );

  const rows = data?.data;
  const total = data?.total ?? 0;
  const totalPages = data ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : 1;

  // Counts reflect the current page only (the index is paginated); a whole-index
  // aggregate would defeat the pagination this modal exists to provide.
  const expiredCount = useMemo(() => rows?.filter((r) => isExpired(r.urlExpiresAt)).length ?? 0, [rows]);
  const rehostedCount = useMemo(() => rows?.filter((r) => r.rehostedUrl != null).length ?? 0, [rows]);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          <ImageIcon size={18} />
          <Title order={4}>Asset Index</Title>
          <Text size="sm" c="dimmed">
            ({formatNumber(total)} entries)
          </Text>
          {rehostedCount > 0 && (
            <Badge color="teal" size="sm">
              {formatNumber(rehostedCount)} rehosted on page
            </Badge>
          )}
          {expiredCount > 0 && (
            <Badge color="red" size="sm">
              {formatNumber(expiredCount)} expired on page
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
      ) : (
        <>
          {rows?.length === 0 ? (
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
                  {rows?.map((r) => {
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
          {totalPages > 1 && (
            <Group justify="center" mt="sm">
              <Pagination value={page} onChange={setPage} total={totalPages} size="sm" />
            </Group>
          )}
        </>
      )}
    </Modal>
  );
}
