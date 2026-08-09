import { DbService } from '../../db/db.service';
import { FileReferenceService } from '../file-reference.service';
import { RefCleanerService } from '../ref-cleaner.service';
import { SchemaHelperService } from '../schema-helper.service';

describe('FileReferenceService.deleteForFolderExcludingLiveChildren', () => {
  function makeService() {
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const db = { client: { fileReference: { deleteMany } } } as unknown as DbService;
    const service = new FileReferenceService(db, {} as RefCleanerService, {} as SchemaHelperService);
    return { service, deleteMany };
  }

  it('prefix-deletes under the folder with no exclusions when there are no live children', async () => {
    const { service, deleteMany } = makeService();

    await service.deleteForFolderExcludingLiveChildren('wkb_1', 'DeadConn/Issues', []);

    expect(deleteMany).toHaveBeenCalledWith({
      where: { workbookId: 'wkb_1', sourceFilePath: { startsWith: 'DeadConn/Issues/' } },
    });
  });

  it('excludes each live child folder subtree so its refs survive', async () => {
    const { service, deleteMany } = makeService();

    await service.deleteForFolderExcludingLiveChildren('wkb_1', 'Site/Collections/Blog', ['Site/Collections/Blog/fr']);

    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        workbookId: 'wkb_1',
        sourceFilePath: { startsWith: 'Site/Collections/Blog/' },
        AND: [{ NOT: { sourceFilePath: { startsWith: 'Site/Collections/Blog/fr/' } } }],
      },
    });
  });

  it('escapes SQL LIKE wildcards in both the folder and live-child prefixes', async () => {
    const { service, deleteMany } = makeService();

    await service.deleteForFolderExcludingLiveChildren('wkb_1', 'public/product_variants', [
      'public/product_variants/live_locale',
    ]);

    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        workbookId: 'wkb_1',
        sourceFilePath: { startsWith: 'public/product\\_variants/' },
        AND: [{ NOT: { sourceFilePath: { startsWith: 'public/product\\_variants/live\\_locale/' } } }],
      },
    });
  });
});
