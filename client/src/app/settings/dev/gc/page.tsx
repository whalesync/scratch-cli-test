'use client';

import MainContent from '@/app/components/layouts/MainContent';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { Center, Group, Loader, Text } from '@mantine/core';
import { RecycleIcon } from 'lucide-react';
import { GitMaintenancePanel } from './GitMaintenancePanel';

const TITLE = 'Git GC';

/**
 * scratch-git background maintenance (DEV-11316): the on/off switch, what the 60 s loop is doing,
 * and the maintenance DB's tables — repos, runs, ticks, settings. The one-line entry on the Cron
 * Jobs page links here.
 */
export default function GitGcDevPage() {
  const { isAdmin, isLoading: isUserLoading } = useScratchPadUser();

  if (isUserLoading) {
    return (
      <MainContent>
        <MainContent.BasicHeader title={TITLE} Icon={RecycleIcon} />
        <MainContent.Body>
          <Center h="100%">
            <Group>
              <Loader size="sm" />
              <Text>Loading...</Text>
            </Group>
          </Center>
        </MainContent.Body>
      </MainContent>
    );
  }

  if (!isAdmin) {
    return (
      <MainContent>
        <MainContent.BasicHeader title={TITLE} Icon={RecycleIcon} />
        <MainContent.Body>
          <Center h="100%">
            <Text c="red">You do not have permission to view this page. Admin access is required.</Text>
          </Center>
        </MainContent.Body>
      </MainContent>
    );
  }

  return (
    <MainContent>
      <MainContent.BasicHeader title={TITLE} Icon={RecycleIcon} />
      <MainContent.Body>
        <GitMaintenancePanel />
      </MainContent.Body>
    </MainContent>
  );
}
