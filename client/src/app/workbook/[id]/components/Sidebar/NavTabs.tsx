'use client';

import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { Text12Regular, Text13Regular } from '@/app/components/base/text';
import { useWorkbookActiveJobs } from '@/hooks/use-workbook-active-jobs';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { SWR_KEYS } from '@/lib/api/keys';
import { workbookApi } from '@/lib/api/workbook';
import { isExperimentEnabled } from '@/types/server-entities/users';
import { Badge, Box, Stack, Tooltip, UnstyledButton } from '@mantine/core';
import type { WorkbookId } from '@spinner/shared-types';
import {
  CalendarIcon,
  FolderIcon,
  HistoryIcon,
  RefreshCwIcon,
  RocketIcon,
  ScrollTextIcon,
  SquareIcon,
} from 'lucide-react';
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

  const { user } = useScratchPadUser();
  const publishHistoryEnabled = isExperimentEnabled('ENABLE_PUBLISH_HISTORY', user);
  const { activeJobs } = useWorkbookActiveJobs(workbookId);
  const { data: dirtyStatus } = useSWR(
    SWR_KEYS.dirtyFiles.hasDirty(workbookId),
    () => workbookApi.hasDirtyFiles(workbookId),
    { refreshInterval: 10000 },
  );
  const hasDirty = dirtyStatus?.dirty ?? false;

  const reviewTab = {
    id: 'review',
    label: 'Review & Publish',
    icon: RocketIcon,
    href: `/workbook/${params.id}/review`,
    disabled: false,
  };

  const tabs: NavTab[] = [
    {
      id: 'files',
      label: 'Files',
      icon: FolderIcon,
      href: `/workbook/${params.id}/files`,
      disabled: false,
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
    ...(publishHistoryEnabled
      ? [
          {
            id: 'publish-history',
            label: 'Publish History',
            icon: ScrollTextIcon,
            href: `/workbook/${params.id}/publish-history`,
            disabled: false,
          },
        ]
      : []),
  ];

  const topSegment = pathname.split('/').at(3);
  const isOnRunsPage = topSegment === 'runs';

  const runsSubTabs: NavTab[] = [
    {
      id: 'runs-recent',
      label: 'Recent runs',
      icon: HistoryIcon,
      href: `/workbook/${params.id}/runs`,
    },
    {
      id: 'runs-scheduled',
      label: 'Scheduled runs',
      icon: CalendarIcon,
      href: `/workbook/${params.id}/runs/scheduled`,
    },
  ];

  const isActive = (tab: NavTab) => {
    if (tab.id === 'files') return topSegment === 'files';
    if (tab.id === 'runs-recent') return topSegment === 'runs' && pathname.split('/').at(4) !== 'scheduled';
    if (tab.id === 'runs-scheduled') return topSegment === 'runs' && pathname.split('/').at(4) === 'scheduled';
    return topSegment === tab.id;
  };

  const reviewActive = topSegment === 'review';

  return (
    <Box
      style={{
        borderBottom: '1px solid var(--fg-divider)',
      }}
    >
      <Stack gap={0}>
        {/* Review & Publish tab */}
        <Link href={reviewTab.href} style={{ textDecoration: 'none' }}>
          <UnstyledButton
            px="sm"
            py={8}
            style={{
              width: '100%',
              backgroundColor: reviewActive ? 'var(--bg-selected)' : 'transparent',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
            }}
          >
            <Box style={{ height: 19, display: 'flex', alignItems: 'center' }}>
              <StyledLucideIcon
                Icon={RocketIcon}
                size="sm"
                c={reviewActive ? 'var(--fg-primary)' : 'var(--fg-secondary)'}
              />
            </Box>
            <Box>
              <Text13Regular c={reviewActive ? 'var(--fg-primary)' : 'var(--fg-secondary)'}>
                {reviewTab.label}
              </Text13Regular>
              {hasDirty && (
                <Badge size="sm" variant="filled" color="var(--mantine-color-green-7)" radius="sm" mt={4}>
                  Changes to approve
                </Badge>
              )}
            </Box>
          </UnstyledButton>
        </Link>

        {/* Regular tabs */}
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
            <Box key={tab.id}>
              <Link href={tab.href} style={{ textDecoration: 'none' }}>
                {button}
              </Link>
              {tab.id === 'runs' &&
                isOnRunsPage &&
                runsSubTabs.map((subTab) => {
                  const subActive = isActive(subTab);
                  return (
                    <Link key={subTab.id} href={subTab.href} style={{ textDecoration: 'none' }}>
                      <UnstyledButton
                        px="sm"
                        py={6}
                        pl={36}
                        style={{
                          width: '100%',
                          backgroundColor: subActive ? 'var(--bg-selected)' : 'transparent',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                        }}
                      >
                        <StyledLucideIcon
                          Icon={subTab.icon}
                          size="xs"
                          c={subActive ? 'var(--fg-primary)' : 'var(--fg-secondary)'}
                        />
                        <Text12Regular c={subActive ? 'var(--fg-primary)' : 'var(--fg-secondary)'}>
                          {subTab.label}
                        </Text12Regular>
                      </UnstyledButton>
                    </Link>
                  );
                })}
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
}
