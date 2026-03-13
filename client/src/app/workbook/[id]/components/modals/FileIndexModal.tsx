'use client';

import { workbookApi } from '@/lib/api/workbook';
import { Group, Modal, ScrollArea, Table, Text, Title } from '@mantine/core';
import { WorkbookId } from '@spinner/shared-types';
import { DatabaseIcon } from 'lucide-react';
import useSWR from 'swr';

interface FileIndexEntry {
  id: string;
  workbookId: string;
  folderPath: string;
  filename: string;
  recordId: string;
  lastSeenAt: string | null;
}

interface FileIndexModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
}

export function FileIndexModal({ opened, onClose, workbookId }: FileIndexModalProps) {
  const { data: rows, isLoading } = useSWR(
    opened ? ['file-index', workbookId] : null,
    () => workbookApi.listFileIndex(workbookId) as Promise<FileIndexEntry[]>,
  );

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          <DatabaseIcon size={18} />
          <Title order={4}>File Index</Title>
          <Text size="sm" c="dimmed">
            ({rows?.length ?? 0} entries)
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
        <ScrollArea h={500}>
          <Table stickyHeader highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Folder</Table.Th>
                <Table.Th>Filename</Table.Th>
                <Table.Th>Record ID</Table.Th>
                <Table.Th>Last Seen</Table.Th>
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
      )}
    </Modal>
  );
}
