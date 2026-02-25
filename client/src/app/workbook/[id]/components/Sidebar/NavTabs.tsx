'use client';

import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { Text13Regular } from '@/app/components/base/text';
import { useWorkbookActiveJobs } from '@/hooks/use-workbook-active-jobs';
import { SWR_KEYS } from '@/lib/api/keys';
import { workbookApi } from '@/lib/api/workbook';
import { Badge, Box, Stack, Tooltip, UnstyledButton } from '@mantine/core';
import type { WorkbookId } from '@spinner/shared-types';
import { FolderIcon, PencilIcon, RefreshCwIcon, SquareIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import useSWR from 'swr';

interface NavTab {
  id: string;
  label: string;
  icon: typeof FolderIcon;
  href: string;
  disabled?: boolean;
  badge?: number;
  dot?: boolean;
}

export function NavTabs() {
  const params = useParams<{ id: string }>();
  const pathname = usePathname();
  const workbookId = params.id as WorkbookId;

  const { activeJobs } = useWorkbookActiveJobs(workbookId);
  const { data: dirtyStatus } = useSWR(
    SWR_KEYS.dirtyFiles.hasDirty(workbookId),
    () => workbookApi.hasDirtyFiles(workbookId),
    { refreshInterval: 10000 },
  );
  const hasDirty = dirtyStatus?.dirty ?? false;

  const tabs: NavTab[] = [
    {
      id: 'files',
      label: 'Files',
      icon: FolderIcon,
      href: `/workbook/${params.id}/files`,
      disabled: false,
    },
    {
      id: 'review',
      label: 'Review & Publish',
      icon: PencilIcon,
      href: `/workbook/${params.id}/review`,
      disabled: false,
      dot: hasDirty,
    },
    {
      id: 'syncs',
      label: 'Syncs',
      icon: RefreshCwIcon,
      href: `/workbook/${params.id}/syncs`,
      disabled: false,
    },
    {
      id: 'runs',
      label: 'Runs',
      icon: SquareIcon,
      href: `/workbook/${params.id}/runs`,
      disabled: false,
      badge: activeJobs && activeJobs.length > 0 ? activeJobs.length : undefined,
    },
  ];

  const isActive = (tab: NavTab) => {
    if (tab.id === 'files') {
      return pathname.includes('/files');
    }
    return pathname.includes(`/${tab.id}`);
  };

  return (
    <Box
      py="xs"
      style={{
        borderBottom: '1px solid var(--fg-divider)',
      }}
    >
      <Stack gap={0}>
        {tabs.map((tab) => {
          const active = isActive(tab);

          const button = (
            <UnstyledButton
              key={tab.id}
              disabled={tab.disabled}
              px="sm"
              py={8}
              style={{
                width: '100%',
                backgroundColor: active ? 'var(--bg-selected)' : 'transparent',
                opacity: tab.disabled ? 0.5 : 1,
                cursor: tab.disabled ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <Box style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <StyledLucideIcon Icon={tab.icon} size="sm" c={active ? 'var(--fg-primary)' : 'var(--fg-secondary)'} />
                <Text13Regular c={active ? 'var(--fg-primary)' : 'var(--fg-secondary)'}>{tab.label}</Text13Regular>
              </Box>
              {tab.dot && (
                <Box
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    backgroundColor: 'var(--mantine-color-orange-filled)',
                  }}
                />
              )}
              {tab.badge && (
                <Badge size="sm" variant="filled" color="orange" radius="xl">
                  {tab.badge}
                </Badge>
              )}
            </UnstyledButton>
          );

          if (tab.disabled) {
            return (
              <Tooltip key={tab.id} label="Coming soon" position="right">
                {button}
              </Tooltip>
            );
          }

          return (
            <Link key={tab.id} href={tab.href} style={{ textDecoration: 'none' }}>
              {button}
            </Link>
          );
        })}
      </Stack>
    </Box>
  );
}
