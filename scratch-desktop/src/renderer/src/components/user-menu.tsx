import { Text13Regular } from '@/components/base/text';
import { Group, Menu, UnstyledButton } from '@mantine/core';
import { LogOut, TerminalSquare, UserRound } from 'lucide-react';
import { useCurrentUser } from '../hooks/use-current-user';
import { useAuth } from '../providers/AuthProvider';

export function UserMenu() {
  const { logout } = useAuth();
  const { user } = useCurrentUser();

  return (
    <Menu shadow="md" width={200} position="top-start">
      <Menu.Target>
        <UnstyledButton px="sm" py={8} style={{ width: '100%' }}>
          <Group gap={8} wrap="nowrap">
            <UserRound size={14} color="var(--fg-secondary)" />
            <Text13Regular c="var(--fg-secondary)" truncate>
              {user?.email}
            </Text13Regular>
          </Group>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{user?.email}</Menu.Label>
        <Menu.Divider />
        <Menu.Item
          leftSection={<TerminalSquare size={14} />}
          onClick={() => void window.scratchDesktop.toggleDevTools()}
        >
          Toggle Dev Tools
        </Menu.Item>
        <Menu.Item leftSection={<LogOut size={14} />} onClick={() => void logout()}>
          Sign out
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
