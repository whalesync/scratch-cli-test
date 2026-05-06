'use client';

import { useDataFolders } from '@/hooks/use-data-folders';
import type { WorkbookId } from '@spinner/shared-types';
import { useParams } from 'next/navigation';
import { useMemo } from 'react';
import { FolderViewer } from '../../../components/MainPane/FolderViewer';
import { ReviewFileViewer } from '../../../components/MainPane/ReviewFileViewer';

export default function ReviewFilePage() {
  const params = useParams<{ id: string; connectorAccountId: string; path: string[] }>();
  const workbookId = params.id as WorkbookId;
  const connectorAccountId = decodeURIComponent(params.connectorAccountId);
  const { folders } = useDataFolders(workbookId);

  // Decode the path segments
  const pathSegments = useMemo(() => params.path?.map((segment) => decodeURIComponent(segment)) ?? [], [params.path]);
  const filePath = pathSegments.join('/') || null;

  // Try to match the full URL path against a folder's path, scoped to the
  // connection from the URL — folders from different connections may share
  // the same path (e.g. /Companies under both Affinity and Attio).
  const matchedFolder = useMemo(() => {
    const candidate = '/' + pathSegments.join('/');
    return folders.find((f) => f.path === candidate && f.connectorAccountId === connectorAccountId) ?? null;
  }, [pathSegments, folders, connectorAccountId]);

  // If the full path matches a folder exactly, show folder viewer in review mode
  if (matchedFolder) {
    return (
      <FolderViewer
        workbookId={workbookId}
        folderId={matchedFolder.id}
        folderName={matchedFolder.name}
        mode="review"
        connectorAccountId={matchedFolder.connectorAccountId ?? undefined}
      />
    );
  }

  return <ReviewFileViewer workbookId={workbookId} filePath={filePath} connectorAccountId={connectorAccountId} />;
}
