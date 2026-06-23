import type { WorkbookCluster } from 'src/db/cluster-types';
import { WorkspaceEntity } from '../workspace.entity';

const NOW = new Date('2025-01-01T00:00:00Z');

function folderRow(id: string, recordCount: number): WorkbookCluster.DataFolder {
  return {
    id,
    workbookId: 'wkb_1',
    name: `Folder ${id}`,
    createdAt: NOW,
    updatedAt: NOW,
    connectorAccountId: null,
    connectorService: null,
    connectorAccount: null,
    path: `/${id}`,
    remoteWebUrl: null,
    lock: null,
    version: 1,
    tableId: [],
    isAssetTable: false,
    options: null,
    lastFullPullAt: null,
    lastIncrementalPullAt: null,
    recordCount,
  } as unknown as WorkbookCluster.DataFolder;
}

function workbookRow(dataFolders: WorkbookCluster.DataFolder[] | undefined): WorkbookCluster.Workbook {
  return {
    id: 'wkb_1',
    name: 'Workbook',
    createdAt: NOW,
    updatedAt: NOW,
    version: 2,
    isPendingDelete: false,
    managedBy: null,
    settings: {},
    userId: 'usr_1',
    organizationId: 'org_1',
    dataFolders,
  } as unknown as WorkbookCluster.Workbook;
}

describe('WorkspaceEntity.from — recordCount aggregate', () => {
  it('sums the per-folder recordCount into the workspace total', () => {
    const workspace = WorkspaceEntity.from(workbookRow([folderRow('a', 3), folderRow('b', 5), folderRow('c', 0)]));
    expect(workspace.recordCount).toBe(8);
    expect(workspace.dataFolders?.map((folder) => folder.recordCount)).toEqual([3, 5, 0]);
  });

  it('leaves recordCount undefined when dataFolders are not loaded', () => {
    const workspace = WorkspaceEntity.from(workbookRow(undefined));
    expect(workspace.recordCount).toBeUndefined();
    expect(workspace.dataFolders).toBeUndefined();
  });
});
