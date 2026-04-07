'use client';

import { IconButtonToolbar } from '@/app/components/base/buttons';
import { OpenInDesktopButton } from '@/app/components/open-in-desktop-button';
import { Text12Medium, Text12Regular } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { trackToggleDisplayMode } from '@/lib/posthog';
import { useLayoutManagerStore } from '@/stores/layout-manager-store';
import { Box, Breadcrumbs, Group, Tooltip, useMantineColorScheme } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { WorkbookId } from '@spinner/shared-types';
import { BugIcon, ChevronRightIcon, MoonIcon, SunIcon, TerminalIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useMemo } from 'react';
import { ConnectToCLIModal } from '../shared/ConnectToCLIModal';
import { DebugMenu } from './DebugMenu';

function getPageName(pathname: string): { label: string; id: string } {
  const segment = pathname.split('/').at(3);
  if (segment === 'review') return { label: 'Review & Publish', id: 'review' };
  if (segment === 'syncs') return { label: 'Syncs', id: 'syncs' };
  if (segment === 'runs') {
    if (pathname.split('/').at(4) === 'scheduled') return { label: 'Scheduled runs', id: 'runs/scheduled' };
    return { label: 'Recent runs', id: 'runs' };
  }
  return { label: 'Files', id: 'files' };
}

interface ToolbarProps {
  workbookId: string;
}

export function Toolbar({ workbookId }: ToolbarProps) {
  const params = useParams<{ id: string; path?: string[] }>();
  const pathname = usePathname();
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const { user } = useScratchPadUser();
  const openReportABugModal = useLayoutManagerStore((state) => state.openReportABugModal);

  const showBugReport = user?.experimentalFlags?.ENABLE_CREATE_BUG_REPORT;

  const [cliModalOpened, { open: openCLIModal, close: closeCLIModal }] = useDisclosure(false);

  const toggleColorScheme = () => {
    const newScheme = colorScheme === 'light' ? 'dark' : 'light';
    setColorScheme(newScheme);
    trackToggleDisplayMode(newScheme);
  };

  const page = getPageName(pathname);

  const breadcrumbs = useMemo(() => {
    const items: { label: string; href: string }[] = [];

    // Runs sub-pages get a "Runs" parent breadcrumb
    if (page.id === 'runs' || page.id === 'runs/scheduled') {
      items.push({
        label: 'Runs',
        href: `/workbook/${params.id}/runs`,
      });
    }

    const basePath = page.id === 'review' ? 'review' : page.id;
    items.push({
      label: page.label,
      href: `/workbook/${params.id}/${basePath}`,
    });

    if (params.path && params.path.length > 0 && (page.id === 'files' || page.id === 'review')) {
      const pathParts = params.path;

      pathParts.forEach((part, index) => {
        const decodedPart = decodeURIComponent(part);
        const currentPath = pathParts.slice(0, index + 1).join('/');

        items.push({
          label: decodedPart,
          href: `/workbook/${params.id}/${basePath}/${currentPath}`,
        });
      });
    }

    return items;
  }, [page.label, page.id, params.id, params.path]);

  return (
    <Box
      h={40}
      px="sm"
      style={{
        borderBottom: '1px solid var(--fg-divider)',
        backgroundColor: 'var(--bg-selected)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}
    >
      {/* Left: Breadcrumbs */}
      <Group gap="sm">
        <Breadcrumbs
          separator={<StyledLucideIcon Icon={ChevronRightIcon} size="sm" c="var(--fg-muted)" />}
          separatorMargin={4}
        >
          {breadcrumbs.map((item, index) => {
            const isLast = index === breadcrumbs.length - 1;

            if (isLast) {
              return (
                <Text12Medium key={item.href} c="var(--fg-primary)">
                  {item.label}
                </Text12Medium>
              );
            }

            return (
              <Link key={item.href} href={item.href} style={{ textDecoration: 'none' }}>
                <Text12Regular
                  c="var(--fg-secondary)"
                  style={{
                    cursor: 'pointer',
                  }}
                  __vars={{
                    '--hover-color': 'var(--fg-primary)',
                  }}
                >
                  {item.label}
                </Text12Regular>
              </Link>
            );
          })}
        </Breadcrumbs>
      </Group>

      {/* Right: Utility buttons */}
      <Group gap="xs">
        <OpenInDesktopButton />
        <Tooltip label="Connect to CLI" position="bottom">
          <IconButtonToolbar onClick={openCLIModal} aria-label="Connect to CLI">
            <StyledLucideIcon Icon={TerminalIcon} size="sm" />
          </IconButtonToolbar>
        </Tooltip>
        {showBugReport && (
          <Tooltip label="Report a bug" position="bottom">
            <IconButtonToolbar onClick={openReportABugModal} aria-label="Report a bug">
              <StyledLucideIcon Icon={BugIcon} size="sm" />
            </IconButtonToolbar>
          </Tooltip>
        )}
        <Tooltip label={colorScheme === 'light' ? 'Dark mode' : 'Light mode'} position="bottom">
          <IconButtonToolbar onClick={toggleColorScheme} aria-label="Toggle color scheme">
            <StyledLucideIcon Icon={colorScheme === 'light' ? MoonIcon : SunIcon} size="sm" />
          </IconButtonToolbar>
        </Tooltip>
        <DebugMenu workbookId={workbookId as WorkbookId} />
      </Group>

      <ConnectToCLIModal opened={cliModalOpened} onClose={closeCLIModal} workbookId={workbookId} />
    </Box>
  );
}
