'use client';

import { workbookApi } from '@/lib/api/workbook';
import { Accordion, Anchor, Badge, Group, Modal, ScrollArea, Table, Text, Title } from '@mantine/core';
import { WorkbookId } from '@spinner/shared-types';
import { ImageIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

interface AssetEntry {
  id: string;
  workbookId: string;
  service: string;
  remoteAssetId: string;
  recordFilePath: string;
  recordRemoteId: string | null;
  fieldPath: string | null;
  assetContext: string;
  url: string | null;
  filename: string | null;
  mimeType: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  mediaType: string | null;
  urlExpiresAt: string | null;
  lastSeenAt: string | null;
  updatedAt: string;
}

interface AssetIndexModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
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
    const abbrev = parsed.host + (path.length > maxLen - parsed.host.length ? path.slice(0, maxLen - parsed.host.length) + '...' : path);
    return abbrev;
  } catch {
    return url.length > maxLen ? url.slice(0, maxLen) + '...' : url;
  }
}

function isExpired(urlExpiresAt: string | null): boolean {
  if (!urlExpiresAt) return false;
  return new Date(urlExpiresAt) < new Date();
}

export function AssetIndexModal({ opened, onClose, workbookId }: AssetIndexModalProps) {
  const [rows, setRows] = useState<AssetEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!opened) return;
    setIsLoading(true);
    workbookApi
      .listAssetIndex(workbookId)
      .then((data) => setRows(data as AssetEntry[]))
      .catch(console.error)
      .finally(() => setIsLoading(false));
  }, [opened, workbookId]);

  const groupedByService = useMemo(() => {
    const groups = new Map<string, AssetEntry[]>();
    for (const row of rows) {
      const existing = groups.get(row.service) ?? [];
      existing.push(row);
      groups.set(row.service, existing);
    }
    return groups;
  }, [rows]);

  const serviceKeys = useMemo(() => [...groupedByService.keys()], [groupedByService]);

  const expiredCount = useMemo(() => rows.filter((r) => isExpired(r.urlExpiresAt)).length, [rows]);

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
          <Accordion multiple defaultValue={serviceKeys} variant="separated">
            {[...groupedByService.entries()].map(([service, assets]) => (
              <Accordion.Item key={service} value={service}>
                <Accordion.Control>
                  <Group gap="xs">
                    <Text size="sm" fw={600}>
                      {service}
                    </Text>
                    <Text size="xs" c="dimmed">
                      ({assets.length})
                    </Text>
                  </Group>
                </Accordion.Control>
                <Accordion.Panel p={0}>
                  <Table highlightOnHover>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th tt="none">Filename</Table.Th>
                        <Table.Th tt="none">Record Path</Table.Th>
                        <Table.Th tt="none">Field</Table.Th>
                        <Table.Th tt="none">Type</Table.Th>
                        <Table.Th tt="none">Size</Table.Th>
                        <Table.Th tt="none">Dimensions</Table.Th>
                        <Table.Th tt="none">URL</Table.Th>
                        <Table.Th tt="none">URL Status</Table.Th>
                        <Table.Th tt="none">Last Seen</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {assets.map((r) => {
                        const expired = isExpired(r.urlExpiresAt);
                        return (
                          <Table.Tr key={r.id} bg={expired ? 'var(--mantine-color-red-0)' : undefined}>
                            <Table.Td>
                              <Text size="xs" ff="monospace">
                                {r.filename ?? '—'}
                              </Text>
                            </Table.Td>
                            <Table.Td>
                              <Text size="xs" ff="monospace">
                                {r.recordFilePath}
                              </Text>
                            </Table.Td>
                            <Table.Td>
                              <Text size="xs" ff="monospace" lineClamp={1} maw={150}>
                                {r.fieldPath ?? '—'}
                              </Text>
                            </Table.Td>
                            <Table.Td>
                              <Text size="xs">{r.mediaType ?? r.mimeType ?? '—'}</Text>
                            </Table.Td>
                            <Table.Td>
                              <Text size="xs">{r.size != null ? formatBytes(Number(r.size)) : '—'}</Text>
                            </Table.Td>
                            <Table.Td>
                              <Text size="xs">
                                {r.width != null && r.height != null ? `${r.width}x${r.height}` : '—'}
                              </Text>
                            </Table.Td>
                            <Table.Td>
                              {r.url ? (
                                <Anchor href={r.url} target="_blank" size="xs" ff="monospace">
                                  {abbreviateUrl(r.url)}
                                </Anchor>
                              ) : (
                                <Text size="xs" c="dimmed">
                                  —
                                </Text>
                              )}
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
                              <Text size="xs" c="dimmed">
                                {r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleString() : '—'}
                              </Text>
                            </Table.Td>
                          </Table.Tr>
                        );
                      })}
                    </Table.Tbody>
                  </Table>
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
        </ScrollArea>
      )}
    </Modal>
  );
}
