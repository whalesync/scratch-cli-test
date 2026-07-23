/**
 * End-to-end Pass 3 (unmatched-destination write) integration tests for the
 * sync archive feature (DEV-10008).
 *
 * Exercises the motivating worked example — when a source record disappears the
 * matching destination record is archived; matched records get the
 * matched-bucket value; hand-authored content is left alone — plus the gating
 * and defensive-runtime behaviors of Pass 3. Runs against a real Postgres DB
 * with mocked git + data-folder I/O, mirroring `sync-service.spec.ts`.
 *
 * Pass 3 only fires when ALL hold: phase === 'DATA', no single-record scope,
 * `recordMatching` configured, `unmatchedDestinationPolicy` has an `apply`
 * value, AND the match-key column exists in the destination schema. Several
 * tests pin each gate.
 */

import { PrismaClient } from '@prisma/client';
import {
  ConnectorMetadata,
  createDataFolderId,
  createSyncId,
  createWorkbookId,
  DataFolderId,
  SyncId,
  TableMappingV2,
  WorkbookId,
} from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { connectorRegistry } from 'src/remote-service/connectors/connector-registry';
import { ScheduleService } from 'src/schedule/schedule.service';
import { ScratchGitNotFoundError } from 'src/scratch-git/scratch-git.client';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { SyncService } from 'src/sync/sync.service';
import { Actor } from 'src/users/types';
import { DataFolderService } from 'src/workbook/data-folder.service';

// Destination schema that DECLARES the match-key column (`email`), so Pass 3's
// "match-key column exists in destination schema" gate passes.
const DEST_SCHEMA_WITH_EMAIL = {
  idPath: 'id',
  schema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      email: { type: 'string' },
      name: { type: 'string' },
      archived: { type: 'boolean' },
    },
  },
};

