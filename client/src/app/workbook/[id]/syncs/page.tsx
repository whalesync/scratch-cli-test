'use client';

import { Text13Regular } from '@/app/components/base/text';
import { useSyncStore } from '@/stores/sync-store';
import { Box } from '@mantine/core';
import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';

export default function SyncsPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const syncs = useSyncStore((state) => state.syncs);

  useEffect(() => {
    if (syncs.length > 0) {
      router.replace(`/workbook/${params.id}/syncs/${syncs[0].id}`);
    }
  }, [syncs, params.id, router]);

  return (
    <Box
      p="xl"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
      }}
    >
      <Text13Regular c="dimmed">Select a sync to configure, or create a new one</Text13Regular>
    </Box>
  );
}
