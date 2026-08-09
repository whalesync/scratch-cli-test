import {
  computeOrphanFolderPaths,
  folderPathHasLiveOwner,
  liveChildFolderPathsUnder,
  rootOrphanFolderPaths,
} from '../fileindex-filereference-orphan-gc';

describe('folderPathHasLiveOwner', () => {
  it('is owned by a live folder at its own path', () => {
    expect(folderPathHasLiveOwner('Contacts', ['Contacts', 'Companies'])).toBe(true);
  });

  it('is owned by a live ANCESTOR folder (Shopify-GID artifact under a live folder)', () => {
    expect(folderPathHasLiveOwner('Product Variants/gid://shopify/ProductVariant', ['Product Variants'])).toBe(true);
  });

  it('is owned by a live nested folder at its own path (Webflow secondary locale)', () => {
    expect(folderPathHasLiveOwner('Site/Collections/Blog/French', ['Site/Collections/Blog/French'])).toBe(true);
  });

  it('is NOT owned by a folder that only shares a string prefix (no slash boundary)', () => {
    expect(folderPathHasLiveOwner('Foobar', ['Foo'])).toBe(false);
    expect(folderPathHasLiveOwner('Foo Extra', ['Foo'])).toBe(false);
  });

  it('is an orphan when no live folder owns it', () => {
    expect(folderPathHasLiveOwner('DeadConnection/Issues', ['Contacts'])).toBe(false);
    expect(folderPathHasLiveOwner('Contacts', [])).toBe(false);
  });
});

describe('computeOrphanFolderPaths', () => {
  it('returns only folderPaths with no live owner, preserving artifacts and locales', () => {
    const distinctFolderPaths = [
      'Contacts', // live (own path)
      'Product Variants/gid://shopify/ProductVariant', // artifact under live /Product Variants
      'Site/Collections/Blog/French', // live nested locale
      'DeadConnection/Issues', // orphan — no live owner
      'DeadConnection/Issues/gid://x', // orphan — deeper under a dead folder
    ];
    const liveFolderPathsNoSlash = ['Contacts', 'Product Variants', 'Site/Collections/Blog/French'];

    expect(computeOrphanFolderPaths(distinctFolderPaths, liveFolderPathsNoSlash)).toEqual([
      'DeadConnection/Issues',
      'DeadConnection/Issues/gid://x',
    ]);
  });

  it('treats every folderPath as an orphan when the workbook has no live folders', () => {
    expect(computeOrphanFolderPaths(['A', 'B/c'], [])).toEqual(['A', 'B/c']);
  });
});

describe('liveChildFolderPathsUnder', () => {
  it('returns live folders nested strictly under the orphan folder', () => {
    expect(
      liveChildFolderPathsUnder('Webflow/Collections/Blog', [
        'Webflow/Collections/Blog/French',
        'Webflow/Collections/Blog', // self is not "under"
        'Other',
      ]),
    ).toEqual(['Webflow/Collections/Blog/French']);
  });

  it('returns nothing when no live folder is nested under it', () => {
    expect(liveChildFolderPathsUnder('DeadConnection/Issues', ['Contacts'])).toEqual([]);
  });
});

describe('rootOrphanFolderPaths', () => {
  it('drops a descendant orphan already covered by an ancestor orphan (dry-run double-count guard)', () => {
    // A dead Shopify connection leaves both the folder and its slash-bearing GID sub-path as orphans.
    expect(
      rootOrphanFolderPaths(['Shop/Product Variants', 'Shop/Product Variants/gid://shopify/ProductVariant']),
    ).toEqual(['Shop/Product Variants']);
  });

  it('keeps sibling orphans and unrelated orphans (disjoint subtrees)', () => {
    expect(rootOrphanFolderPaths(['DeadA/Issues', 'DeadB/Notes', 'DeadA/Comments'])).toEqual([
      'DeadA/Issues',
      'DeadB/Notes',
      'DeadA/Comments',
    ]);
  });

  it('does not treat a mere string-prefix sibling as nested (slash boundary)', () => {
    expect(rootOrphanFolderPaths(['Foo', 'Foobar'])).toEqual(['Foo', 'Foobar']);
  });
});
