'use client';

import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { formatNumber } from '@/utils/helpers';
import { Group, Modal, Pagination, ScrollArea, Table, Text, Title } from '@mantine/core';
import { WorkbookId } from '@spinner/shared-types';
import { DatabaseIcon } from 'lucide-react';
import { useState } from 'react';
import useSWR from 'swr';

interface FileIndexModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
}

const PAGE_SIZE = 100;

export function FileIndexModal({ opened, onClose, workbookId }: FileIndexModalProps) {
  const [page, setPage] = useState(1);

  const { data, isLoading } = useSWR(opened ? SWR_KEYS.publishPlans.fileIndex(workbookId, page) : null, () =>
    scratchApiClient.publish.listFileIndex(workbookId, { page, pageSize: PAGE_SIZE }),
  );

  const rows = data?.data;
  const total = data?.total ?? 0;
  const totalPages = data ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : 1;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          <DatabaseIcon size={18} />
          <Title order={4}>File Index</Title>
          <Text size="sm" c="dimmed">
            ({formatNumber(total)} entries)
          </Text>
        </Group>
      }
      size="90%"
    >
      {isLoading ? (
        <Text size="sm" c="dimmed" ta="center" py="md">
          Loading...
        </Text>
      ) : (
        <>
          <ScrollArea h={500}>
            <Table stickyHeader highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Folder</Table.Th>
                  <Table.Th>Filename</Table.Th>
                  <Table.Th>Record ID</Table.Th>
                  <Table.Th title="Set on create or rename; otherwise refreshed at most once a day while pulls keep seeing the row">
                    Last Seen (±1 day)
                  </Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {!rows?.length ? (
                  <Table.Tr>
                    <Table.Td colSpan={4}>
                      <Text size="sm" c="dimmed" ta="center" py="md">
                        No entries.
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ) : (
                  rows.map((r) => (
                    <Table.Tr key={r.id}>
                      <Table.Td>
                        <Text size="xs" ff="monospace">
                          {r.folderPath}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" ff="monospace">
                          {r.filename}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" ff="monospace">
                          {r.recordId}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed">
                          {r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleString() : '—'}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))
                )}
              </Table.Tbody>
            </Table>
          </ScrollArea>
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
