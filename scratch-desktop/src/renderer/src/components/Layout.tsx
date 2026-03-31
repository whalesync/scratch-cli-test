import { useAuth, useUser } from '@clerk/clerk-react';
import { ActionIcon, Avatar, Box, Group, Menu, Text } from '@mantine/core';
import { LogOut } from 'lucide-react';
import { Outlet } from 'react-router-dom';
import { useCurrentUser } from '../hooks/use-current-user';

export function Layout() {
  const { user: clerkUser } = useUser();
  const { signOut } = useAuth();
  const { user } = useCurrentUser();

  return (
    <Box h="100vh" style={{ display: 'flex', flexDirection: 'column' }}>
      <Group
        h={48}
        px="lg"
        justify="space-between"
        style={{ borderBottom: '0.5px solid var(--fg-divider)', flexShrink: 0 }}
      >
        <Text fw={600} size="sm">
          Scratch Desktop
        </Text>

        <Menu shadow="md" width={200} position="bottom-end">
          <Menu.Target>
            <ActionIcon variant="transparent" size="lg">
              <Avatar src={clerkUser?.imageUrl} size={28} radius="xl">
                {(user?.name ?? clerkUser?.firstName)?.charAt(0)}
              </Avatar>
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>{user?.email ?? clerkUser?.primaryEmailAddress?.emailAddress}</Menu.Label>
            <Menu.Divider />
            <Menu.Item leftSection={<LogOut size={14} />} onClick={() => void signOut()}>
              Sign out
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>

      <Box style={{ flex: 1, overflow: 'auto' }}>
        <Outlet />
      </Box>
    </Box>
  );
}
