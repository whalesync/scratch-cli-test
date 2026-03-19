'use client';

import { ButtonPrimarySolid } from '@/app/components/base/buttons';
import { Text13Regular, Text16Regular } from '@/app/components/base/text';
import MainContent from '@/app/components/layouts/MainContent';
import { devToolsApi } from '@/lib/api/dev-tools';
import { SWR_KEYS } from '@/lib/api/keys';
import { Stack, Table } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { ListChecksIcon } from 'lucide-react';
import { useCallback } from 'react';
import useSWR from 'swr';

export default function WaitlistDevPage() {
  const {
    data: pendingUsers,
    isLoading,
    mutate,
  } = useSWR(SWR_KEYS.devTools.waitlistPending(), devToolsApi.getWaitlistPending);

  const handleApprove = useCallback(
    async (userId: string) => {
      try {
        await devToolsApi.approveWaitlistUser(userId);
        notifications.show({ title: 'User approved', message: 'User has been granted access', color: 'green' });
        await mutate();
      } catch {
        notifications.show({ title: 'Error', message: 'Failed to approve user', color: 'red' });
      }
    },
    [mutate],
  );

  return (
    <MainContent>
      <MainContent.BasicHeader title="Waitlist" Icon={ListChecksIcon} />
      <MainContent.Body>
        <Stack>
          <Text16Regular>Users pending waitlist approval</Text16Regular>

          {isLoading && <Text13Regular c="var(--fg-muted)">Loading...</Text13Regular>}

          {!isLoading && (!pendingUsers || pendingUsers.length === 0) && (
            <Text13Regular c="var(--fg-muted)">No pending users</Text13Regular>
          )}

          {pendingUsers && pendingUsers.length > 0 && (
            <Table highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Email</Table.Th>
                  <Table.Th>Created</Table.Th>
                  <Table.Th w="120px" />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {pendingUsers.map((user) => (
                  <Table.Tr key={user.id}>
                    <Table.Td>{user.name || '-'}</Table.Td>
                    <Table.Td>{user.email || '-'}</Table.Td>
                    <Table.Td>{new Date(user.createdAt).toLocaleDateString()}</Table.Td>
                    <Table.Td>
                      <ButtonPrimarySolid size="xs" onClick={() => handleApprove(user.id)}>
                        Approve
                      </ButtonPrimarySolid>
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
