'use client';

import type { WorkbookId } from '@spinner/shared-types';
import { useParams } from 'next/navigation';
import { useMemo } from 'react';
import { ScratchFileViewer } from '../../components/MainPane/ScratchFileViewer';

export default function WorkbookRepoFilePage() {
  const params = useParams<{ id: string; path: string[] }>();
  const workbookId = params.id as WorkbookId;

  const filePath = useMemo(
    () => params.path?.map((segment) => decodeURIComponent(segment)).join('/') ?? '',
    [params.path],
  );

  return <ScratchFileViewer workbookId={workbookId} filePath={filePath} useConfigRepo />;
}
