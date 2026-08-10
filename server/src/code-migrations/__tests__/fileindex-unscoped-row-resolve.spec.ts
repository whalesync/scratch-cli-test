import {
  classifyUnscopedRowOwnership,
  findClaimantConnectorAccountIdsForFolderPath,
  resolveMultiOwnerUnscopedRowByContent,
} from '../fileindex-unscoped-row-resolve';

describe('findClaimantConnectorAccountIdsForFolderPath', () => {
  it('returns every connection whose folder sits at the row folderPath', () => {
    // The DEV-11242 shape: two connections both expose a folder named `Products`.
    expect(
      findClaimantConnectorAccountIdsForFolderPath('Products', [
        { connectorAccountId: 'coa_hubspot', folderPathNoSlash: 'Products' },
        { connectorAccountId: 'coa_shopify', folderPathNoSlash: 'Products' },
        { connectorAccountId: 'coa_stripe', folderPathNoSlash: 'Contacts' },
      ]),
    ).toEqual(['coa_hubspot', 'coa_shopify']);
  });

  it('attributes a row stored deeper than any folder path to its ancestor folder', () => {
    // The Shopify-GID shape: the row's folderPath is the folder plus an id prefix.
    expect(
      findClaimantConnectorAccountIdsForFolderPath('Product Media/gid:/shopify/MediaImage', [
        { connectorAccountId: 'coa_shopify', folderPathNoSlash: 'Product Media' },
      ]),
    ).toEqual(['coa_shopify']);
  });

  it('gives a deeply-nested row to its LONGEST-prefix owner, not the parent', () => {
    // A Webflow secondary-locale folder nested inside its collection folder owns its own rows.
    expect(
      findClaimantConnectorAccountIdsForFolderPath('Site/Collections/Blog/de-DE', [
        { connectorAccountId: 'coa_parent', folderPathNoSlash: 'Site/Collections/Blog' },
        { connectorAccountId: 'coa_locale', folderPathNoSlash: 'Site/Collections/Blog/de-DE' },
      ]),
    ).toEqual(['coa_locale']);
  });

  it('does not treat a sibling folder sharing a name prefix as an owner', () => {
    expect(
      findClaimantConnectorAccountIdsForFolderPath('Blog Posts', [
        { connectorAccountId: 'coa_other', folderPathNoSlash: 'Blog' },
      ]),
    ).toEqual([]);
  });

  it('deduplicates a connection that owns the path through two folder rows', () => {
    expect(
      findClaimantConnectorAccountIdsForFolderPath('Pages', [
        { connectorAccountId: 'coa_wordpress', folderPathNoSlash: 'Pages' },
        { connectorAccountId: 'coa_wordpress', folderPathNoSlash: 'Pages' },
      ]),
    ).toEqual(['coa_wordpress']);
  });

  it('returns nothing when no connector folder owns the path', () => {
    expect(
      findClaimantConnectorAccountIdsForFolderPath('Notes', [
        { connectorAccountId: 'coa_a', folderPathNoSlash: 'Deals' },
      ]),
    ).toEqual([]);
  });
});

describe('classifyUnscopedRowOwnership', () => {
  it('scopes the row when exactly one claimant repo holds the file', () => {
    expect(classifyUnscopedRowOwnership(['coa_wordpress', 'coa_shopify'], ['coa_wordpress'])).toEqual({
      kind: 'scope',
      connectorAccountId: 'coa_wordpress',
    });
  });

  it('deletes the row when claimants exist but none of their repos holds the file', () => {
    expect(classifyUnscopedRowOwnership(['coa_wordpress', 'coa_shopify'], [])).toEqual({ kind: 'delete' });
  });

  // The dangerous case: with no claimant there is no repo to probe, so "no holder" says
  // nothing about whether the file exists. Deleting here would wipe a scratch folder's
  // legitimately-NULL rows and the orphan GC's 47k-row population on test.
  it('leaves a row alone when NO connector-backed folder owns its path', () => {
    expect(classifyUnscopedRowOwnership([], [])).toEqual({ kind: 'skip-no-connector-claimant' });
  });

  it('defers to the content tie-break when several claimant repos hold the file', () => {
    expect(classifyUnscopedRowOwnership(['coa_notion_1', 'coa_notion'], ['coa_notion_1', 'coa_notion'])).toEqual({
      kind: 'unresolvable',
      candidateConnectorAccountIds: ['coa_notion', 'coa_notion_1'],
    });
  });
});

describe('resolveMultiOwnerUnscopedRowByContent', () => {
  it('scopes to the lowest connectorAccountId when every candidate holds an identical file', () => {
    // The prod case: one Notion workspace connected twice, so both repos hold the very
    // same page. Either candidate yields the same recordId, so the pick is free.
    const samePage = '{"object":"page","id":"26f51c96-d209-80da-afb8-d90cd6d3214e"}';
    expect(
      resolveMultiOwnerUnscopedRowByContent([
        { connectorAccountId: 'coa_GAmYn6wLKE', content: samePage },
        { connectorAccountId: 'coa_FuJsG3v2e8', content: samePage },
      ]),
    ).toEqual({ kind: 'scope', connectorAccountId: 'coa_FuJsG3v2e8' });
  });

  it('is deterministic regardless of the order the candidates arrive in', () => {
    const samePage = '{"id":"abc"}';
    const forwards = resolveMultiOwnerUnscopedRowByContent([
      { connectorAccountId: 'coa_a', content: samePage },
      { connectorAccountId: 'coa_b', content: samePage },
    ]);
    const backwards = resolveMultiOwnerUnscopedRowByContent([
      { connectorAccountId: 'coa_b', content: samePage },
      { connectorAccountId: 'coa_a', content: samePage },
    ]);
    expect(forwards).toEqual(backwards);
  });

  it('leaves the row NULL when the candidates hold DIFFERENT records', () => {
    // Two HubSpot portals whose contacts happen to share a filename — guessing an owner
    // here would point one connection's publish at the other's remote record.
    expect(
      resolveMultiOwnerUnscopedRowByContent([
        { connectorAccountId: 'coa_portal_a', content: '{"id":"551"}' },
        { connectorAccountId: 'coa_portal_b', content: '{"id":"9902"}' },
      ]),
    ).toEqual({ kind: 'unresolvable', candidateConnectorAccountIds: ['coa_portal_a', 'coa_portal_b'] });
  });

  it('leaves the row NULL when a candidate file could not be read', () => {
    expect(
      resolveMultiOwnerUnscopedRowByContent([
        { connectorAccountId: 'coa_a', content: null },
        { connectorAccountId: 'coa_b', content: '{"id":"1"}' },
      ]),
    ).toEqual({ kind: 'unresolvable', candidateConnectorAccountIds: ['coa_a', 'coa_b'] });
  });

  it('leaves the row NULL when there are no candidates at all', () => {
    expect(resolveMultiOwnerUnscopedRowByContent([])).toEqual({
      kind: 'unresolvable',
      candidateConnectorAccountIds: [],
    });
  });
});
