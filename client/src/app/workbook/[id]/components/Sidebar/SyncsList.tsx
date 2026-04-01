'use client';

import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { Text12Medium, Text12Regular } from '@/app/components/base/text';
import { useDevTools } from '@/hooks/use-dev-tools';
import { workbookApi } from '@/lib/api/workbook';
import { useSyncStore } from '@/stores/sync-store';
import { Box, Group, ScrollArea, Stack, Tooltip, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import type { Sync, WorkbookId } from '@spinner/shared-types';
import { ClockIcon, DownloadIcon, GitBranchIcon, PlayIcon, PlusIcon, RefreshCwIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { WhalesyncImportModal } from '../modals/WhalesyncImportModal';

interface SyncsListProps {
  workbookId: WorkbookId;
}

export function SyncsList({ workbookId }: SyncsListProps) {
  const syncs = useSyncStore((state) => state.syncs);
  const activeJobs = useSyncStore((state) => state.activeJobs);
  const fetchSyncs = useSyncStore((state) => state.fetchSyncs);
  const isLoading = useSyncStore((state) => state.isLoading);

  const params = useParams<{ syncId?: string }>();
  const router = useRouter();
  const { isDevToolsEnabled } = useDevTools();
  const [importModalOpened, { open: openImportModal, close: closeImportModal }] = useDisclosure(false);
  const [isPushingToGit, setIsPushingToGit] = useState(false);

  useEffect(() => {
    fetchSyncs(workbookId);
  }, [workbookId, fetchSyncs]);

  const handlePushSyncsToGit = async () => {
    setIsPushingToGit(true);
    try {
      const result = await workbookApi.pushSyncsToGit(workbookId);
      notifications.show({
        title: 'Syncs pushed to git',
        message: `${result.count} sync${result.count !== 1 ? 's' : ''} written to the workbook repo`,
        color: 'green',
      });
    } catch {
      notifications.show({
        title: 'Failed to push syncs',
        message: 'Could not write syncs to git. Please try again.',
        color: 'red',
      });
    } finally {
      setIsPushingToGit(false);
    }
  };

  const handleCreateNew = () => {
    router.push(`/workbook/${workbookId}/syncs/new`);
  };

  if (isLoading && syncs.length === 0) {
    return (
      <Box p="md">
        <Text12Regular c="dimmed">Loading syncs...</Text12Regular>
      </Box>
    );
  }

  return (
    <ScrollArea h="100%" type="auto" offsetScrollbars>
      <Stack gap={0} py="xs">
        {/* Create New Sync button */}
        <UnstyledButton
          onClick={handleCreateNew}
          px="sm"
          py={6}
          style={{
            width: '100%',
            backgroundColor: 'transparent',
          }}
        >
          <Group gap={6} wrap="nowrap">
            <StyledLucideIcon Icon={PlusIcon} size="sm" c="var(--mantine-color-blue-6)" />
            <Text12Regular c="var(--mantine-color-blue-6)">New Sync</Text12Regular>
          </Group>
        </UnstyledButton>

        {/* Deprecated legacy/manual push button (admin-only) */}
        {isDevToolsEnabled && (
          <Tooltip
            label="Deprecated manual action. Normal sync saves already keep the workbook config git repo up to date."
            position="right"
          >
            <UnstyledButton
              onClick={handlePushSyncsToGit}
              disabled={isPushingToGit}
              px="sm"
              py={6}
              style={{ width: '100%', backgroundColor: 'transparent', opacity: isPushingToGit ? 0.5 : 1 }}
            >
              <Group gap={6} wrap="nowrap">
                <StyledLucideIcon Icon={GitBranchIcon} size="sm" c="var(--mantine-color-devTool-9)" />
                <Text12Regular c="var(--mantine-color-devTool-9)">
                  {isPushingToGit ? 'Pushing...' : 'Legacy: Push syncs to git'}
                </Text12Regular>
              </Group>
            </UnstyledButton>
          </Tooltip>
        )}

        {/* Import from Whalesync button (admin-only) */}
        {isDevToolsEnabled && (
          <UnstyledButton
            onClick={openImportModal}
            px="sm"
            py={6}
            style={{ width: '100%', backgroundColor: 'transparent' }}
          >
            <Group gap={6} wrap="nowrap">
              <StyledLucideIcon Icon={DownloadIcon} size="sm" c="var(--mantine-color-devTool-9)" />
              <Text12Regular c="var(--mantine-color-devTool-9)">Import from Whalesync</Text12Regular>
            </Group>
          </UnstyledButton>
        )}

        {/* Divider */}
        {syncs.length > 0 && <Box my="xs" mx="sm" style={{ borderBottom: '1px solid var(--fg-divider)' }} />}

        {/* Sync list */}
        {syncs.map((sync) => (
          <SyncItem
            key={sync.id}
            sync={sync}
            workbookId={workbookId}
            isActive={params.syncId === sync.id}
            isRunning={!!activeJobs[sync.id]}
          />
        ))}

        {/* Empty state */}
        {syncs.length === 0 && (
          <Box p="md">
            <Text12Regular c="dimmed">No syncs configured yet</Text12Regular>
          </Box>
        )}
      </Stack>

      <WhalesyncImportModal opened={importModalOpened} onClose={closeImportModal} workbookId={workbookId} />
    </ScrollArea>
  );
}

interface SyncItemProps {
  sync: Sync;
  workbookId: WorkbookId;
  isActive: boolean;
  isRunning: boolean;
}

function SyncItem({ sync, workbookId, isActive, isRunning }: SyncItemProps) {
  const runSync = useSyncStore((state) => state.runSync);
  const href = `/workbook/${workbookId}/syncs/${sync.id}`;

  const handleRunSync = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isRunning) {
      runSync(workbookId, sync.id);
    }
  };

  return (
    <Link href={href} style={{ textDecoration: 'none' }}>
      <UnstyledButton
        px="sm"
        py={6}
        style={{
          width: '100%',
          backgroundColor: isActive ? 'var(--bg-selected)' : 'transparent',
          borderLeft: isActive ? '3px solid var(--mantine-primary-color-filled)' : '3px solid transparent',
        }}
      >
        <Group gap={8} wrap="nowrap" justify="space-between">
          {/* Play button */}
          <Tooltip label="Run now" position="top">
            <Box
              onClick={handleRunSync}
              style={{
                padding: 2,
                cursor: isRunning ? 'default' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                opacity: isRunning ? 0.5 : 0.6,
                flexShrink: 0,
              }}
              onMouseOver={(e) => {
                if (!isRunning) (e.currentTarget as HTMLElement).style.opacity = '1';
              }}
              onMouseOut={(e) => {
                (e.currentTarget as HTMLElement).style.opacity = isRunning ? '0.5' : '0.6';
              }}
            >
              {isRunning ? (
                <RefreshCwIcon
                  size={12}
                  style={{ animation: 'spin 1s linear infinite' }}
                  color="var(--mantine-color-blue-6)"
                />
              ) : (
                <PlayIcon size={12} color="var(--fg-muted)" />
              )}
            </Box>
          </Tooltip>

          <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
            <StyledLucideIcon Icon={RefreshCwIcon} size="sm" c="var(--fg-secondary)" />
            <Text12Medium c="var(--fg-primary)" truncate style={{ flex: 1 }}>
              {sync.displayName}
            </Text12Medium>
          </Group>

          {sync.lastSyncTime && (
            <Tooltip label={`Last run: ${new Date(sync.lastSyncTime).toLocaleString()}`} position="right">
              <Group gap={4} wrap="nowrap">
                <ClockIcon size={10} color="var(--fg-muted)" />
                <Text12Regular c="dimmed" style={{ fontSize: 10 }}>
                  {formatRelativeTime(sync.lastSyncTime)}
                </Text12Regular>
              </Group>
            </Tooltip>
          )}
        </Group>
      </UnstyledButton>
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </Link>
  );
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  return `${diffDays}d`;
}
