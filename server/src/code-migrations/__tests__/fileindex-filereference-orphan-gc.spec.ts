import {
  computeOrphanFolderPaths,
  folderPathHasLiveOwner,
  isSplitRecordIdArtifactRow,
  liveChildFolderPathsUnder,
  rootOrphanFolderPaths,
  selectSplitRecordIdArtifactRowIds,
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

describe('isSplitRecordIdArtifactRow (DEV-11015)', () => {
  it('flags a Shopify GID row whose record id was split into folderPath + filename', () => {
    // The exact prod shape: the id's slashes became directory separators at pull.
    expect(
      isSplitRecordIdArtifactRow({
        folderPath: 'Product Media/gid://shopify/MediaImage',
        filename: '38012599304435.json',
        recordId: 'gid://shopify/MediaImage/38012599304435',
      }),
    ).toBe(true);
  });

  it('flags the doubly-nested row left by a deduplicateFileName collision suffix', () => {
    // The dedup suffix carried a second unsanitized id, nesting one level deeper —
    // which is why the folderPath test is `includes`, not `endsWith`.
    expect(
      isSplitRecordIdArtifactRow({
        folderPath: 'Product Media/gid://shopify/MediaImage/44040420655417-gid://shopify/MediaImage',
        filename: '44040420655417.json',
        recordId: 'gid://shopify/MediaImage/44040420655417',
      }),
    ).toBe(true);
  });

  it('does NOT flag a row correctly indexed at its own folder with a slash-bearing id', () => {
    // Post-fix rows: same GID record id, but the filename is sanitized and the row
    // sits at the real folder — this is the common case and must never be deleted.
    expect(
      isSplitRecordIdArtifactRow({
        folderPath: 'Product Media',
        filename: 'gid-shopify-MediaImage-38012599304435.json',
        recordId: 'gid://shopify/MediaImage/38012599304435',
      }),
    ).toBe(false);
  });

  it('does NOT flag a Webflow secondary-locale row (slash-free record id)', () => {
    // The legitimately-nested case the orphan rule protects: a slash-free id can
    // never reconstruct a folderPath tail, so the pass structurally cannot reach it.
    expect(
      isSplitRecordIdArtifactRow({
        folderPath: 'Site/Collections/Blog Posts/fr',
        filename: 'my-post.json',
        recordId: '65f0c1a2b3d4e5f60718293a',
      }),
    ).toBe(false);
  });

  it('does NOT flag a row whose folderPath merely resembles the id prefix but whose filename differs', () => {
    expect(
      isSplitRecordIdArtifactRow({
        folderPath: 'Product Media/gid://shopify/MediaImage',
        filename: 'something-else.json',
        recordId: 'gid://shopify/MediaImage/38012599304435',
      }),
    ).toBe(false);
  });

  it('does NOT flag ids with a leading slash or a trailing slash (empty prefix/segment)', () => {
    expect(isSplitRecordIdArtifactRow({ folderPath: 'Anything', filename: 'x.json', recordId: '/x' })).toBe(false);
    expect(isSplitRecordIdArtifactRow({ folderPath: 'Anything', filename: 'x.json', recordId: 'x/' })).toBe(false);
  });
});

describe('selectSplitRecordIdArtifactRowIds', () => {
  it('returns only the artifact rows’ ids, leaving live rows untouched', () => {
    const rows = [
      {
        id: 'fi_artifact',
        folderPath: 'Product Media/gid://shopify/MediaImage',
        filename: '38012599304435.json',
        recordId: 'gid://shopify/MediaImage/38012599304435',
      },
      {
        id: 'fi_live',
        folderPath: 'Product Media',
        filename: 'gid-shopify-MediaImage-38012599304435.json',
        recordId: 'gid://shopify/MediaImage/38012599304435',
      },
    ];
    expect(selectSplitRecordIdArtifactRowIds(rows)).toEqual(['fi_artifact']);
  });
});
