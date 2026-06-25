import { Text13Regular } from '@/components/base/text';
import { Group, Menu, UnstyledButton } from '@mantine/core';
import { LogOut, Settings, TerminalSquare, UserRound } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useCurrentUser } from '../hooks/use-current-user';
import { useDevTools } from '../hooks/use-dev-tools';
import { trackOpenSettings } from '../lib/posthog';
import { useAuth } from '../providers/AuthProvider';

export function UserMenu() {
  const { logout } = useAuth();
  const { user } = useCurrentUser();
  const { isDevToolsEnabled } = useDevTools();
  const navigate = useNavigate();

  const openSettings = (): void => {
    void trackOpenSettings('billing', 'user_menu');
    void navigate('/settings/billing');
  };

  return (
    <Menu shadow="md" width={200} position="top-start">
      <Menu.Target>
        <UnstyledButton px="sm" py={8}>
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
        <Menu.Item leftSection={<Settings size={14} color="var(--fg-secondary)" />} onClick={openSettings}>
          Settings
        </Menu.Item>
        {isDevToolsEnabled && (
          <Menu.Item
            leftSection={<TerminalSquare size={14} color="var(--mantine-color-devTool-9)" />}
            onClick={() => void window.scratchDesktop.toggleDevTools()}
            c="var(--mantine-color-devTool-9)"
          >
            Toggle Console
          </Menu.Item>
        )}
        <Menu.Item leftSection={<LogOut size={14} />} onClick={() => void logout()}>
          Sign out
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
