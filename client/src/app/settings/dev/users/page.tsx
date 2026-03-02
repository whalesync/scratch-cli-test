'use client';

import { Badge } from '@/app/components/base/badge';
import { ButtonPrimaryLight } from '@/app/components/base/buttons';
import { Text16Regular } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import MainContent from '@/app/components/layouts/MainContent';
import { useUserDevTools } from '@/hooks/use-user-dev-tools';
import { getBuildFlavor } from '@/utils/build';
import { ActionIcon, Alert, Anchor, CopyButton, Group, Stack, Table, TextInput, Tooltip } from '@mantine/core';
import { AlertCircleIcon, CheckIcon, CopyIcon, HatGlassesIcon, PiggyBankIcon, Search, UsersIcon } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { UserDetailsCard } from './components/UserDetails';
import { clerkUserUrl, posthogPersonUrl } from './utils';

export default function UsersDevPage() {
  const searchParams = useSearchParams();
  const qParam = searchParams.get('q') || '';
  const [searchQuery, setSearchQuery] = useState('');
  const { users, isLoading, error, search, retrieveUserDetails, currentUserDetails, clearCurrentUserDetails } =
    useUserDevTools();

  useEffect(() => {
    if (qParam.trim() && qParam.trim() !== searchQuery) {
      setSearchQuery(qParam.trim());
      search(qParam.trim());
    }
  }, [qParam, search, searchQuery]);

  const handleSearch = () => {
    if (searchQuery.trim()) {
      search(searchQuery.trim());
    }
  };

  const handleKeyPress = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      handleSearch();
    }
  };

  const handleRefreshUserDetails = (userId: string) => {
    retrieveUserDetails(userId);
  };

  const sortedUsers = useMemo(() => {
    if (!users) return [];
    return users.sort((a, b) => {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [users]);

  return (
    <MainContent>
      <MainContent.BasicHeader title="User Management" Icon={UsersIcon} />
      <MainContent.Body>
        <Stack>
          <Text16Regular>Search for users by ID, email, name, or Clerk ID</Text16Regular>

          <Group>
            <TextInput
              placeholder="Enter search query..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              onKeyDown={handleKeyPress}
              disabled={isLoading}
              style={{ flex: 1 }}
            />
            <ButtonPrimaryLight
              onClick={handleSearch}
              leftSection={<StyledLucideIcon Icon={Search} size={16} />}
              loading={isLoading}
              disabled={searchQuery.trim().length < 3}
            >
              Search
            </ButtonPrimaryLight>
          </Group>

          {error && (
            <Alert title="Error" color="red" radius="md" icon={<AlertCircleIcon />}>
              {error.message}
            </Alert>
          )}

          <Group align="flex-start" justify="space-between" wrap="nowrap">
            {users.length > 0 && (
              <Table highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>ID</Table.Th>
                    <Table.Th>Name</Table.Th>
                    {!currentUserDetails && <Table.Th>Clerk</Table.Th>}
                    {!currentUserDetails && <Table.Th>Email</Table.Th>}
                    {!currentUserDetails && <Table.Th>Created</Table.Th>}
                    {!currentUserDetails && <Table.Th w="40px" />}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {sortedUsers.map((user) => (
                    <Table.Tr key={user.id} onClick={() => retrieveUserDetails(user.id)} style={{ cursor: 'pointer' }}>
                      <Table.Td>
                        {user.id}{' '}
                        <CopyButton value={user?.id || ''} timeout={2000}>
                          {({ copied, copy }) => (
                            <Tooltip label={copied ? 'Copied' : `${user?.id}`} withArrow position="right">
                              <ActionIcon color={copied ? 'teal' : 'gray'} variant="subtle" onClick={copy}>
                                {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
                              </ActionIcon>
                            </Tooltip>
                          )}
                        </CopyButton>
                        {user.isAdmin && <Badge>Admin</Badge>}
                      </Table.Td>
                      <Table.Td>{user.name || '-'}</Table.Td>

                      {!currentUserDetails && (
                        <Table.Td>
                          <Group>
                            {user.clerkId}
                            <Anchor
                              href={clerkUserUrl(user.clerkId, getBuildFlavor())}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <StyledLucideIcon Icon={HatGlassesIcon} size={16} />
                            </Anchor>
                          </Group>
                        </Table.Td>
                      )}
                      {!currentUserDetails && (
                        <Table.Td>
                          {user.email || '-'}
                          <CopyButton value={user?.email || ''} timeout={2000}>
                            {({ copied, copy }) => (
                              <Tooltip label={copied ? 'Copied' : `${user?.email}`} withArrow position="right">
                                <ActionIcon color={copied ? 'teal' : 'gray'} variant="subtle" onClick={copy}>
                                  {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
                                </ActionIcon>
                              </Tooltip>
                            )}
                          </CopyButton>
                        </Table.Td>
                      )}
                      {!currentUserDetails && <Table.Td>{new Date(user.createdAt).toLocaleDateString()}</Table.Td>}
                      {!currentUserDetails && (
                        <Table.Td>
                          <Tooltip label="View in PostHog">
                            <Anchor
                              href={posthogPersonUrl(user.id, getBuildFlavor())}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <StyledLucideIcon Icon={PiggyBankIcon} size={16} />
                            </Anchor>
                          </Tooltip>
                        </Table.Td>
                      )}
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
            {currentUserDetails && (
              <Stack miw="60%">
                <UserDetailsCard
                  details={currentUserDetails}
                  onClose={clearCurrentUserDetails}
                  onRefreshUser={handleRefreshUserDetails}
                />
              </Stack>
            )}
          </Group>
        </Stack>
      </MainContent.Body>
    </MainContent>
  );
}
