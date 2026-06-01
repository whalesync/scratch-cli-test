/**
 * V1-compatibility regression gate for the sync-mapping v1 → v2 migration
 * (DEV-10008).
 *
 * This is the dedicated spec the `sync_v1_compat` CI job runs in isolation. Its
 * green status is the green-light precondition before the dual-column v2
 * rollout proceeds: it proves that existing v1 `Sync.mappings` run byte-for-byte
 * identically through the v2-internal executor.
 *
 * The executor normalizes any v1 `TableMapping` to v2 at its entry point
 * (`ensureTableMappingV2` → `transformV1ToV2`). A transformed v1 mapping has no
 * `unmatchedDestinationPolicy` and every column mapping defaults to
 * `when: 'matched'`, so Pass 3 (the unmatched-destination write) is a no-op and
 * v1 syncs behave exactly as they did before v2 shipped. These tests lock that
 * invariant in against a real Postgres DB with mocked git + data-folder I/O,
 * mirroring `sync-service.spec.ts`.
 */

import { PrismaClient } from '@prisma/client';
import {
  ColumnMapping,
  createDataFolderId,
  createSyncId,
  createWorkbookId,
  DataFolderId,
  SyncId,
  SyncMappingV1,
  TableMapping,
  TableMappingV2,
  transformV1ToV2,
  WorkbookId,
} from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { ScheduleService } from 'src/schedule/schedule.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { SyncService } from 'src/sync/sync.service';
import { Actor } from 'src/users/types';
import { DataFolderService } from 'src/workbook/data-folder.service';

