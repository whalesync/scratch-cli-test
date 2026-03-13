'use client';

import { workbookApi } from '@/lib/api/workbook';
import { Group, Modal, ScrollArea, Table, Text, Title } from '@mantine/core';
import { WorkbookId } from '@spinner/shared-types';
import { LinkIcon } from 'lucide-react';
import useSWR from 'swr';

interface RefIndexEntry {
  id: string;
  workbookId: string;
  sourceFilePath: string;
  targetRemoteTableId: string | null;
  targetRemoteId: string | null;
  branch: string;
}

interface RefIndexModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
}

export function RefIndexModal({ opened, onClose, workbookId }: RefIndexModalProps) {
  const { data: rows, isLoading } = useSWR(
    opened ? ['ref-index', workbookId] : null,
    () => workbookApi.listRefIndex(workbookId) as Promise<RefIndexEntry[]>,
  );

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          <LinkIcon size={18} />
          <Title order={4}>Ref Index</Title>
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
                <Table.Th tt="none">sourceFilePath</Table.Th>
                <Table.Th tt="none">targetRemoteTableId</Table.Th>
                <Table.Th tt="none">targetRemoteId</Table.Th>
                <Table.Th tt="none">branch</Table.Th>
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
                        {r.sourceFilePath}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" ff="monospace">
                        {r.targetRemoteTableId ?? '—'}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" ff="monospace">
                        {r.targetRemoteId ?? '—'}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {r.branch}
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
