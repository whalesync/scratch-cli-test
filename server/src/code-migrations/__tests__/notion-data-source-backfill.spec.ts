import { DataFolderId } from '@spinner/shared-types';
import {
  accumulate,
  AuditLogEntry,
  BACKFILL_AUDIT_MARKER,
  BackfillDeps,
  backfillNotionFolder,
  emptySummary,
  FolderResult,
  FolderToBackfill,
  NewDataFolderInput,
  NotionFetchOutcome,
} from '../notion-data-source-backfill';

// ---------------------------------------------------------------------------
// Test harness — collects every side effect so we can assert on the call graph.
// ---------------------------------------------------------------------------

interface CollectedSideEffects {
  updates: Array<{ folderId: DataFolderId; tableId: string[] }>;
  creates: NewDataFolderInput[];
  audits: AuditLogEntry[];
}

function makeDeps(
  outcome: NotionFetchOutcome,
  dryRun = false,
): { deps: BackfillDeps; collected: CollectedSideEffects } {
  const collected: CollectedSideEffects = { updates: [], creates: [], audits: [] };
  const deps: BackfillDeps = {
    dryRun,
    fetchDataSources: () => Promise.resolve(outcome),
    updateFolderTableId: (folderId, tableId) => {
      collected.updates.push({ folderId, tableId });
      return Promise.resolve();
    },
    createDataFolder: (input) => {
      collected.creates.push(input);
      return Promise.resolve(input.id);
    },
    logAudit: (entry) => {
      collected.audits.push(entry);
      return Promise.resolve();
    },
  };
  return { deps, collected };
}

