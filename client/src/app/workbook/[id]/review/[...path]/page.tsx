'use client';

import { useDataFolders } from '@/hooks/use-data-folders';
import type { WorkbookId } from '@spinner/shared-types';
import { useParams } from 'next/navigation';
import { useMemo } from 'react';
import { FolderViewer } from '../../components/MainPane/FolderViewer';
import { ReviewFileViewer } from '../../components/MainPane/ReviewFileViewer';

export default function ReviewFilePage() {
  const params = useParams<{ id: string; path: string[] }>();
  const workbookId = params.id as WorkbookId;
  const { folders } = useDataFolders(workbookId);

  // Decode the path segments
  const pathSegments = useMemo(() => params.path?.map((segment) => decodeURIComponent(segment)) ?? [], [params.path]);
  const filePath = pathSegments.join('/') || null;

  // Try to match the full URL path against a folder's path.
  // Folder paths in the DB have a leading slash (e.g. "/Audienceful/People"),
  // while URL segments don't, so we prepend "/" when comparing.
  const matchedFolder = useMemo(() => {
    const candidate = '/' + pathSegments.join('/');
    return folders.find((f) => f.path === candidate) ?? null;
  }, [pathSegments, folders]);

  // If the full path matches a folder exactly, show folder viewer in review mode
  if (matchedFolder) {
    return (
      <FolderViewer workbookId={workbookId} folderId={matchedFolder.id} folderName={matchedFolder.name} mode="review" />
    );
  }

  return <ReviewFileViewer workbookId={workbookId} filePath={filePath} />;
}