describe('SyncService - v1 compatibility regression gate', () => {
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

  // Files captured from commitFilesToBranch — the bytes the executor wrote.
  let writtenFiles: Array<{ path: string; content: string }>;
  // Schema map keyed by folder path — readSchemaFromGit returns per-folder spec.
  let gitSchemasByPath: Record<string, Record<string, unknown>>;

  // Wire a source/destination file fixture into the data-folder mock for a run.
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

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  beforeEach(async () => {
    writtenFiles = [];
    gitSchemasByPath = {
      '/src': { idColumnRemoteId: 'id' },
      '/dest': { idColumnRemoteId: 'id' },
    };

    dbService = { client: prisma } as unknown as DbService;

    dataFolderService = {
      getAllFileContentsByFolderId: jest.fn(),
      getFileContentsByFolderIdPaginated: jest.fn(),
      findOne: jest.fn(),
    } as unknown as DataFolderService;

    // Paginated reader delegates to the all-at-once mock (single page).
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
      data: { id: 'org_v1compat_' + Date.now(), name: 'Test Org', clerkId: 'clerk_v1compat_' + Date.now() },
    });
    orgId = org.id;

    const user = await prisma.user.create({
      data: { id: 'user_v1compat_' + Date.now(), email: `v1compat-${Date.now()}@example.com`, organizationId: org.id },
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

  it('creates new destination records from a v1 mapping (unchanged create behavior)', async () => {
    setFolderContents(
      [
        { path: 'src/file1.json', content: '{"id":"rec1","email":"john@example.com","name":"John"}' },
        { path: 'src/file2.json', content: '{"id":"rec2","email":"jane@example.com","name":"Jane"}' },
      ],
      [],
    );

    const columnMappings: ColumnMapping[] = [
      { sourceColumnId: 'email', destinationColumnId: 'email_address' },
      { sourceColumnId: 'name', destinationColumnId: 'full_name' },
    ];
    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings,
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email_address' },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    expect(result.recordsCreated).toBe(2);
    expect(result.recordsUpdated).toBe(0);
    expect(result.errors).toHaveLength(0);
    // Pass 3 never fires for a v1 mapping — counts stay zero.
    expect(result.unmatchedDestinationCounts).toEqual({
      withMatchKey: 0,
      withoutMatchKey: 0,
      archived: 0,
      unarchived: 0,
    });
    expect(writtenFiles).toHaveLength(2);
    const contents = writtenFiles.map((f) => JSON.parse(f.content) as Record<string, unknown>);
    expect(contents.every((c) => typeof c.email_address === 'string' && typeof c.full_name === 'string')).toBe(true);
  });

  it('updates matched records and preserves unmapped destination fields (unchanged merge behavior)', async () => {
    setFolderContents(
      [
        { path: 'src/file1.json', content: '{"id":"rec1","email":"john@example.com","name":"John Updated"}' },
        { path: 'src/file2.json', content: '{"id":"rec2","email":"jane@example.com","name":"Jane Updated"}' },
      ],
      [
        {
          path: 'dest/item1.json',
          content: '{"id":"dest1","email":"john@example.com","name":"John","phone":"555-1234","notes":"VIP"}',
        },
        {
          path: 'dest/item2.json',
          content: '{"id":"dest2","email":"jane@example.com","name":"Jane","phone":"555-5678"}',
        },
      ],
    );

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: [
        { sourceColumnId: 'email', destinationColumnId: 'email' },
        { sourceColumnId: 'name', destinationColumnId: 'name' },
      ],
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email' },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    expect(result.recordsCreated).toBe(0);
    expect(result.recordsUpdated).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(result.unmatchedDestinationCounts).toEqual({
      withMatchKey: 0,
      withoutMatchKey: 0,
      archived: 0,
      unarchived: 0,
    });

    const file1 = writtenFiles.find((f) => f.path === 'dest/item1.json');
    const file1Content = JSON.parse(file1!.content) as Record<string, unknown>;
    expect(file1Content.name).toBe('John Updated');
    expect(file1Content.phone).toBe('555-1234'); // unmapped field preserved
    expect(file1Content.notes).toBe('VIP'); // unmapped field preserved
    expect(file1Content.id).toBe('dest1');
  });

  it('leaves unmatched destination records untouched for a v1 mapping (Pass 3 no-op)', async () => {
    // dest "ghost" has a populated match key but no source counterpart this run.
    // Under v1 semantics (no unmatchedDestinationPolicy) it must be ignored.
    setFolderContents(
      [{ path: 'src/file1.json', content: '{"id":"rec1","email":"john@example.com","name":"John"}' }],
      [
        { path: 'dest/item1.json', content: '{"id":"dest1","email":"john@example.com","name":"John"}' },
        { path: 'dest/ghost.json', content: '{"id":"dest2","email":"ghost@example.com","name":"Ghost"}' },
      ],
    );

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: [{ sourceColumnId: 'name', destinationColumnId: 'name' }],
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email' },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    // The ghost record is never written and never counted by Pass 3.
    expect(writtenFiles.find((f) => f.path === 'dest/ghost.json')).toBeUndefined();
    expect(result.unmatchedDestinationCounts).toEqual({
      withMatchKey: 0,
      withoutMatchKey: 0,
      archived: 0,
      unarchived: 0,
    });
  });

  it('produces byte-identical writes whether run as v1 or as its transformV1ToV2 equivalent', async () => {
    // Update-only scenario (no creates → no random temp IDs) so the two runs are
    // deterministically comparable byte-for-byte.
    const sourceFiles = [
      { path: 'src/file1.json', content: '{"id":"rec1","email":"john@example.com","name":"John A"}' },
      { path: 'src/file2.json', content: '{"id":"rec2","email":"jane@example.com","name":"Jane A"}' },
    ];
    const destFiles = [
      { path: 'dest/item1.json', content: '{"id":"dest1","email":"john@example.com","name":"John"}' },
      { path: 'dest/item2.json', content: '{"id":"dest2","email":"jane@example.com","name":"Jane"}' },
    ];

    const v1TableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: [{ sourceColumnId: 'name', destinationColumnId: 'name' }],
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email' },
    };
    const v1Sync: SyncMappingV1 = { version: 1, tableMappings: [v1TableMapping] };
    const v2TableMapping: TableMappingV2 = transformV1ToV2(v1Sync).tableMappings[0];

    // Run 1: pass the v1 shape directly.
    setFolderContents(sourceFiles, destFiles);
    await syncService.syncTableMapping(syncId, v1TableMapping, workbookId, actor);
    const writesFromV1 = writtenFiles
      .map((f) => ({ path: f.path, content: f.content }))
      .sort((a, b) => a.path.localeCompare(b.path));

    // Run 2: pass the v2 transform of the same logical mapping. The executor
    // clears + rebuilds its caches each run, and the mock returns the same
    // fixture, so the inputs are identical.
    writtenFiles = [];
    setFolderContents(sourceFiles, destFiles);
    await syncService.syncTableMapping(syncId, v2TableMapping, workbookId, actor);
    const writesFromV2 = writtenFiles
      .map((f) => ({ path: f.path, content: f.content }))
      .sort((a, b) => a.path.localeCompare(b.path));

    expect(writesFromV1).toHaveLength(2);
    expect(writesFromV2).toEqual(writesFromV1);
  });
});
