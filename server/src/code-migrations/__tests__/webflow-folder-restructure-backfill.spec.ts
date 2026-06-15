import { DataFolderId } from '@spinner/shared-types';
import {
  WEBFLOW_NESTED_STRUCTURE_VERSION,
  webflowCollectionBasePath,
} from 'src/remote-service/connectors/library/webflow/webflow-folder-paths';
import {
  WEBFLOW_ASSETS_TABLE_ID_PREFIX,
  WEBFLOW_PAGES_TABLE_ID_PREFIX,
} from 'src/remote-service/connectors/library/webflow/webflow-json-schema';
import { Site } from 'src/remote-service/connectors/library/webflow/webflow-types';
import { escapeConnectorFolderPathSegment } from 'src/workbook/connector-folder-path.util';
import {
  accumulateWebflowFolderRestructure,
  AuditLogEntry,
  classifyWebflowTableByTableId,
  computeNestedWebflowCollectionPath,
  emptyWebflowFolderRestructureSummary,
  FolderMovePathRewriteInput,
  GitFolderMoveOutcome,
  isCollectionsNamedCollectionFolder,
  migrateWebflowCollectionFolder,
  rewriteFilePathFolderPrefix,
  sortWebflowCollectionFoldersForSafeMoveOrder,
  splitFolderPathIntoParentAndLeaf,
  WEBFLOW_FOLDER_RESTRUCTURE_AUDIT_MARKER,
  WebflowCollectionFolderMigrationResult,
  WebflowCollectionFolderToMigrate,
  WebflowFolderRestructureDeps,
} from '../webflow-folder-restructure-backfill';

// ---------------------------------------------------------------------------
// Test harness — substitutes in-memory stubs for every dep side effect and
// records the call graph, mirroring the notion-data-source-backfill spec.
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