function makeFolder(overrides: Partial<FolderToBackfill> = {}): FolderToBackfill {
  return {
    id: 'fld_test' as DataFolderId,
    workbookId: 'wbk_test',
    organizationId: 'org_test',
    connectorAccountId: 'cna_test',
    tableId: ['notion-db-1'],
    name: 'Project Tracker',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('backfillNotionFolder', () => {
  describe('idempotency', () => {
    it('skips folders that already have a 2-element tableId', async () => {
      const folder = makeFolder({ tableId: ['notion-db-1', 'notion-ds-1'] });
      // fetch should never be called — pass an outcome that would throw if it were
      const { deps, collected } = makeDeps({ kind: 'ok', dataSources: [{ id: 'x', name: 'x' }] });
      const result = await backfillNotionFolder(folder, deps);

      expect(result).toEqual({ kind: 'skipped_already_backfilled' });
      expect(collected.updates).toHaveLength(0);
      expect(collected.creates).toHaveLength(0);
      expect(collected.audits).toHaveLength(0);
    });

    it('errors out on a malformed empty tableId rather than silently overwriting', async () => {
      const folder = makeFolder({ tableId: [] });
      const { deps, collected } = makeDeps({ kind: 'ok', dataSources: [{ id: 'x', name: 'x' }] });
      const result = await backfillNotionFolder(folder, deps);

      expect(result.kind).toBe('errored');
      expect(collected.updates).toHaveLength(0);
    });
  });

  describe('single-source case', () => {
    it('rewrites tableId in place + writes one audit entry tagged with the backfill marker', async () => {
      const folder = makeFolder();
      const { deps, collected } = makeDeps({
        kind: 'ok',
        dataSources: [{ id: 'ds_primary', name: 'Project Tracker' }],
      });

      const result = await backfillNotionFolder(folder, deps);

      expect(result).toEqual({ kind: 'single_source_rewritten', dataSourceId: 'ds_primary' });
      expect(collected.updates).toEqual([{ folderId: folder.id, tableId: ['notion-db-1', 'ds_primary'] }]);
      expect(collected.creates).toHaveLength(0);
      expect(collected.audits).toHaveLength(1);
      expect(collected.audits[0].context.marker).toBe(BACKFILL_AUDIT_MARKER);
      expect(collected.audits[0].context.action).toBe('rewrite_tableid');
      expect(collected.audits[0].entityId).toBe(folder.id);
      expect(collected.audits[0].organizationId).toBe('org_test');
    });
  });

  describe('multi-source case — the key behavior for Phase 2', () => {
    it('rewrites existing folder to source[0] AND creates one new folder per additional source', async () => {
      const folder = makeFolder();
      const { deps, collected } = makeDeps({
        kind: 'ok',
        dataSources: [
          { id: 'ds_a', name: 'Tasks' },
          { id: 'ds_b', name: 'Bugs' },
          { id: 'ds_c', name: 'Backlog' },
        ],
      });

      const result = await backfillNotionFolder(folder, deps);

      // Existing folder rewritten to point at ds_a.
      expect(collected.updates).toEqual([{ folderId: folder.id, tableId: ['notion-db-1', 'ds_a'] }]);
      // Two new folders, one per additional source.
      expect(collected.creates).toHaveLength(2);
      expect(collected.creates[0]).toMatchObject({
        workbookId: 'wbk_test',
        connectorAccountId: 'cna_test',
        name: 'Bugs',
        tableId: ['notion-db-1', 'ds_b'],
      });
      expect(collected.creates[1]).toMatchObject({
        workbookId: 'wbk_test',
        connectorAccountId: 'cna_test',
        name: 'Backlog',
        tableId: ['notion-db-1', 'ds_c'],
      });

      // Result reports the new folder ids in creation order.
      expect(result.kind).toBe('multi_source_expanded');
      if (result.kind !== 'multi_source_expanded') throw new Error('unreachable');
      expect(result.primaryDataSourceId).toBe('ds_a');
      expect(result.newFolderIds).toHaveLength(2);
      // The new folder ids in the result should match the ids fed to createDataFolder.
      expect(result.newFolderIds[0]).toBe(collected.creates[0].id);
      expect(result.newFolderIds[1]).toBe(collected.creates[1].id);

      // Three audit entries: one for the rewrite, two for the new folders.
      // All carry the backfill marker so a future rollback can find them.
      expect(collected.audits).toHaveLength(3);
      expect(collected.audits.every((a) => a.context.marker === BACKFILL_AUDIT_MARKER)).toBe(true);

      // The rewrite entry references the existing folder; the new-folder
      // entries reference the new ids, not the original.
      expect(collected.audits[0].entityId).toBe(folder.id);
      expect(collected.audits[0].context.action).toBe('rewrite_tableid');
      expect(collected.audits[1].entityId).toBe(collected.creates[0].id);
      expect(collected.audits[1].context.action).toBe('create_folder_for_additional_source');
      expect(collected.audits[1].context.originalFolderId).toBe(folder.id);
      expect(collected.audits[2].entityId).toBe(collected.creates[1].id);
    });

    it('falls back to a generic name when a data source has an empty name', async () => {
      const folder = makeFolder();
      const { deps, collected } = makeDeps({
        kind: 'ok',
        dataSources: [
          { id: 'ds_a', name: 'Primary' },
          { id: 'ds_b', name: '' },
        ],
      });

      await backfillNotionFolder(folder, deps);

      expect(collected.creates[0].name).toBe('Project Tracker (source 2)');
    });
  });

  describe('error handling', () => {
    it('skips when the database is missing in Notion', async () => {
      const folder = makeFolder();
      const { deps, collected } = makeDeps({ kind: 'not_found' });

      const result = await backfillNotionFolder(folder, deps);

      expect(result).toEqual({ kind: 'skipped_missing_in_notion', reason: 'not_found' });
      expect(collected.updates).toHaveLength(0);
      expect(collected.audits).toHaveLength(0);
    });

    it('skips when the integration lost access (401)', async () => {
      const folder = makeFolder();
      const { deps, collected } = makeDeps({ kind: 'unauthorized' });

      const result = await backfillNotionFolder(folder, deps);

      expect(result).toEqual({ kind: 'skipped_missing_in_notion', reason: 'unauthorized' });
      expect(collected.updates).toHaveLength(0);
    });

    it('reports errored on a generic transport failure (caller decides whether to abort)', async () => {
      const folder = makeFolder();
      const err = new Error('connection reset');
      const { deps, collected } = makeDeps({ kind: 'error', error: err });

      const result = await backfillNotionFolder(folder, deps);

      expect(result).toEqual({ kind: 'errored', error: err });
      expect(collected.updates).toHaveLength(0);
    });

    it('errors out if Notion returns zero data sources (impossible per the API contract)', async () => {
      const folder = makeFolder();
      const { deps, collected } = makeDeps({ kind: 'ok', dataSources: [] });

      const result = await backfillNotionFolder(folder, deps);

      expect(result.kind).toBe('errored');
      expect(collected.updates).toHaveLength(0);
    });
  });

  describe('dry-run mode', () => {
    it('reports the decision but performs no writes for single-source', async () => {
      const folder = makeFolder();
      const { deps, collected } = makeDeps({ kind: 'ok', dataSources: [{ id: 'ds_a', name: 'A' }] }, true);

      const result = await backfillNotionFolder(folder, deps);

      expect(result.kind).toBe('single_source_rewritten');
      expect(collected.updates).toHaveLength(0);
      expect(collected.creates).toHaveLength(0);
      expect(collected.audits).toHaveLength(0);
    });

    it('reports the decision but performs no writes for multi-source', async () => {
      const folder = makeFolder();
      const { deps, collected } = makeDeps(
        {
          kind: 'ok',
          dataSources: [
            { id: 'ds_a', name: 'A' },
            { id: 'ds_b', name: 'B' },
          ],
        },
        true,
      );

      const result = await backfillNotionFolder(folder, deps);

      expect(result.kind).toBe('multi_source_expanded');
      // No DB writes; no audit log entries.
      expect(collected.updates).toHaveLength(0);
      expect(collected.creates).toHaveLength(0);
      expect(collected.audits).toHaveLength(0);
    });
  });
});

describe('accumulate', () => {
  it('counts each result kind and tallies multi-source new folder count', () => {
    const summary = emptySummary();
    const results: FolderResult[] = [
      { kind: 'single_source_rewritten', dataSourceId: 'a' },
      { kind: 'single_source_rewritten', dataSourceId: 'b' },
      {
        kind: 'multi_source_expanded',
        primaryDataSourceId: 'c',
        newFolderIds: ['fld_x' as DataFolderId, 'fld_y' as DataFolderId],
      },
      { kind: 'multi_source_expanded', primaryDataSourceId: 'd', newFolderIds: ['fld_z' as DataFolderId] },
      { kind: 'skipped_already_backfilled' },
      { kind: 'skipped_missing_in_notion', reason: 'not_found' },
      { kind: 'errored', error: new Error('x') },
    ];
    for (const r of results) accumulate(summary, r);

    expect(summary).toEqual({
      total: 7,
      single_source_rewritten: 2,
      multi_source_expanded: 2,
      multi_source_new_folders: 3, // 2 from the first expansion + 1 from the second
      skipped_already_backfilled: 1,
      skipped_missing_in_notion: 1,
      errored: 1,
    });
  });
});
