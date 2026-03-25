import type { DirtyFile } from '@/hooks/use-dirty-files';
import type { DataFolder, DataFolderGroup, DataFolderId, WorkbookId } from '@spinner/shared-types';
import { fileMatchesFolder, findDataFolderForFile, getDirtyDataFolderIds } from '../data-folder-helpers';

/** Helper to create a minimal DataFolder with just the fields we need. */
function makeFolder(overrides: Partial<DataFolder> & { id: DataFolderId; path: string | null }): DataFolder {
  return {
    createdAt: '',
    updatedAt: '',
    name: overrides.path?.split('/').pop() ?? '',
    workbookId: 'wkb_test' as WorkbookId,
    connectorAccountId: null,
    connectorDisplayName: null,
    connectorService: null,
    schema: null,
    lastSchemaRefreshAt: null,
    parentId: null,
    lock: null,
    version: 1,
    tableId: [],
    options: null,
    schedules: [],
    ...overrides,
  } as DataFolder;
}

describe('fileMatchesFolder', () => {
  it('matches when folder.path has leading slash and file path does not', () => {
    expect(fileMatchesFolder('/Airtable/Base/Table', 'Airtable/Base/Table/file.json')).toBe(true);
  });

  it('matches when neither path has a leading slash', () => {
    expect(fileMatchesFolder('Airtable/Base/Table', 'Airtable/Base/Table/file.json')).toBe(true);
  });

  it('matches when both paths have a leading slash', () => {
    expect(fileMatchesFolder('/Airtable/Base/Table', '/Airtable/Base/Table/file.json')).toBe(true);
  });

  it('matches when folder path has trailing slash', () => {
    expect(fileMatchesFolder('/Airtable/Base/Table/', 'Airtable/Base/Table/file.json')).toBe(true);
  });

  it('does not match a file in a different folder', () => {
    expect(fileMatchesFolder('/Airtable/Base/Table', 'Airtable/Base/OtherTable/file.json')).toBe(false);
  });

  it('does not match a folder name that is a prefix of another folder name', () => {
    // "/Airtable/Base/Tab" should NOT match "Airtable/Base/Table/file.json"
    expect(fileMatchesFolder('/Airtable/Base/Tab', 'Airtable/Base/Table/file.json')).toBe(false);
  });

  it('does not match the folder path itself (no filename)', () => {
    expect(fileMatchesFolder('/Airtable/Base/Table', 'Airtable/Base/Table')).toBe(false);
  });

  it('matches files in nested subdirectories', () => {
    expect(fileMatchesFolder('/Airtable/Base/Table', 'Airtable/Base/Table/sub/dir/file.json')).toBe(true);
  });

  it('handles Scratch folder paths', () => {
    expect(fileMatchesFolder('/Scratch', 'Scratch/my-note.md')).toBe(true);
  });

  it('handles folder names with spaces', () => {
    expect(fileMatchesFolder('/Airtable/My Base/My Table', 'Airtable/My Base/My Table/record.json')).toBe(true);
  });
});

describe('getDirtyDataFolderIds', () => {
  const folder1 = makeFolder({ id: 'dfd_1' as DataFolderId, path: '/Airtable/Base/Table1' });
  const folder2 = makeFolder({ id: 'dfd_2' as DataFolderId, path: '/Airtable/Base/Table2' });
  const folder3 = makeFolder({ id: 'dfd_3' as DataFolderId, path: '/Webflow/Site/Collection' });

  const groups = [
    {
      name: 'Airtable',
      service: 'AIRTABLE',
      dataFolders: [folder1, folder2],
    },
    {
      name: 'Webflow',
      service: 'WEBFLOW',
      dataFolders: [folder3],
    },
  ] as DataFolderGroup[];

  it('returns folder IDs that have dirty files', () => {
    const dirtyFiles: DirtyFile[] = [
      { path: 'Airtable/Base/Table1/record1.json', status: 'modified' },
      { path: 'Airtable/Base/Table1/record2.json', status: 'added' },
    ];
    expect(getDirtyDataFolderIds(dirtyFiles, groups)).toEqual(['dfd_1']);
  });

  it('returns multiple folder IDs across groups', () => {
    const dirtyFiles: DirtyFile[] = [
      { path: 'Airtable/Base/Table2/record.json', status: 'modified' },
      { path: 'Webflow/Site/Collection/item.json', status: 'deleted' },
    ];
    const ids = getDirtyDataFolderIds(dirtyFiles, groups);
    expect(ids).toContain('dfd_2');
    expect(ids).toContain('dfd_3');
    expect(ids).toHaveLength(2);
  });

  it('returns empty array when no dirty files match', () => {
    const dirtyFiles: DirtyFile[] = [{ path: 'Unknown/folder/file.json', status: 'added' }];
    expect(getDirtyDataFolderIds(dirtyFiles, groups)).toEqual([]);
  });

  it('returns empty array for empty dirty files', () => {
    expect(getDirtyDataFolderIds([], groups)).toEqual([]);
  });

  it('skips folders with null path', () => {
    const nullPathFolder = makeFolder({ id: 'dfd_null' as DataFolderId, path: null });
    const groupsWithNull: DataFolderGroup[] = [{ name: 'Broken', service: null, dataFolders: [nullPathFolder] }];
    const dirtyFiles: DirtyFile[] = [{ path: 'anything/file.json', status: 'modified' }];
    expect(getDirtyDataFolderIds(dirtyFiles, groupsWithNull)).toEqual([]);
  });
});

describe('findDataFolderForFile', () => {
  const folder1 = makeFolder({ id: 'dfd_1' as DataFolderId, path: '/Airtable/Base/Table1' });
  const folder2 = makeFolder({ id: 'dfd_2' as DataFolderId, path: '/Airtable/Base/Table2' });
  const folders = [folder1, folder2];

  it('finds the correct folder for a file', () => {
    expect(findDataFolderForFile(folders, 'Airtable/Base/Table1/record.json')).toBe(folder1);
    expect(findDataFolderForFile(folders, 'Airtable/Base/Table2/record.json')).toBe(folder2);
  });

  it('finds the correct folder when file path has a leading slash', () => {
    expect(findDataFolderForFile(folders, '/Airtable/Base/Table1/record.json')).toBe(folder1);
  });

  it('returns undefined when no folder matches', () => {
    expect(findDataFolderForFile(folders, 'Unknown/folder/file.json')).toBeUndefined();
  });

  it('returns undefined for empty folders list', () => {
    expect(findDataFolderForFile([], 'Airtable/Base/Table1/record.json')).toBeUndefined();
  });

  it('prefers the most specific (longest path) folder', () => {
    const parentFolder = makeFolder({ id: 'dfd_parent' as DataFolderId, path: '/Airtable/Base' });
    const childFolder = makeFolder({ id: 'dfd_child' as DataFolderId, path: '/Airtable/Base/Table1' });
    // Order shouldn't matter — child should win regardless
    expect(findDataFolderForFile([parentFolder, childFolder], 'Airtable/Base/Table1/record.json')).toBe(childFolder);
    expect(findDataFolderForFile([childFolder, parentFolder], 'Airtable/Base/Table1/record.json')).toBe(childFolder);
  });

  it('skips folders with null path', () => {
    const nullFolder = makeFolder({ id: 'dfd_null' as DataFolderId, path: null });
    expect(findDataFolderForFile([nullFolder, folder1], 'Airtable/Base/Table1/record.json')).toBe(folder1);
  });
});
