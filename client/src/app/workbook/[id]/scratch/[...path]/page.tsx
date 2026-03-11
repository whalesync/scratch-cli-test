'use client';

import type { WorkbookId } from '@spinner/shared-types';
import { useParams, useSearchParams } from 'next/navigation';
import { useMemo } from 'react';
import { ScratchFileViewer } from '../../components/MainPane/ScratchFileViewer';

export default function ScratchFilePage() {
  const params = useParams<{ id: string; path: string[] }>();
  const searchParams = useSearchParams();
  const workbookId = params.id as WorkbookId;
  const connectorAccountId = searchParams.get('connectorAccountId') ?? undefined;

  const filePath = useMemo(
    () => params.path?.map((segment) => decodeURIComponent(segment)).join('/') ?? '',
    [params.path],
  );

  return <ScratchFileViewer workbookId={workbookId} filePath={filePath} connectorAccountId={connectorAccountId} />;
}
