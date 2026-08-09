import { DbService } from '../../db/db.service';
import { FileIndexService, folderPathOwns, isDeeperFolderPathOrphanedByDelete } from '../file-index.service';

describe('folderPathOwns', () => {
  it('owns its own path and any descendant', () => {
    expect(folderPathOwns('Foo', 'Foo')).toBe(true);
    expect(folderPathOwns('Foo', 'Foo/Bar')).toBe(true);
    expect(folderPathOwns('Foo', 'Foo/gid://shopify/ProductVariant')).toBe(true);
  });

  it('does not own a sibling that merely shares a string prefix (no slash boundary)', () => {
    expect(folderPathOwns('Foo', 'Foo Extra')).toBe(false);
    expect(folderPathOwns('Foo', 'Foobar')).toBe(false);
  });

  it('does not own an ancestor', () => {
    expect(folderPathOwns('Foo/Bar', 'Foo')).toBe(false);
  });
});

describe('isDeeperFolderPathOrphanedByDelete', () => {
  it('treats a Shopify-GID artifact path as an orphan of its plain folder', () => {
    // A variant with a slash-bearing GID id leaks a deeper folderPath under a live
    // `/Product Variants` folder; deleting that folder orphans the artifact row.
    expect(
      isDeeperFolderPathOrphanedByDelete('Product Variants/gid://shopify/ProductVariant', 'Product Variants', []),
    ).toBe(true);
  });

  it('preserves rows owned by a live nested child DataFolder (Webflow secondary locale)', () => {
    expect(
      isDeeperFolderPathOrphanedByDelete('Site/Collections/Blog/French', 'Site/Collections/Blog', [
        'Site/Collections/Blog/French',
      ]),
    ).toBe(false);
  });

  it('still sweeps an artifact deeper than a folder even when a live child exists elsewhere under it', () => {
    expect(
      isDeeperFolderPathOrphanedByDelete('Site/Collections/Blog/gid://x', 'Site/Collections/Blog', [
        'Site/Collections/Blog/French',
      ]),
    ).toBe(true);
  });

  it('returns false when the row is not under the deleted folder at all', () => {
    expect(isDeeperFolderPathOrphanedByDelete('Other/x', 'Foo', [])).toBe(false);
  });
});

describe('FileIndexService.deleteForConnection', () => {
  it('deletes every row scoped to the connection (covers nested sub-paths for free)', async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 3 });
    const db = { client: { fileIndex: { deleteMany } } } as unknown as DbService;
    const service = new FileIndexService(db);

    await service.deleteForConnection('wkb_1', 'coa_shop');

    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany).toHaveBeenCalledWith({ where: { workbookId: 'wkb_1', connectorAccountId: 'coa_shop' } });
  });
});

describe('FileIndexService.deleteRowsOwnedByDeletedFolder', () => {
  function makeService(distinctDeeperFolderPaths: string[]) {
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const findMany = jest.fn().mockResolvedValue(distinctDeeperFolderPaths.map((folderPath) => ({ folderPath })));
    const db = { client: { fileIndex: { deleteMany, findMany } } } as unknown as DbService;
    return { service: new FileIndexService(db), deleteMany, findMany };
  }

  it('deletes the exact folder path and its GID-artifact sub-paths, scoped by connectorAccountId', async () => {
    const { service, deleteMany } = makeService(['Product Variants/gid://shopify/ProductVariant']);

    await service.deleteRowsOwnedByDeletedFolder('wkb_1', 'coa_shop', 'Product Variants', []);

    expect(deleteMany).toHaveBeenNthCalledWith(1, {
      where: { workbookId: 'wkb_1', connectorAccountId: 'coa_shop', folderPath: 'Product Variants' },
    });
    expect(deleteMany).toHaveBeenNthCalledWith(2, {
      where: {
        workbookId: 'wkb_1',
        connectorAccountId: 'coa_shop',
        folderPath: { in: ['Product Variants/gid://shopify/ProductVariant'] },
      },
    });
  });

  it('preserves a live nested child folder while sweeping a sibling artifact under the same parent', async () => {
    const { service, deleteMany } = makeService(['Site/Collections/Blog/French', 'Site/Collections/Blog/gid://x']);

    await service.deleteRowsOwnedByDeletedFolder('wkb_1', 'coa_wf', 'Site/Collections/Blog', [
      'Site/Collections/Blog/French',
    ]);

    // Exact path, then only the artifact — the live French locale's rows are left intact.
    expect(deleteMany).toHaveBeenNthCalledWith(2, {
      where: {
        workbookId: 'wkb_1',
        connectorAccountId: 'coa_wf',
        folderPath: { in: ['Site/Collections/Blog/gid://x'] },
      },
    });
    expect(deleteMany).toHaveBeenCalledTimes(2);
  });

  it('escapes SQL LIKE wildcards in the deeper-rows prefix scan so a `_` cannot over-match', async () => {
    const { service, findMany } = makeService([]);

    await service.deleteRowsOwnedByDeletedFolder('wkb_1', 'coa_pg', 'public/product_variants', []);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        workbookId: 'wkb_1',
        connectorAccountId: 'coa_pg',
        folderPath: { startsWith: 'public/product\\_variants/' },
      },
      select: { folderPath: true },
      distinct: ['folderPath'],
    });
  });

  it('only issues the exact-path delete when there are no deeper rows', async () => {
    const { service, deleteMany } = makeService([]);

    await service.deleteRowsOwnedByDeletedFolder('wkb_1', 'coa_air', 'Contacts', []);

    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { workbookId: 'wkb_1', connectorAccountId: 'coa_air', folderPath: 'Contacts' },
    });
  });
});
