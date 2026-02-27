'use client';

import MainContent from '@/app/components/layouts/MainContent';
import { useWorkbooks } from '@/hooks/use-workbooks';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { Badge, Button, Center, Group, Loader, Stack, Table, Text, Tooltip } from '@mantine/core';
import { BookOpenIcon } from 'lucide-react';

export default function WorkbooksDevPage() {
  const { isAdmin, isLoading: isUserLoading } = useScratchPadUser();
  const { workbooks, isLoading } = useWorkbooks();

  if (isUserLoading) {
    return (
      <MainContent>
        <MainContent.BasicHeader title="Workbooks Admin" Icon={BookOpenIcon} />
        <MainContent.Body>
          <Center h="100%">
            <Group>
              <Loader size="sm" />
              <Text>Loading...</Text>
            </Group>
          </Center>
        </MainContent.Body>
      </MainContent>
    );
  }

  if (!isAdmin) {
    return (
      <MainContent>
        <MainContent.BasicHeader title="Workbooks Admin" Icon={BookOpenIcon} />
        <MainContent.Body>
          <Center h="100%">
            <Text c="red">You do not have permission to view this page. Admin access is required.</Text>
          </Center>
        </MainContent.Body>
      </MainContent>
    );
  }

  if (isLoading) {
    return (
      <MainContent>
        <MainContent.BasicHeader title="Workbooks Admin" Icon={BookOpenIcon} />
        <MainContent.Body>
          <Center h="100%">
            <Group>
              <Loader size="sm" />
              <Text>Loading workbooks...</Text>
            </Group>
          </Center>
        </MainContent.Body>
      </MainContent>
    );
  }

  return (
    <MainContent>
      <MainContent.BasicHeader title="Workbooks Admin" Icon={BookOpenIcon} />
      <MainContent.Body>
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            {workbooks?.length ?? 0} workbook{workbooks?.length !== 1 ? 's' : ''}
          </Text>
          {!workbooks || workbooks.length === 0 ? (
            <Center h="50vh">
              <Text c="dimmed">No workbooks found</Text>
            </Center>
          ) : (
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>ID</Table.Th>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Version</Table.Th>
                  <Table.Th>Created</Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {workbooks.map((workbook) => (
                  <Table.Tr key={workbook.id}>
                    <Table.Td>
                      <Text size="xs" c="dimmed" style={{ fontFamily: 'monospace' }}>
                        {workbook.id}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{workbook.name ?? '(unnamed)'}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge color={workbook.version === 1 ? 'gray' : 'blue'} variant="outline" size="sm">
                        v{workbook.version}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {new Date(workbook.createdAt).toLocaleDateString()}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Tooltip label="Migration to v2 not yet implemented">
                        <Button size="xs" variant="outline" disabled>
                          → v2
                        </Button>
                      </Tooltip>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Stack>
      </MainContent.Body>
    </MainContent>
  );
}
