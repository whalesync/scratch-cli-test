'use client';

import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { formatNumber } from '@/utils/helpers';
import { Group, Modal, Pagination, ScrollArea, Table, Text, Title } from '@mantine/core';
import { WorkbookId } from '@spinner/shared-types';
import { LinkIcon } from 'lucide-react';
import { useState } from 'react';
import useSWR from 'swr';

interface RefIndexModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
}

const PAGE_SIZE = 100;

export function RefIndexModal({ opened, onClose, workbookId }: RefIndexModalProps) {
  const [page, setPage] = useState(1);

  const { data, isLoading } = useSWR(opened ? SWR_KEYS.publishPlans.refIndex(workbookId, page) : null, () =>
    scratchApiClient.publish.listRefIndex(workbookId, { page, pageSize: PAGE_SIZE }),
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
          <LinkIcon size={18} />
          <Title order={4}>Ref Index</Title>
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
