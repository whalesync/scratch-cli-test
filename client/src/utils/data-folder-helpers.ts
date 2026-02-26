import type { DirtyFile } from '@/hooks/use-dirty-files';
import type { DataFolder, DataFolderGroup, DataFolderId } from '@spinner/shared-types';

/**
 * Strips a leading slash if present.
 * DataFolder.path uses a leading slash (e.g. "/Airtable/Base/Table")
 * while git file paths do not (e.g. "Airtable/Base/Table/file.json").
 */
function stripLeadingSlash(p: string): string {
  return p.startsWith('/') ? p.substring(1) : p;
}

/**
 * Returns true if `filePath` belongs to the given folder,
 * i.e. the file path starts with the folder path as a directory prefix.
 * Handles the leading-slash mismatch between DataFolder.path and git paths.
 */
export function fileMatchesFolder(folderPath: string, filePath: string): boolean {
  const normalizedFolder = stripLeadingSlash(folderPath);
  const normalizedFile = stripLeadingSlash(filePath);
  const prefix = normalizedFolder.endsWith('/') ? normalizedFolder : `${normalizedFolder}/`;
  return normalizedFile.startsWith(prefix);
}

/**
 * Given a list of dirty files and data folder groups, returns the IDs of
 * data folders that contain at least one dirty file.
 */
export function getDirtyDataFolderIds(dirtyFiles: DirtyFile[], dataFolderGroups: DataFolderGroup[]): DataFolderId[] {
  const dataFolderIds: DataFolderId[] = [];
  dataFolderGroups.forEach((group) => {
    group.dataFolders.forEach((folder) => {
      if (folder.path && dirtyFiles.some((file) => fileMatchesFolder(folder.path!, file.path))) {
        dataFolderIds.push(folder.id);
      }
    });
  });

  return dataFolderIds;
}

/** Finds the most specific DataFolder that a file belongs to (longest matching path). */
export function findDataFolderForFile(folders: DataFolder[], filePath: string): DataFolder | undefined {
  let best: DataFolder | undefined;
  for (const folder of folders) {
    if (folder.path && fileMatchesFolder(folder.path, filePath)) {
      if (!best || !best.path || folder.path.length > best.path.length) {
        best = folder;
      }
    }
  }
  return best;
}
