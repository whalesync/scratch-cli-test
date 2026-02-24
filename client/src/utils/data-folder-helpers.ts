import type { DirtyFile } from '@/hooks/use-dirty-files';
import type { DataFolder, DataFolderGroup, DataFolderId } from '@spinner/shared-types';

/**
 * Given a list of dirty files and data folder groups, returns the IDs of
 * data folders whose name matches a folder path extracted from the dirty files.
 *
 * NOTE: This is fragile — it breaks if a folder name contains a slash.
 * We should include folder IDs in the dirty file object in the future.
 */
export function getDirtyDataFolderIds(dirtyFiles: DirtyFile[], dataFolderGroups: DataFolderGroup[]): DataFolderId[] {
  const dirtyFolderPaths = new Set<string>();
  dirtyFiles.forEach((file) => {
    const lastIndex = file.path.lastIndexOf('/');
    const folderPath = file.path.substring(0, lastIndex);
    if (folderPath) {
      dirtyFolderPaths.add(folderPath);
    }
  });

  const dataFolderIds: DataFolderId[] = [];
  dataFolderGroups.forEach((group) => {
    group.dataFolders.forEach((folder) => {
      if (folder.path && dirtyFolderPaths.has(folder.path)) {
        dataFolderIds.push(folder.id);
      }
    });
  });

  return dataFolderIds;
}

/** Finds the DataFolder that a file belongs to by matching its parent path. */
export function findDataFolderForFile(folders: DataFolder[], filePath: string): DataFolder | undefined {
  const lastIndex = filePath.lastIndexOf('/');
  const folderPath = lastIndex === -1 ? '' : filePath.substring(0, lastIndex);
  const normalizedFolderPath = folderPath.startsWith('/') ? folderPath.substring(1) : folderPath;

  return folders.find((f) => {
    const fPath = f.path && f.path.startsWith('/') ? f.path.substring(1) : f.path;
    return fPath === normalizedFolderPath;
  });
}
