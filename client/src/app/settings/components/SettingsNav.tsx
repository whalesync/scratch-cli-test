'use client';

import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { Text12Medium, Text13Regular } from '@/app/components/base/text';
import { useDevTools } from '@/hooks/use-dev-tools';
import { Box, Divider, Stack, UnstyledButton } from '@mantine/core';
import {
  BlocksIcon,
  BookOpenIcon,
  BriefcaseIcon,
  CreditCardIcon,
  DatabaseIcon,
  FolderSyncIcon,
  LayoutGridIcon,
  UserIcon,
  UsersIcon,
  WrenchIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface NavItem {
  id: string;
  label: string;
  icon: typeof UserIcon;
  href: string;
}

const mainNavItems: NavItem[] = [
  {
    id: 'billing',
    label: 'Billing',
    icon: CreditCardIcon,
    href: '/settings/billing',
  },
  {
    id: 'integrations',
    label: 'Integrations',
    icon: BlocksIcon,
    href: '/settings/integrations',
  },
  {
    id: 'user',
    label: 'User',
    icon: UserIcon,
    href: '/settings/user',
  },
];

const devNavItems: NavItem[] = [
  {
    id: 'user-info',
    label: 'User Info',
    icon: WrenchIcon,
    href: '/settings/dev/user-info',
  },
  {
    id: 'users',
    label: 'User Management',
    icon: UsersIcon,
    href: '/settings/dev/users',
  },
  {
    id: 'gallery',
    label: 'Component Gallery',
    icon: LayoutGridIcon,
    href: '/settings/dev/gallery',
  },
  {
    id: 'jobs',
    label: 'Job Manager',
    icon: BriefcaseIcon,
    href: '/settings/dev/jobs',
  },
  {
    id: 'migrations',
    label: 'Migrations',
    icon: DatabaseIcon,
    href: '/settings/dev/migrations',
  },
  {
    id: 'sync-data-folders',
    label: 'Sync Data Folders',
    icon: FolderSyncIcon,
    href: '/settings/dev/sync-data-folders',
  },
  {
    id: 'workbooks',
    label: 'Workbooks Admin',
    icon: BookOpenIcon,
    href: '/settings/dev/workbooks',
  },
];

export function SettingsNav() {
  const pathname = usePathname();
  const { isDevToolsEnabled } = useDevTools();

  const isActive = (item: NavItem) => {
    return pathname === item.href || pathname.startsWith(item.href + '/');
  };

  return (
    <Stack gap={0}>
      {/* Main Settings Section */}
      <Box px="sm" py={6}>
        <Text12Medium c="var(--fg-muted)" style={{ textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Settings
        </Text12Medium>
      </Box>
      {mainNavItems.map((item) => (
        <NavButton key={item.id} item={item} active={isActive(item)} />
      ))}

      {/* Dev Tools Section */}
      {isDevToolsEnabled && (
        <>
          <Divider my="sm" color="var(--fg-divider)" />
          <Box px="sm" py={6}>
            <Text12Medium
              c="var(--mantine-color-devTool-6)"
              style={{ textTransform: 'uppercase', letterSpacing: '0.5px' }}
            >
              Dev Tools
            </Text12Medium>
          </Box>
          {devNavItems.map((item) => (
            <NavButton key={item.id} item={item} active={isActive(item)} isDevTool />
          ))}
        </>
      )}
    </Stack>
  );
}

function NavButton({ item, active, isDevTool = false }: { item: NavItem; active: boolean; isDevTool?: boolean }) {
  const activeColor = isDevTool ? 'var(--mantine-color-devTool-6)' : 'var(--fg-primary)';
  const inactiveColor = isDevTool ? 'var(--mantine-color-devTool-4)' : 'var(--fg-secondary)';

  return (
    <Link href={item.href} style={{ textDecoration: 'none' }}>
      <UnstyledButton
        px="sm"
        py={8}
        style={{
          width: '100%',
          backgroundColor: active ? 'var(--bg-selected)' : 'transparent',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <StyledLucideIcon Icon={item.icon} size="sm" c={active ? activeColor : inactiveColor} />
          <Text13Regular c={active ? activeColor : inactiveColor}>{item.label}</Text13Regular>
        </Box>
      </UnstyledButton>
    </Link>
  );
}
