import { DbService } from '../../db/db.service';
import { BaseJsonTableSpec } from '../../remote-service/connectors/types';
import { ScratchGitService } from '../../scratch-git/scratch-git.service';
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

    const contactsSpec = {
      name: 'Contacts',
      id: { wsId: 'contacts', remoteId: ['contacts'] },
    } as unknown as BaseJsonTableSpec;
    const scratchGitService = {
      resolveConnectionRepoPath: jest.fn().mockResolvedValue('repo-id'),
      readSchemaFromGit: jest.fn().mockResolvedValue(contactsSpec),
    } as unknown as ScratchGitService;

    const service = new SchemaHelperService(db, scratchGitService, {} as never, {} as never);
    return { service, findFirst };
  }

  it('resolves the folder of the connection being published, not an arbitrary same-path folder', async () => {
    const { service } = makeService();

    // Without connection scoping this returns the generic-api folder (dfd_generic),
    // since both folders share the "/Contacts" path.
    const info = await service.getDataFolderInfo('wkb', 'Contacts', undefined, 'coa_ghl');

    expect(info?.id).toBe('dfd_ghl');
  });

  it('caches per (connectorAccountId, path) so the two connections do not collide in one build', async () => {
    const { service } = makeService();
    const cache = new Map<string, { id: string; tableId: string[]; spec: BaseJsonTableSpec } | null>();

    const ghl = await service.getDataFolderInfo('wkb', 'Contacts', cache, 'coa_ghl');
    const generic = await service.getDataFolderInfo('wkb', 'Contacts', cache, 'coa_generic');

    expect(ghl?.id).toBe('dfd_ghl');
    expect(generic?.id).toBe('dfd_generic');
  });
});
