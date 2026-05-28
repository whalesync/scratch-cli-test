'use client';

import { TextTitle4 } from '@/app/components/base/text';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { isExperimentEnabled } from '@/types/server-entities/users';
import { Box, Stack } from '@mantine/core';
import type { WorkbookId } from '@spinner/shared-types';
import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { PublishPlansList } from '../components/modals/PublishPlansList';

export default function PublishHistoryPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const workbookId = params.id as WorkbookId;
  const { user } = useScratchPadUser();
  const enabled = isExperimentEnabled('ENABLE_PUBLISH_HISTORY', user);

  useEffect(() => {
    if (user && !enabled) {
      router.replace(`/workbook/${params.id}/files`);
    }
  }, [user, enabled, router, params.id]);

  if (!enabled) {
    return null;
  }

  return (
    <Stack gap={0}>
      <Box p="md">
        <TextTitle4>Publish History</TextTitle4>
      </Box>
      <PublishPlansList workbookId={workbookId} showPlanAndRunButton={false} />
    </Stack>
  );
}