describe('SyncService - Pass 3 unmatched-destination write (archive)', () => {
  let prisma: PrismaClient;
  let syncService: SyncService;
  let dataFolderService: DataFolderService;
  let scratchGitService: ScratchGitService;
  let dbService: DbService;

  let workbookId: WorkbookId;
  let sourceFolderId: DataFolderId;
  let destFolderId: DataFolderId;
  let syncId: SyncId;
  let orgId: string;
  let userId: string;
  const actor: Actor = { userId: 'test-user', organizationId: 'test-org' };

  let writtenFiles: Array<{ path: string; content: string }>;
  let gitSchemasByPath: Record<string, Record<string, unknown>>;

  const setFolderContents = (
    sourceFiles: Array<{ path: string; content: string }>,
    destFiles: Array<{ path: string; content: string }>,
  ): void => {
    (dataFolderService.getAllFileContentsByFolderId as jest.Mock).mockImplementation((_workbookIdArg, folderIdArg) => {
      if (folderIdArg === sourceFolderId) {
        return Promise.resolve(sourceFiles.map((f) => ({ folderId: sourceFolderId, ...f })));
      }
      if (folderIdArg === destFolderId) {
        return Promise.resolve(destFiles.map((f) => ({ folderId: destFolderId, ...f })));
      }
      return Promise.resolve([]);
    });
  };

  const writtenByPath = (path: string): Record<string, unknown> | undefined => {
    const file = writtenFiles.find((f) => f.path === path);
    return file ? (JSON.parse(file.content) as Record<string, unknown>) : undefined;
  };

  // The DEV-10008 column mappings: copy `name`, force `archived` false for
  // matched records and true for unmatched-destination records.
  const archiveColumnMappings = (): TableMappingV2['columnMappings'] => [
    { destinationColumnId: 'name', source: { kind: 'column', columnId: 'name' } },
    { destinationColumnId: 'archived', when: 'matched', source: { kind: 'constant', value: false } },
    { destinationColumnId: 'archived', when: 'unmatched', source: { kind: 'constant', value: true } },
  ];

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  beforeEach(async () => {
    writtenFiles = [];
    gitSchemasByPath = {
      '/src': { idPath: 'id' },
      '/dest': DEST_SCHEMA_WITH_EMAIL,
    };

    dbService = { client: prisma } as unknown as DbService;

    dataFolderService = {
      getAllFileContentsByFolderId: jest.fn(),
      getFileContentsByFolderIdPaginated: jest.fn(),
      findOne: jest.fn(),
    } as unknown as DataFolderService;

    (dataFolderService.getFileContentsByFolderIdPaginated as jest.Mock).mockImplementation(
      async (wbId, folderId, actorArg, branch, cursor) => {
        if (cursor) {
          return { files: [], nextCursor: undefined };
        }
        const files = ((await (dataFolderService.getAllFileContentsByFolderId as jest.Mock)(
          wbId,
          folderId,
          actorArg,
          branch,
        )) ?? []) as { folderId: DataFolderId; path: string; content: string }[];
        return { files, nextCursor: undefined };
      },
    );

    scratchGitService = {
      resolveRepoId: jest.fn().mockImplementation((wkbId: WorkbookId) => Promise.resolve(wkbId)),
      resolveConnectionRepoPath: jest
        .fn()
        .mockImplementation((connectorAccountId: string) => Promise.resolve(connectorAccountId)),
      readSchemaFromGit: jest.fn().mockImplementation((_repoId: string, folderPath: string) => {
        return Promise.resolve(gitSchemasByPath[folderPath] ?? null);
      }),
      commitFilesToBranch: jest
        .fn()
        .mockImplementation((_workbookId, _branch, files: Array<{ path: string; content: string }>) => {
          writtenFiles.push(...files);
          return Promise.resolve({ created: [], updated: [], unchanged: [] });
        }),
    } as unknown as ScratchGitService;

    const scheduleService = { create: jest.fn(), update: jest.fn(), delete: jest.fn() } as unknown as ScheduleService;
    syncService = new SyncService(
      dbService,
      dataFolderService,
      {} as PostHogService,
      scheduleService,
      scratchGitService,
      {} as never,
      {} as never,
    );

    const org = await prisma.organization.create({
      data: { id: 'org_archive_' + Date.now(), name: 'Test Org', clerkId: 'clerk_archive_' + Date.now() },
    });
    orgId = org.id;

    const user = await prisma.user.create({
      data: { id: 'user_archive_' + Date.now(), email: `archive-${Date.now()}@example.com`, organizationId: org.id },
    });
    userId = user.id;

    const wbId = createWorkbookId();
    await prisma.workbook.create({
      data: { id: wbId, name: 'Test Workbook', userId: user.id, organizationId: org.id },
    });
    workbookId = wbId;

    const srcFolderId = createDataFolderId();
    await prisma.dataFolder.create({ data: { id: srcFolderId, name: 'Source Folder', workbookId, path: '/src' } });
    sourceFolderId = srcFolderId;

    const dstFolderId = createDataFolderId();
    await prisma.dataFolder.create({
      data: { id: dstFolderId, name: 'Destination Folder', workbookId, path: '/dest' },
    });
    destFolderId = dstFolderId;

    (dataFolderService.findOne as jest.Mock).mockImplementation((folderId) => {
      if (folderId === destFolderId) return Promise.resolve({ path: '/dest' });
      return Promise.resolve({ path: '/src' });
    });

    const synId = createSyncId();
    await prisma.sync.create({ data: { id: synId, displayName: 'Test Sync', mappings: [] } });
    syncId = synId;
  });

  afterEach(async () => {
    await prisma.sync.delete({ where: { id: syncId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.organization.delete({ where: { id: orgId } });
    await prisma.syncMatchKeys.deleteMany({ where: { syncId } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Standard 2-source / 4-destination archive fixture. d1/d2 are matched; d3 is
  // an unmatched record with a populated match key (source deleted upstream);
  // d4 is hand-authored content with no match key.
  const seedArchiveFixture = (): void => {
    setFolderContents(
      [
        { path: 'src/s1.json', content: '{"id":"s1","email":"john@example.com","name":"John"}' },
        { path: 'src/s2.json', content: '{"id":"s2","email":"jane@example.com","name":"Jane"}' },
      ],
      [
        { path: 'dest/d1.json', content: '{"id":"dest1","email":"john@example.com","name":"John","archived":true}' },
        { path: 'dest/d2.json', content: '{"id":"dest2","email":"jane@example.com","name":"Jane","archived":false}' },
        { path: 'dest/d3.json', content: '{"id":"dest3","email":"bob@example.com","name":"Bob","archived":false}' },
        { path: 'dest/d4.json', content: '{"id":"dest4","email":"","name":"Hand authored","archived":false}' },
      ],
    );
  };

  it('archives an unmatched-with-key record, leaves hand-authored content alone (DEV-10008 worked example)', async () => {
    seedArchiveFixture();
    const tableMapping: TableMappingV2 = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: archiveColumnMappings(),
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email' },
      unmatchedDestinationPolicy: { withMatchKey: 'apply', withoutMatchKey: 'ignore' },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    expect(result.errors).toHaveLength(0);
    expect(result.recordsCreated).toBe(0);

    // d3 (unmatched, has key) is archived by Pass 3.
    const d3 = writtenByPath('dest/d3.json');
    expect(d3).toBeDefined();
    expect(d3!.archived).toBe(true);
    expect(d3!.email).toBe('bob@example.com'); // identity preserved
    expect(d3!.name).toBe('Bob'); // unmatched bucket only applies constants

    // d1 (matched) gets the matched-bucket constant: archived flips true → false.
    const d1 = writtenByPath('dest/d1.json');
    expect(d1).toBeDefined();
    expect(d1!.archived).toBe(false);

    // d2 (matched, already correct) is a no-op write. d4 (no match key) is ignored.
    expect(writtenByPath('dest/d2.json')).toBeUndefined();
    expect(writtenByPath('dest/d4.json')).toBeUndefined();

    expect(result.unmatchedDestinationCounts).toEqual({
      withMatchKey: 1, // d3
      withoutMatchKey: 1, // d4 (visited + counted, but ignored)
      archived: 1, // d3 written
      unarchived: 1, // d1 written in Pass 2 with a matched constant present
      deleted: 0,
    });
  });

  it('archives hand-authored records too when withoutMatchKey is apply (sync owns the whole collection)', async () => {
    seedArchiveFixture();
    const tableMapping: TableMappingV2 = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: archiveColumnMappings(),
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email' },
      unmatchedDestinationPolicy: { withMatchKey: 'apply', withoutMatchKey: 'apply' },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    const d3 = writtenByPath('dest/d3.json');
    const d4 = writtenByPath('dest/d4.json');
    expect(d3!.archived).toBe(true);
    expect(d4).toBeDefined();
    expect(d4!.archived).toBe(true);
    expect(result.unmatchedDestinationCounts).toEqual({
      withMatchKey: 1,
      withoutMatchKey: 1,
      archived: 2, // d3 + d4
      unarchived: 1,
      deleted: 0,
    });
  });

  it('is a no-op when the policy is all-ignore (Pass 3 gated off)', async () => {
    seedArchiveFixture();
    const tableMapping: TableMappingV2 = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: archiveColumnMappings(),
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email' },
      unmatchedDestinationPolicy: { withMatchKey: 'ignore', withoutMatchKey: 'ignore' },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    expect(writtenByPath('dest/d3.json')).toBeUndefined();
    expect(writtenByPath('dest/d4.json')).toBeUndefined();
    // Pass 3 never classified anything; only Pass 2's matched-constant counter moved.
    expect(result.unmatchedDestinationCounts).toEqual({
      withMatchKey: 0,
      withoutMatchKey: 0,
      archived: 0,
      unarchived: 1,
      deleted: 0,
    });
  });

  it('treats an empty/never-pulled destination folder (scratch-git 404) as zero existing records and still creates source records', async () => {
    // Regression: an empty (or not-yet-populated) destination folder has zero files,
    // so git tracks no directory for it and a path-scoped read returns 404. The Pass 1
    // destination read must treat that as "0 existing records" rather than failing the
    // whole sync — e.g. syncing into a brand-new/empty Webflow collection.
    // Found by /investigate on 2026-06-01 (sync syn_MOS5XHuygU, empty Webflow collection).
    setFolderContents(
      [
        { path: 'src/s1.json', content: '{"id":"s1","email":"john@example.com","name":"John"}' },
        { path: 'src/s2.json', content: '{"id":"s2","email":"jane@example.com","name":"Jane"}' },
      ],
      [],
    );
    // Override the paginated read so the destination folder 404s like an empty git folder.
    (dataFolderService.getFileContentsByFolderIdPaginated as jest.Mock).mockImplementation(
      async (wbId, folderId, actorArg, branch) => {
        if (folderId === destFolderId) {
          throw new ScratchGitNotFoundError(
            '/api/repo/read/org%2Fwkb%2Fcoa/files-paginated?branch=dirty&folder=dest&limit=1000',
            'folder not found',
          );
        }
        const files = ((await (dataFolderService.getAllFileContentsByFolderId as jest.Mock)(
          wbId,
          folderId,
          actorArg,
          branch,
        )) ?? []) as { folderId: DataFolderId; path: string; content: string }[];
        return { files, nextCursor: undefined };
      },
    );

    const tableMapping: TableMappingV2 = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: archiveColumnMappings(),
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email' },
      unmatchedDestinationPolicy: { withMatchKey: 'apply', withoutMatchKey: 'ignore' },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    // No crash: the 404 destination read is treated as 0 existing records.
    expect(result.errors).toHaveLength(0);
    // Both source records create into the empty destination (unmatched-source path).
    expect(result.recordsCreated).toBe(2);
    // Pass 3 saw no destination records to classify or archive.
    expect(result.unmatchedDestinationCounts.withMatchKey).toBe(0);
    expect(result.unmatchedDestinationCounts.withoutMatchKey).toBe(0);
    expect(result.unmatchedDestinationCounts.archived).toBe(0);
  });

  it('is a no-op when scoped to a single source file (syncOneRecord path)', async () => {
    seedArchiveFixture();
    const tableMapping: TableMappingV2 = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: archiveColumnMappings(),
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email' },
      unmatchedDestinationPolicy: { withMatchKey: 'apply', withoutMatchKey: 'apply' },
    };

    // onlySourceFilePath set → Pass 3 must not run (would archive everything
    // outside the single record's scope).
    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor, 'DATA', 'src/s1.json');

    expect(writtenByPath('dest/d3.json')).toBeUndefined();
    expect(writtenByPath('dest/d4.json')).toBeUndefined();
    expect(result.unmatchedDestinationCounts.withMatchKey).toBe(0);
    expect(result.unmatchedDestinationCounts.withoutMatchKey).toBe(0);
    expect(result.unmatchedDestinationCounts.archived).toBe(0);
  });

  it('is a no-op when recordMatching is unset (no way to classify destination records)', async () => {
    // Empty source so Pass 2 creates nothing; dest has unmatched records.
    setFolderContents(
      [],
      [
        { path: 'dest/d3.json', content: '{"id":"dest3","email":"bob@example.com","name":"Bob","archived":false}' },
        { path: 'dest/d4.json', content: '{"id":"dest4","email":"","name":"Hand authored","archived":false}' },
      ],
    );
    const tableMapping: TableMappingV2 = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: archiveColumnMappings(),
      // recordMatching intentionally omitted.
      unmatchedDestinationPolicy: { withMatchKey: 'apply', withoutMatchKey: 'apply' },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    expect(writtenFiles).toHaveLength(0);
    expect(result.unmatchedDestinationCounts).toEqual({
      withMatchKey: 0,
      withoutMatchKey: 0,
      archived: 0,
      unarchived: 0,
      deleted: 0,
    });
  });

  it('skips Pass 3 (never crashes) when the match-key column is missing from the destination schema', async () => {
    // Destination schema omits `email` → the match-key existence gate fails.
    gitSchemasByPath['/dest'] = {
      idPath: 'id',
      schema: { type: 'object', properties: { id: { type: 'string' }, archived: { type: 'boolean' } } },
    };
    seedArchiveFixture();
    const tableMapping: TableMappingV2 = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: archiveColumnMappings(),
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email' },
      unmatchedDestinationPolicy: { withMatchKey: 'apply', withoutMatchKey: 'apply' },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    expect(result.errors).toHaveLength(0);
    // Pass 2 still ran (matching uses field values, not schema), but Pass 3 bailed.
    expect(writtenByPath('dest/d3.json')).toBeUndefined();
    expect(result.unmatchedDestinationCounts.withMatchKey).toBe(0);
    expect(result.unmatchedDestinationCounts.withoutMatchKey).toBe(0);
    expect(result.unmatchedDestinationCounts.archived).toBe(0);
  });

  it('defensively strips a constant mapping that targets the match-key column at runtime', async () => {
    // Simulates a manually-edited DB row that smuggled a constant onto the
    // match-key column. Pass 3 must omit it and never overwrite the identifier.
    seedArchiveFixture();
    const tableMapping: TableMappingV2 = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: [
        ...archiveColumnMappings(),
        { destinationColumnId: 'email', when: 'unmatched', source: { kind: 'constant', value: 'HACKED@example.com' } },
      ],
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email' },
      unmatchedDestinationPolicy: { withMatchKey: 'apply', withoutMatchKey: 'ignore' },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    const d3 = writtenByPath('dest/d3.json');
    expect(d3).toBeDefined();
    expect(d3!.email).toBe('bob@example.com'); // match key NOT overwritten
    expect(d3!.archived).toBe(true); // archive rule still applied
    expect(result.errors).toHaveLength(0);
  });

  it('classifies a whitespace-only match key as unmatchedWithoutMatchKey', async () => {
    setFolderContents(
      [{ path: 'src/s1.json', content: '{"id":"s1","email":"john@example.com","name":"John"}' }],
      [
        { path: 'dest/d1.json', content: '{"id":"dest1","email":"john@example.com","name":"John","archived":false}' },
        { path: 'dest/ws.json', content: '{"id":"dest9","email":"   ","name":"Whitespace","archived":false}' },
      ],
    );
    const tableMapping: TableMappingV2 = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: archiveColumnMappings(),
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email' },
      // Only without-key applies — so a write to the whitespace record proves it
      // was classified into the without-key bucket, not with-key.
      unmatchedDestinationPolicy: { withMatchKey: 'ignore', withoutMatchKey: 'apply' },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    expect(result.unmatchedDestinationCounts.withMatchKey).toBe(0);
    expect(result.unmatchedDestinationCounts.withoutMatchKey).toBe(1);
    const ws = writtenByPath('dest/ws.json');
    expect(ws).toBeDefined();
    expect(ws!.archived).toBe(true);
  });

  // ===========================================================================
  // DEV-11013: Pass 2 unarchive repair for a MATCHED destination record whose
  // source still exists but which was archived in the service with no field
  // drift. Distinct from the DEV-10008 constant-mapping path above: no
  // `when: 'matched'` constant is configured — the sync consults the connector's
  // registry hook and forces the unarchive write automatically.
  // ===========================================================================
  describe('DEV-11013: unarchive matched destination record with no field drift', () => {
    const ARCHIVE_REPAIR_SERVICE = 'FAKE_ARCHIVE_REPAIR_SVC';

    beforeAll(() => {
      // Register a throwaway connector whose archive-repair hook clears a boolean
      // `archived` flag. Exercises the generic sync path (registry lookup →
      // overlay → forced write) without coupling this suite to a real connector.
      // The connector-registry is a per-test-file singleton, so one registration
      // holds for the whole suite and never collides with other files.
      if (!connectorRegistry.get(ARCHIVE_REPAIR_SERVICE)) {
        connectorRegistry.register({
          service: ARCHIVE_REPAIR_SERVICE,
          metadata: {} as ConnectorMetadata,
          advancedSettings: [],
          supportedAuthMethods: [],
          createConnector: () => Promise.reject(new Error('not instantiated in this test')),
          resolveMatchedRecordArchiveRepairFields: (fields) => (fields.archived === true ? { archived: false } : null),
        });
      }
    });

    const matchOnlyMapping = (): TableMappingV2 => ({
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: [{ destinationColumnId: 'name', source: { kind: 'column', columnId: 'name' } }],
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email' },
    });

    it('forces an unarchive write for a matched record even when no mapped field drifted', async () => {
      await prisma.dataFolder.update({
        where: { id: destFolderId },
        data: { connectorService: ARCHIVE_REPAIR_SERVICE },
      });
      // Source and destination agree on every mapped field (name); the only
      // difference is the destination is archived. Without the repair hook the
      // isEqual no-op skip would leave it archived (the DEV-11013 bug).
      setFolderContents(
        [{ path: 'src/s1.json', content: '{"id":"s1","email":"john@example.com","name":"John"}' }],
        [{ path: 'dest/d1.json', content: '{"id":"dest1","email":"john@example.com","name":"John","archived":true}' }],
      );

      const result = await syncService.syncTableMapping(syncId, matchOnlyMapping(), workbookId, actor);

      expect(result.errors).toHaveLength(0);
      const d1 = writtenByPath('dest/d1.json');
      expect(d1).toBeDefined();
      expect(d1).toMatchObject({ id: 'dest1', name: 'John', archived: false });
      expect(result.recordsUpdated).toBe(1);
      expect(result.unmatchedDestinationCounts.unarchived).toBe(1);
    });

    it('leaves a matched but non-archived record untouched (no spurious write)', async () => {
      await prisma.dataFolder.update({
        where: { id: destFolderId },
        data: { connectorService: ARCHIVE_REPAIR_SERVICE },
      });
      setFolderContents(
        [{ path: 'src/s1.json', content: '{"id":"s1","email":"john@example.com","name":"John"}' }],
        [{ path: 'dest/d1.json', content: '{"id":"dest1","email":"john@example.com","name":"John","archived":false}' }],
      );

      const result = await syncService.syncTableMapping(syncId, matchOnlyMapping(), workbookId, actor);

      expect(writtenByPath('dest/d1.json')).toBeUndefined();
      expect(result.recordsUpdated).toBe(0);
      expect(result.unmatchedDestinationCounts.unarchived).toBe(0);
    });
  });
});
