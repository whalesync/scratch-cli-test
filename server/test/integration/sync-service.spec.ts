import { PrismaClient } from '@prisma/client';
import {
  ColumnMapping,
  createConnectorAccountId,
  createDataFolderId,
  createSyncId,
  createSyncTablePairId,
  createWorkbookId,
  DataFolderId,
  SyncId,
  TableMapping,
  WorkbookId,
} from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { ScheduleService } from 'src/schedule/schedule.service';
import { DIRTY_BRANCH, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { SyncService } from 'src/sync/sync.service';
import { Actor } from 'src/users/types';
import { DataFolderService } from 'src/workbook/data-folder.service';

describe('SyncService - fillSyncCaches', () => {
  let prisma: PrismaClient;
  let syncService: SyncService;
  let dataFolderService: DataFolderService;
  let scratchGitService: ScratchGitService;
  let dbService: DbService;

  // Test data
  let workbookId: WorkbookId;
  let sourceFolderId: DataFolderId;
  let destFolderId: DataFolderId;
  let syncId: SyncId;
  let orgId: string;
  let userId: string;

  beforeAll(() => {
    // Initialize Prisma client
    prisma = new PrismaClient();
  });

  beforeEach(async () => {
    // Create mock instances
    dbService = { client: prisma } as unknown as DbService;

    // We'll mock DataFolderService since it depends on git operations
    dataFolderService = {
      getAllFileContentsByFolderId: jest.fn(),
    } as unknown as DataFolderService;

    // Shouldn't be called
    scratchGitService = {
      resolveRepoId: jest.fn().mockImplementation((wkbId: WorkbookId) => Promise.resolve(wkbId)),
      resolveConnectionRepoPath: jest
        .fn()
        .mockImplementation((connectorAccountId: string) => Promise.resolve(connectorAccountId)),
    } as unknown as ScratchGitService;

    // Create SyncService instance (workbookService not needed for these tests)
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

    // Create test organization
    const org = await prisma.organization.create({
      data: {
        id: 'org_test_' + Date.now(),
        name: 'Test Org',
        clerkId: 'clerk_' + Date.now(),
      },
    });
    orgId = org.id;

    // Create user
    const user = await prisma.user.create({
      data: {
        id: 'user_test_' + Date.now(),
        email: `test-${Date.now()}@example.com`,
        organizationId: org.id,
      },
    });
    userId = user.id;

    // Create workbook
    const wbId = createWorkbookId();
    await prisma.workbook.create({
      data: {
        id: wbId,
        name: 'Test Workbook',
        userId: user.id,
        organizationId: org.id,
      },
    });
    workbookId = wbId;

    // Create source and destination data folders
    const srcFolderId = createDataFolderId();
    await prisma.dataFolder.create({
      data: {
        id: srcFolderId,
        name: 'Source Folder',
        workbookId,
      },
    });
    sourceFolderId = srcFolderId;

    const dstFolderId = createDataFolderId();
    await prisma.dataFolder.create({
      data: {
        id: dstFolderId,
        name: 'Destination Folder',
        workbookId,
      },
    });
    destFolderId = dstFolderId;

    // Create sync
    const synId = createSyncId();
    await prisma.sync.create({
      data: {
        id: synId,
        displayName: 'Test Sync',
        mappings: [],
      },
    });
    syncId = synId;
  });

  afterEach(async () => {
    // Clean up test data belonging to this test run only
    // Sync deletion cascades to SyncMatchKeys and SyncRemoteIdMapping
    // Org deletion cascades to workbook → dataFolder (and also to sync caches via dataFolderId)
    await prisma.sync.delete({ where: { id: syncId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.organization.delete({ where: { id: orgId } });
    await prisma.syncMatchKeys.deleteMany({ where: { syncId: syncId } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('should populate SyncMatchKeys and SyncRemoteIdMapping for matching records', async () => {
    // Create source and destination records
    const sourceRecords = [
      { id: '/file1.json', filePath: '/file1.json', fields: { email: 'john@example.com' } },
      { id: '/file2.json', filePath: '/file2.json', fields: { email: 'jane@example.com' } },
      { id: '/file3.json', filePath: '/file3.json', fields: { email: 'bob@example.com' } },
    ];

    const destinationRecords = [
      { id: '/item1.json', filePath: '/item1.json', fields: { email: 'john@example.com' } },
      { id: '/item2.json', filePath: '/item2.json', fields: { email: 'jane@example.com' } },
    ];

    // Create table mapping with record matching
    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: [],
      recordMatching: {
        sourceColumnId: 'email',
        destinationColumnId: 'email',
      },
    };

    // Call fillSyncCaches with records
    await syncService.fillSyncCachesBatch(syncId, tableMapping, sourceRecords, destinationRecords);
    await syncService.buildRecordMatchingMappings(syncId, tableMapping);

    // Verify SyncMatchKeys were inserted for both sides
    const sourceMatches = await prisma.syncMatchKeys.findMany({
      where: { syncId, dataFolderId: sourceFolderId },
    });
    expect(sourceMatches).toHaveLength(3);
    const sourceRemoteIds = (sourceMatches as { remoteId: string }[]).map((m) => m.remoteId);
    sourceRemoteIds.sort();
    const expectedSourceIds = ['/file1.json', '/file2.json', '/file3.json'];
    expectedSourceIds.sort();
    expect(sourceRemoteIds).toEqual(expectedSourceIds);

    const destMatches = await prisma.syncMatchKeys.findMany({
      where: { syncId, dataFolderId: destFolderId },
    });
    expect(destMatches).toHaveLength(2);
    const destRemoteIds = (destMatches as { remoteId: string }[]).map((m) => m.remoteId);
    destRemoteIds.sort();
    const expectedDestIds = ['/item1.json', '/item2.json'];
    expectedDestIds.sort();
    expect(destRemoteIds).toEqual(expectedDestIds);

    // Verify SyncRemoteIdMappings were created for all source records
    // (matched records have both destinationRemoteId and destinationFilePath, unmatched have null)
    const mappings = await prisma.syncRemoteIdMapping.findMany({
      where: { syncId, dataFolderId: sourceFolderId },
    });

    expect(mappings).toHaveLength(3);

    // Verify mapping integrity: destinationRemoteId is the record ID, destinationFilePath is the file path
    const johnMapping = mappings.find((m) => m.sourceRemoteId === '/file1.json');
    expect(johnMapping).toBeDefined();
    expect(johnMapping?.destinationRemoteId).toBe('/item1.json');
    expect(johnMapping?.destinationFilePath).toBe('/item1.json');

    const janeMapping = mappings.find((m) => m.sourceRemoteId === '/file2.json');
    expect(janeMapping).toBeDefined();
    expect(janeMapping?.destinationRemoteId).toBe('/item2.json');
    expect(janeMapping?.destinationFilePath).toBe('/item2.json');

    // Bob's file should have null destination fields since it doesn't exist in destination
    const bobMapping = mappings.find((m) => m.sourceRemoteId === '/file3.json');
    expect(bobMapping).toBeDefined();
    expect(bobMapping?.destinationRemoteId).toBeNull();
    expect(bobMapping?.destinationFilePath).toBeNull();
  });

  it('should handle empty record lists', async () => {
    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: [],
      recordMatching: {
        sourceColumnId: 'email',
        destinationColumnId: 'email',
      },
    };

    await syncService.fillSyncCachesBatch(syncId, tableMapping, [], []);
    await syncService.buildRecordMatchingMappings(syncId, tableMapping);

    const matchKeys = await prisma.syncMatchKeys.findMany({ where: { syncId } });
    expect(matchKeys).toHaveLength(0);

    const mappings = await prisma.syncRemoteIdMapping.findMany({ where: { syncId } });
    expect(mappings).toHaveLength(0);
  });

  it('should handle records without matching column values', async () => {
    // Records without the matching column
    const sourceRecords = [{ id: '/file1.json', filePath: '/file1.json', fields: { name: 'John' } }];
    const destinationRecords = [{ id: '/item1.json', filePath: '/item1.json', fields: { name: 'Jane' } }];

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: [],
      recordMatching: {
        sourceColumnId: 'email', // Column doesn't exist in records
        destinationColumnId: 'email',
      },
    };

    await syncService.fillSyncCachesBatch(syncId, tableMapping, sourceRecords, destinationRecords);
    await syncService.buildRecordMatchingMappings(syncId, tableMapping);

    // No mappings should be created since no match keys were created
    // (records don't have the matching column values)
    const mappings = await prisma.syncRemoteIdMapping.findMany({ where: { syncId } });
    expect(mappings).toHaveLength(0);
  });

  it('should populate SyncMatchKeys using dot-separated paths for nested fields', async () => {
    const sourceRecords = [
      { id: '/file1.json', filePath: '/file1.json', fields: { meta: { email: 'john@example.com' } } },
      { id: '/file2.json', filePath: '/file2.json', fields: { meta: { email: 'jane@example.com' } } },
    ];

    const destinationRecords = [
      { id: '/item1.json', filePath: '/item1.json', fields: { contact: { email: 'john@example.com' } } },
    ];

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: [],
      recordMatching: {
        sourceColumnId: 'meta.email',
        destinationColumnId: 'contact.email',
      },
    };

    await syncService.fillSyncCachesBatch(syncId, tableMapping, sourceRecords, destinationRecords);
    await syncService.buildRecordMatchingMappings(syncId, tableMapping);

    // Source match keys should be created for both records
    const sourceMatches = await prisma.syncMatchKeys.findMany({
      where: { syncId, dataFolderId: sourceFolderId },
    });
    expect(sourceMatches).toHaveLength(2);

    // Destination match keys should be created for the one record
    const destMatches = await prisma.syncMatchKeys.findMany({
      where: { syncId, dataFolderId: destFolderId },
    });
    expect(destMatches).toHaveLength(1);

    // John should be matched across source and destination
    const mappings = await prisma.syncRemoteIdMapping.findMany({
      where: { syncId, dataFolderId: sourceFolderId },
    });
    expect(mappings).toHaveLength(2);

    const johnMapping = mappings.find((m) => m.sourceRemoteId === '/file1.json');
    expect(johnMapping).toBeDefined();
    expect(johnMapping?.destinationRemoteId).toBe('/item1.json');
    expect(johnMapping?.destinationFilePath).toBe('/item1.json');

    const janeMapping = mappings.find((m) => m.sourceRemoteId === '/file2.json');
    expect(janeMapping).toBeDefined();
    expect(janeMapping?.destinationRemoteId).toBeNull();
    expect(janeMapping?.destinationFilePath).toBeNull();
  });

  it('collapses two source match keys sharing a remote ID, keeping the one that matched a destination', async () => {
    // SyncMatchKeys is unique on (syncId, dataFolderId, matchId), not on remoteId, so
    // two records with the same id but different match-key values both survive the
    // insert. Both then reduce to the same sourceRemoteId, which is the ON CONFLICT
    // target of the set-based mapping build — without DISTINCT ON, Postgres aborts the
    // whole statement with "cannot affect row a second time" and fails the sync run.
    const sourceRecords = [
      { id: '/file1.json', filePath: '/file1.json', fields: { email: 'john@example.com' } },
      { id: '/file1.json', filePath: '/copy-of-file1.json', fields: { email: 'jane@example.com' } },
    ];
    const destinationRecords = [{ id: '/item1.json', filePath: '/item1.json', fields: { email: 'jane@example.com' } }];

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: [],
      recordMatching: {
        sourceColumnId: 'email',
        destinationColumnId: 'email',
      },
    };

    await syncService.fillSyncCachesBatch(syncId, tableMapping, sourceRecords, destinationRecords);

    // Both match keys are stored — the duplicate remote ID is only a problem downstream.
    const sourceMatches = await prisma.syncMatchKeys.findMany({
      where: { syncId, dataFolderId: sourceFolderId },
    });
    expect(sourceMatches).toHaveLength(2);
    expect(new Set(sourceMatches.map((m) => m.remoteId))).toEqual(new Set(['/file1.json']));

    await expect(syncService.buildRecordMatchingMappings(syncId, tableMapping)).resolves.not.toThrow();

    // One row survives per source remote ID, and it is the one that actually matched
    // a destination rather than whichever the planner happened to reach first.
    const mappings = await prisma.syncRemoteIdMapping.findMany({
      where: { syncId, dataFolderId: sourceFolderId },
    });
    expect(mappings).toHaveLength(1);
    expect(mappings[0].sourceRemoteId).toBe('/file1.json');
    expect(mappings[0].destinationRemoteId).toBe('/item1.json');
    expect(mappings[0].destinationFilePath).toBe('/item1.json');
  });
});

describe('SyncService - syncTableMapping', () => {
  let prisma: PrismaClient;
  let syncService: SyncService;
  let dataFolderService: DataFolderService;
  let scratchGitService: ScratchGitService;
  let dbService: DbService;

  // Test data
  let workbookId: WorkbookId;
  let sourceFolderId: DataFolderId;
  let destFolderId: DataFolderId;
  let syncId: SyncId;
  let orgId: string;
  let userId: string;
  const actor: Actor = { userId: 'test-user', organizationId: 'test-org' };

  // Track written files for verification
  let writtenFiles: Array<{ path: string; content: string }>;

  // Track files spilled to the scratch-git staging area (large-table write path)
  let stagedFiles: Array<{ folder: string; path: string; content: string }>;

  // Schema map keyed by folder path — readSchemaFromGit returns the right schema per folder
  let gitSchemasByPath: Record<string, Record<string, unknown>>;

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  beforeEach(async () => {
    writtenFiles = [];
    stagedFiles = [];
    gitSchemasByPath = {
      '/src': { idPath: 'id' },
      '/dest': { idPath: 'id' },
    };

    dbService = { client: prisma } as unknown as DbService;

    dataFolderService = {
      getAllFileContentsByFolderId: jest.fn(),
      getFileContentsByFolderIdPaginated: jest.fn(),
      findOne: jest.fn(),
    } as unknown as DataFolderService;

    // Wire paginated mock to delegate to getAllFileContentsByFolderId mock,
    // returning all files in a single page (no nextCursor).
    (dataFolderService.getFileContentsByFolderIdPaginated as jest.Mock).mockImplementation(
      async (wbId, folderId, actorArg, branch, cursor) => {
        // Only return files on the first page (no cursor)
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
      stageFiles: jest
        .fn()
        .mockImplementation((_stagingJobKey, folder: string, files: Array<{ path: string; content: string }>) => {
          stagedFiles.push(...files.map((file) => ({ folder, path: file.path, content: file.content })));
          return Promise.resolve();
        }),
      commitStagedFilesAtomic: jest
        .fn()
        // `committed` mirrors the staged-row count — the sync treats an
        // unexpected zero as lost staging state and fails the run.
        .mockImplementation(() =>
          Promise.resolve({
            committed: stagedFiles.length,
            createdCount: stagedFiles.length,
            updatedCount: 0,
            unchangedCount: 0,
          }),
        ),
      cleanupStaging: jest.fn().mockResolvedValue(undefined),
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

    // Create test organization
    const org = await prisma.organization.create({
      data: {
        id: 'org_sync_test_' + Date.now(),
        name: 'Test Org',
        clerkId: 'clerk_sync_' + Date.now(),
      },
    });
    orgId = org.id;

    // Create user
    const user = await prisma.user.create({
      data: {
        id: 'user_sync_test_' + Date.now(),
        email: `sync-test-${Date.now()}@example.com`,
        organizationId: org.id,
      },
    });
    userId = user.id;

    // Create workbook
    const wbId = createWorkbookId();
    await prisma.workbook.create({
      data: {
        id: wbId,
        name: 'Test Workbook',
        userId: user.id,
        organizationId: org.id,
      },
    });
    workbookId = wbId;

    // Create source and destination data folders
    const srcFolderId = createDataFolderId();
    await prisma.dataFolder.create({
      data: {
        id: srcFolderId,
        name: 'Source Folder',
        workbookId,
        path: '/src',
      },
    });
    sourceFolderId = srcFolderId;

    const dstFolderId = createDataFolderId();
    await prisma.dataFolder.create({
      data: {
        id: dstFolderId,
        name: 'Destination Folder',
        workbookId,
        path: '/dest',
      },
    });
    destFolderId = dstFolderId;

    // Mock findOne to return folder info with path
    (dataFolderService.findOne as jest.Mock).mockImplementation((folderId) => {
      if (folderId === destFolderId) {
        return Promise.resolve({ path: '/dest' });
      }
      return Promise.resolve({ path: '/src' });
    });

    // Create sync
    const synId = createSyncId();
    await prisma.sync.create({
      data: {
        id: synId,
        displayName: 'Test Sync',
        mappings: [],
      },
    });
    syncId = synId;
  });

  afterEach(async () => {
    await prisma.sync.delete({ where: { id: syncId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.organization.delete({ where: { id: orgId } });
    await prisma.syncMatchKeys.deleteMany({ where: { syncId: syncId } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('should create new records in destination when none exist', async () => {
    const sourceFiles = [
      {
        folderId: sourceFolderId,
        path: 'src/file1.json',
        content: '{"id": "rec1", "email": "john@example.com", "name": "John"}',
      },
      {
        folderId: sourceFolderId,
        path: 'src/file2.json',
        content: '{"id": "rec2", "email": "jane@example.com", "name": "Jane"}',
      },
      {
        folderId: sourceFolderId,
        path: 'src/file3.json',
        content: '{"id": "rec3", "email": "bob@example.com", "name": "Bob"}',
      },
    ];

    // No destination files - all source records are new
    const destFiles: typeof sourceFiles = [];

    (dataFolderService.getAllFileContentsByFolderId as jest.Mock).mockImplementation((_workbookIdArg, folderIdArg) => {
      if (folderIdArg === sourceFolderId) {
        return Promise.resolve(sourceFiles);
      } else if (folderIdArg === destFolderId) {
        return Promise.resolve(destFiles);
      }
      return Promise.resolve([]);
    });

    const columnMappings: ColumnMapping[] = [
      { sourceColumnId: 'email', destinationColumnId: 'email_address' },
      { sourceColumnId: 'name', destinationColumnId: 'full_name' },
    ];

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings,
      recordMatching: {
        sourceColumnId: 'email',
        destinationColumnId: 'email_address',
      },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    expect(result.recordsCreated).toBe(3);
    expect(result.recordsUpdated).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Verify commitFilesToBranch was called
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(scratchGitService.commitFilesToBranch).toHaveBeenCalledWith(
      null,
      DIRTY_BRANCH,
      expect.any(Array),
      'Sync: batch write files',
    );

    // Verify files were written with transformed content
    // New files get generated paths using the temporary ID (e.g., dest/scratch_pending_publish_xxx.json)
    expect(writtenFiles).toHaveLength(3);
    expect(
      writtenFiles.every((f) => f.path.startsWith('dest/scratch_pending_publish_') && f.path.endsWith('.json')),
    ).toBe(true);

    // Verify one of the files has the correct transformed content
    const file1Content = JSON.parse(writtenFiles[0].content) as Record<string, unknown>;
    expect(file1Content.email_address).toBeDefined();
    expect(file1Content.full_name).toBeDefined();

    // Verify new records have temporary IDs for matching on subsequent syncs
    expect(file1Content.id).toBeDefined();
    expect(typeof file1Content.id).toBe('string');
    expect((file1Content.id as string).startsWith('scratch_pending_publish_')).toBe(true);

    // Verify all written files have temp IDs
    for (const file of writtenFiles) {
      const content = JSON.parse(file.content) as Record<string, unknown>;
      expect((content.id as string).startsWith('scratch_pending_publish_')).toBe(true);
    }
  });

  it('should update existing records when they match, merging with existing destination fields', async () => {
    const sourceFiles = [
      {
        folderId: sourceFolderId,
        path: 'src/file1.json',
        content: '{"id": "rec1", "email": "john@example.com", "name": "John Updated"}',
      },
      {
        folderId: sourceFolderId,
        path: 'src/file2.json',
        content: '{"id": "rec2", "email": "jane@example.com", "name": "Jane Updated"}',
      },
    ];

    // Destination records have extra fields (phone, notes) not covered by column mappings
    const destFiles = [
      {
        folderId: destFolderId,
        path: 'dest/item1.json',
        content: '{"id": "dest1", "email": "john@example.com", "name": "John", "phone": "555-1234", "notes": "VIP"}',
      },
      {
        folderId: destFolderId,
        path: 'dest/item2.json',
        content: '{"id": "dest2", "email": "jane@example.com", "name": "Jane", "phone": "555-5678"}',
      },
    ];

    (dataFolderService.getAllFileContentsByFolderId as jest.Mock).mockImplementation((_workbookIdArg, folderIdArg) => {
      if (folderIdArg === sourceFolderId) {
        return Promise.resolve(sourceFiles);
      } else if (folderIdArg === destFolderId) {
        return Promise.resolve(destFiles);
      }
      return Promise.resolve([]);
    });

    const columnMappings: ColumnMapping[] = [
      { sourceColumnId: 'email', destinationColumnId: 'email' },
      { sourceColumnId: 'name', destinationColumnId: 'name' },
    ];

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings,
      recordMatching: {
        sourceColumnId: 'email',
        destinationColumnId: 'email',
      },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    expect(result.recordsCreated).toBe(0);
    expect(result.recordsUpdated).toBe(2);
    expect(result.errors).toHaveLength(0);

    // Verify files were written to existing destination paths
    expect(writtenFiles).toHaveLength(2);

    const file1 = writtenFiles.find((f) => f.path === 'dest/item1.json');
    expect(file1).toBeDefined();
    const file1Content = JSON.parse(file1!.content) as Record<string, unknown>;
    // Mapped fields should be updated from source
    expect(file1Content.name).toBe('John Updated');
    expect(file1Content.email).toBe('john@example.com');
    // Unmapped destination fields should be preserved
    expect(file1Content.phone).toBe('555-1234');
    expect(file1Content.notes).toBe('VIP');
    // Destination id should be preserved
    expect(file1Content.id).toBe('dest1');

    const file2 = writtenFiles.find((f) => f.path === 'dest/item2.json');
    expect(file2).toBeDefined();
    const file2Content = JSON.parse(file2!.content) as Record<string, unknown>;
    expect(file2Content.name).toBe('Jane Updated');
    expect(file2Content.phone).toBe('555-5678');
    expect(file2Content.id).toBe('dest2');
  });

  it('should handle mixed create and update scenarios', async () => {
    const sourceFiles = [
      {
        folderId: sourceFolderId,
        path: 'src/file1.json',
        content: '{"id": "rec1", "email": "john@example.com", "name": "John"}',
      },
      {
        folderId: sourceFolderId,
        path: 'src/file2.json',
        content: '{"id": "rec2", "email": "jane@example.com", "name": "Jane"}',
      },
      {
        folderId: sourceFolderId,
        path: 'src/file3.json',
        content: '{"id": "rec3", "email": "bob@example.com", "name": "Bob"}',
      },
    ];

    // Only john exists in destination (with an extra unmapped field)
    const destFiles = [
      {
        folderId: destFolderId,
        path: 'dest/john.json',
        content: '{"id": "dest1", "email": "john@example.com", "name": "John Old", "phone": "555-9999"}',
      },
    ];

    (dataFolderService.getAllFileContentsByFolderId as jest.Mock).mockImplementation((_workbookIdArg, folderIdArg) => {
      if (folderIdArg === sourceFolderId) {
        return Promise.resolve(sourceFiles);
      } else if (folderIdArg === destFolderId) {
        return Promise.resolve(destFiles);
      }
      return Promise.resolve([]);
    });

    const columnMappings: ColumnMapping[] = [
      { sourceColumnId: 'email', destinationColumnId: 'email' },
      { sourceColumnId: 'name', destinationColumnId: 'name' },
    ];

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings,
      recordMatching: {
        sourceColumnId: 'email',
        destinationColumnId: 'email',
      },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    expect(result.recordsCreated).toBe(2); // jane and bob are new
    expect(result.recordsUpdated).toBe(1); // john is updated
    expect(result.errors).toHaveLength(0);
    expect(writtenFiles).toHaveLength(3);

    // Verify john's update uses existing destination path and preserves unmapped fields
    const johnFile = writtenFiles.find((f) => f.path === 'dest/john.json');
    expect(johnFile).toBeDefined();
    const johnContent = JSON.parse(johnFile!.content) as Record<string, unknown>;
    expect(johnContent.name).toBe('John');
    expect(johnContent.phone).toBe('555-9999');
    expect(johnContent.id).toBe('dest1');

    // Verify new files (jane, bob) use generated paths
    const newFiles = writtenFiles.filter((f) => f.path.startsWith('dest/scratch_pending_publish_'));
    expect(newFiles).toHaveLength(2);

    // Verify new files have temporary IDs
    for (const newFile of newFiles) {
      const fileContent = JSON.parse(newFile.content) as Record<string, unknown>;
      expect((fileContent.id as string).startsWith('scratch_pending_publish_')).toBe(true);
    }
  });

  it('should apply column mappings correctly (rename fields)', async () => {
    const sourceFiles = [
      {
        folderId: sourceFolderId,
        path: 'src/file1.json',
        content: '{"id": "rec1", "email": "john@example.com", "first_name": "John", "last_name": "Doe"}',
      },
    ];

    const destFiles: typeof sourceFiles = [];

    (dataFolderService.getAllFileContentsByFolderId as jest.Mock).mockImplementation((_workbookIdArg, folderIdArg) => {
      if (folderIdArg === sourceFolderId) {
        return Promise.resolve(sourceFiles);
      } else if (folderIdArg === destFolderId) {
        return Promise.resolve(destFiles);
      }
      return Promise.resolve([]);
    });

    // Map to different field names
    const columnMappings: ColumnMapping[] = [
      { sourceColumnId: 'email', destinationColumnId: 'contact_email' },
      { sourceColumnId: 'first_name', destinationColumnId: 'given_name' },
      { sourceColumnId: 'last_name', destinationColumnId: 'family_name' },
    ];

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings,
      recordMatching: {
        sourceColumnId: 'email',
        destinationColumnId: 'contact_email',
      },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    expect(result.recordsCreated).toBe(1);
    expect(result.errors).toHaveLength(0);

    // Verify field names were transformed
    expect(writtenFiles).toHaveLength(1);
    const file = writtenFiles[0];
    // New file should have a generated path
    expect(file.path.startsWith('dest/scratch_pending_publish_')).toBe(true);
    const fileContent = JSON.parse(file.content) as Record<string, unknown>;
    expect(fileContent.contact_email).toBe('john@example.com');
    expect(fileContent.given_name).toBe('John');
    expect(fileContent.family_name).toBe('Doe');
    // Original field names should not appear
    expect(fileContent.email).toBeUndefined();
    expect(fileContent.first_name).toBeUndefined();
    expect(fileContent.last_name).toBeUndefined();
    // Verify temporary ID was set
    expect((fileContent.id as string).startsWith('scratch_pending_publish_')).toBe(true);
  });

  it('should return error when batch write fails', async () => {
    const sourceFiles = [
      { folderId: sourceFolderId, path: 'src/file1.json', content: '{"id": "rec1", "email": "john@example.com"}' },
    ];

    const destFiles: typeof sourceFiles = [];

    (dataFolderService.getAllFileContentsByFolderId as jest.Mock).mockImplementation((_workbookIdArg, folderIdArg) => {
      if (folderIdArg === sourceFolderId) {
        return Promise.resolve(sourceFiles);
      } else if (folderIdArg === destFolderId) {
        return Promise.resolve(destFiles);
      }
      return Promise.resolve([]);
    });

    // Mock commitFilesToBranch to fail
    (scratchGitService.commitFilesToBranch as jest.Mock).mockRejectedValue(new Error('Git commit failed'));

    const columnMappings: ColumnMapping[] = [{ sourceColumnId: 'email', destinationColumnId: 'email' }];

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings,
      recordMatching: {
        sourceColumnId: 'email',
        destinationColumnId: 'email',
      },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    // When batch write fails, counts should be reset and errors reported
    expect(result.recordsCreated).toBe(0);
    expect(result.recordsUpdated).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].error).toContain('Batch write failed');
  });

  // -------------------------------------------------------------------------
  // Large-table write path (DEV-11193): output files exceeding one source page
  // spill to the scratch-git staging area page by page and land as exactly ONE
  // atomic commit, instead of accumulating every serialized file in memory.
  // -------------------------------------------------------------------------

  /** 1001 source records served in two pages (1000 + 1), crossing the one-page spill threshold. */
  function mockSourcePagesCrossingSpillThreshold(recordCount: number) {
    const sourceFilesForPagination = Array.from({ length: recordCount }, (_, recordIndex) => ({
      folderId: sourceFolderId,
      path: `src/file${recordIndex}.json`,
      content: `{"id": "rec${recordIndex}", "email": "user${recordIndex}@example.com"}`,
    }));
    (dataFolderService.getFileContentsByFolderIdPaginated as jest.Mock).mockImplementation(
      (_wbId, folderId, _actorArg, _branch, cursor) => {
        if (folderId !== sourceFolderId) {
          return Promise.resolve({ files: [], nextCursor: undefined });
        }
        if (cursor === undefined) {
          return Promise.resolve({ files: sourceFilesForPagination.slice(0, 1000), nextCursor: 'page-2' });
        }
        return Promise.resolve({ files: sourceFilesForPagination.slice(1000), nextCursor: undefined });
      },
    );
  }

  it('spills output files to staging and lands them as one atomic commit when writes exceed one page', async () => {
    mockSourcePagesCrossingSpillThreshold(1001);

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: [{ sourceColumnId: 'email', destinationColumnId: 'email_address' }],
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email_address' },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    expect(result.errors).toHaveLength(0);
    expect(result.recordsCreated).toBe(1001);

    // The whole run landed through staging + ONE atomic commit — never the
    // in-memory commitFilesToBranch path.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(scratchGitService.commitFilesToBranch).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(scratchGitService.commitStagedFilesAtomic).toHaveBeenCalledTimes(1);
    const atomicCommitArgs = (scratchGitService.commitStagedFilesAtomic as jest.Mock).mock.calls[0] as string[];
    expect(atomicCommitArgs[2]).toBe(DIRTY_BRANCH);
    expect(atomicCommitArgs[3]).toBe('dest');
    expect(atomicCommitArgs[4]).toBe('Sync: batch write files');

    // Every file was staged (page spill + tail flush), with paths RELATIVE to
    // the destination folder — scratch-git prefixes the folder on commit.
    expect(stagedFiles).toHaveLength(1001);
    expect(stagedFiles.every((file) => file.folder === 'dest')).toBe(true);
    expect(stagedFiles.every((file) => !file.path.includes('/'))).toBe(true);

    // The staging key carries a per-run random component (a shared key would
    // let concurrent runs of the same sync clean up or commit each other's
    // rows), and every staging call in the run uses the SAME key.
    const stagingKeysUsed = [
      ...(scratchGitService.stageFiles as jest.Mock).mock.calls.map((call) => call[0] as string),
      atomicCommitArgs[0],
      ...(scratchGitService.cleanupStaging as jest.Mock).mock.calls.map((call) => call[0] as string),
    ];
    expect(new Set(stagingKeysUsed).size).toBe(1);
    expect(stagingKeysUsed[0]).toMatch(new RegExp(`^sync-${syncId}-${destFolderId}-.+`));

    // The staging dir is cleaned up after the commit (per-run key ⇒ no
    // pre-spill cleanup is needed; a crashed attempt's rows are unreachable).
    const cleanupCallOrders = (scratchGitService.cleanupStaging as jest.Mock).mock.invocationCallOrder;
    expect(cleanupCallOrders.length).toBe(1);
    expect(cleanupCallOrders[0]).toBeGreaterThan(
      (scratchGitService.commitStagedFilesAtomic as jest.Mock).mock.invocationCallOrder[0],
    );
  }, 60_000);

  it('writes one SyncRemoteIdMapping per source record across pages, and samples the reported paths', async () => {
    // Guards the set-based mapping build and the per-page backfill (DEV-11192):
    // both used to queue one database operation per record, and both are exercised
    // here by a table whose records span more than one source page and are all
    // creates (empty destination).
    mockSourcePagesCrossingSpillThreshold(1001);

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: [{ sourceColumnId: 'email', destinationColumnId: 'email_address' }],
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email_address' },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    expect(result.errorCount).toBe(0);
    expect(result.recordsCreated).toBe(1001);
    // Counts stay exact; the path lists are samples.
    expect(result.createdPaths).toHaveLength(100);

    // Every source record got a mapping row, and the backfill filled in each
    // one's destination path and record id.
    const mappings = await prisma.syncRemoteIdMapping.findMany({
      where: { syncId, dataFolderId: sourceFolderId },
      select: { sourceRemoteId: true, destinationFilePath: true, destinationRemoteId: true },
    });
    expect(mappings).toHaveLength(1001);
    expect(new Set(mappings.map((m) => m.sourceRemoteId)).size).toBe(1001);
    expect(mappings.every((m) => m.destinationFilePath?.startsWith('dest/'))).toBe(true);
    expect(mappings.every((m) => m.destinationRemoteId !== null)).toBe(true);
  }, 60_000);

  it('zeroes counts and reports every record failed when the atomic staged commit fails', async () => {
    mockSourcePagesCrossingSpillThreshold(1001);
    (scratchGitService.commitStagedFilesAtomic as jest.Mock).mockRejectedValue(new Error('Atomic commit failed'));

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: [{ sourceColumnId: 'email', destinationColumnId: 'email_address' }],
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email_address' },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    // Nothing landed (staged files only become visible at the atomic commit),
    // so the run reports all-or-nothing failure — same contract as the old
    // single commitFilesToBranch call.
    expect(result.recordsCreated).toBe(0);
    expect(result.recordsUpdated).toBe(0);
    // Every queued record counts as failed; the errors list carries a sample of
    // them rather than one entry per record.
    expect(result.errorCount).toBe(1001);
    expect(result.errors).toHaveLength(100);
    expect(result.errors[0].error).toContain('Batch write failed');
    // Staging dir still cleaned up on the failure path.
    expect((scratchGitService.cleanupStaging as jest.Mock).mock.invocationCallOrder.length).toBe(1);
  }, 60_000);

  it('fails the run when the atomic commit reports zero committed files (staging state lost)', async () => {
    // The endpoint returns empty success when its staging index is missing —
    // it cannot tell "nothing staged" from "staging state destroyed". The sync
    // KNOWS it staged files, so it must fail loudly rather than report a
    // successful sync that wrote nothing.
    mockSourcePagesCrossingSpillThreshold(1001);
    (scratchGitService.commitStagedFilesAtomic as jest.Mock).mockResolvedValue({
      committed: 0,
      createdCount: 0,
      updatedCount: 0,
      unchangedCount: 0,
    });

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: [{ sourceColumnId: 'email', destinationColumnId: 'email_address' }],
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email_address' },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    expect(result.recordsCreated).toBe(0);
    expect(result.errorCount).toBe(1001);
    expect(result.errors).toHaveLength(100);
    expect(result.errors[0].error).toContain('staging state was lost');
  }, 60_000);

  it('should return error when source record is missing match key field', async () => {
    const sourceFiles = [
      {
        folderId: sourceFolderId,
        path: 'src/file1.json',
        // Has 'id' (required for record parsing) but missing 'external_ref' (the match key)
        content: '{"id": "rec1", "name": "John", "company": "Acme"}',
      },
    ];

    const destFiles: typeof sourceFiles = [];

    (dataFolderService.getAllFileContentsByFolderId as jest.Mock).mockImplementation((_workbookIdArg, folderIdArg) => {
      if (folderIdArg === sourceFolderId) {
        return Promise.resolve(sourceFiles);
      } else if (folderIdArg === destFolderId) {
        return Promise.resolve(destFiles);
      }
      return Promise.resolve([]);
    });

    const columnMappings: ColumnMapping[] = [{ sourceColumnId: 'name', destinationColumnId: 'full_name' }];

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings,
      recordMatching: {
        sourceColumnId: 'external_ref', // This field doesn't exist in the source record
        destinationColumnId: 'source_id',
      },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    // Record should be skipped (not an error) when match key field is missing
    expect(result.recordsCreated).toBe(0);
    expect(result.recordsSkipped).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it('should skip source records with falsy match key values (empty string, null) without errors', async () => {
    const sourceFiles = [
      {
        folderId: sourceFolderId,
        path: 'src/file1.json',
        // email is empty string
        content: '{"id": "rec1", "email": "", "name": "John"}',
      },
      {
        folderId: sourceFolderId,
        path: 'src/file2.json',
        // email is null
        content: '{"id": "rec2", "email": null, "name": "Jane"}',
      },
      {
        folderId: sourceFolderId,
        path: 'src/file3.json',
        // email is valid — this one should sync fine
        content: '{"id": "rec3", "email": "bob@example.com", "name": "Bob"}',
      },
    ];

    const destFiles: typeof sourceFiles = [];

    (dataFolderService.getAllFileContentsByFolderId as jest.Mock).mockImplementation((_workbookIdArg, folderIdArg) => {
      if (folderIdArg === sourceFolderId) {
        return Promise.resolve(sourceFiles);
      } else if (folderIdArg === destFolderId) {
        return Promise.resolve(destFiles);
      }
      return Promise.resolve([]);
    });

    const columnMappings: ColumnMapping[] = [
      { sourceColumnId: 'email', destinationColumnId: 'email' },
      { sourceColumnId: 'name', destinationColumnId: 'name' },
    ];

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings,
      recordMatching: {
        sourceColumnId: 'email',
        destinationColumnId: 'email',
      },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    // Only rec3 (Bob) should be created; rec1 and rec2 should be skipped (not errors)
    expect(result.recordsCreated).toBe(1);
    expect(result.recordsSkipped).toBe(2);
    expect(result.errors).toHaveLength(0);

    // Verify only Bob's record was written
    expect(writtenFiles).toHaveLength(1);
    const bobContent = JSON.parse(writtenFiles[0].content) as Record<string, unknown>;
    expect(bobContent.email).toBe('bob@example.com');
    expect(bobContent.name).toBe('Bob');
  });

  it('should preserve explicitly mapped ID column instead of generating a temp ID', async () => {
    const sourceFiles = [
      {
        folderId: sourceFolderId,
        path: 'src/file1.json',
        content: '{"id": "rec1", "email": "john@example.com", "name": "John", "external_id": "ext_123"}',
      },
      {
        folderId: sourceFolderId,
        path: 'src/file2.json',
        content: '{"id": "rec2", "email": "jane@example.com", "name": "Jane", "external_id": "ext_456"}',
      },
    ];

    const destFiles: typeof sourceFiles = [];

    (dataFolderService.getAllFileContentsByFolderId as jest.Mock).mockImplementation((_workbookIdArg, folderIdArg) => {
      if (folderIdArg === sourceFolderId) {
        return Promise.resolve(sourceFiles);
      } else if (folderIdArg === destFolderId) {
        return Promise.resolve(destFiles);
      }
      return Promise.resolve([]);
    });

    // Column mappings explicitly map external_id to the destination's ID column ('id')
    const columnMappings: ColumnMapping[] = [
      { sourceColumnId: 'email', destinationColumnId: 'email_address' },
      { sourceColumnId: 'name', destinationColumnId: 'full_name' },
      { sourceColumnId: 'external_id', destinationColumnId: 'id' },
    ];

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings,
      recordMatching: {
        sourceColumnId: 'email',
        destinationColumnId: 'email_address',
      },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    expect(result.recordsCreated).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(writtenFiles).toHaveLength(2);

    // Verify that the explicitly mapped ID values are preserved, not overwritten with temp IDs
    for (const file of writtenFiles) {
      const content = JSON.parse(file.content) as Record<string, unknown>;
      expect((content.id as string).startsWith('scratch_pending_publish_')).toBe(false);
    }

    // Verify the exact mapped values
    const file1 = writtenFiles.find((f) => {
      const content = JSON.parse(f.content) as Record<string, unknown>;
      return content.email_address === 'john@example.com';
    });
    expect(file1).toBeDefined();
    const file1Content = JSON.parse(file1!.content) as Record<string, unknown>;
    expect(file1Content.id).toBe('ext_123');
    expect(file1Content.full_name).toBe('John');

    const file2 = writtenFiles.find((f) => {
      const content = JSON.parse(f.content) as Record<string, unknown>;
      return content.email_address === 'jane@example.com';
    });
    expect(file2).toBeDefined();
    const file2Content = JSON.parse(file2!.content) as Record<string, unknown>;
    expect(file2Content.id).toBe('ext_456');
    expect(file2Content.full_name).toBe('Jane');
  });

  it('should format JSON content with Prettier formatting (newlines and proper structure)', async () => {
    const sourceFiles = [
      {
        folderId: sourceFolderId,
        path: 'src/file1.json',
        content: '{"id": "rec1", "email": "john@example.com", "name": "John"}',
      },
    ];

    const destFiles: typeof sourceFiles = [];

    (dataFolderService.getAllFileContentsByFolderId as jest.Mock).mockImplementation((_workbookIdArg, folderIdArg) => {
      if (folderIdArg === sourceFolderId) {
        return Promise.resolve(sourceFiles);
      } else if (folderIdArg === destFolderId) {
        return Promise.resolve(destFiles);
      }
      return Promise.resolve([]);
    });

    const columnMappings: ColumnMapping[] = [{ sourceColumnId: 'email', destinationColumnId: 'email' }];

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings,
      recordMatching: {
        sourceColumnId: 'email',
        destinationColumnId: 'email',
      },
    };

    await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    // Verify that written files have properly formatted JSON
    expect(writtenFiles).toHaveLength(1);
    const content = writtenFiles[0].content;

    // Check that JSON is formatted (contains newlines and proper indentation)
    expect(content).toContain('\n');
    expect(content).toMatch(/^\{\n/); // Should start with { followed by newline
    expect(content.endsWith('\n')).toBe(true); // Should end with newline

    // Verify JSON is still valid
    const parsed = JSON.parse(content) as { email: string | undefined };
    expect(parsed.email).toBe('john@example.com');
  });

  it('should maintain Prettier formatting consistency across multiple records', async () => {
    const sourceFiles = [
      {
        folderId: sourceFolderId,
        path: 'src/file1.json',
        content: '{"id": "rec1", "email": "john@example.com", "name": "John", "company": "Acme"}',
      },
      {
        folderId: sourceFolderId,
        path: 'src/file2.json',
        content: '{"id": "rec2", "email": "jane@example.com", "name": "Jane", "role": "Manager"}',
      },
    ];

    const destFiles: typeof sourceFiles = [];

    (dataFolderService.getAllFileContentsByFolderId as jest.Mock).mockImplementation((_workbookIdArg, folderIdArg) => {
      if (folderIdArg === sourceFolderId) {
        return Promise.resolve(sourceFiles);
      } else if (folderIdArg === destFolderId) {
        return Promise.resolve(destFiles);
      }
      return Promise.resolve([]);
    });

    const columnMappings: ColumnMapping[] = [
      { sourceColumnId: 'email', destinationColumnId: 'email' },
      { sourceColumnId: 'name', destinationColumnId: 'name' },
    ];

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings,
      recordMatching: {
        sourceColumnId: 'email',
        destinationColumnId: 'email',
      },
    };

    await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    // All files should have consistent formatting
    expect(writtenFiles).toHaveLength(2);
    for (const file of writtenFiles) {
      expect(file.content).toContain('\n'); // All should have newlines
      expect(file.content).toMatch(/^\{\n/); // All should start with { and newline
      expect(file.content.endsWith('\n')).toBe(true); // All should end with newline
      expect(JSON.parse(file.content)).toBeDefined(); // All should be valid JSON
    }
  });

  it('should create records with dot-separated source column paths (nested source fields)', async () => {
    const sourceFiles = [
      {
        folderId: sourceFolderId,
        path: 'src/file1.json',
        content: '{"id": "rec1", "fields": {"Name": "John", "Email": "john@example.com"}}',
      },
    ];

    const destFiles: typeof sourceFiles = [];

    (dataFolderService.getAllFileContentsByFolderId as jest.Mock).mockImplementation((_workbookIdArg, folderIdArg) => {
      if (folderIdArg === sourceFolderId) {
        return Promise.resolve(sourceFiles);
      } else if (folderIdArg === destFolderId) {
        return Promise.resolve(destFiles);
      }
      return Promise.resolve([]);
    });

    const columnMappings: ColumnMapping[] = [
      { sourceColumnId: 'fields.Email', destinationColumnId: 'email' },
      { sourceColumnId: 'fields.Name', destinationColumnId: 'name' },
    ];

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings,
      recordMatching: {
        sourceColumnId: 'fields.Email',
        destinationColumnId: 'email',
      },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    expect(result.recordsCreated).toBe(1);
    expect(result.errors).toHaveLength(0);

    expect(writtenFiles).toHaveLength(1);
    const fileContent = JSON.parse(writtenFiles[0].content) as Record<string, unknown>;
    expect(fileContent.email).toBe('john@example.com');
    expect(fileContent.name).toBe('John');
  });

  it('should create records with dot-separated destination column paths (nested destination fields)', async () => {
    const sourceFiles = [
      {
        folderId: sourceFolderId,
        path: 'src/file1.json',
        content: '{"id": "rec1", "email": "john@example.com", "name": "John"}',
      },
    ];

    const destFiles: typeof sourceFiles = [];

    (dataFolderService.getAllFileContentsByFolderId as jest.Mock).mockImplementation((_workbookIdArg, folderIdArg) => {
      if (folderIdArg === sourceFolderId) {
        return Promise.resolve(sourceFiles);
      } else if (folderIdArg === destFolderId) {
        return Promise.resolve(destFiles);
      }
      return Promise.resolve([]);
    });

    const columnMappings: ColumnMapping[] = [
      { sourceColumnId: 'email', destinationColumnId: 'fields.Email' },
      { sourceColumnId: 'name', destinationColumnId: 'fields.Name' },
    ];

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings,
      recordMatching: {
        sourceColumnId: 'email',
        destinationColumnId: 'fields.Email',
      },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    expect(result.recordsCreated).toBe(1);
    expect(result.errors).toHaveLength(0);

    expect(writtenFiles).toHaveLength(1);
    const fileContent = JSON.parse(writtenFiles[0].content) as Record<string, unknown>;
    expect((fileContent.fields as Record<string, unknown>).Email).toBe('john@example.com');
    expect((fileContent.fields as Record<string, unknown>).Name).toBe('John');
  });

  it('should match and update records using dot-separated record matching paths', async () => {
    const sourceFiles = [
      {
        folderId: sourceFolderId,
        path: 'src/file1.json',
        content: '{"id": "rec1", "meta": {"slug": "hello-world"}, "title": "Hello Updated"}',
      },
    ];

    const destFiles = [
      {
        folderId: destFolderId,
        path: 'dest/item1.json',
        content: '{"id": "dest1", "info": {"slug": "hello-world"}, "title": "Hello"}',
      },
    ];

    (dataFolderService.getAllFileContentsByFolderId as jest.Mock).mockImplementation((_workbookIdArg, folderIdArg) => {
      if (folderIdArg === sourceFolderId) {
        return Promise.resolve(sourceFiles);
      } else if (folderIdArg === destFolderId) {
        return Promise.resolve(destFiles);
      }
      return Promise.resolve([]);
    });

    const columnMappings: ColumnMapping[] = [{ sourceColumnId: 'title', destinationColumnId: 'title' }];

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings,
      recordMatching: {
        sourceColumnId: 'meta.slug',
        destinationColumnId: 'info.slug',
      },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    expect(result.recordsUpdated).toBe(1);
    expect(result.recordsCreated).toBe(0);
    expect(result.errors).toHaveLength(0);

    const file = writtenFiles.find((f) => f.path === 'dest/item1.json');
    expect(file).toBeDefined();
    const fileContent = JSON.parse(file!.content) as Record<string, unknown>;
    expect(fileContent.title).toBe('Hello Updated');
    expect(fileContent.id).toBe('dest1');
  });

  it('should skip source record when dot-separated match key field is missing', async () => {
    const sourceFiles = [
      {
        folderId: sourceFolderId,
        path: 'src/file1.json',
        // Has 'meta' but not 'meta.email'
        content: '{"id": "rec1", "meta": {"name": "John"}, "name": "John"}',
      },
    ];

    const destFiles: typeof sourceFiles = [];

    (dataFolderService.getAllFileContentsByFolderId as jest.Mock).mockImplementation((_workbookIdArg, folderIdArg) => {
      if (folderIdArg === sourceFolderId) {
        return Promise.resolve(sourceFiles);
      } else if (folderIdArg === destFolderId) {
        return Promise.resolve(destFiles);
      }
      return Promise.resolve([]);
    });

    const columnMappings: ColumnMapping[] = [{ sourceColumnId: 'name', destinationColumnId: 'name' }];

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings,
      recordMatching: {
        sourceColumnId: 'meta.email',
        destinationColumnId: 'email',
      },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    // Record should be skipped (not an error) when nested match key field is missing
    expect(result.recordsCreated).toBe(0);
    expect(result.recordsSkipped).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it('should handle dot-separated idPath when parsing records', async () => {
    // Source folder uses a nested ID column — register its schema in the git mock
    gitSchemasByPath['/nested-src'] = { idPath: 'sys.id' };

    const nestedIdFolderId = createDataFolderId();
    await prisma.dataFolder.create({
      data: {
        id: nestedIdFolderId,
        name: 'Nested ID Source',
        workbookId,
        path: '/nested-src',
      },
    });

    const sourceFiles = [
      {
        folderId: nestedIdFolderId,
        path: 'nested-src/file1.json',
        content: '{"sys": {"id": "rec1"}, "fields": {"name": "John"}, "email": "john@example.com"}',
      },
    ];

    const destFiles: typeof sourceFiles = [];

    (dataFolderService.getAllFileContentsByFolderId as jest.Mock).mockImplementation((_workbookIdArg, folderIdArg) => {
      if (folderIdArg === nestedIdFolderId) {
        return Promise.resolve(sourceFiles);
      } else if (folderIdArg === destFolderId) {
        return Promise.resolve(destFiles);
      }
      return Promise.resolve([]);
    });

    const columnMappings: ColumnMapping[] = [
      { sourceColumnId: 'email', destinationColumnId: 'email' },
      { sourceColumnId: 'fields.name', destinationColumnId: 'name' },
    ];

    const tableMapping: TableMapping = {
      sourceDataFolderId: nestedIdFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings,
      recordMatching: {
        sourceColumnId: 'email',
        destinationColumnId: 'email',
      },
    };

    // This should not throw — the record should be parsed with sys.id as the record ID
    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    expect(result.recordsCreated).toBe(1);
    expect(result.errors).toHaveLength(0);

    expect(writtenFiles).toHaveLength(1);
    const fileContent = JSON.parse(writtenFiles[0].content) as Record<string, unknown>;
    expect(fileContent.email).toBe('john@example.com');
    expect(fileContent.name).toBe('John');
  });

  it('should apply string_to_number transformer to convert string values to numbers', async () => {
    const sourceFiles = [
      {
        folderId: sourceFolderId,
        path: 'src/file1.json',
        content: '{"id": "rec1", "email": "john@example.com", "price": "$1,234.56", "quantity": "42"}',
      },
      {
        folderId: sourceFolderId,
        path: 'src/file2.json',
        content: '{"id": "rec2", "email": "jane@example.com", "price": "€99.99", "quantity": "7"}',
      },
    ];

    const destFiles: typeof sourceFiles = [];

    (dataFolderService.getAllFileContentsByFolderId as jest.Mock).mockImplementation((_workbookIdArg, folderIdArg) => {
      if (folderIdArg === sourceFolderId) {
        return Promise.resolve(sourceFiles);
      } else if (folderIdArg === destFolderId) {
        return Promise.resolve(destFiles);
      }
      return Promise.resolve([]);
    });

    // Use transformers to convert string fields to numbers
    const columnMappings: ColumnMapping[] = [
      { sourceColumnId: 'email', destinationColumnId: 'email' },
      {
        sourceColumnId: 'price',
        destinationColumnId: 'price_cents',
        transformer: { type: 'string_to_number', options: { stripCurrency: true } },
      },
      {
        sourceColumnId: 'quantity',
        destinationColumnId: 'qty',
        transformer: { type: 'string_to_number', options: { parseInteger: true } },
      },
    ];

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings,
      recordMatching: {
        sourceColumnId: 'email',
        destinationColumnId: 'email',
      },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    expect(result.recordsCreated).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(writtenFiles).toHaveLength(2);

    // Verify string values were transformed to numbers
    const file1 = writtenFiles.find((f) => {
      const content = JSON.parse(f.content) as Record<string, unknown>;
      return content.email === 'john@example.com';
    });
    expect(file1).toBeDefined();
    const file1Content = JSON.parse(file1!.content) as Record<string, unknown>;
    expect(file1Content.price_cents).toBe(1234.56); // Currency stripped and parsed as float
    expect(file1Content.qty).toBe(42); // Parsed as integer

    const file2 = writtenFiles.find((f) => {
      const content = JSON.parse(f.content) as Record<string, unknown>;
      return content.email === 'jane@example.com';
    });
    expect(file2).toBeDefined();
    const file2Content = JSON.parse(file2!.content) as Record<string, unknown>;
    expect(file2Content.price_cents).toBe(99.99);
    expect(file2Content.qty).toBe(7);
  });

  it('should skip writing file and not count as updated when no fields actually changed', async () => {
    // Source and destination have identical mapped field values
    const sourceFiles = [
      {
        folderId: sourceFolderId,
        path: 'src/file1.json',
        content: '{"id": "rec1", "email": "john@example.com", "name": "John"}',
      },
    ];

    // Destination already has the same values for the mapped fields (plus extra unmapped fields)
    const destFiles = [
      {
        folderId: destFolderId,
        path: 'dest/item1.json',
        content: '{"id": "dest1", "email": "john@example.com", "name": "John", "phone": "555-1234"}',
      },
    ];

    (dataFolderService.getAllFileContentsByFolderId as jest.Mock).mockImplementation((_workbookIdArg, folderIdArg) => {
      if (folderIdArg === sourceFolderId) {
        return Promise.resolve(sourceFiles);
      } else if (folderIdArg === destFolderId) {
        return Promise.resolve(destFiles);
      }
      return Promise.resolve([]);
    });

    const columnMappings: ColumnMapping[] = [
      { sourceColumnId: 'email', destinationColumnId: 'email' },
      { sourceColumnId: 'name', destinationColumnId: 'name' },
    ];

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings,
      recordMatching: {
        sourceColumnId: 'email',
        destinationColumnId: 'email',
      },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    // No actual data changed, so it should not be counted as an update
    expect(result.recordsCreated).toBe(0);
    expect(result.recordsUpdated).toBe(0);
    expect(result.errors).toHaveLength(0);

    // No files should have been written
    expect(writtenFiles).toHaveLength(0);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(scratchGitService.commitFilesToBranch).not.toHaveBeenCalled();
  });

  it('matches an object-valued match field via its own extraction transformer', async () => {
    // The source match field `title` holds a complex object (e.g. Notion rich-text blocks).
    // Record matching reduces each side to a canonical primitive using the FIELD's own
    // connector-declared extraction transformer (x-scratch-suggested-transformer) — never the
    // column-mapping copy transformers — so an object-valued field still matches a plain
    // destination value. Here the source schema declares a JSONPath extractor on `title`.
    gitSchemasByPath['/src'] = {
      idColumnRemoteId: 'id',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: {
            type: 'array',
            'x-scratch-suggested-transformer': { type: 'jsonpath', options: { expression: '$[0].text.content' } },
          },
          name: { type: 'string' },
        },
      },
    };
    // Folders carry a connectorService — the reducer needs it to run the extraction transformer.
    (dataFolderService.findOne as jest.Mock).mockImplementation((folderId: DataFolderId) =>
      Promise.resolve(
        folderId === destFolderId
          ? { path: '/dest', connectorService: 'POSTGRES' }
          : { path: '/src', connectorService: 'POSTGRES' },
      ),
    );

    const sourceFiles = [
      {
        folderId: sourceFolderId,
        path: 'src/file1.json',
        content: JSON.stringify({
          id: 'rec1',
          title: [{ type: 'text', text: { content: 'hello-world' } }],
          name: 'John',
        }),
      },
      {
        folderId: sourceFolderId,
        path: 'src/file2.json',
        content: JSON.stringify({
          id: 'rec2',
          title: [{ type: 'text', text: { content: 'goodbye-world' } }],
          name: 'Jane',
        }),
      },
      {
        folderId: sourceFolderId,
        path: 'src/file3.json',
        content: JSON.stringify({
          id: 'rec3',
          title: [{ type: 'text', text: { content: 'new-post' } }],
          name: 'Bob',
        }),
      },
    ];

    // Only john exists in destination (matched by slug)
    const destFiles = [
      {
        folderId: destFolderId,
        path: 'dest/john.json',
        content: '{"id": "dest1", "slug": "hello-world", "full_name": "John Old", "phone": "555-9999"}',
      },
    ];

    (dataFolderService.getAllFileContentsByFolderId as jest.Mock).mockImplementation((_workbookIdArg, folderIdArg) => {
      if (folderIdArg === sourceFolderId) {
        return Promise.resolve(sourceFiles);
      } else if (folderIdArg === destFolderId) {
        return Promise.resolve(destFiles);
      }
      return Promise.resolve([]);
    });

    // The `title -> slug` copy still uses its own JSONPath transformer to write the scalar slug.
    // Matching is independent of these copy mappings — it's driven by the schema's extraction
    // transformer above — so the first `title -> raw_title` copy (no transformer) is irrelevant
    // to whether John matches.
    const columnMappings: ColumnMapping[] = [
      { sourceColumnId: 'title', destinationColumnId: 'raw_title' },
      {
        sourceColumnId: 'title',
        destinationColumnId: 'slug',
        transformer: { type: 'jsonpath', options: { expression: '$[0].text.content' } },
      },
      { sourceColumnId: 'name', destinationColumnId: 'full_name' },
    ];

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings,
      recordMatching: {
        sourceColumnId: 'title',
        destinationColumnId: 'slug',
      },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    // John should be updated (matched via transformed title -> slug),
    // Jane and Bob should be created (no match in destination)
    expect(result.recordsCreated).toBe(2);
    expect(result.recordsUpdated).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(writtenFiles).toHaveLength(3);

    // Verify john's update uses existing destination path and preserves unmapped fields
    const johnFile = writtenFiles.find((f) => f.path === 'dest/john.json');
    expect(johnFile).toBeDefined();
    const johnContent = JSON.parse(johnFile!.content) as Record<string, unknown>;
    expect(johnContent.full_name).toBe('John');
    expect(johnContent.phone).toBe('555-9999');
    expect(johnContent.id).toBe('dest1');
    // The slug field should have the transformed value
    expect(johnContent.slug).toBe('hello-world');

    // Verify new files (jane, bob) use generated paths
    const newFiles = writtenFiles.filter((f) => f.path.startsWith('dest/scratch_pending_publish_'));
    expect(newFiles).toHaveLength(2);
  });

  it('matches when the DESTINATION match field is object-valued (reverse direction)', async () => {
    // The exact bug this feature fixes: a plain source value (e.g. Postgres string) syncing
    // into a destination whose match field is an object envelope (e.g. Notion). Matching
    // reduces the DESTINATION side through ITS field's extraction transformer too, so the two
    // sides meet on the same canonical key. Before the fix the destination object was compared
    // raw and never matched.
    gitSchemasByPath['/dest'] = {
      idColumnRemoteId: 'id',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          code: {
            type: 'object',
            'x-scratch-suggested-transformer': { type: 'jsonpath', options: { expression: '$.value' } },
          },
          name: { type: 'string' },
        },
      },
    };
    (dataFolderService.findOne as jest.Mock).mockImplementation((folderId: DataFolderId) =>
      Promise.resolve(
        folderId === destFolderId
          ? { path: '/dest', connectorService: 'NOTION' }
          : { path: '/src', connectorService: 'POSTGRES' },
      ),
    );

    // Source match field `id` is a plain string.
    const sourceFiles = [
      { folderId: sourceFolderId, path: 'src/a.json', content: '{"id": "shared-1", "name": "Alice"}' },
      { folderId: sourceFolderId, path: 'src/b.json', content: '{"id": "shared-2", "name": "Bob"}' },
    ];
    // Destination match field `code` is an object; the first reduces to "shared-1" (a match),
    // the second to "shared-9" (no source counterpart).
    const destFiles = [
      {
        folderId: destFolderId,
        path: 'dest/alice.json',
        content: '{"id": "dst1", "code": {"value": "shared-1"}, "name": "Old Alice"}',
      },
      {
        folderId: destFolderId,
        path: 'dest/other.json',
        content: '{"id": "dst2", "code": {"value": "shared-9"}, "name": "Unrelated"}',
      },
    ];

    (dataFolderService.getAllFileContentsByFolderId as jest.Mock).mockImplementation((_workbookIdArg, folderIdArg) => {
      if (folderIdArg === sourceFolderId) return Promise.resolve(sourceFiles);
      if (folderIdArg === destFolderId) return Promise.resolve(destFiles);
      return Promise.resolve([]);
    });

    const tableMapping: TableMapping = {
      sourceDataFolderId: sourceFolderId,
      destinationDataFolderId: destFolderId,
      columnMappings: [{ sourceColumnId: 'name', destinationColumnId: 'name' }],
      recordMatching: { sourceColumnId: 'id', destinationColumnId: 'code' },
    };

    const result = await syncService.syncTableMapping(syncId, tableMapping, workbookId, actor);

    // Alice matched her destination record (despite its object-valued match field);
    // Bob has no destination counterpart and is created.
    expect(result.errors).toHaveLength(0);
    expect(result.recordsUpdated).toBe(1);
    expect(result.recordsCreated).toBe(1);

    const aliceFile = writtenFiles.find((f) => f.path === 'dest/alice.json');
    expect(aliceFile).toBeDefined();
    const aliceContent = JSON.parse(aliceFile!.content) as Record<string, unknown>;
    expect(aliceContent.name).toBe('Alice');
    expect(aliceContent.id).toBe('dst1');
    // The object-valued match field is preserved verbatim — matching never rewrites it.
    expect(aliceContent.code).toEqual({ value: 'shared-1' });
  });
});

describe('SyncService - source_fk_to_dest_fk transformer (two-phase)', () => {
  let prisma: PrismaClient;
  let syncService: SyncService;
  let dataFolderService: DataFolderService;
  let scratchGitService: ScratchGitService;
  let dbService: DbService;

  // Test data
  let workbookId: WorkbookId;
  let sourceAuthorsFolderId: DataFolderId;
  let destAuthorsFolderId: DataFolderId;
  let sourcePostsFolderId: DataFolderId;
  let destPostsFolderId: DataFolderId;
  let syncId: SyncId;
  let orgId: string;
  let userId: string;
  let connectorAccountId: string;
  const actor: Actor = { userId: 'test-user', organizationId: 'test-org' };

  /**
   * The connection's display name, which is also its folder name at the top of the workspace
   * tree — and therefore the first segment of every pseudo-ref the FK producer emits for a
   * destination record in it (`@/<connection>/<folder>/<file>.json`).
   */
  const DEST_CONNECTION_FOLDER = 'Test Destination';

  // Track written files per call for verification
  let writtenFilesByCall: Array<Array<{ path: string; content: string }>>;

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  beforeEach(async () => {
    writtenFilesByCall = [];

    dbService = { client: prisma } as unknown as DbService;

    dataFolderService = {
      getAllFileContentsByFolderId: jest.fn(),
      getFileContentsByFolderIdPaginated: jest.fn(),
      findOne: jest.fn(),
    } as unknown as DataFolderService;

    // Wire paginated mock to delegate to getAllFileContentsByFolderId mock
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
        const schemas: Record<string, Record<string, unknown>> = {
          '/src-authors': { idPath: 'id' },
          '/dest-authors': { idPath: 'id' },
          '/src-posts': { idPath: 'id' },
          '/dest-posts': { idPath: 'id' },
        };
        return Promise.resolve(schemas[folderPath] ?? null);
      }),
      commitFilesToBranch: jest
        .fn()
        .mockImplementation((_workbookId, _branch, files: Array<{ path: string; content: string }>) => {
          writtenFilesByCall.push([...files]);
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

    // Create test organization
    const org = await prisma.organization.create({
      data: {
        id: 'org_fk_test_' + Date.now(),
        name: 'FK Test Org',
        clerkId: 'clerk_fk_' + Date.now(),
      },
    });
    orgId = org.id;

    const user = await prisma.user.create({
      data: {
        id: 'user_fk_test_' + Date.now(),
        email: `fk-test-${Date.now()}@example.com`,
        organizationId: org.id,
      },
    });
    userId = user.id;

    const wbId = createWorkbookId();
    await prisma.workbook.create({
      data: {
        id: wbId,
        name: 'FK Test Workbook',
        userId: user.id,
        organizationId: org.id,
      },
    });
    workbookId = wbId;

    // The connection the DESTINATION folders belong to. A linked DataFolder always has one in
    // production, and the FK producer reads it to build the workspace-absolute pseudo-ref, so
    // the folders below have to carry it or no reference can be named.
    const connAccountId = createConnectorAccountId();
    await prisma.connectorAccount.create({
      data: {
        id: connAccountId,
        workbookId,
        service: 'AIRTABLE',
        displayName: DEST_CONNECTION_FOLDER,
      },
    });
    connectorAccountId = connAccountId;

    // Create 4 data folders: sourceAuthors, destAuthors, sourcePosts, destPosts
    const srcAuthId = createDataFolderId();
    await prisma.dataFolder.create({
      data: {
        id: srcAuthId,
        name: 'Source Authors',
        workbookId,
        connectorAccountId,
        path: '/src-authors',
      },
    });
    sourceAuthorsFolderId = srcAuthId;

    const dstAuthId = createDataFolderId();
    await prisma.dataFolder.create({
      data: {
        id: dstAuthId,
        name: 'Dest Authors',
        workbookId,
        connectorAccountId,
        path: '/dest-authors',
      },
    });
    destAuthorsFolderId = dstAuthId;

    const srcPostsId = createDataFolderId();
    await prisma.dataFolder.create({
      data: {
        id: srcPostsId,
        name: 'Source Posts',
        workbookId,
        connectorAccountId,
        path: '/src-posts',
      },
    });
    sourcePostsFolderId = srcPostsId;

    const dstPostsId = createDataFolderId();
    await prisma.dataFolder.create({
      data: {
        id: dstPostsId,
        name: 'Dest Posts',
        workbookId,
        connectorAccountId,
        path: '/dest-posts',
      },
    });
    destPostsFolderId = dstPostsId;

    // Create sync
    const synId = createSyncId();
    await prisma.sync.create({
      data: {
        id: synId,
        displayName: 'FK Test Sync',
        mappings: [],
      },
    });
    syncId = synId;

    // One SyncTablePair per table mapping — exactly what `createSync`/`updateSync` write for
    // every real sync. These tests drive `syncTableMapping` directly instead of going through
    // those, so the rows have to be seeded by hand. The FK producer reads the referenced pair's
    // DESTINATION folder through here to name the connection its pseudo-ref points at.
    await prisma.syncTablePair.createMany({
      data: [
        {
          id: createSyncTablePairId(),
          syncId,
          sourceDataFolderId: sourceAuthorsFolderId,
          destinationDataFolderId: destAuthorsFolderId,
        },
        {
          id: createSyncTablePairId(),
          syncId,
          sourceDataFolderId: sourcePostsFolderId,
          destinationDataFolderId: destPostsFolderId,
        },
      ],
    });
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

  /**
   * Helper: set up mock for getAllFileContentsByFolderId
   */
  function mockFiles(filesByFolder: Record<string, Array<{ folderId: DataFolderId; path: string; content: string }>>) {
    (dataFolderService.getAllFileContentsByFolderId as jest.Mock).mockImplementation(
      (_workbookIdArg: WorkbookId, folderIdArg: DataFolderId) => {
        return Promise.resolve(filesByFolder[folderIdArg] ?? []);
      },
    );
  }

  it('should resolve FK to an existing destination record after two-phase sync', async () => {
    // Author already exists in destination with a known ID
    const sourceAuthorFiles = [
      {
        folderId: sourceAuthorsFolderId,
        path: 'src-authors/author1.json',
        content: '{"id": "rec_author_1", "name": "Alice", "email": "alice@example.com"}',
      },
    ];
    const destAuthorFiles = [
      {
        folderId: destAuthorsFolderId,
        path: 'dest-authors/author1.json',
        content: '{"id": "dest_author_1", "name": "Alice", "email": "alice@example.com"}',
      },
    ];
    const sourcePostFiles = [
      {
        folderId: sourcePostsFolderId,
        path: 'src-posts/post1.json',
        content: '{"id": "rec_post_1", "title": "Hello World", "slug": "hello-world", "author_id": "rec_author_1"}',
      },
    ];
    const destPostFiles: typeof sourcePostFiles = [];

    // Phase 1: sync authors (existing record matches), then sync posts
    mockFiles({
      [sourceAuthorsFolderId]: sourceAuthorFiles,
      [destAuthorsFolderId]: destAuthorFiles,
      [sourcePostsFolderId]: sourcePostFiles,
      [destPostsFolderId]: destPostFiles,
    });

    const authorsMapping: TableMapping = {
      sourceDataFolderId: sourceAuthorsFolderId,
      destinationDataFolderId: destAuthorsFolderId,
      columnMappings: [
        { sourceColumnId: 'name', destinationColumnId: 'name' },
        { sourceColumnId: 'email', destinationColumnId: 'email' },
      ],
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email' },
    };

    const postsMapping: TableMapping = {
      sourceDataFolderId: sourcePostsFolderId,
      destinationDataFolderId: destPostsFolderId,
      columnMappings: [
        { sourceColumnId: 'title', destinationColumnId: 'title' },
        { sourceColumnId: 'slug', destinationColumnId: 'slug' },
        {
          sourceColumnId: 'author_id',
          destinationColumnId: 'author_id',
          transformer: {
            type: 'source_fk_to_dest_fk',
            options: { referencedDataFolderId: sourceAuthorsFolderId },
          },
        },
      ],
      recordMatching: { sourceColumnId: 'slug', destinationColumnId: 'slug' },
    };

    // Phase 1: sync both table mappings
    await syncService.syncTableMapping(syncId, authorsMapping, workbookId, actor);
    const postsResult = await syncService.syncTableMapping(syncId, postsMapping, workbookId, actor);

    expect(postsResult.recordsCreated).toBe(1);
    expect(postsResult.errors).toHaveLength(0);

    // After Phase 1, the post file should NOT have author_id — it's skipped during DATA phase
    const phase1PostFiles = writtenFilesByCall[writtenFilesByCall.length - 1];
    expect(phase1PostFiles).toHaveLength(1);
    const phase1PostContent = JSON.parse(phase1PostFiles[0].content) as Record<string, unknown>;
    expect(phase1PostContent.author_id).toBeUndefined(); // Skipped in DATA phase, resolved in Phase 2

    // Phase 2: resolve FK references
    // First update mock to return the newly written post file
    const postTempId = phase1PostContent.id as string;
    mockFiles({
      [sourceAuthorsFolderId]: sourceAuthorFiles,
      [destAuthorsFolderId]: destAuthorFiles,
      [sourcePostsFolderId]: sourcePostFiles,
      [destPostsFolderId]: [
        {
          folderId: destPostsFolderId,
          path: phase1PostFiles[0].path,
          content: phase1PostFiles[0].content,
        },
      ],
    });

    const fkResult = await syncService.syncTableMapping(syncId, postsMapping, workbookId, actor, 'FOREIGN_KEY_MAPPING');

    expect(fkResult.recordsCreated).toBe(0);
    expect(fkResult.recordsUpdated).toBe(1);
    expect(fkResult.errors).toHaveLength(0);

    // Verify the resolved file has the destination author ID
    const phase2PostFiles = writtenFilesByCall[writtenFilesByCall.length - 1];
    const phase2PostContent = JSON.parse(phase2PostFiles[0].content) as Record<string, unknown>;
    expect(phase2PostContent.author_id).toBe('dest_author_1'); // Resolved to real destination remote ID
    expect(phase2PostContent.id).toBe(postTempId); // ID should be preserved
  });

  it('should resolve FK to a newly created record (cross-table)', async () => {
    // Author is NEW (doesn't exist in destination)
    const sourceAuthorFiles = [
      {
        folderId: sourceAuthorsFolderId,
        path: 'src-authors/author1.json',
        content: '{"id": "rec_author_1", "name": "Bob", "email": "bob@example.com"}',
      },
    ];
    const destAuthorFiles: typeof sourceAuthorFiles = [];
    const sourcePostFiles = [
      {
        folderId: sourcePostsFolderId,
        path: 'src-posts/post1.json',
        content: '{"id": "rec_post_1", "title": "First Post", "slug": "first-post", "author_id": "rec_author_1"}',
      },
    ];
    const destPostFiles: typeof sourcePostFiles = [];

    mockFiles({
      [sourceAuthorsFolderId]: sourceAuthorFiles,
      [destAuthorsFolderId]: destAuthorFiles,
      [sourcePostsFolderId]: sourcePostFiles,
      [destPostsFolderId]: destPostFiles,
    });

    const authorsMapping: TableMapping = {
      sourceDataFolderId: sourceAuthorsFolderId,
      destinationDataFolderId: destAuthorsFolderId,
      columnMappings: [
        { sourceColumnId: 'name', destinationColumnId: 'name' },
        { sourceColumnId: 'email', destinationColumnId: 'email' },
      ],
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email' },
    };

    const postsMapping: TableMapping = {
      sourceDataFolderId: sourcePostsFolderId,
      destinationDataFolderId: destPostsFolderId,
      columnMappings: [
        { sourceColumnId: 'title', destinationColumnId: 'title' },
        { sourceColumnId: 'slug', destinationColumnId: 'slug' },
        {
          sourceColumnId: 'author_id',
          destinationColumnId: 'author_id',
          transformer: {
            type: 'source_fk_to_dest_fk',
            options: { referencedDataFolderId: sourceAuthorsFolderId },
          },
        },
      ],
      recordMatching: { sourceColumnId: 'slug', destinationColumnId: 'slug' },
    };

    // Phase 1: sync both table mappings
    const authorsResult = await syncService.syncTableMapping(syncId, authorsMapping, workbookId, actor);
    expect(authorsResult.recordsCreated).toBe(1);

    const postsResult = await syncService.syncTableMapping(syncId, postsMapping, workbookId, actor);
    expect(postsResult.recordsCreated).toBe(1);
    expect(postsResult.errors).toHaveLength(0);

    // Get the temp IDs assigned to the new records
    const authorFiles = writtenFilesByCall[0];
    const authorContent = JSON.parse(authorFiles[0].content) as Record<string, unknown>;
    const authorTempId = authorContent.id as string;
    expect(authorTempId.startsWith('scratch_pending_publish_')).toBe(true);

    const postFiles = writtenFilesByCall[1];
    const postContent = JSON.parse(postFiles[0].content) as Record<string, unknown>;
    expect(postContent.author_id).toBeUndefined(); // Skipped in DATA phase, resolved in Phase 2

    // Phase 2: update mock to return written files, then resolve FKs
    mockFiles({
      [sourcePostsFolderId]: sourcePostFiles,
      [destPostsFolderId]: [
        {
          folderId: destPostsFolderId,
          path: postFiles[0].path,
          content: postFiles[0].content,
        },
      ],
    });

    const fkResult = await syncService.syncTableMapping(syncId, postsMapping, workbookId, actor, 'FOREIGN_KEY_MAPPING');

    expect(fkResult.recordsCreated).toBe(0);
    expect(fkResult.recordsUpdated).toBe(1);
    expect(fkResult.errors).toHaveLength(0);

    // The post's author_id is now a workspace-absolute pseudo-ref to the author's file:
    // the connection folder first, then the connection-relative path.
    const resolvedPostFiles = writtenFilesByCall[writtenFilesByCall.length - 1];
    const resolvedPostContent = JSON.parse(resolvedPostFiles[0].content) as Record<string, unknown>;
    expect(resolvedPostContent.author_id).toBe(`@/${DEST_CONNECTION_FOLDER}/${authorFiles[0].path}`);
  });

  it('should handle FK with null value (no error)', async () => {
    const sourcePostFiles = [
      {
        folderId: sourcePostsFolderId,
        path: 'src-posts/post1.json',
        content: '{"id": "rec_post_1", "title": "No Author", "slug": "no-author", "author_id": null}',
      },
    ];
    const destPostFiles: typeof sourcePostFiles = [];

    mockFiles({
      [sourcePostsFolderId]: sourcePostFiles,
      [destPostsFolderId]: destPostFiles,
    });

    const postsMapping: TableMapping = {
      sourceDataFolderId: sourcePostsFolderId,
      destinationDataFolderId: destPostsFolderId,
      columnMappings: [
        { sourceColumnId: 'title', destinationColumnId: 'title' },
        { sourceColumnId: 'slug', destinationColumnId: 'slug' },
        {
          sourceColumnId: 'author_id',
          destinationColumnId: 'author_id',
          transformer: {
            type: 'source_fk_to_dest_fk',
            options: { referencedDataFolderId: sourceAuthorsFolderId },
          },
        },
      ],
      recordMatching: { sourceColumnId: 'slug', destinationColumnId: 'slug' },
    };

    // Phase 1
    const result = await syncService.syncTableMapping(syncId, postsMapping, workbookId, actor);
    expect(result.recordsCreated).toBe(1);
    expect(result.errors).toHaveLength(0);

    const postFiles = writtenFilesByCall[0];
    const postContent = JSON.parse(postFiles[0].content) as Record<string, unknown>;
    // FK field is skipped in DATA phase (not written at all)
    expect(postContent.author_id).toBeUndefined();

    // Phase 2: resolve FKs - null should resolve to null without error
    mockFiles({
      [sourcePostsFolderId]: sourcePostFiles,
      [destPostsFolderId]: [
        {
          folderId: destPostsFolderId,
          path: postFiles[0].path,
          content: postFiles[0].content,
        },
      ],
    });

    const fkResult = await syncService.syncTableMapping(syncId, postsMapping, workbookId, actor, 'FOREIGN_KEY_MAPPING');
    expect(fkResult.errors).toHaveLength(0);
    // Null FK value passes through unchanged, record still gets updated (other fields re-written)
    expect(fkResult.recordsUpdated).toBe(1);
  });

  it('should resolve FK with array value', async () => {
    // Author 1 exists in destination
    const sourceAuthorFiles = [
      {
        folderId: sourceAuthorsFolderId,
        path: 'src-authors/auth1.json',
        content: '{"id": "auth_1", "name": "Author1", "email": "a1@example.com"}',
      },
      {
        folderId: sourceAuthorsFolderId,
        path: 'src-authors/auth2.json',
        content: '{"id": "auth_2", "name": "Author2", "email": "a2@example.com"}',
      },
    ];
    const destAuthorFiles = [
      {
        folderId: destAuthorsFolderId,
        path: 'dest-authors/auth1.json',
        content: '{"id": "dest_auth_1", "name": "Author1", "email": "a1@example.com"}',
      },
      {
        folderId: destAuthorsFolderId,
        path: 'dest-authors/auth2.json',
        content: '{"id": "dest_auth_2", "name": "Author2", "email": "a2@example.com"}',
      },
    ];

    const sourcePostFiles = [
      {
        folderId: sourcePostsFolderId,
        path: 'src-posts/post1.json',
        content: '{"id": "rec_post_1", "title": "Collab Post", "slug": "collab", "author_ids": ["auth_1", "auth_2"]}',
      },
    ];
    const destPostFiles: typeof sourcePostFiles = [];

    mockFiles({
      [sourceAuthorsFolderId]: sourceAuthorFiles,
      [destAuthorsFolderId]: destAuthorFiles,
      [sourcePostsFolderId]: sourcePostFiles,
      [destPostsFolderId]: destPostFiles,
    });

    const authorsMapping: TableMapping = {
      sourceDataFolderId: sourceAuthorsFolderId,
      destinationDataFolderId: destAuthorsFolderId,
      columnMappings: [
        { sourceColumnId: 'name', destinationColumnId: 'name' },
        { sourceColumnId: 'email', destinationColumnId: 'email' },
      ],
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email' },
    };

    const postsMapping: TableMapping = {
      sourceDataFolderId: sourcePostsFolderId,
      destinationDataFolderId: destPostsFolderId,
      columnMappings: [
        { sourceColumnId: 'title', destinationColumnId: 'title' },
        { sourceColumnId: 'slug', destinationColumnId: 'slug' },
        {
          sourceColumnId: 'author_ids',
          destinationColumnId: 'author_ids',
          transformer: {
            type: 'source_fk_to_dest_fk',
            options: { referencedDataFolderId: sourceAuthorsFolderId },
          },
        },
      ],
      recordMatching: { sourceColumnId: 'slug', destinationColumnId: 'slug' },
    };

    // Phase 1
    await syncService.syncTableMapping(syncId, authorsMapping, workbookId, actor);
    const postsResult = await syncService.syncTableMapping(syncId, postsMapping, workbookId, actor);
    expect(postsResult.recordsCreated).toBe(1);

    const postFiles = writtenFilesByCall[writtenFilesByCall.length - 1];
    const postContent = JSON.parse(postFiles[0].content) as Record<string, unknown>;
    // FK field is skipped in DATA phase (not written at all)
    expect(postContent.author_ids).toBeUndefined();

    // Phase 2: resolve FKs
    mockFiles({
      [sourcePostsFolderId]: sourcePostFiles,
      [destPostsFolderId]: [
        {
          folderId: destPostsFolderId,
          path: postFiles[0].path,
          content: postFiles[0].content,
        },
      ],
    });

    const fkResult = await syncService.syncTableMapping(syncId, postsMapping, workbookId, actor, 'FOREIGN_KEY_MAPPING');
    expect(fkResult.recordsCreated).toBe(0);
    expect(fkResult.recordsUpdated).toBe(1);
    expect(fkResult.errors).toHaveLength(0);

    const resolvedPostFiles = writtenFilesByCall[writtenFilesByCall.length - 1];
    const resolvedPostContent = JSON.parse(resolvedPostFiles[0].content) as Record<string, unknown>;
    expect(resolvedPostContent.author_ids).toEqual(['dest_auth_1', 'dest_auth_2']); // Resolved to real destination remote IDs
  });

  it('should warn and empty the link — not fail the table — when FK references a non-existent record', async () => {
    // DEV-11222: a reference whose target is gone from the source (deleted upstream, so the pull
    // never saw it) is normal in every CRM/billing source. It used to fail the record, and a failed
    // record fails its whole table and skips the run's publish; now the one link is left empty and
    // the loss is reported as a warning.
    const sourcePostFiles = [
      {
        folderId: sourcePostsFolderId,
        path: 'src-posts/post1.json',
        content: '{"id": "rec_post_1", "title": "Orphan", "slug": "orphan", "author_id": "non_existent_author"}',
      },
    ];
    const destPostFiles: typeof sourcePostFiles = [];

    mockFiles({
      [sourcePostsFolderId]: sourcePostFiles,
      [destPostsFolderId]: destPostFiles,
    });

    const postsMapping: TableMapping = {
      sourceDataFolderId: sourcePostsFolderId,
      destinationDataFolderId: destPostsFolderId,
      columnMappings: [
        { sourceColumnId: 'title', destinationColumnId: 'title' },
        { sourceColumnId: 'slug', destinationColumnId: 'slug' },
        {
          sourceColumnId: 'author_id',
          destinationColumnId: 'author_id',
          transformer: {
            type: 'source_fk_to_dest_fk',
            options: { referencedDataFolderId: sourceAuthorsFolderId },
          },
        },
      ],
      recordMatching: { sourceColumnId: 'slug', destinationColumnId: 'slug' },
    };

    // Phase 1
    await syncService.syncTableMapping(syncId, postsMapping, workbookId, actor);

    const postFiles = writtenFilesByCall[0];

    // Phase 2: resolve FKs — the author doesn't exist, so the link is emptied and warned about
    mockFiles({
      [sourcePostsFolderId]: sourcePostFiles,
      [destPostsFolderId]: [
        {
          folderId: destPostsFolderId,
          path: postFiles[0].path,
          content: postFiles[0].content,
        },
      ],
    });

    const fkResult = await syncService.syncTableMapping(syncId, postsMapping, workbookId, actor, 'FOREIGN_KEY_MAPPING');
    expect(fkResult.recordsCreated).toBe(0);
    expect(fkResult.errors).toHaveLength(0);
    expect(fkResult.errorCount).toBe(0);
    expect(fkResult.warningCount).toBe(1);
    expect(fkResult.warnings[0].warning).toContain('Skipped unresolved foreign key');
    expect(fkResult.warnings[0].warning).toContain('non_existent_author');

    // The rest of the record still synced; only the unresolvable link is empty.
    const resolvedPostFiles = writtenFilesByCall[writtenFilesByCall.length - 1];
    const resolvedPostContent = JSON.parse(resolvedPostFiles[0].content) as Record<string, unknown>;
    expect(resolvedPostContent.title).toBe('Orphan');
    expect(resolvedPostContent.author_id).toBeNull();
  });

  it('should PRESERVE an existing destination link when the FK becomes unresolvable', async () => {
    // DEV-11222 follow-on: the destination record already links to the author correctly from an
    // earlier sync, and only now has the author gone missing from the source. Emptying the field
    // here would publish an UNLINK to the destination service — destroying a good link because we
    // could not resolve the source's reference. The field must be left exactly as it is.
    const sourcePostFiles = [
      {
        folderId: sourcePostsFolderId,
        path: 'src-posts/post1.json',
        content: '{"id": "rec_post_1", "title": "Orphan", "slug": "orphan", "author_id": "since_deleted_author"}',
      },
    ];

    mockFiles({
      [sourcePostsFolderId]: sourcePostFiles,
      [destPostsFolderId]: [],
    });

    const postsMapping: TableMapping = {
      sourceDataFolderId: sourcePostsFolderId,
      destinationDataFolderId: destPostsFolderId,
      columnMappings: [
        { sourceColumnId: 'title', destinationColumnId: 'title' },
        { sourceColumnId: 'slug', destinationColumnId: 'slug' },
        {
          sourceColumnId: 'author_id',
          destinationColumnId: 'author_id',
          transformer: {
            type: 'source_fk_to_dest_fk',
            options: { referencedDataFolderId: sourceAuthorsFolderId },
          },
        },
      ],
      recordMatching: { sourceColumnId: 'slug', destinationColumnId: 'slug' },
    };

    // Phase 1 establishes the record pair, then we seed the destination copy with the link a
    // PREVIOUS sync had resolved — the state that must survive.
    await syncService.syncTableMapping(syncId, postsMapping, workbookId, actor);
    const postFiles = writtenFilesByCall[0];
    const alreadyLinkedDestRecord = {
      ...(JSON.parse(postFiles[0].content) as Record<string, unknown>),
      author_id: 'dest_auth_1',
    };

    const writeCallCountBeforeFkPhase = writtenFilesByCall.length;
    mockFiles({
      [sourcePostsFolderId]: sourcePostFiles,
      [destPostsFolderId]: [
        {
          folderId: destPostsFolderId,
          path: postFiles[0].path,
          content: JSON.stringify(alreadyLinkedDestRecord),
        },
      ],
    });

    const fkResult = await syncService.syncTableMapping(syncId, postsMapping, workbookId, actor, 'FOREIGN_KEY_MAPPING');
    expect(fkResult.errorCount).toBe(0);
    expect(fkResult.warningCount).toBe(1);
    expect(fkResult.warnings[0].warning).toContain('Left the field untouched');

    // The record is byte-identical to what was on disk, so nothing is written and nothing is
    // published — the existing link survives.
    expect(fkResult.recordsUpdated).toBe(0);
    const filesWrittenDuringFkPhase = writtenFilesByCall.slice(writeCallCountBeforeFkPhase).flat();
    expect(filesWrittenDuringFkPhase).toHaveLength(0);
  });

  it('should resolve circular FK references (authors reference posts, posts reference authors)', async () => {
    // Authors have latest_post_id, Posts have author_id
    const sourceAuthorFiles = [
      {
        folderId: sourceAuthorsFolderId,
        path: 'src-authors/auth1.json',
        content: '{"id": "auth_1", "name": "Alice", "email": "alice@example.com", "latest_post_id": "post_1"}',
      },
    ];
    const destAuthorFiles: typeof sourceAuthorFiles = [];

    const sourcePostFiles = [
      {
        folderId: sourcePostsFolderId,
        path: 'src-posts/post1.json',
        content: '{"id": "post_1", "title": "Hello", "slug": "hello", "author_id": "auth_1"}',
      },
    ];
    const destPostFiles: typeof sourcePostFiles = [];

    mockFiles({
      [sourceAuthorsFolderId]: sourceAuthorFiles,
      [destAuthorsFolderId]: destAuthorFiles,
      [sourcePostsFolderId]: sourcePostFiles,
      [destPostsFolderId]: destPostFiles,
    });

    const authorsMapping: TableMapping = {
      sourceDataFolderId: sourceAuthorsFolderId,
      destinationDataFolderId: destAuthorsFolderId,
      columnMappings: [
        { sourceColumnId: 'name', destinationColumnId: 'name' },
        { sourceColumnId: 'email', destinationColumnId: 'email' },
        {
          sourceColumnId: 'latest_post_id',
          destinationColumnId: 'latest_post_id',
          transformer: {
            type: 'source_fk_to_dest_fk',
            options: { referencedDataFolderId: sourcePostsFolderId },
          },
        },
      ],
      recordMatching: { sourceColumnId: 'email', destinationColumnId: 'email' },
    };

    const postsMapping: TableMapping = {
      sourceDataFolderId: sourcePostsFolderId,
      destinationDataFolderId: destPostsFolderId,
      columnMappings: [
        { sourceColumnId: 'title', destinationColumnId: 'title' },
        { sourceColumnId: 'slug', destinationColumnId: 'slug' },
        {
          sourceColumnId: 'author_id',
          destinationColumnId: 'author_id',
          transformer: {
            type: 'source_fk_to_dest_fk',
            options: { referencedDataFolderId: sourceAuthorsFolderId },
          },
        },
      ],
      recordMatching: { sourceColumnId: 'slug', destinationColumnId: 'slug' },
    };

    // Phase 1: sync both table mappings (order shouldn't matter)
    const authorsResult = await syncService.syncTableMapping(syncId, authorsMapping, workbookId, actor);
    expect(authorsResult.recordsCreated).toBe(1);

    const postsResult = await syncService.syncTableMapping(syncId, postsMapping, workbookId, actor);
    expect(postsResult.recordsCreated).toBe(1);

    // Get the temp IDs
    const authorFiles = writtenFilesByCall[0];
    const authorContent = JSON.parse(authorFiles[0].content) as Record<string, unknown>;
    // FK field is skipped in DATA phase (not written at all)
    expect(authorContent.latest_post_id).toBeUndefined();

    const postFiles = writtenFilesByCall[1];
    const postContent = JSON.parse(postFiles[0].content) as Record<string, unknown>;
    // FK field is skipped in DATA phase (not written at all)
    expect(postContent.author_id).toBeUndefined();

    // Phase 2: resolve FKs for both table mappings
    // Update mocks to return written files
    mockFiles({
      [sourceAuthorsFolderId]: sourceAuthorFiles,
      [sourcePostsFolderId]: sourcePostFiles,
      [destAuthorsFolderId]: [
        {
          folderId: destAuthorsFolderId,
          path: authorFiles[0].path,
          content: authorFiles[0].content,
        },
      ],
      [destPostsFolderId]: [
        {
          folderId: destPostsFolderId,
          path: postFiles[0].path,
          content: postFiles[0].content,
        },
      ],
    });

    // Resolve authors (latest_post_id -> posts)
    const authorsFkResult = await syncService.syncTableMapping(
      syncId,
      authorsMapping,
      workbookId,
      actor,
      'FOREIGN_KEY_MAPPING',
    );
    expect(authorsFkResult.recordsCreated).toBe(0);
    expect(authorsFkResult.recordsUpdated).toBe(1);
    expect(authorsFkResult.errors).toHaveLength(0);

    // Resolve posts (author_id -> authors)
    const postsFkResult = await syncService.syncTableMapping(
      syncId,
      postsMapping,
      workbookId,
      actor,
      'FOREIGN_KEY_MAPPING',
    );
    expect(postsFkResult.recordsCreated).toBe(0);
    expect(postsFkResult.recordsUpdated).toBe(1);
    expect(postsFkResult.errors).toHaveLength(0);

    // Verify resolved values — FK fields should be file paths, not IDs
    const resolvedAuthorFiles = writtenFilesByCall[writtenFilesByCall.length - 2];
    const resolvedAuthorContent = JSON.parse(resolvedAuthorFiles[0].content) as Record<string, unknown>;
    expect(resolvedAuthorContent.latest_post_id).toBe(`@/${DEST_CONNECTION_FOLDER}/${postFiles[0].path}`);

    const resolvedPostFiles = writtenFilesByCall[writtenFilesByCall.length - 1];
    const resolvedPostContent = JSON.parse(resolvedPostFiles[0].content) as Record<string, unknown>;
    expect(resolvedPostContent.author_id).toBe(`@/${DEST_CONNECTION_FOLDER}/${authorFiles[0].path}`);
  });
});

describe('SyncService - lookup_field transformer', () => {
  let prisma: PrismaClient;
  let syncService: SyncService;
  let dataFolderService: DataFolderService;
  let scratchGitService: ScratchGitService;
  let dbService: DbService;

  // Test data
  let workbookId: WorkbookId;
  let sourceCategoriesFolderId: DataFolderId;
  let sourcePostsFolderId: DataFolderId;
  let destPostsFolderId: DataFolderId;
  let syncId: SyncId;
  let orgId: string;
  let userId: string;
  const actor: Actor = { userId: 'test-user', organizationId: 'test-org' };

  // Track written files for verification
  let writtenFiles: Array<{ path: string; content: string }>;

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  beforeEach(async () => {
    writtenFiles = [];

    dbService = { client: prisma } as unknown as DbService;

    dataFolderService = {
      getAllFileContentsByFolderId: jest.fn(),
      getFileContentsByFolderIdPaginated: jest.fn(),
      findOne: jest.fn(),
    } as unknown as DataFolderService;

    // Wire paginated mock to delegate to getAllFileContentsByFolderId mock
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
        const schemas: Record<string, Record<string, unknown>> = {
          '/src-categories': { idPath: 'id' },
          '/src-posts': { idPath: 'id' },
          '/dest-posts': { idPath: 'id' },
        };
        return Promise.resolve(schemas[folderPath] ?? null);
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

    // Create test organization
    const org = await prisma.organization.create({
      data: {
        id: 'org_lookup_test_' + Date.now(),
        name: 'Lookup Test Org',
        clerkId: 'clerk_lookup_' + Date.now(),
      },
    });
    orgId = org.id;

    const user = await prisma.user.create({
      data: {
        id: 'user_lookup_test_' + Date.now(),
        email: `lookup-test-${Date.now()}@example.com`,
        organizationId: org.id,
      },
    });
    userId = user.id;

    const wbId = createWorkbookId();
    await prisma.workbook.create({
      data: {
        id: wbId,
        name: 'Lookup Test Workbook',
        userId: user.id,
        organizationId: org.id,
      },
    });
    workbookId = wbId;

    // Create 3 data folders: sourceCategories, sourcePosts, destPosts
    const srcCatId = createDataFolderId();
    await prisma.dataFolder.create({
      data: {
        id: srcCatId,
        name: 'Source Categories',
        workbookId,
        path: '/src-categories',
      },
    });
    sourceCategoriesFolderId = srcCatId;

    const srcPostsId = createDataFolderId();
    await prisma.dataFolder.create({
      data: {
        id: srcPostsId,
        name: 'Source Posts',
        workbookId,
        path: '/src-posts',
      },
    });
    sourcePostsFolderId = srcPostsId;

    const dstPostsId = createDataFolderId();
    await prisma.dataFolder.create({
      data: {
        id: dstPostsId,
        name: 'Dest Posts',
        workbookId,
        path: '/dest-posts',
      },
    });
    destPostsFolderId = dstPostsId;

    // Create sync
    const synId = createSyncId();
    await prisma.sync.create({
      data: {
        id: synId,
        displayName: 'Lookup Test Sync',
        mappings: [],
      },
    });
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

  /**
   * Helper: set up mock for getAllFileContentsByFolderId
   */
  function mockFiles(filesByFolder: Record<string, Array<{ folderId: DataFolderId; path: string; content: string }>>) {
    (dataFolderService.getAllFileContentsByFolderId as jest.Mock).mockImplementation(
      (_workbookIdArg: WorkbookId, folderIdArg: DataFolderId) => {
        return Promise.resolve(filesByFolder[folderIdArg] ?? []);
      },
    );
  }

  it('should resolve a scalar FK to a field value from the referenced record', async () => {
    const sourceCategoryFiles = [
      {
        folderId: sourceCategoriesFolderId,
        path: 'src-categories/cat1.json',
        content: '{"id": "cat_1", "name": "Technology", "description": "Tech articles"}',
      },
      {
        folderId: sourceCategoriesFolderId,
        path: 'src-categories/cat2.json',
        content: '{"id": "cat_2", "name": "Science", "description": "Science articles"}',
      },
    ];

    const sourcePostFiles = [
      {
        folderId: sourcePostsFolderId,
        path: 'src-posts/post1.json',
        content: '{"id": "post_1", "title": "AI is cool", "slug": "ai-cool", "category_id": "cat_1"}',
      },
      {
        folderId: sourcePostsFolderId,
        path: 'src-posts/post2.json',
        content: '{"id": "post_2", "title": "Quantum stuff", "slug": "quantum", "category_id": "cat_2"}',
      },
    ];

    const destPostFiles: typeof sourcePostFiles = [];

    mockFiles({
      [sourceCategoriesFolderId]: sourceCategoryFiles,
      [sourcePostsFolderId]: sourcePostFiles,
      [destPostsFolderId]: destPostFiles,
    });

    const postsMapping: TableMapping = {
      sourceDataFolderId: sourcePostsFolderId,
      destinationDataFolderId: destPostsFolderId,
      columnMappings: [
        { sourceColumnId: 'title', destinationColumnId: 'title' },
        { sourceColumnId: 'slug', destinationColumnId: 'slug' },
        {
          sourceColumnId: 'category_id',
          destinationColumnId: 'category_name',
          transformer: {
            type: 'lookup_field',
            options: {
              referencedDataFolderId: sourceCategoriesFolderId,
              referencedFieldPath: 'name',
            },
          },
        },
      ],
      recordMatching: { sourceColumnId: 'slug', destinationColumnId: 'slug' },
    };

    const result = await syncService.syncTableMapping(syncId, postsMapping, workbookId, actor);

    expect(result.recordsCreated).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(writtenFiles).toHaveLength(2);

    // Find each file by checking its content
    const file1 = writtenFiles.find((f) => {
      const content = JSON.parse(f.content) as Record<string, unknown>;
      return content.title === 'AI is cool';
    });
    expect(file1).toBeDefined();
    const file1Content = JSON.parse(file1!.content) as Record<string, unknown>;
    expect(file1Content.category_name).toBe('Technology');

    const file2 = writtenFiles.find((f) => {
      const content = JSON.parse(f.content) as Record<string, unknown>;
      return content.title === 'Quantum stuff';
    });
    expect(file2).toBeDefined();
    const file2Content = JSON.parse(file2!.content) as Record<string, unknown>;
    expect(file2Content.category_name).toBe('Science');
  });

  it('should handle null FK value without error', async () => {
    const sourceCategoryFiles = [
      {
        folderId: sourceCategoriesFolderId,
        path: 'src-categories/cat1.json',
        content: '{"id": "cat_1", "name": "Technology"}',
      },
    ];

    const sourcePostFiles = [
      {
        folderId: sourcePostsFolderId,
        path: 'src-posts/post1.json',
        content: '{"id": "post_1", "title": "Uncategorized", "slug": "uncategorized", "category_id": null}',
      },
    ];

    const destPostFiles: typeof sourcePostFiles = [];

    mockFiles({
      [sourceCategoriesFolderId]: sourceCategoryFiles,
      [sourcePostsFolderId]: sourcePostFiles,
      [destPostsFolderId]: destPostFiles,
    });

    const postsMapping: TableMapping = {
      sourceDataFolderId: sourcePostsFolderId,
      destinationDataFolderId: destPostsFolderId,
      columnMappings: [
        { sourceColumnId: 'title', destinationColumnId: 'title' },
        { sourceColumnId: 'slug', destinationColumnId: 'slug' },
        {
          sourceColumnId: 'category_id',
          destinationColumnId: 'category_name',
          transformer: {
            type: 'lookup_field',
            options: {
              referencedDataFolderId: sourceCategoriesFolderId,
              referencedFieldPath: 'name',
            },
          },
        },
      ],
      recordMatching: { sourceColumnId: 'slug', destinationColumnId: 'slug' },
    };

    const result = await syncService.syncTableMapping(syncId, postsMapping, workbookId, actor);

    expect(result.recordsCreated).toBe(1);
    expect(result.errors).toHaveLength(0);

    const fileContent = JSON.parse(writtenFiles[0].content) as Record<string, unknown>;
    expect(fileContent.category_name).toBeNull();
  });

  it('should return error when FK references a non-existent record', async () => {
    // No categories exist — the FK can't be resolved
    const sourceCategoryFiles: Array<{ folderId: DataFolderId; path: string; content: string }> = [];

    const sourcePostFiles = [
      {
        folderId: sourcePostsFolderId,
        path: 'src-posts/post1.json',
        content: '{"id": "post_1", "title": "Orphaned", "slug": "orphaned", "category_id": "cat_999"}',
      },
    ];

    const destPostFiles: typeof sourcePostFiles = [];

    mockFiles({
      [sourceCategoriesFolderId]: sourceCategoryFiles,
      [sourcePostsFolderId]: sourcePostFiles,
      [destPostsFolderId]: destPostFiles,
    });

    const postsMapping: TableMapping = {
      sourceDataFolderId: sourcePostsFolderId,
      destinationDataFolderId: destPostsFolderId,
      columnMappings: [
        { sourceColumnId: 'title', destinationColumnId: 'title' },
        { sourceColumnId: 'slug', destinationColumnId: 'slug' },
        {
          sourceColumnId: 'category_id',
          destinationColumnId: 'category_name',
          transformer: {
            type: 'lookup_field',
            options: {
              referencedDataFolderId: sourceCategoriesFolderId,
              referencedFieldPath: 'name',
            },
          },
        },
      ],
      recordMatching: { sourceColumnId: 'slug', destinationColumnId: 'slug' },
    };

    const result = await syncService.syncTableMapping(syncId, postsMapping, workbookId, actor);

    expect(result.recordsCreated).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain('Could not find referenced record');
    expect(result.errors[0].error).toContain('cat_999');
  });

  it('should resolve a nested field path from the referenced record', async () => {
    const sourceCategoryFiles = [
      {
        folderId: sourceCategoriesFolderId,
        path: 'src-categories/cat1.json',
        content: '{"id": "cat_1", "name": "Technology", "metadata": {"color": "blue", "icon": "laptop"}}',
      },
    ];

    const sourcePostFiles = [
      {
        folderId: sourcePostsFolderId,
        path: 'src-posts/post1.json',
        content: '{"id": "post_1", "title": "AI is cool", "slug": "ai-cool", "category_id": "cat_1"}',
      },
    ];

    const destPostFiles: typeof sourcePostFiles = [];

    mockFiles({
      [sourceCategoriesFolderId]: sourceCategoryFiles,
      [sourcePostsFolderId]: sourcePostFiles,
      [destPostsFolderId]: destPostFiles,
    });

    const postsMapping: TableMapping = {
      sourceDataFolderId: sourcePostsFolderId,
      destinationDataFolderId: destPostsFolderId,
      columnMappings: [
        { sourceColumnId: 'title', destinationColumnId: 'title' },
        { sourceColumnId: 'slug', destinationColumnId: 'slug' },
        {
          sourceColumnId: 'category_id',
          destinationColumnId: 'category_color',
          transformer: {
            type: 'lookup_field',
            options: {
              referencedDataFolderId: sourceCategoriesFolderId,
              referencedFieldPath: 'metadata.color',
            },
          },
        },
      ],
      recordMatching: { sourceColumnId: 'slug', destinationColumnId: 'slug' },
    };

    const result = await syncService.syncTableMapping(syncId, postsMapping, workbookId, actor);

    expect(result.recordsCreated).toBe(1);
    expect(result.errors).toHaveLength(0);

    const fileContent = JSON.parse(writtenFiles[0].content) as Record<string, unknown>;
    expect(fileContent.category_color).toBe('blue');
  });

  it('should resolve array FK values to an array of looked-up field values', async () => {
    const sourceCategoryFiles = [
      {
        folderId: sourceCategoriesFolderId,
        path: 'src-categories/tag1.json',
        content: '{"id": "tag_1", "name": "Tech"}',
      },
      {
        folderId: sourceCategoriesFolderId,
        path: 'src-categories/tag2.json',
        content: '{"id": "tag_2", "name": "Science"}',
      },
      {
        folderId: sourceCategoriesFolderId,
        path: 'src-categories/tag3.json',
        content: '{"id": "tag_3", "name": "Art"}',
      },
    ];

    const sourcePostFiles = [
      {
        folderId: sourcePostsFolderId,
        path: 'src-posts/post1.json',
        content: '{"id": "post_1", "title": "Multi-tag", "slug": "multi-tag", "tag_ids": ["tag_1", "tag_3"]}',
      },
    ];

    const destPostFiles: typeof sourcePostFiles = [];

    mockFiles({
      [sourceCategoriesFolderId]: sourceCategoryFiles,
      [sourcePostsFolderId]: sourcePostFiles,
      [destPostsFolderId]: destPostFiles,
    });

    const postsMapping: TableMapping = {
      sourceDataFolderId: sourcePostsFolderId,
      destinationDataFolderId: destPostsFolderId,
      columnMappings: [
        { sourceColumnId: 'title', destinationColumnId: 'title' },
        { sourceColumnId: 'slug', destinationColumnId: 'slug' },
        {
          sourceColumnId: 'tag_ids',
          destinationColumnId: 'tag_names',
          transformer: {
            type: 'lookup_field',
            options: {
              referencedDataFolderId: sourceCategoriesFolderId,
              referencedFieldPath: 'name',
            },
          },
        },
      ],
      recordMatching: { sourceColumnId: 'slug', destinationColumnId: 'slug' },
    };

    const result = await syncService.syncTableMapping(syncId, postsMapping, workbookId, actor);

    expect(result.recordsCreated).toBe(1);
    expect(result.errors).toHaveLength(0);

    const fileContent = JSON.parse(writtenFiles[0].content) as Record<string, unknown>;
    expect(fileContent.tag_names).toEqual(['Tech', 'Art']);
  });

  it('should resolve a scalar FK from a dot-separated source column path', async () => {
    const sourceCategoryFiles = [
      {
        folderId: sourceCategoriesFolderId,
        path: 'src-categories/cat1.json',
        content: '{"id": "cat_1", "name": "Technology", "description": "Tech articles"}',
      },
      {
        folderId: sourceCategoriesFolderId,
        path: 'src-categories/cat2.json',
        content: '{"id": "cat_2", "name": "Science", "description": "Science articles"}',
      },
    ];

    const sourcePostFiles = [
      {
        folderId: sourcePostsFolderId,
        path: 'src-posts/post1.json',
        content: '{"id": "post_1", "title": "AI is cool", "slug": "ai-cool", "refs": {"category_id": "cat_1"}}',
      },
    ];

    const destPostFiles: typeof sourcePostFiles = [];

    mockFiles({
      [sourceCategoriesFolderId]: sourceCategoryFiles,
      [sourcePostsFolderId]: sourcePostFiles,
      [destPostsFolderId]: destPostFiles,
    });

    const postsMapping: TableMapping = {
      sourceDataFolderId: sourcePostsFolderId,
      destinationDataFolderId: destPostsFolderId,
      columnMappings: [
        { sourceColumnId: 'title', destinationColumnId: 'title' },
        { sourceColumnId: 'slug', destinationColumnId: 'slug' },
        {
          sourceColumnId: 'refs.category_id',
          destinationColumnId: 'category_name',
          transformer: {
            type: 'lookup_field',
            options: {
              referencedDataFolderId: sourceCategoriesFolderId,
              referencedFieldPath: 'name',
            },
          },
        },
      ],
      recordMatching: { sourceColumnId: 'slug', destinationColumnId: 'slug' },
    };

    const result = await syncService.syncTableMapping(syncId, postsMapping, workbookId, actor);

    expect(result.recordsCreated).toBe(1);
    expect(result.errors).toHaveLength(0);

    const fileContent = JSON.parse(writtenFiles[0].content) as Record<string, unknown>;
    expect(fileContent.category_name).toBe('Technology');
  });

  it('should skip in FOREIGN_KEY_MAPPING phase', async () => {
    const sourceCategoryFiles = [
      {
        folderId: sourceCategoriesFolderId,
        path: 'src-categories/cat1.json',
        content: '{"id": "cat_1", "name": "Technology"}',
      },
    ];

    const sourcePostFiles = [
      {
        folderId: sourcePostsFolderId,
        path: 'src-posts/post1.json',
        content: '{"id": "post_1", "title": "AI", "slug": "ai", "category_id": "cat_1"}',
      },
    ];

    // First run DATA phase to create the record
    mockFiles({
      [sourceCategoriesFolderId]: sourceCategoryFiles,
      [sourcePostsFolderId]: sourcePostFiles,
      [destPostsFolderId]: [],
    });

    const postsMapping: TableMapping = {
      sourceDataFolderId: sourcePostsFolderId,
      destinationDataFolderId: destPostsFolderId,
      columnMappings: [
        { sourceColumnId: 'title', destinationColumnId: 'title' },
        { sourceColumnId: 'slug', destinationColumnId: 'slug' },
        {
          sourceColumnId: 'category_id',
          destinationColumnId: 'category_name',
          transformer: {
            type: 'lookup_field',
            options: {
              referencedDataFolderId: sourceCategoriesFolderId,
              referencedFieldPath: 'name',
            },
          },
        },
      ],
      recordMatching: { sourceColumnId: 'slug', destinationColumnId: 'slug' },
    };

    const dataResult = await syncService.syncTableMapping(syncId, postsMapping, workbookId, actor);
    expect(dataResult.recordsCreated).toBe(1);

    const phase1Content = JSON.parse(writtenFiles[0].content) as Record<string, unknown>;
    expect(phase1Content.category_name).toBe('Technology');

    // Now run FOREIGN_KEY_MAPPING phase — lookup_field should skip
    mockFiles({
      [sourceCategoriesFolderId]: sourceCategoryFiles,
      [sourcePostsFolderId]: sourcePostFiles,
      [destPostsFolderId]: [
        {
          folderId: destPostsFolderId,
          path: writtenFiles[0].path,
          content: writtenFiles[0].content,
        },
      ],
    });

    const fkResult = await syncService.syncTableMapping(syncId, postsMapping, workbookId, actor, 'FOREIGN_KEY_MAPPING');

    // Should succeed — lookup_field skipped, no actual changes, so no file written
    expect(fkResult.errors).toHaveLength(0);
    expect(fkResult.recordsUpdated).toBe(0);

    // No additional files should have been written since nothing changed
    expect(writtenFiles).toHaveLength(1); // Only the file from the DATA phase
  });
});
