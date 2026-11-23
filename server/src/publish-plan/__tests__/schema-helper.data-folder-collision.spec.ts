import { DbService } from '../../db/db.service';
import { BaseJsonTableSpec } from '../../remote-service/connectors/types';
import { DataFolderTableSpecStoreService } from '../../workbook/table-spec-store/data-folder-table-spec-store.service';
import type { TableSpecLocation } from '../../workbook/table-spec-store/table-spec-store';
import { SchemaHelperService } from '../schema-helper.service';

/**
 * Regression: a workbook can have two connections that each expose a folder
 * with the same path (e.g. both a GoHighLevel and a generic-api connection
 * have a "/Contacts" table). When building a publish plan for ONE connection,
 * the DataFolder must be resolved for THAT connection — resolving by path
 * alone returns an arbitrary folder, so one connector receives another
 * connector's schema and mis-routes its writes (the original bug: a HighLevel
 * contact create dispatched to the generic-api table id → `POST
 * /objects/GET/records` → 400 "Invalid Key Passed", create silently lost).
 */
describe('SchemaHelperService.getDataFolderInfo — folder-path collision across connections', () => {
  const ghlFolder = { id: 'dfd_ghl', tableId: ['contacts'], connectorAccountId: 'coa_ghl', path: '/Contacts' };
  const genericFolder = {
    id: 'dfd_generic',
    tableId: ['GET', 'https://api.openphone.com/v1/contacts'],
    connectorAccountId: 'coa_generic',
    path: '/Contacts',
  };

  function makeService() {
    // Emulate Prisma `findFirst`: a row is eligible only if it matches every
    // provided filter; the first eligible row wins. With no connectorAccountId
    // filter, BOTH /Contacts folders match and the generic one is returned
    // first — reproducing the original corruption.
    const findFirst = jest.fn(
      ({ where }: { where: { workbookId: string; path: unknown; connectorAccountId?: string } }) => {
        const candidates = [genericFolder, ghlFolder].filter(
          (f) => !where.connectorAccountId || f.connectorAccountId === where.connectorAccountId,
        );
        return Promise.resolve(candidates[0] ?? null);
      },
    );
    const db = { client: { dataFolder: { findFirst } } } as unknown as DbService;

    // Each connection's /Contacts folder has its own stored spec, keyed by the folder id the store receives.
    const tableSpecByDataFolderId = new Map<string, BaseJsonTableSpec>([
      [
        'dfd_ghl',
        { name: 'Contacts', id: { wsId: 'contacts', remoteId: ['contacts'] } } as unknown as BaseJsonTableSpec,
      ],
      [
        'dfd_generic',
        {
          name: 'Contacts',
          id: { wsId: 'contacts', remoteId: ['GET', 'https://api.openphone.com/v1/contacts'] },
        } as unknown as BaseJsonTableSpec,
      ],
    ]);
    const readTableSpec = jest.fn((location: TableSpecLocation) =>
      Promise.resolve(tableSpecByDataFolderId.get(location.dataFolderId) ?? null),
    );
    const dataFolderTableSpecStore = { readTableSpec } as unknown as DataFolderTableSpecStoreService;

    const service = new SchemaHelperService(db, dataFolderTableSpecStore, {} as never, {} as never);
    return { service, findFirst, readTableSpec };
  }

  it('resolves the folder of the connection being published, not an arbitrary same-path folder', async () => {
    const { service, readTableSpec } = makeService();

    // Without connection scoping this returns the generic-api folder (dfd_generic),
    // since both folders share the "/Contacts" path.
    const info = await service.getDataFolderInfo('wkb', 'Contacts', undefined, 'coa_ghl');

    expect(info?.id).toBe('dfd_ghl');
    expect(info?.spec.id.remoteId).toEqual(['contacts']);
    expect(readTableSpec).toHaveBeenCalledWith({
      dataFolderId: 'dfd_ghl',
      connectorAccountId: 'coa_ghl',
      folderPath: '/Contacts',
    });
  });

  it('caches per (connectorAccountId, path) so the two connections do not collide in one build', async () => {
    const { service } = makeService();
    const cache = new Map<string, { id: string; tableId: string[]; spec: BaseJsonTableSpec } | null>();

    const ghl = await service.getDataFolderInfo('wkb', 'Contacts', cache, 'coa_ghl');
    const generic = await service.getDataFolderInfo('wkb', 'Contacts', cache, 'coa_generic');

    expect(ghl?.id).toBe('dfd_ghl');
    expect(generic?.id).toBe('dfd_generic');
    expect(ghl?.spec.id.remoteId).toEqual(['contacts']);
    expect(generic?.spec.id.remoteId).toEqual(['GET', 'https://api.openphone.com/v1/contacts']);
  });
});
