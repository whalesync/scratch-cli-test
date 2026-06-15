import { DataFolderId } from '@spinner/shared-types';
import { WEBFLOW_NESTED_STRUCTURE_VERSION } from 'src/remote-service/connectors/library/webflow/webflow-folder-paths';
import {
  WEBFLOW_ASSETS_TABLE_ID_PREFIX,
  WEBFLOW_PAGES_TABLE_ID_PREFIX,
} from 'src/remote-service/connectors/library/webflow/webflow-json-schema';
import {
  AuditLogEntry,
  computeNestedWebflowCollectionPath,
  FolderMovePathRewriteInput,
  GitFolderMoveOutcome,
  WebflowCollectionFolderToMigrate,
  WebflowFolderRestructureDeps,
} from '../webflow-folder-restructure-backfill';
import {
  accumulateWebflowFolderRestructureInverse,
  computeFlatWebflowCollectionPath,
  emptyWebflowFolderRestructureInverseSummary,
  invertWebflowCollectionFolder,
  isInverseCollectionsNamedFolder,
  sortWebflowCollectionFoldersForSafeInverseMoveOrder,
  WEBFLOW_FOLDER_RESTRUCTURE_INVERSE_AUDIT_MARKER,
  WebflowCollectionFolderInversionResult,
} from '../webflow-folder-restructure-inverse-backfill';

// ---------------------------------------------------------------------------
// Test harness — mirrors the forward spec; in-memory stubs record the call graph.
// ---------------------------------------------------------------------------

interface CollectedSideEffects {
  uniquePathCalls: Array<{ candidateFolderPath: string; folderId: DataFolderId }>;
  gitMoveCalls: Array<{ oldFolderPath: string; newFolderPath: string }>;
  rewriteCalls: FolderMovePathRewriteInput[];
  audits: AuditLogEntry[];
}

function makeDeps(
  overrides: {
    dryRun?: boolean;
    ensureUniqueReturns?: (candidate: string) => string;
    gitMoveOutcome?: GitFolderMoveOutcome;
  } = {},
): { deps: WebflowFolderRestructureDeps; collected: CollectedSideEffects } {
  const collected: CollectedSideEffects = {
    uniquePathCalls: [],
    gitMoveCalls: [],
    rewriteCalls: [],
    audits: [],
  };
  const deps: WebflowFolderRestructureDeps = {
    dryRun: overrides.dryRun ?? false,
    ensureUniqueFolderPath: (_workbookId, _connectorAccountId, candidateFolderPath, folderId) => {
      collected.uniquePathCalls.push({ candidateFolderPath, folderId });
      return Promise.resolve(
        overrides.ensureUniqueReturns ? overrides.ensureUniqueReturns(candidateFolderPath) : candidateFolderPath,
      );
    },
    moveFolderInGit: (_connectorAccountId, oldFolderPath, newFolderPath) => {
      collected.gitMoveCalls.push({ oldFolderPath, newFolderPath });
      return Promise.resolve(overrides.gitMoveOutcome ?? { kind: 'moved' });
    },
    applyFolderMovePathRewrite: (input) => {
      collected.rewriteCalls.push(input);
      return Promise.resolve();
    },
    logAudit: (entry) => {
      collected.audits.push(entry);
      return Promise.resolve();
    },
  };
  return { deps, collected };
}