function makeCollectionFolder(
  overrides: Partial<WebflowCollectionFolderToMigrate> = {},
): WebflowCollectionFolderToMigrate {
  return {
    id: 'folder-blog' as DataFolderId,
    workbookId: 'wb-1',
    organizationId: 'org-1',
    connectorAccountId: 'acct-1',
    name: 'Blog Posts',
    path: '/My Site/Blog Posts',
    version: 1,
    tableId: ['site-123', 'collection-abc'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// splitFolderPathIntoParentAndLeaf
// ---------------------------------------------------------------------------

describe('splitFolderPathIntoParentAndLeaf', () => {
  it('splits a two-segment path into dirname + leaf, keeping the leading slash on the parent', () => {
    expect(splitFolderPathIntoParentAndLeaf('/My Site/Blog Posts')).toEqual({
      parentDirPath: '/My Site',
      leafSegment: 'Blog Posts',
    });
  });

  it('splits a deeper path keeping all parent segments', () => {
    expect(splitFolderPathIntoParentAndLeaf('/Site/Parent/Coll')).toEqual({
      parentDirPath: '/Site/Parent',
      leafSegment: 'Coll',
    });
  });

  it.each([
    ['no leading slash', 'My Site/Blog'],
    ['single segment', '/Site'],
    ['root only', '/'],
    ['empty', ''],
    ['trailing slash (empty leaf)', '/Site/Coll/'],
    ['double slash (empty interior segment)', '/Site//Coll'],
  ])('returns null for a malformed path: %s', (_label, path) => {
    expect(splitFolderPathIntoParentAndLeaf(path)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeNestedWebflowCollectionPath
// ---------------------------------------------------------------------------

describe('computeNestedWebflowCollectionPath', () => {
  it('nests a flat collection under /<Site>/Collections/', () => {
    expect(computeNestedWebflowCollectionPath('/My Site/Blog Posts', 'Blog Posts')).toEqual({
      kind: 'ok',
      newFolderPath: '/My Site/Collections/Blog Posts',
    });
  });

  it('recomputes the leaf from the name, repairing an ensureUniquePath -{id5} suffix (regression: Assets-a3f9c)', () => {
    // A CMS collection a user named "Assets" collided with the synthetic Assets
    // folder under the flat layout and got an `-a3f9c` suffix on its path. The
    // leaf is recomputed from the clean name, so the suffix is dropped.
    expect(computeNestedWebflowCollectionPath('/My Site/Assets-a3f9c', 'Assets')).toEqual({
      kind: 'ok',
      newFolderPath: '/My Site/Collections/Assets',
    });
  });

  it('escapes filesystem-unsafe characters in the collection name for the leaf', () => {
    expect(computeNestedWebflowCollectionPath('/My Site/old', 'A/B*C')).toEqual({
      kind: 'ok',
      newFolderPath: '/My Site/Collections/A B C',
    });
  });

  it('handles the prefix case: a collection literally named "Collections"', () => {
    expect(computeNestedWebflowCollectionPath('/My Site/Collections', 'Collections')).toEqual({
      kind: 'ok',
      newFolderPath: '/My Site/Collections/Collections',
    });
  });

  it('keeps all parent segments for a deeper (>=3 segment) path', () => {
    expect(computeNestedWebflowCollectionPath('/Site/Parent/Coll', 'Coll')).toEqual({
      kind: 'ok',
      newFolderPath: '/Site/Parent/Collections/Coll',
    });
  });

  it('reports bad_shape for a single-segment path', () => {
    const result = computeNestedWebflowCollectionPath('/OnlySite', 'OnlySite');
    expect(result.kind).toBe('bad_shape');
  });

  it('reports bad_shape when the name escapes to an empty segment', () => {
    const result = computeNestedWebflowCollectionPath('/My Site/old', '///');
    expect(result.kind).toBe('bad_shape');
  });
});

// ---------------------------------------------------------------------------
// C1 drift guard — migration path == fresh-pull connector path for a v2 collection
// ---------------------------------------------------------------------------

describe('C1 drift guard: migration target path matches a fresh v2 pull', () => {
  // Faithful reimplementation of DataFolderService.buildConnectorFolderPath's
  // join logic, fed the SAME shared pieces the connector uses
  // (webflowCollectionBasePath + escapeConnectorFolderPathSegment). If the
  // segment constant or the escape rules change, both producers move together
  // and this still holds; if only one side changed, it would break.
  function connectorFolderPath(basePath: string[], tableName: string): string {
    return '/' + [...basePath, tableName].filter(Boolean).map(escapeConnectorFolderPathSegment).join('/');
  }

  it.each([
    ['My Site', 'Blog Posts'],
    ['My Site', 'Team Members'],
    ['Acme/Co', 'Press*Releases'],
    ['My Site', 'Collections'], // the prefix case
  ])('site=%s collection=%s', (siteDisplayName, collectionName) => {
    const site: Site = { id: 'site-1', displayName: siteDisplayName };

    // What a v1 (flat) pull wrote to disk, and what a v2 (nested) pull would write.
    const connectorV1Path = connectorFolderPath(webflowCollectionBasePath(site, 1), collectionName);
    const connectorV2Path = connectorFolderPath(
      webflowCollectionBasePath(site, WEBFLOW_NESTED_STRUCTURE_VERSION),
      collectionName,
    );

    // The migration recomputes the v2 path from the existing v1 path + name.
    const migrated = computeNestedWebflowCollectionPath(connectorV1Path, collectionName);

    expect(migrated.kind).toBe('ok');
    if (migrated.kind === 'ok') {
      expect(migrated.newFolderPath).toBe(connectorV2Path);
    }
  });
});

// ---------------------------------------------------------------------------
// classifyWebflowTableByTableId (#13)
// ---------------------------------------------------------------------------

describe('classifyWebflowTableByTableId', () => {
  it('classifies a real collection id as collection', () => {
    expect(classifyWebflowTableByTableId(['site-1', 'collection-abc'])).toBe('collection');
  });

  it('classifies the synthetic Assets table by its tableId prefix', () => {
    expect(classifyWebflowTableByTableId(['site-1', `${WEBFLOW_ASSETS_TABLE_ID_PREFIX}site-1`])).toBe('assets');
  });

  it('classifies the synthetic Pages table by its tableId prefix', () => {
    expect(classifyWebflowTableByTableId(['site-1', `${WEBFLOW_PAGES_TABLE_ID_PREFIX}site-1`])).toBe('pages');
  });

  it('does NOT misclassify a collection a user named "Assets" (discriminates by tableId, not name)', () => {
    // Real collection id, not the __assets__ sentinel.
    expect(classifyWebflowTableByTableId(['site-1', 'collection-real'])).toBe('collection');
  });
});

// ---------------------------------------------------------------------------
// isCollectionsNamedCollectionFolder
// ---------------------------------------------------------------------------

describe('isCollectionsNamedCollectionFolder', () => {
  it('is true for a folder whose leaf is exactly "Collections"', () => {
    expect(isCollectionsNamedCollectionFolder('/My Site/Collections')).toBe(true);
  });

  it('is false for an ordinary collection folder', () => {
    expect(isCollectionsNamedCollectionFolder('/My Site/Blog Posts')).toBe(false);
  });

  it('is false for a malformed path', () => {
    expect(isCollectionsNamedCollectionFolder('/Collections')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rewriteFilePathFolderPrefix (#10 prefix-safety)
// ---------------------------------------------------------------------------

describe('rewriteFilePathFolderPrefix', () => {
  // The record/file-path columns store paths with NO leading slash (the system
  // convention enforced by validateRecordPath / path.replace(/^\//, '')), so the
  // executor passes — and these cases assert — the no-leading-slash form.
  it('swaps the folder prefix of a record file under the moved folder', () => {
    expect(rewriteFilePathFolderPrefix('My Site/Blog/rec123.json', 'My Site/Blog', 'My Site/Collections/Blog')).toBe(
      'My Site/Collections/Blog/rec123.json',
    );
  });

  it('does NOT touch a sibling folder that merely shares a string prefix (#10)', () => {
    // Moving "My Site/Blog" must not rewrite files under "My Site/Blog Posts".
    expect(rewriteFilePathFolderPrefix('My Site/Blog Posts/rec.json', 'My Site/Blog', 'My Site/Collections/Blog')).toBe(
      'My Site/Blog Posts/rec.json',
    );
  });

  it('leaves a path that is not under the folder unchanged', () => {
    expect(rewriteFilePathFolderPrefix('Other/rec.json', 'My Site/Blog', 'My Site/Collections/Blog')).toBe(
      'Other/rec.json',
    );
  });

  it('leaves the bare folder path (no trailing slash) unchanged — only files under it move', () => {
    expect(rewriteFilePathFolderPrefix('My Site/Blog', 'My Site/Blog', 'My Site/Collections/Blog')).toBe(
      'My Site/Blog',
    );
  });
});

// ---------------------------------------------------------------------------
// sortWebflowCollectionFoldersForSafeMoveOrder (move ordering)
// ---------------------------------------------------------------------------

describe('sortWebflowCollectionFoldersForSafeMoveOrder', () => {
  it('migrates a "Collections"-named collection before its siblings within the same site', () => {
    const folders = [
      { connectorAccountId: 'acct-1', path: '/My Site/Blog Posts' },
      { connectorAccountId: 'acct-1', path: '/My Site/Collections' }, // prefix case
      { connectorAccountId: 'acct-1', path: '/My Site/Team Members' },
    ];
    const ordered = sortWebflowCollectionFoldersForSafeMoveOrder(folders);
    expect(ordered.map((f) => f.path)).toEqual([
      '/My Site/Collections',
      '/My Site/Blog Posts',
      '/My Site/Team Members',
    ]);
  });

  it('orders the prefix case first independently within each site', () => {
    const folders = [
      { connectorAccountId: 'acct-1', path: '/Site A/Blog' },
      { connectorAccountId: 'acct-1', path: '/Site B/Posts' },
      { connectorAccountId: 'acct-1', path: '/Site B/Collections' },
      { connectorAccountId: 'acct-1', path: '/Site A/Collections' },
    ];
    const ordered = sortWebflowCollectionFoldersForSafeMoveOrder(folders);
    // Within Site A, Collections precedes Blog; within Site B, Collections precedes Posts.
    const siteA = ordered.filter((f) => f.path.startsWith('/Site A/')).map((f) => f.path);
    const siteB = ordered.filter((f) => f.path.startsWith('/Site B/')).map((f) => f.path);
    expect(siteA).toEqual(['/Site A/Collections', '/Site A/Blog']);
    expect(siteB).toEqual(['/Site B/Collections', '/Site B/Posts']);
  });

  it('preserves relative order of ordinary siblings (stable)', () => {
    const folders = [
      { connectorAccountId: 'acct-1', path: '/Site/Charlie' },
      { connectorAccountId: 'acct-1', path: '/Site/Alpha' },
      { connectorAccountId: 'acct-1', path: '/Site/Bravo' },
    ];
    const ordered = sortWebflowCollectionFoldersForSafeMoveOrder(folders);
    expect(ordered.map((f) => f.path)).toEqual(['/Site/Charlie', '/Site/Alpha', '/Site/Bravo']);
  });
});

// ---------------------------------------------------------------------------
// migrateWebflowCollectionFolder — the per-folder decision
// ---------------------------------------------------------------------------

describe('migrateWebflowCollectionFolder', () => {
  it('skips a folder already at the nested version (idempotency), touching nothing', async () => {
    const folder = makeCollectionFolder({ version: WEBFLOW_NESTED_STRUCTURE_VERSION });
    const { deps, collected } = makeDeps();

    const result = await migrateWebflowCollectionFolder(folder, deps);

    expect(result).toEqual({ kind: 'skipped_already_migrated' });
    expect(collected.gitMoveCalls).toHaveLength(0);
    expect(collected.rewriteCalls).toHaveLength(0);
    expect(collected.audits).toHaveLength(0);
  });

  it.each([
    ['assets', `${WEBFLOW_ASSETS_TABLE_ID_PREFIX}site-1`],
    ['pages', `${WEBFLOW_PAGES_TABLE_ID_PREFIX}site-1`],
  ])('skips the synthetic %s table (never moves), touching nothing', async (tableType, collectionId) => {
    const folder = makeCollectionFolder({ tableId: ['site-1', collectionId], name: tableType });
    const { deps, collected } = makeDeps();

    const result = await migrateWebflowCollectionFolder(folder, deps);

    expect(result).toEqual({ kind: 'skipped_not_a_collection', tableType });
    expect(collected.gitMoveCalls).toHaveLength(0);
    expect(collected.rewriteCalls).toHaveLength(0);
    expect(collected.audits).toHaveLength(0);
  });

  it('migrates a collection: git move + atomic rewrite + audit, all with the computed path', async () => {
    const folder = makeCollectionFolder();
    const { deps, collected } = makeDeps({ gitMoveOutcome: { kind: 'moved' } });

    const result = await migrateWebflowCollectionFolder(folder, deps);

    expect(result).toEqual({
      kind: 'migrated',
      oldPath: '/My Site/Blog Posts',
      newPath: '/My Site/Collections/Blog Posts',
      movedInGit: true,
    });
    expect(collected.uniquePathCalls).toEqual([
      { candidateFolderPath: '/My Site/Collections/Blog Posts', folderId: folder.id },
    ]);
    expect(collected.gitMoveCalls).toEqual([
      { oldFolderPath: '/My Site/Blog Posts', newFolderPath: '/My Site/Collections/Blog Posts' },
    ]);
    expect(collected.rewriteCalls).toEqual([
      {
        folderId: folder.id,
        workbookId: 'wb-1',
        connectorAccountId: 'acct-1',
        oldFolderPath: '/My Site/Blog Posts',
        newFolderPath: '/My Site/Collections/Blog Posts',
      },
    ]);
    expect(collected.audits).toHaveLength(1);
    expect(collected.audits[0].context.marker).toBe(WEBFLOW_FOLDER_RESTRUCTURE_AUDIT_MARKER);
    expect(collected.audits[0].entityId).toBe(folder.id);
  });

  it('migrates a CMS collection a user named "Assets" to /<Site>/Collections/Assets (regression)', async () => {
    const folder = makeCollectionFolder({
      name: 'Assets',
      path: '/My Site/Assets-a3f9c', // the flat-layout collision suffix
      tableId: ['site-1', 'collection-real'], // a real collection, NOT the __assets__ sentinel
    });
    const { deps, collected } = makeDeps();

    const result = await migrateWebflowCollectionFolder(folder, deps);

    expect(result).toMatchObject({ kind: 'migrated', newPath: '/My Site/Collections/Assets' });
    expect(collected.gitMoveCalls[0]).toEqual({
      oldFolderPath: '/My Site/Assets-a3f9c',
      newFolderPath: '/My Site/Collections/Assets',
    });
  });

  it('uses the re-suffixed path from ensureUniquePath when the target collides (A2)', async () => {
    const folder = makeCollectionFolder({ id: 'folder-xy12345' as DataFolderId });
    const { deps, collected } = makeDeps({
      ensureUniqueReturns: (candidate) => `${candidate}-12345`,
    });

    const result = await migrateWebflowCollectionFolder(folder, deps);

    expect(result).toMatchObject({ kind: 'migrated', newPath: '/My Site/Collections/Blog Posts-12345' });
    // The git move and the DB rewrite both use the de-collided path, not the raw one.
    expect(collected.gitMoveCalls[0].newFolderPath).toBe('/My Site/Collections/Blog Posts-12345');
    expect(collected.rewriteCalls[0].newFolderPath).toBe('/My Site/Collections/Blog Posts-12345');
  });

  it('skips (without DB rewrite) when the connection repo does not exist yet', async () => {
    const folder = makeCollectionFolder();
    const { deps, collected } = makeDeps({ gitMoveOutcome: { kind: 'repo_missing' } });

    const result = await migrateWebflowCollectionFolder(folder, deps);

    expect(result).toEqual({ kind: 'skipped_repo_missing', path: '/My Site/Blog Posts' });
    expect(collected.rewriteCalls).toHaveLength(0);
    expect(collected.audits).toHaveLength(0);
  });

  it('reports movedInGit=false when the git move was a no-op (already relocated, mid-run crash recovery)', async () => {
    const folder = makeCollectionFolder();
    const { deps } = makeDeps({ gitMoveOutcome: { kind: 'noop' } });

    const result = await migrateWebflowCollectionFolder(folder, deps);

    expect(result).toMatchObject({ kind: 'migrated', movedInGit: false });
  });

  it('skips a folder with a malformed path shape (#5), touching nothing', async () => {
    const folder = makeCollectionFolder({ path: '/OnlySite' });
    const { deps, collected } = makeDeps();

    const result = await migrateWebflowCollectionFolder(folder, deps);

    expect(result.kind).toBe('skipped_bad_path_shape');
    expect(collected.gitMoveCalls).toHaveLength(0);
    expect(collected.rewriteCalls).toHaveLength(0);
  });

  it('in dry-run, reports the would-be path and performs no writes', async () => {
    const folder = makeCollectionFolder();
    const { deps, collected } = makeDeps({ dryRun: true });

    const result = await migrateWebflowCollectionFolder(folder, deps);

    expect(result).toEqual({
      kind: 'would_migrate',
      oldPath: '/My Site/Blog Posts',
      newPath: '/My Site/Collections/Blog Posts',
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

describe('accumulateWebflowFolderRestructure', () => {
  it('tallies a mix of outcomes', () => {
    const summary = emptyWebflowFolderRestructureSummary();
    const results: WebflowCollectionFolderMigrationResult[] = [
      { kind: 'migrated', oldPath: '/a/b', newPath: '/a/Collections/b', movedInGit: true },
      { kind: 'migrated', oldPath: '/a/c', newPath: '/a/Collections/c', movedInGit: false },
      { kind: 'skipped_already_migrated' },
      { kind: 'skipped_not_a_collection', tableType: 'assets' },
      { kind: 'skipped_bad_path_shape', path: '/x', reason: 'bad' },
      { kind: 'skipped_repo_missing', path: '/a/d' },
      { kind: 'errored', error: new Error('boom') },
    ];
    for (const result of results) accumulateWebflowFolderRestructure(summary, result);

    expect(summary).toEqual({
      total: 7,
      migrated: 2,
      would_migrate: 0,
      skipped_already_migrated: 1,
      skipped_not_a_collection: 1,
      skipped_bad_path_shape: 1,
      skipped_repo_missing: 1,
      errored: 1,
    });
  });
});
