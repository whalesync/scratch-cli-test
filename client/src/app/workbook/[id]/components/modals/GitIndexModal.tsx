'use client';

import type { GitIndexDump } from '@/lib/api/workbook';
import { Badge, Button, Group, Modal, ScrollArea, Stack, Table, Tabs } from '@mantine/core';

interface GitIndexModalProps {
  opened: boolean;
  onClose: () => void;
  data: GitIndexDump | null;
}

export function GitIndexModal({ opened, onClose, data }: GitIndexModalProps) {
  if (!data) return null;

  return (
    <Modal opened={opened} onClose={onClose} title="Git Index" size="xl">
      <Stack>
        <Group>
          <Badge color="blue" variant="light">
            {data.files.length} file{data.files.length !== 1 ? 's' : ''}
          </Badge>
          <Badge color="violet" variant="light">
            {data.references.length} reference{data.references.length !== 1 ? 's' : ''}
          </Badge>
        </Group>

        <Tabs defaultValue="files">
          <Tabs.List>
            <Tabs.Tab value="files">Files</Tabs.Tab>
            <Tabs.Tab value="references">References</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="files" pt="sm">
            <ScrollArea h={400}>
              <Table striped highlightOnHover withTableBorder withColumnBorders fz="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Folder</Table.Th>
                    <Table.Th>Filename</Table.Th>
                    <Table.Th>Remote ID</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.files.map((f, i) => (
                    <Table.Tr key={i}>
                      <Table.Td>{f.folder || '/'}</Table.Td>
                      <Table.Td>{f.filename}</Table.Td>
                      <Table.Td>{f.remoteId ?? '—'}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          </Tabs.Panel>

          <Tabs.Panel value="references" pt="sm">
            <ScrollArea h={400}>
              <Table striped highlightOnHover withTableBorder withColumnBorders fz="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Source</Table.Th>
                    <Table.Th>Target Table</Table.Th>
                    <Table.Th>Target Remote ID</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {data.references.map((r, i) => (
                    <Table.Tr key={i}>
                      <Table.Td>
                        {r.sourceFolder}/{r.sourceFilename}
                      </Table.Td>
                      <Table.Td>{r.targetTableId}</Table.Td>
                      <Table.Td>{r.targetRemoteId}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          </Tabs.Panel>
        </Tabs>

        <Group justify="flex-end" mt="md">
          <Button onClick={onClose}>Close</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