function makeNestedCollectionFolder(
  overrides: Partial<WebflowCollectionFolderToMigrate> = {},
): WebflowCollectionFolderToMigrate {
  return {
    id: 'folder-blog' as DataFolderId,
    workbookId: 'wb-1',
    organizationId: 'org-1',
    connectorAccountId: 'acct-1',
    name: 'Blog Posts',
    path: '/My Site/Collections/Blog Posts',
    version: WEBFLOW_NESTED_STRUCTURE_VERSION,
    tableId: ['site-123', 'collection-abc'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeFlatWebflowCollectionPath
// ---------------------------------------------------------------------------

describe('computeFlatWebflowCollectionPath', () => {
  it('un-nests a collection back to the flat /<Site>/<Collection>', () => {
    expect(computeFlatWebflowCollectionPath('/My Site/Collections/Blog Posts', 'Blog Posts')).toEqual({
      kind: 'ok',
      newFolderPath: '/My Site/Blog Posts',
    });
  });

  it('handles the mirror case: a collection literally named "Collections"', () => {
    expect(computeFlatWebflowCollectionPath('/My Site/Collections/Collections', 'Collections')).toEqual({
      kind: 'ok',
      newFolderPath: '/My Site/Collections',
    });
  });

  it('keeps all site segments for a deeper (legacy >=3-segment) nested path', () => {
    expect(computeFlatWebflowCollectionPath('/Webflow/My Site/Collections/Coll', 'Coll')).toEqual({
      kind: 'ok',
      newFolderPath: '/Webflow/My Site/Coll',
    });
  });

  it('recomputes the leaf from the name (the clean flat leaf; suffix restoration is the orchestrator’s job)', () => {
    // A collection named "Assets" whose nested leaf is clean reverts to the clean
    // flat leaf; ensureUniquePath (a dep) is what re-applies any collision suffix.
    expect(computeFlatWebflowCollectionPath('/My Site/Collections/Assets', 'Assets')).toEqual({
      kind: 'ok',
      newFolderPath: '/My Site/Assets',
    });
  });

  it('escapes filesystem-unsafe characters in the collection name for the leaf', () => {
    expect(computeFlatWebflowCollectionPath('/My Site/Collections/old', 'A/B*C')).toEqual({
      kind: 'ok',
      newFolderPath: '/My Site/A B C',
    });
  });

  it.each([
    ['too shallow (no grandparent)', '/My Site/Blog'],
    ['parent dir is not "Collections"', '/My Site/NotCollections/Blog'],
    ['single segment', '/OnlySite'],
  ])('reports bad_shape for %s', (_label, path) => {
    expect(computeFlatWebflowCollectionPath(path, 'Blog').kind).toBe('bad_shape');
  });

  it('reports bad_shape when the name escapes to an empty segment', () => {
    expect(computeFlatWebflowCollectionPath('/My Site/Collections/old', '///').kind).toBe('bad_shape');
  });
});

// ---------------------------------------------------------------------------
// Round-trip drift guard — forward then inverse returns the original flat path.
// ---------------------------------------------------------------------------

describe('round-trip: computeNested then computeFlat restores the original flat path', () => {
  it.each([
    ['/My Site/Blog Posts', 'Blog Posts'],
    ['/My Site/Team Members', 'Team Members'],
    ['/My Site/Collections', 'Collections'], // the mirror case
    ['/Webflow/My Site/Coll', 'Coll'], // legacy 3-segment site
    ['/Acme Co/Press Releases', 'Press Releases'],
  ])('flat=%s name=%s', (flatPath, name) => {
    const nested = computeNestedWebflowCollectionPath(flatPath, name);
    expect(nested.kind).toBe('ok');
    if (nested.kind !== 'ok') return;
    const backToFlat = computeFlatWebflowCollectionPath(nested.newFolderPath, name);
    expect(backToFlat).toEqual({ kind: 'ok', newFolderPath: flatPath });
  });
});

// ---------------------------------------------------------------------------
// isInverseCollectionsNamedFolder
// ---------------------------------------------------------------------------

describe('isInverseCollectionsNamedFolder', () => {
  it('is true for the nested folder of a collection named "Collections"', () => {
    expect(isInverseCollectionsNamedFolder('/My Site/Collections/Collections')).toBe(true);
  });

  it('is false for an ordinary nested collection', () => {
    expect(isInverseCollectionsNamedFolder('/My Site/Collections/Blog Posts')).toBe(false);
  });

  it('is false for a flat "Collections" folder (only the doubly-nested mirror counts)', () => {
    expect(isInverseCollectionsNamedFolder('/My Site/Collections')).toBe(false);
  });

  it('is false for a malformed path', () => {
    expect(isInverseCollectionsNamedFolder('/Collections')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sortWebflowCollectionFoldersForSafeInverseMoveOrder
// ---------------------------------------------------------------------------

describe('sortWebflowCollectionFoldersForSafeInverseMoveOrder', () => {
  it('reverts a "Collections"-named collection LAST within its site', () => {
    const folders = [
      { connectorAccountId: 'acct-1', path: '/My Site/Collections/Collections' }, // mirror case
      { connectorAccountId: 'acct-1', path: '/My Site/Collections/Blog Posts' },
      { connectorAccountId: 'acct-1', path: '/My Site/Collections/Team Members' },
    ];
    const ordered = sortWebflowCollectionFoldersForSafeInverseMoveOrder(folders);
    expect(ordered.map((f) => f.path)).toEqual([
      '/My Site/Collections/Blog Posts',
      '/My Site/Collections/Team Members',
      '/My Site/Collections/Collections',
    ]);
  });

  it('orders the mirror case last independently within each site', () => {
    const folders = [
      { connectorAccountId: 'acct-1', path: '/Site A/Collections/Collections' },
      { connectorAccountId: 'acct-1', path: '/Site A/Collections/Blog' },
      { connectorAccountId: 'acct-1', path: '/Site B/Collections/Collections' },
      { connectorAccountId: 'acct-1', path: '/Site B/Collections/Posts' },
    ];
    const ordered = sortWebflowCollectionFoldersForSafeInverseMoveOrder(folders);
    const siteA = ordered.filter((f) => f.path.startsWith('/Site A/')).map((f) => f.path);
    const siteB = ordered.filter((f) => f.path.startsWith('/Site B/')).map((f) => f.path);
    expect(siteA).toEqual(['/Site A/Collections/Blog', '/Site A/Collections/Collections']);
    expect(siteB).toEqual(['/Site B/Collections/Posts', '/Site B/Collections/Collections']);
  });

  it('preserves relative order of ordinary siblings (stable)', () => {
    const folders = [
      { connectorAccountId: 'acct-1', path: '/Site/Collections/Charlie' },
      { connectorAccountId: 'acct-1', path: '/Site/Collections/Alpha' },
      { connectorAccountId: 'acct-1', path: '/Site/Collections/Bravo' },
    ];
    const ordered = sortWebflowCollectionFoldersForSafeInverseMoveOrder(folders);
    expect(ordered.map((f) => f.path)).toEqual([
      '/Site/Collections/Charlie',
      '/Site/Collections/Alpha',
      '/Site/Collections/Bravo',
    ]);
  });
});

// ---------------------------------------------------------------------------
// invertWebflowCollectionFolder — the per-folder decision
// ---------------------------------------------------------------------------

describe('invertWebflowCollectionFolder', () => {
  it('skips a folder already at the flat version (idempotency), touching nothing', async () => {
    const folder = makeNestedCollectionFolder({ version: 1 });
    const { deps, collected } = makeDeps();

    const result = await invertWebflowCollectionFolder(folder, deps);

    expect(result).toEqual({ kind: 'skipped_already_flat' });
    expect(collected.gitMoveCalls).toHaveLength(0);
    expect(collected.rewriteCalls).toHaveLength(0);
    expect(collected.audits).toHaveLength(0);
  });

  it.each([
    ['assets', `${WEBFLOW_ASSETS_TABLE_ID_PREFIX}site-1`],
    ['pages', `${WEBFLOW_PAGES_TABLE_ID_PREFIX}site-1`],
  ])('skips the synthetic %s table, touching nothing', async (tableType, collectionId) => {
    const folder = makeNestedCollectionFolder({ tableId: ['site-1', collectionId], name: tableType });
    const { deps, collected } = makeDeps();

    const result = await invertWebflowCollectionFolder(folder, deps);

    expect(result).toEqual({ kind: 'skipped_not_a_collection', tableType });
    expect(collected.gitMoveCalls).toHaveLength(0);
    expect(collected.rewriteCalls).toHaveLength(0);
  });

  it('reverts a collection: git move + atomic rewrite + audit, all with the flat path', async () => {
    const folder = makeNestedCollectionFolder();
    const { deps, collected } = makeDeps({ gitMoveOutcome: { kind: 'moved' } });

    const result = await invertWebflowCollectionFolder(folder, deps);

    expect(result).toEqual({
      kind: 'reverted',
      oldPath: '/My Site/Collections/Blog Posts',
      newPath: '/My Site/Blog Posts',
      movedInGit: true,
    });
    expect(collected.uniquePathCalls).toEqual([{ candidateFolderPath: '/My Site/Blog Posts', folderId: folder.id }]);
    expect(collected.gitMoveCalls).toEqual([
      { oldFolderPath: '/My Site/Collections/Blog Posts', newFolderPath: '/My Site/Blog Posts' },
    ]);
    expect(collected.rewriteCalls).toEqual([
      {
        folderId: folder.id,
        workbookId: 'wb-1',
        connectorAccountId: 'acct-1',
        oldFolderPath: '/My Site/Collections/Blog Posts',
        newFolderPath: '/My Site/Blog Posts',
      },
    ]);
    expect(collected.audits).toHaveLength(1);
    expect(collected.audits[0].context.marker).toBe(WEBFLOW_FOLDER_RESTRUCTURE_INVERSE_AUDIT_MARKER);
    expect(collected.audits[0].entityId).toBe(folder.id);
  });

  it('reverts the "Collections"-named collection to /<Site>/Collections', async () => {
    const folder = makeNestedCollectionFolder({
      name: 'Collections',
      path: '/My Site/Collections/Collections',
    });
    const { deps, collected } = makeDeps();

    const result = await invertWebflowCollectionFolder(folder, deps);

    expect(result).toMatchObject({
      kind: 'reverted',
      oldPath: '/My Site/Collections/Collections',
      newPath: '/My Site/Collections',
    });
    expect(collected.gitMoveCalls[0]).toEqual({
      oldFolderPath: '/My Site/Collections/Collections',
      newFolderPath: '/My Site/Collections',
    });
  });

  it('re-applies a collision suffix via ensureUniquePath when the flat target collides (e.g. a collection named "Assets")', async () => {
    const folder = makeNestedCollectionFolder({
      name: 'Assets',
      path: '/My Site/Collections/Assets',
      tableId: ['site-1', 'collection-real'], // a real collection, NOT the __assets__ sentinel
    });
    // The flat `/My Site/Assets` collides with the synthetic Assets folder → re-suffix.
    const { deps, collected } = makeDeps({
      ensureUniqueReturns: (candidate) => (candidate === '/My Site/Assets' ? '/My Site/Assets-a3f9c' : candidate),
    });

    const result = await invertWebflowCollectionFolder(folder, deps);

    expect(result).toMatchObject({ kind: 'reverted', newPath: '/My Site/Assets-a3f9c' });
    // Both the git move and the DB rewrite use the de-collided path.
    expect(collected.gitMoveCalls[0].newFolderPath).toBe('/My Site/Assets-a3f9c');
    expect(collected.rewriteCalls[0].newFolderPath).toBe('/My Site/Assets-a3f9c');
  });

  it('skips (without DB rewrite) when the connection repo does not exist yet', async () => {
    const folder = makeNestedCollectionFolder();
    const { deps, collected } = makeDeps({ gitMoveOutcome: { kind: 'repo_missing' } });

    const result = await invertWebflowCollectionFolder(folder, deps);

    expect(result).toEqual({ kind: 'skipped_repo_missing', path: '/My Site/Collections/Blog Posts' });
    expect(collected.rewriteCalls).toHaveLength(0);
    expect(collected.audits).toHaveLength(0);
  });

  it('reports movedInGit=false when the git move was a no-op (mid-run crash recovery)', async () => {
    const folder = makeNestedCollectionFolder();
    const { deps } = makeDeps({ gitMoveOutcome: { kind: 'noop' } });

    const result = await invertWebflowCollectionFolder(folder, deps);

    expect(result).toMatchObject({ kind: 'reverted', movedInGit: false });
  });

  it.each([
    ['too shallow', '/My Site/Blog'],
    ['parent dir is not "Collections"', '/My Site/NotCollections/Blog'],
  ])('skips a folder with a malformed nested path shape (%s), touching nothing', async (_label, path) => {
    const folder = makeNestedCollectionFolder({ path });
    const { deps, collected } = makeDeps();

    const result = await invertWebflowCollectionFolder(folder, deps);

    expect(result.kind).toBe('skipped_bad_path_shape');
    expect(collected.gitMoveCalls).toHaveLength(0);
    expect(collected.rewriteCalls).toHaveLength(0);
  });

  it('in dry-run, reports the would-be flat path and performs no writes', async () => {
    const folder = makeNestedCollectionFolder();
    const { deps, collected } = makeDeps({ dryRun: true });

    const result = await invertWebflowCollectionFolder(folder, deps);

    expect(result).toEqual({
      kind: 'would_revert',
      oldPath: '/My Site/Collections/Blog Posts',
      newPath: '/My Site/Blog Posts',
    });
    expect(collected.uniquePathCalls).toHaveLength(0);
    expect(collected.gitMoveCalls).toHaveLength(0);
    expect(collected.rewriteCalls).toHaveLength(0);
    expect(collected.audits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Summary aggregation
// ---------------------------------------------------------------------------

describe('accumulateWebflowFolderRestructureInverse', () => {
  it('tallies a mix of outcomes', () => {
    const summary = emptyWebflowFolderRestructureInverseSummary();
    const results: WebflowCollectionFolderInversionResult[] = [
      { kind: 'reverted', oldPath: '/a/Collections/b', newPath: '/a/b', movedInGit: true },
      { kind: 'reverted', oldPath: '/a/Collections/c', newPath: '/a/c', movedInGit: false },
      { kind: 'skipped_already_flat' },
      { kind: 'skipped_not_a_collection', tableType: 'pages' },
      { kind: 'skipped_bad_path_shape', path: '/x', reason: 'bad' },
      { kind: 'skipped_repo_missing', path: '/a/Collections/d' },
      { kind: 'errored', error: new Error('boom') },
    ];
    for (const result of results) accumulateWebflowFolderRestructureInverse(summary, result);

    expect(summary).toEqual({
      total: 7,
      reverted: 2,
      would_revert: 0,
      skipped_already_flat: 1,
      skipped_not_a_collection: 1,
      skipped_bad_path_shape: 1,
      skipped_repo_missing: 1,
      errored: 1,
    });
  });
});
