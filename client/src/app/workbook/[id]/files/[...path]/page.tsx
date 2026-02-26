'use client';

import { useDataFolders } from '@/hooks/use-data-folders';
import type { WorkbookId } from '@spinner/shared-types';
import { useParams } from 'next/navigation';
import { useMemo } from 'react';
import { FileViewer } from '../../components/MainPane/FileViewer';
import { FolderViewer } from '../../components/MainPane/FolderViewer';

/**
 * Files tab with a specific file or folder selected
 * URL patterns:
 * - /workbook/<id>/files/Audienceful/People - shows folder contents (path segments map to DataFolder.path)
 * - /workbook/<id>/files/Audienceful/People/record.json - shows file editor
 */
export default function FileDetailPage() {
  const params = useParams<{ id: string; path: string[] }>();
  const workbookId = params.id as WorkbookId;
  const { folders, isLoading: foldersLoading } = useDataFolders(workbookId);

  // Decode each path segment and rejoin
  const pathSegments = useMemo(() => params.path?.map((segment) => decodeURIComponent(segment)) ?? [], [params.path]);
  const filePath = pathSegments.join('/');

  // Try to match the full URL path against a folder's path.
  // Folder paths in the DB have a leading slash (e.g. "/Audienceful/People"),
  // while URL segments don't, so we prepend "/" when comparing.
  const matchedFolder = useMemo(() => {
    const candidate = '/' + pathSegments.join('/');
    return folders.find((f) => f.path === candidate) ?? null;
  }, [pathSegments, folders]);

  // If the full path matches a folder exactly, show the folder viewer
  if (matchedFolder) {
    return <FolderViewer workbookId={workbookId} folderId={matchedFolder.id} folderName={matchedFolder.name} />;
  }

  // Don't render FileViewer until folders have loaded — the path segments
  // might match a folder, and we'd incorrectly try to read a directory as a file.
  if (foldersLoading) {
    return null;
  }

  // Otherwise show file viewer
  return <FileViewer workbookId={workbookId} filePath={filePath} />;
}
