import { IncrementalPullSupport } from '@spinner/shared-types';
import { DataFolderCluster } from '../../../db/cluster-types';
import { DataFolderEntity } from '../data-folder.entity';

/**
 * The container is stored as three scalar columns and reassembled on the wire,
 * so these cover the reassembly and the breadcrumb derived from it.
 */
function makeRow(overrides: Partial<DataFolderCluster.DataFolder> = {}): DataFolderCluster.DataFolder {
  return {
    id: 'dfd_1',
    workbookId: 'wkb_1',
    name: 'Appointments',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    connectorAccountId: 'coa_1',
    connectorService: 'GOOGLE_SHEETS',
    path: '/appointments',
    remoteWebUrl: 'https://docs.google.com/spreadsheets/d/ss_1/edit#gid=7',
    remoteContainerId: 'ss_1',
    remoteContainerName: 'Q3 CRM export',
    remoteContainerWebUrl: 'https://docs.google.com/spreadsheets/d/ss_1/edit',
    lock: null,
    version: 1,
    tableId: ['ss_1', '7'],
    isAssetTable: false,
    options: null,
    lastFullPullAt: null,
    lastIncrementalPullAt: null,
    recordCount: 0,
    ...overrides,
  } as unknown as DataFolderCluster.DataFolder;
}

describe('DataFolderEntity remote container', () => {
  it('reassembles the three columns into a container object', () => {
    const entity = new DataFolderEntity(makeRow(), [], IncrementalPullSupport.NOT_SUPPORTED);

    expect(entity.remoteContainer).toEqual({
      id: 'ss_1',
      name: 'Q3 CRM export',
      remoteWebUrl: 'https://docs.google.com/spreadsheets/d/ss_1/edit',
    });
  });

  it('derives the breadcrumb as [container, table]', () => {
    const entity = new DataFolderEntity(makeRow(), [], IncrementalPullSupport.NOT_SUPPORTED);

    expect(entity.remoteBreadcrumb).toEqual(['Q3 CRM export', 'Appointments']);
  });

  it('keeps a container that has a name but no link — the label still renders', () => {
    const entity = new DataFolderEntity(
      makeRow({ remoteContainerWebUrl: null }),
      [],
      IncrementalPullSupport.NOT_SUPPORTED,
    );

    expect(entity.remoteContainer).toEqual({ id: 'ss_1', name: 'Q3 CRM export', remoteWebUrl: null });
    expect(entity.remoteBreadcrumb).toEqual(['Q3 CRM export', 'Appointments']);
  });

  it('reports no container for a folder whose connector reports none', () => {
    const entity = new DataFolderEntity(
      makeRow({ remoteContainerId: null, remoteContainerName: null, remoteContainerWebUrl: null }),
      [],
      IncrementalPullSupport.NOT_SUPPORTED,
    );

    expect(entity.remoteContainer).toBeNull();
    // Breadcrumb degrades to the table alone rather than to an empty array, so a
    // caller can render it unconditionally.
    expect(entity.remoteBreadcrumb).toEqual(['Appointments']);
  });
});
