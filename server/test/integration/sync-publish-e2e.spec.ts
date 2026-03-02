import { PrismaClient } from '@prisma/client';
import {
  ColumnMapping,
  createConnectorAccountId,
  createDataFolderId,
  createOrganizationId,
  createSyncId,
  createUserId,
  createWorkbookId,
  DataFolderId,
  Service,
  SyncId,
  TableMapping,
  WorkbookId,
} from '@spinner/shared-types';
import { SchemaHelperService } from 'server/src/publish-plan/schema-helper.service';
import { CredentialEncryptionService } from 'src/credential-encryption/credential-encryption.service';
import { DbService } from 'src/db/db.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { FileIndexEntry, FileIndexService } from 'src/publish-plan/file-index.service';
import { FileReferenceService } from 'src/publish-plan/file-reference.service';
import { PublishPlanBuildService } from 'src/publish-plan/publish-plan-build.service';
import { PublishPlanRunService } from 'src/publish-plan/publish-plan-run.service';
import { RefCleanerService } from 'src/publish-plan/ref-cleaner.service';
import { RefResolverService } from 'src/publish-plan/ref-resolver.service';
import { ConnectorsService } from 'src/remote-service/connectors/connectors.service';
import { BaseJsonTableSpec, ConnectorFile } from 'src/remote-service/connectors/types';
import { ScheduleService } from 'src/schedule/schedule.service';
import { DIRTY_BRANCH, getRepoId, MAIN_BRANCH, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { SyncService } from 'src/sync/sync.service';
import { Actor } from 'src/users/types';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { WorkbookService } from 'src/workbook/workbook.service';

type ParsedRecord = Record<string, unknown>;

const MATCH_COUNT = parseInt(process.env.TEST_MATCH_COUNT ?? '2', 10);
const CREATE_COUNT = parseInt(process.env.TEST_CREATE_COUNT ?? '3', 10);
const ORPHAN_DEST_COUNT = parseInt(process.env.TEST_ORPHAN_DEST_COUNT ?? '1', 10);

describe('Sync + Publish E2E Pipeline (Airtable → WordPress)', () => {
  let prisma: PrismaClient;
  let vfs: VirtualGitFs;

  // Services
  let dbService: DbService;
  let syncService: SyncService;
  let fileIndexService: FileIndexService;
  let publishPlanService: PublishPlanBuildService;
  let publishRunService: PublishPlanRunService;
  let publishSchemaService: SchemaHelperService;
  let publishRefResolverService: RefResolverService;
  let refCleanerService: RefCleanerService;
  let fileReferenceService: FileReferenceService;

  // Mocks
  let scratchGitService: ScratchGitService;
  let dataFolderService: DataFolderService;
  let connectorsService: ConnectorsService;
  let credentialEncryptionService: CredentialEncryptionService;
  let mockConnector: {
    getBatchSize: jest.Mock;
    createRecords: jest.Mock;
    updateRecords: jest.Mock;
    deleteRecords: jest.Mock;
  };

  // Entity IDs
  let orgId: string;
  let userId: string;
  let workbookId: WorkbookId;
  let syncId: SyncId;
  let connectorAccountId: string;
  let sourceTagsFolderId: DataFolderId;
  let destTagsFolderId: DataFolderId;
  let sourcePostsFolderId: DataFolderId;
  let destPostsFolderId: DataFolderId;

  // Actor
  let actor: Actor;

  // Data folder path map for the DataFolderService mock
  const folderPathMap = new Map<string, string>();

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  beforeEach(async () => {
    vfs = new VirtualGitFs();

    // ---- DB Service (real) ----
    dbService = { client: prisma } as unknown as DbService;

    // ---- Real services ----
    fileIndexService = new FileIndexService(dbService);
    publishSchemaService = new SchemaHelperService(dbService);
    refCleanerService = new RefCleanerService();
    publishRefResolverService = new RefResolverService(fileIndexService);
    fileReferenceService = new FileReferenceService(dbService, refCleanerService, publishSchemaService);

    // ---- Mock: ScratchGitService ----
    scratchGitService = {
      resolveRepoId: jest.fn().mockImplementation((wkbId: WorkbookId) => Promise.resolve(wkbId)),
      commitFilesToBranch: jest
        .fn()
        .mockImplementation((_wkbId: WorkbookId, branch: string, files: { path: string; content: string }[]) => {
          vfs.commitFiles(branch, files);
          return Promise.resolve();
        }),
      deleteFilesFromBranch: jest.fn().mockImplementation((_wkbId: WorkbookId, branch: string, paths: string[]) => {
        vfs.deleteFiles(branch, paths);
        return Promise.resolve();
      }),
      getRepoStatus: jest.fn().mockImplementation(() => {
        return Promise.resolve(vfs.getStatus());
      }),
      readRepoFilesByFolder: jest.fn().mockImplementation((_wkbId: WorkbookId, branch: string, paths: string[]) => {
        return Promise.resolve(vfs.readFiles(branch, paths));
      }),
      rebaseDirty: jest.fn().mockImplementation(() => {
        vfs.rebaseDirty();
        return Promise.resolve();
      }),
    } as unknown as ScratchGitService;

    // ---- Mock: DataFolderService ----
    folderPathMap.clear();

    dataFolderService = {
      getAllFileContentsByFolderId: jest
        .fn()
        .mockImplementation(
          (_wkbId: WorkbookId, folderId: DataFolderId, _actor: Actor, branch: string = DIRTY_BRANCH) => {
            const folderPath = folderPathMap.get(folderId);
            if (!folderPath) return Promise.resolve([]);
            const files = vfs.getFilesByFolder(branch, folderPath);
            return Promise.resolve(files.map((f) => ({ folderId, path: f.path, content: f.content })));
          },
        ),
      getFileContentsByFolderIdPaginated: jest
        .fn()
        .mockImplementation(
          (_wkbId: WorkbookId, folderId: DataFolderId, _actor: Actor, branch: string = DIRTY_BRANCH) => {
            const folderPath = folderPathMap.get(folderId);
            if (!folderPath) return Promise.resolve({ files: [], nextCursor: undefined });
            const files = vfs.getFilesByFolder(branch, folderPath);
            return Promise.resolve({
              files: files.map((f) => ({ folderId, path: f.path, content: f.content })),
              nextCursor: undefined, // Return all at once for test simplicity
            });
          },
        ),
      findOne: jest.fn().mockImplementation((id: DataFolderId) => {
        const path = folderPathMap.get(id);
        return Promise.resolve(path ? { id, path: `/${path}` } : null);
      }),
    } as unknown as DataFolderService;

    // ---- Mock: WordPress Connector ----
    let nextWpId = 1001;
    mockConnector = {
      getBatchSize: jest.fn().mockReturnValue(25),
      createRecords: jest.fn().mockImplementation((tableSpec: BaseJsonTableSpec, files: ConnectorFile[]) => {
        const idField = tableSpec.idColumnRemoteId;
        for (const file of files) {
          if (idField in file) {
            throw new Error(
              `createRecords: ID column "${idField}" should not be set on create, but got: ${JSON.stringify(file[idField])}`,
            );
          }
        }
        return Promise.resolve(
          files.map((file) => ({
            ...file,
            [tableSpec.idColumnRemoteId]: nextWpId++,
          })),
        );
      }),
      updateRecords: jest.fn().mockImplementation((tableSpec: BaseJsonTableSpec, files: ConnectorFile[]) => {
        const idField = tableSpec.idColumnRemoteId;
        for (const file of files) {
          const idValue = file[idField];
          const numericValue = Number(idValue);
          if (!Number.isFinite(numericValue) || numericValue <= 0 || !Number.isInteger(numericValue)) {
            throw new Error(
              `updateRecords: ID column "${idField}" should be a positive integer (number or numeric string), but got: ${JSON.stringify(idValue)}`,
            );
          }
        }
        return Promise.resolve(undefined);
      }),
      deleteRecords: jest.fn().mockResolvedValue(undefined),
    };

    connectorsService = {
      getConnector: jest.fn().mockResolvedValue(mockConnector),
    } as unknown as ConnectorsService;

    credentialEncryptionService = {
      decryptCredentials: jest.fn().mockResolvedValue({}),
    } as unknown as CredentialEncryptionService;

    // ---- Instantiate SyncService (real, with mocked deps) ----
    const scheduleService = {
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    } as unknown as ScheduleService;
    syncService = new SyncService(
      dbService,
      dataFolderService,
      {} as PostHogService,
      scheduleService,
      scratchGitService,
      {} as WorkbookService,
    );

    // ---- Instantiate Publish services (real, with mocked I/O) ----
    publishPlanService = new PublishPlanBuildService(
      dbService,
      scratchGitService,
      fileIndexService,
      fileReferenceService,
      refCleanerService,
      publishSchemaService,
    );

    publishRunService = new PublishPlanRunService(
      dbService,
      connectorsService,
      credentialEncryptionService,
      fileIndexService,
      fileReferenceService,
      scratchGitService,
      publishSchemaService,
      publishRefResolverService,
    );

    // ---- Create DB entities ----
    orgId = createOrganizationId();
    userId = createUserId();
    workbookId = createWorkbookId();
    syncId = createSyncId();
    connectorAccountId = createConnectorAccountId();
    sourceTagsFolderId = createDataFolderId();
    destTagsFolderId = createDataFolderId();
    sourcePostsFolderId = createDataFolderId();
    destPostsFolderId = createDataFolderId();

    await prisma.organization.create({
      data: { id: orgId, name: 'E2E Test Org', clerkId: `clerk_${orgId}` },
    });

    await prisma.user.create({
      data: { id: userId, email: `e2e-${Date.now()}@test.com`, organizationId: orgId },
    });

    await prisma.workbook.create({
      data: { id: workbookId, name: 'E2E Test Workbook', userId, organizationId: orgId },
    });

    await prisma.connectorAccount.create({
      data: {
        id: connectorAccountId,
        service: Service.WORDPRESS,
        displayName: 'Test WordPress',
        workbookId,
        userId,
        encryptedCredentials: {},
      },
    });

    // Source Tags folder
    await prisma.dataFolder.create({
      data: {
        id: sourceTagsFolderId,
        name: 'Source Tags',
        workbookId,
        path: '/src-tags',
        schema: { idColumnRemoteId: 'id' },
        lastSchemaRefreshAt: new Date(),
      },
    });
    folderPathMap.set(sourceTagsFolderId, 'src-tags');

    // Destination Tags folder
    await prisma.dataFolder.create({
      data: {
        id: destTagsFolderId,
        name: 'Dest Tags',
        workbookId,
        path: '/dest-tags',
        connectorAccountId,
        schema: { idColumnRemoteId: 'id', slugColumnRemoteId: 'slug' },
        lastSchemaRefreshAt: new Date(),
      },
    });
    folderPathMap.set(destTagsFolderId, 'dest-tags');

    // Source Posts folder
    await prisma.dataFolder.create({
      data: {
        id: sourcePostsFolderId,
        name: 'Source Posts',
        workbookId,
        path: '/src-posts',
        schema: { idColumnRemoteId: 'id' },
        lastSchemaRefreshAt: new Date(),
      },
    });
    folderPathMap.set(sourcePostsFolderId, 'src-posts');

    // Destination Posts folder — with x-scratch-foreign-key on tags
    await prisma.dataFolder.create({
      data: {
        id: destPostsFolderId,
        name: 'Dest Posts',
        workbookId,
        path: '/dest-posts',
        connectorAccountId,
        schema: {
          idColumnRemoteId: 'id',
          slugColumnRemoteId: 'slug',
          schema: {
            type: 'object',
            properties: {
              tags: {
                type: 'array',
                items: { type: 'string' },
                'x-scratch-foreign-key': { linkedTableId: destTagsFolderId },
              },
            },
          },
        },
        lastSchemaRefreshAt: new Date(),
      },
    });
    folderPathMap.set(destPostsFolderId, 'dest-posts');

    // Sync record
    await prisma.sync.create({
      data: { id: syncId, displayName: 'E2E Test Sync', mappings: [] },
    });

    actor = { userId, organizationId: orgId };
  });

  afterEach(async () => {
    // Clean up in reverse dependency order
    await prisma.publishPlanOperation.deleteMany({ where: { plan: { workbookId } } });
    await prisma.publishPlan.deleteMany({ where: { workbookId } });
    await prisma.fileIndex.deleteMany({ where: { workbookId } });
    await prisma.fileReference.deleteMany({ where: { workbookId } });
    await prisma.syncMatchKeys.deleteMany({ where: { syncId } });
    await prisma.syncRemoteIdMapping.deleteMany({ where: { syncId } });
    await prisma.syncForeignKeyRecord.deleteMany({ where: { syncId } });
    await prisma.sync.delete({ where: { id: syncId } });
    await prisma.connectorAccount.deleteMany({ where: { workbookId } });
    await prisma.dataFolder.deleteMany({ where: { workbookId } });
    await prisma.workbook.delete({ where: { id: workbookId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.organization.delete({ where: { id: orgId } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // #region tests
  it('should sync tags, sync posts with FKs, build publish pipeline, and run publish pipeline', async () => {
    const { sourceTags, destTags } = generateTagData();
    const { sourcePosts, destPosts } = generatePostData();

    // =====================================================================
    // Phase A: Seed virtual FS
    // =====================================================================

    // Pre-populate both branches with existing destination files
    vfs.seed(MAIN_BRANCH, destTags);
    vfs.seed(MAIN_BRANCH, destPosts);
    vfs.seed(DIRTY_BRANCH, destTags);
    vfs.seed(DIRTY_BRANCH, destPosts);

    // Seed source files to dirty branch only (simulating completed pull)
    vfs.seed(DIRTY_BRANCH, sourceTags);
    vfs.seed(DIRTY_BRANCH, sourcePosts);

    // Pre-populate FileIndex for matched + orphan dest records (they already
    // exist in the remote service, so the publish pipeline expects them to
    // have entries in the FileIndex).
    const destFileIndexEntries: FileIndexEntry[] = [];
    for (let i = 0; i < MATCH_COUNT; i++) {
      destFileIndexEntries.push({
        workbookId,
        folderPath: 'dest-tags',
        recordId: `${100 + i}`,
        filename: `tag-match-${i}.json`,
      });
      destFileIndexEntries.push({
        workbookId,
        folderPath: 'dest-posts',
        recordId: `${200 + i}`,
        filename: `post-match-${i}.json`,
      });
    }
    for (let i = 0; i < ORPHAN_DEST_COUNT; i++) {
      destFileIndexEntries.push({
        workbookId,
        folderPath: 'dest-tags',
        recordId: `${900 + i}`,
        filename: `tag-orphan-${i}.json`,
      });
      destFileIndexEntries.push({
        workbookId,
        folderPath: 'dest-posts',
        recordId: `${950 + i}`,
        filename: `post-orphan-${i}.json`,
      });
    }
    await fileIndexService.upsertBatch(destFileIndexEntries);

    // =====================================================================
    // Phase B: Sync Tags (DATA phase)
    // =====================================================================

    const tagsTableMapping: TableMapping = {
      sourceDataFolderId: sourceTagsFolderId,
      destinationDataFolderId: destTagsFolderId,
      columnMappings: [
        { sourceColumnId: 'fields.Name', destinationColumnId: 'name' },
        { sourceColumnId: 'fields.Slug', destinationColumnId: 'slug' },
      ] as ColumnMapping[],
      recordMatching: {
        sourceColumnId: 'fields.Slug',
        destinationColumnId: 'slug',
      },
    };

    const tagsResult = await syncService.syncTableMapping(syncId, tagsTableMapping, workbookId, actor, 'DATA');

    // Tags assertions
    expect(tagsResult.errors).toEqual([]);
    expect(tagsResult.recordsCreated).toBe(CREATE_COUNT);
    expect(tagsResult.recordsUpdated).toBe(MATCH_COUNT);

    // Verify updated tags preserve destination numeric IDs
    for (let i = 0; i < MATCH_COUNT; i++) {
      const updatedFile = vfs.getAllFiles(DIRTY_BRANCH).get(`dest-tags/tag-match-${i}.json`);
      expect(updatedFile).toBeDefined();
      const parsed = JSON.parse(updatedFile!) as ParsedRecord;
      expect(parsed.id).toBe(100 + i); // Original destination ID preserved
      expect(parsed.name).toBe(`Tag Match ${i} Updated`);
      expect(parsed.slug).toBe(`tag-match-${i}`);
    }

    // Verify created tags have scratch_pending_publish_ temp IDs
    for (let i = 0; i < CREATE_COUNT; i++) {
      const createdFile = vfs.getAllFiles(DIRTY_BRANCH).get(`dest-tags/tag-create-${i}.json`);
      expect(createdFile).toBeDefined();
      const parsed = JSON.parse(createdFile!) as ParsedRecord;
      expect(typeof parsed.id).toBe('string');
      expect(parsed.id).toMatch(/^scratch_pending_publish_/);
      expect(parsed.name).toBe(`Tag Create ${i}`);
      expect(parsed.slug).toBe(`tag-create-${i}`);
    }

    // =====================================================================
    // Phase C: Sync Posts (DATA phase)
    // =====================================================================

    const postsTableMapping: TableMapping = {
      sourceDataFolderId: sourcePostsFolderId,
      destinationDataFolderId: destPostsFolderId,
      columnMappings: [
        { sourceColumnId: 'fields.Title', destinationColumnId: 'title' },
        { sourceColumnId: 'fields.Slug', destinationColumnId: 'slug' },
        {
          sourceColumnId: 'fields.Tags',
          destinationColumnId: 'tags',
          transformer: {
            type: 'source_fk_to_dest_fk' as const,
            options: { referencedDataFolderId: sourceTagsFolderId },
          },
        },
      ] as ColumnMapping[],
      recordMatching: {
        sourceColumnId: 'fields.Slug',
        destinationColumnId: 'slug',
      },
    };

    const postsDataResult = await syncService.syncTableMapping(syncId, postsTableMapping, workbookId, actor, 'DATA');

    expect(postsDataResult.errors).toEqual([]);
    expect(postsDataResult.recordsCreated).toBe(CREATE_COUNT);
    expect(postsDataResult.recordsUpdated).toBe(MATCH_COUNT);

    // Posts files do NOT have a `tags` field (FK transformer skips in DATA phase)
    for (const postPath of [...postsDataResult.createdPaths, ...postsDataResult.updatedPaths]) {
      const postContent = vfs.getAllFiles(DIRTY_BRANCH).get(postPath);
      expect(postContent).toBeDefined();
      const parsed = JSON.parse(postContent!) as ParsedRecord;
      expect(parsed.tags).toBeUndefined();
    }

    // =====================================================================
    // Phase D: Sync Posts (FOREIGN_KEY_MAPPING phase)
    // =====================================================================

    const postsFkResult = await syncService.syncTableMapping(
      syncId,
      postsTableMapping,
      workbookId,
      actor,
      'FOREIGN_KEY_MAPPING',
    );

    expect(postsFkResult.errors).toEqual([]);
    expect(postsFkResult.recordsUpdated).toBe(MATCH_COUNT + CREATE_COUNT);

    // Posts now have `tags` field containing @/dest-tags/slug.json pseudo-refs
    const allPostPaths = [...postsFkResult.updatedPaths];
    for (const postPath of allPostPaths) {
      const postContent = vfs.getAllFiles(DIRTY_BRANCH).get(postPath);
      expect(postContent).toBeDefined();
      const parsed = JSON.parse(postContent!) as ParsedRecord;
      expect(parsed.tags).toBeDefined();
      expect(Array.isArray(parsed.tags)).toBe(true);

      // Each pseudo-ref should be a valid path to a dest-tags file
      const tags = parsed.tags as string[];
      for (const tag of tags) {
        expect(tag).toMatch(/^@\/dest-tags\/.+\.json$/);
        // Strip @/ prefix and verify file exists on dirty branch
        const targetPath = tag.substring(2);
        const targetFile = vfs.getAllFiles(DIRTY_BRANCH).get(targetPath);
        expect(targetFile).toBeDefined();
      }
    }

    // =====================================================================
    // Phase E: Build Publish Pipeline
    // =====================================================================

    const buildResult = await publishPlanService.buildPipeline(workbookId, userId, connectorAccountId);

    expect(buildResult.status).toBe('planned');

    // Verify plan entries in DB
    const planEntries = await prisma.publishPlanOperation.findMany({
      where: { planId: buildResult.pipelineId },
    });
    expect(planEntries.length).toBeGreaterThan(0);

    const editEntries = planEntries.filter((e) => e.phase === 'edit');
    const createEntries = planEntries.filter((e) => e.phase === 'create');
    const backfillEntries = planEntries.filter((e) => e.phase === 'backfill');

    // Edit entries = updated dest tags + updated dest posts
    expect(editEntries.length).toBe(MATCH_COUNT * 2);

    // Create entries = created dest tags + created dest posts
    expect(createEntries.length).toBe(CREATE_COUNT * 2);

    // Backfill entries should exist for posts that had pseudo-refs stripped
    // (all posts reference tags, so all created + updated posts should have backfill)
    expect(backfillEntries.length).toBeGreaterThan(0);

    // =====================================================================
    // Phase F: Run Publish Pipeline
    // =====================================================================

    const runResult = await publishRunService.runPipeline(buildResult.pipelineId);

    expect(runResult.status).toBe('completed');

    // Connector should have been called
    expect(mockConnector.createRecords).toHaveBeenCalled();
    expect(mockConnector.updateRecords).toHaveBeenCalled();

    // Check plan entry statuses
    const finalEntries = await prisma.publishPlanOperation.findMany({
      where: { planId: buildResult.pipelineId },
    });

    const nonBackfillEntries = finalEntries.filter((e) => e.phase !== 'backfill');
    const backfillEntries2 = finalEntries.filter((e) => e.phase === 'backfill');

    // Edit and create entries should all succeed
    for (const entry of nonBackfillEntries) {
      expect(entry.status).toBe('success');
    }

    // All backfill entries should succeed now that numeric IDs are indexed
    for (const entry of backfillEntries2) {
      expect(entry.status).toBe('success');
    }

    // FileIndex: the publish create phase should have cleaned up scratch_pending_publish_
    // entries after indexing real numeric IDs. Each created file should have exactly one entry.
    for (let i = 0; i < CREATE_COUNT; i++) {
      const tagEntries = await prisma.fileIndex.findMany({
        where: { workbookId, folderPath: 'dest-tags', filename: `tag-create-${i}.json` },
      });
      expect(tagEntries).toHaveLength(1);
      expect(tagEntries[0].recordId).toMatch(/^\d+$/);
    }
    for (let i = 0; i < CREATE_COUNT; i++) {
      const postEntries = await prisma.fileIndex.findMany({
        where: { workbookId, folderPath: 'dest-posts', filename: `post-create-${i}.json` },
      });
      expect(postEntries).toHaveLength(1);
      expect(postEntries[0].recordId).toMatch(/^\d+$/);
    }

    // Main branch files: created records should have real numeric IDs instead of temp IDs
    for (let i = 0; i < CREATE_COUNT; i++) {
      const tagFile = vfs.getAllFiles(MAIN_BRANCH).get(`dest-tags/tag-create-${i}.json`);
      expect(tagFile).toBeDefined();
      const tagParsed = JSON.parse(tagFile!) as ParsedRecord;
      expect(typeof tagParsed.id).toBe('number');
      expect(tagParsed.id).toBeGreaterThanOrEqual(1001);
    }

    // Main branch files: posts tags arrays should contain real numeric IDs
    // (no pseudo-refs and no scratch_pending_publish_ temp IDs)
    const mainBranchPostFiles = vfs.getFilesByFolder(MAIN_BRANCH, 'dest-posts');
    for (const postFile of mainBranchPostFiles) {
      const parsed = JSON.parse(postFile.content) as ParsedRecord;
      const tags = parsed.tags;
      if (tags && Array.isArray(tags)) {
        for (const tagValue of tags as string[]) {
          expect(tagValue).not.toMatch(/^@\//); // No pseudo-refs remaining
          expect(tagValue).not.toMatch(/^scratch_pending_publish_/); // No temp IDs leaked
          expect(tagValue).toMatch(/^\d+$/); // Should be a stringified number
        }
      }
    }

    // rebaseDirty should have been called
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(scratchGitService.rebaseDirty).toHaveBeenCalled();
  }, 60_000); // 60s timeout for integration test
});

describe('Sync + Publish E2E Pipeline (V2 workbook — repo-per-connection)', () => {
  let prisma: PrismaClient;
  let vfs: VirtualGitFs;

  // Services
  let dbService: DbService;
  let syncService: SyncService;
  let fileIndexService: FileIndexService;
  let publishPlanService: PublishPlanBuildService;
  let publishRunService: PublishPlanRunService;
  let publishSchemaService: SchemaHelperService;
  let publishRefResolverService: RefResolverService;
  let refCleanerService: RefCleanerService;
  let fileReferenceService: FileReferenceService;

  // Mocks
  let scratchGitService: ScratchGitService;
  let dataFolderService: DataFolderService;
  let connectorsService: ConnectorsService;
  let credentialEncryptionService: CredentialEncryptionService;
  let mockConnector: {
    getBatchSize: jest.Mock;
    createRecords: jest.Mock;
    updateRecords: jest.Mock;
    deleteRecords: jest.Mock;
  };

  // Entity IDs
  let orgId: string;
  let userId: string;
  let workbookId: WorkbookId;
  let syncId: SyncId;
  let connectorAccountId: string;
  let destTagsFolderId: DataFolderId;
  let destPostsFolderId: DataFolderId;
  let sourceTagsFolderId: DataFolderId;
  let sourcePostsFolderId: DataFolderId;

  // Actor
  let actor: Actor;

  // Data folder path map for the DataFolderService mock
  const folderPathMap = new Map<string, string>();

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  beforeEach(async () => {
    vfs = new VirtualGitFs();

    // ---- DB Service (real) ----
    dbService = { client: prisma } as unknown as DbService;

    // ---- Real services ----
    fileIndexService = new FileIndexService(dbService);
    publishSchemaService = new SchemaHelperService(dbService);
    refCleanerService = new RefCleanerService();
    publishRefResolverService = new RefResolverService(fileIndexService);
    fileReferenceService = new FileReferenceService(dbService, refCleanerService, publishSchemaService);

    // ---- Mock: ScratchGitService (V2-aware) ----
    // resolveRepoId returns the composite ID for V2 workbooks
    scratchGitService = {
      resolveRepoId: jest
        .fn()
        .mockImplementation((wkbId: WorkbookId, connAcctId?: string) =>
          Promise.resolve(connAcctId ? getRepoId(2, wkbId, orgId, connAcctId) : wkbId),
        ),
      commitFilesToBranch: jest
        .fn()
        .mockImplementation((_repoId: string, branch: string, files: { path: string; content: string }[]) => {
          vfs.commitFiles(branch, files);
          return Promise.resolve();
        }),
      deleteFilesFromBranch: jest.fn().mockImplementation((_repoId: string, branch: string, paths: string[]) => {
        vfs.deleteFiles(branch, paths);
        return Promise.resolve();
      }),
      getRepoStatus: jest.fn().mockImplementation(() => {
        return Promise.resolve(vfs.getStatus());
      }),
      readRepoFilesByFolder: jest.fn().mockImplementation((_repoId: string, branch: string, paths: string[]) => {
        return Promise.resolve(vfs.readFiles(branch, paths));
      }),
      rebaseDirty: jest.fn().mockImplementation(() => {
        vfs.rebaseDirty();
        return Promise.resolve();
      }),
    } as unknown as ScratchGitService;

    // ---- Mock: DataFolderService ----
    folderPathMap.clear();

    dataFolderService = {
      getAllFileContentsByFolderId: jest
        .fn()
        .mockImplementation(
          (_wkbId: WorkbookId, folderId: DataFolderId, _actor: Actor, branch: string = DIRTY_BRANCH) => {
            const folderPath = folderPathMap.get(folderId);
            if (!folderPath) return Promise.resolve([]);
            const files = vfs.getFilesByFolder(branch, folderPath);
            return Promise.resolve(files.map((f) => ({ folderId, path: f.path, content: f.content })));
          },
        ),
      getFileContentsByFolderIdPaginated: jest
        .fn()
        .mockImplementation(
          (_wkbId: WorkbookId, folderId: DataFolderId, _actor: Actor, branch: string = DIRTY_BRANCH) => {
            const folderPath = folderPathMap.get(folderId);
            if (!folderPath) return Promise.resolve({ files: [], nextCursor: undefined });
            const files = vfs.getFilesByFolder(branch, folderPath);
            return Promise.resolve({
              files: files.map((f) => ({ folderId, path: f.path, content: f.content })),
              nextCursor: undefined,
            });
          },
        ),
      findOne: jest.fn().mockImplementation((id: DataFolderId) => {
        const path = folderPathMap.get(id);
        return Promise.resolve(path ? { id, path: `/${path}` } : null);
      }),
    } as unknown as DataFolderService;

    // ---- Mock: WordPress Connector ----
    let nextWpId = 2001;
    mockConnector = {
      getBatchSize: jest.fn().mockReturnValue(25),
      createRecords: jest.fn().mockImplementation((tableSpec: BaseJsonTableSpec, files: ConnectorFile[]) => {
        const idField = tableSpec.idColumnRemoteId;
        for (const file of files) {
          if (idField in file) {
            throw new Error(
              `createRecords: ID column "${idField}" should not be set on create, but got: ${JSON.stringify(file[idField])}`,
            );
          }
        }
        return Promise.resolve(
          files.map((file) => ({
            ...file,
            [tableSpec.idColumnRemoteId]: nextWpId++,
          })),
        );
      }),
      updateRecords: jest.fn().mockImplementation((tableSpec: BaseJsonTableSpec, files: ConnectorFile[]) => {
        const idField = tableSpec.idColumnRemoteId;
        for (const file of files) {
          const idValue = file[idField];
          const numericValue = Number(idValue);
          if (!Number.isFinite(numericValue) || numericValue <= 0 || !Number.isInteger(numericValue)) {
            throw new Error(
              `updateRecords: ID column "${idField}" should be a positive integer (number or numeric string), but got: ${JSON.stringify(idValue)}`,
            );
          }
        }
        return Promise.resolve(undefined);
      }),
      deleteRecords: jest.fn().mockResolvedValue(undefined),
    };

    connectorsService = {
      getConnector: jest.fn().mockResolvedValue(mockConnector),
    } as unknown as ConnectorsService;

    credentialEncryptionService = {
      decryptCredentials: jest.fn().mockResolvedValue({}),
    } as unknown as CredentialEncryptionService;

    // ---- Instantiate SyncService ----
    const scheduleService = {
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    } as unknown as ScheduleService;
    syncService = new SyncService(
      dbService,
      dataFolderService,
      {} as PostHogService,
      scheduleService,
      scratchGitService,
      {} as WorkbookService,
    );

    // ---- Instantiate Publish services ----
    publishPlanService = new PublishPlanBuildService(
      dbService,
      scratchGitService,
      fileIndexService,
      fileReferenceService,
      refCleanerService,
      publishSchemaService,
    );

    publishRunService = new PublishPlanRunService(
      dbService,
      connectorsService,
      credentialEncryptionService,
      fileIndexService,
      fileReferenceService,
      scratchGitService,
      publishSchemaService,
      publishRefResolverService,
    );

    // ---- Create DB entities ----
    orgId = createOrganizationId();
    userId = createUserId();
    workbookId = createWorkbookId();
    syncId = createSyncId();
    connectorAccountId = createConnectorAccountId();
    sourceTagsFolderId = createDataFolderId();
    destTagsFolderId = createDataFolderId();
    sourcePostsFolderId = createDataFolderId();
    destPostsFolderId = createDataFolderId();

    await prisma.organization.create({
      data: { id: orgId, name: 'E2E V2 Test Org', clerkId: `clerk_${orgId}` },
    });

    await prisma.user.create({
      data: { id: userId, email: `e2e-v2-${Date.now()}@test.com`, organizationId: orgId },
    });

    // V2 workbook: version: 2
    await prisma.workbook.create({
      data: { id: workbookId, name: 'E2E V2 Test Workbook', userId, organizationId: orgId, version: 2 },
    });

    await prisma.connectorAccount.create({
      data: {
        id: connectorAccountId,
        service: Service.WORDPRESS,
        displayName: 'Test V2 WordPress',
        workbookId,
        userId,
        encryptedCredentials: {},
      },
    });

    // Source Tags folder (no connector)
    await prisma.dataFolder.create({
      data: {
        id: sourceTagsFolderId,
        name: 'Source Tags',
        workbookId,
        path: '/src-tags',
        schema: { idColumnRemoteId: 'id' },
        lastSchemaRefreshAt: new Date(),
      },
    });
    folderPathMap.set(sourceTagsFolderId, 'src-tags');

    // Destination Tags folder (with connector)
    await prisma.dataFolder.create({
      data: {
        id: destTagsFolderId,
        name: 'Dest Tags',
        workbookId,
        path: '/dest-tags',
        connectorAccountId,
        schema: { idColumnRemoteId: 'id', slugColumnRemoteId: 'slug' },
        lastSchemaRefreshAt: new Date(),
      },
    });
    folderPathMap.set(destTagsFolderId, 'dest-tags');

    // Source Posts folder (no connector)
    await prisma.dataFolder.create({
      data: {
        id: sourcePostsFolderId,
        name: 'Source Posts',
        workbookId,
        path: '/src-posts',
        schema: { idColumnRemoteId: 'id' },
        lastSchemaRefreshAt: new Date(),
      },
    });
    folderPathMap.set(sourcePostsFolderId, 'src-posts');

    // Destination Posts folder (with connector, FK on tags)
    await prisma.dataFolder.create({
      data: {
        id: destPostsFolderId,
        name: 'Dest Posts',
        workbookId,
        path: '/dest-posts',
        connectorAccountId,
        schema: {
          idColumnRemoteId: 'id',
          slugColumnRemoteId: 'slug',
          schema: {
            type: 'object',
            properties: {
              tags: {
                type: 'array',
                items: { type: 'string' },
                'x-scratch-foreign-key': { linkedTableId: destTagsFolderId },
              },
            },
          },
        },
        lastSchemaRefreshAt: new Date(),
      },
    });
    folderPathMap.set(destPostsFolderId, 'dest-posts');

    // Sync record
    await prisma.sync.create({
      data: { id: syncId, displayName: 'E2E V2 Test Sync', mappings: [] },
    });

    actor = { userId, organizationId: orgId };
  });

  afterEach(async () => {
    await prisma.publishPlanOperation.deleteMany({ where: { plan: { workbookId } } });
    await prisma.publishPlan.deleteMany({ where: { workbookId } });
    await prisma.fileIndex.deleteMany({ where: { workbookId } });
    await prisma.fileReference.deleteMany({ where: { workbookId } });
    await prisma.syncMatchKeys.deleteMany({ where: { syncId } });
    await prisma.syncRemoteIdMapping.deleteMany({ where: { syncId } });
    await prisma.syncForeignKeyRecord.deleteMany({ where: { syncId } });
    await prisma.sync.delete({ where: { id: syncId } });
    await prisma.connectorAccount.deleteMany({ where: { workbookId } });
    await prisma.dataFolder.deleteMany({ where: { workbookId } });
    await prisma.workbook.delete({ where: { id: workbookId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.organization.delete({ where: { id: orgId } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('should resolve composite V2 repo ID (orgId--workbookId--connAccountId) when building pipeline', async () => {
    const { sourceTags, destTags } = generateTagData();
    const { sourcePosts, destPosts } = generatePostData();

    vfs.seed(MAIN_BRANCH, destTags);
    vfs.seed(MAIN_BRANCH, destPosts);
    vfs.seed(DIRTY_BRANCH, destTags);
    vfs.seed(DIRTY_BRANCH, destPosts);
    vfs.seed(DIRTY_BRANCH, sourceTags);
    vfs.seed(DIRTY_BRANCH, sourcePosts);

    // Pre-populate FileIndex for matched dest records
    const destFileIndexEntries: FileIndexEntry[] = [];
    for (let i = 0; i < MATCH_COUNT; i++) {
      destFileIndexEntries.push({
        workbookId,
        folderPath: 'dest-tags',
        recordId: `${100 + i}`,
        filename: `tag-match-${i}.json`,
      });
      destFileIndexEntries.push({
        workbookId,
        folderPath: 'dest-posts',
        recordId: `${200 + i}`,
        filename: `post-match-${i}.json`,
      });
    }
    for (let i = 0; i < ORPHAN_DEST_COUNT; i++) {
      destFileIndexEntries.push({
        workbookId,
        folderPath: 'dest-tags',
        recordId: `${900 + i}`,
        filename: `tag-orphan-${i}.json`,
      });
      destFileIndexEntries.push({
        workbookId,
        folderPath: 'dest-posts',
        recordId: `${950 + i}`,
        filename: `post-orphan-${i}.json`,
      });
    }
    await fileIndexService.upsertBatch(destFileIndexEntries);

    // Sync tags
    const tagsTableMapping: TableMapping = {
      sourceDataFolderId: sourceTagsFolderId,
      destinationDataFolderId: destTagsFolderId,
      columnMappings: [
        { sourceColumnId: 'fields.Name', destinationColumnId: 'name' },
        { sourceColumnId: 'fields.Slug', destinationColumnId: 'slug' },
      ] as ColumnMapping[],
      recordMatching: { sourceColumnId: 'fields.Slug', destinationColumnId: 'slug' },
    };
    const tagsResult = await syncService.syncTableMapping(syncId, tagsTableMapping, workbookId, actor, 'DATA');
    expect(tagsResult.errors).toEqual([]);
    expect(tagsResult.recordsCreated).toBe(CREATE_COUNT);
    expect(tagsResult.recordsUpdated).toBe(MATCH_COUNT);

    // Sync posts DATA phase
    const postsTableMapping: TableMapping = {
      sourceDataFolderId: sourcePostsFolderId,
      destinationDataFolderId: destPostsFolderId,
      columnMappings: [
        { sourceColumnId: 'fields.Title', destinationColumnId: 'title' },
        { sourceColumnId: 'fields.Slug', destinationColumnId: 'slug' },
        {
          sourceColumnId: 'fields.Tags',
          destinationColumnId: 'tags',
          transformer: {
            type: 'source_fk_to_dest_fk' as const,
            options: { referencedDataFolderId: sourceTagsFolderId },
          },
        },
      ] as ColumnMapping[],
      recordMatching: { sourceColumnId: 'fields.Slug', destinationColumnId: 'slug' },
    };
    const postsDataResult = await syncService.syncTableMapping(syncId, postsTableMapping, workbookId, actor, 'DATA');
    expect(postsDataResult.errors).toEqual([]);

    // Sync posts FK phase
    const postsFkResult = await syncService.syncTableMapping(
      syncId,
      postsTableMapping,
      workbookId,
      actor,
      'FOREIGN_KEY_MAPPING',
    );
    expect(postsFkResult.errors).toEqual([]);

    // Build pipeline with connectorAccountId (V2 path)
    const buildResult = await publishPlanService.buildPipeline(workbookId, userId, connectorAccountId);
    expect(buildResult.status).toBe('planned');

    // Verify resolveRepoId was called with the connectorAccountId
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(scratchGitService.resolveRepoId).toHaveBeenCalledWith(workbookId, connectorAccountId);

    // Verify the composite repo ID was computed correctly
    const expectedRepoId = getRepoId(2, workbookId, orgId, connectorAccountId);
    expect(expectedRepoId).toBe(`${orgId}--${workbookId}--${connectorAccountId}`);

    // Run pipeline
    const runResult = await publishRunService.runPipeline(buildResult.pipelineId);
    expect(runResult.status).toBe('completed');

    expect(mockConnector.createRecords).toHaveBeenCalled();
    expect(mockConnector.updateRecords).toHaveBeenCalled();

    const finalEntries = await prisma.publishPlanOperation.findMany({
      where: { planId: buildResult.pipelineId },
    });
    for (const entry of finalEntries) {
      expect(entry.status).toBe('success');
    }

    // Created files on main branch should have real numeric IDs
    for (let i = 0; i < CREATE_COUNT; i++) {
      const tagFile = vfs.getAllFiles(MAIN_BRANCH).get(`dest-tags/tag-create-${i}.json`);
      expect(tagFile).toBeDefined();
      const tagParsed = JSON.parse(tagFile!) as ParsedRecord;
      expect(typeof tagParsed.id).toBe('number');
      expect(tagParsed.id).toBeGreaterThanOrEqual(2001);
    }

    // rebaseDirty should have been called
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(scratchGitService.rebaseDirty).toHaveBeenCalled();
  }, 60_000);

  it('should use composite V2 repo IDs when checking for diffs without a connectorAccountId', async () => {
    // hasDiffs without connectorAccountId for a V2 workbook calls resolveAllRepoIds,
    // which uses getRepoId for each connector account — not resolveRepoId.
    // Verify getRepoStatus is called with the composite {orgId}--{workbookId}--{connAccountId} ID.
    const hasDiffs = await publishPlanService.hasDiffs(workbookId, undefined);

    // hasDiffs should complete without throwing (empty VFS = no diffs)
    expect(hasDiffs).toBe(false);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const getRepoStatusMock = scratchGitService.getRepoStatus as jest.Mock;
    expect(getRepoStatusMock).toHaveBeenCalled();

    // The repoId passed to getRepoStatus should be the composite V2 ID
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const calledWith = getRepoStatusMock.mock.calls[0][0] as string;
    const expectedRepoId = getRepoId(2, workbookId, orgId, connectorAccountId);
    expect(calledWith).toBe(expectedRepoId);
  }, 30_000);
});

// #region fakes

// ---------------------------------------------------------------------------
// Virtual Git Filesystem
// ---------------------------------------------------------------------------

type BranchFiles = Map<string, string>; // path → content

class VirtualGitFs {
  private branches = new Map<string, BranchFiles>();

  constructor() {
    this.branches.set(MAIN_BRANCH, new Map());
    this.branches.set(DIRTY_BRANCH, new Map());
  }

  seed(branch: string, files: { path: string; content: string }[]): void {
    const b = this.getBranch(branch);
    for (const f of files) b.set(f.path, f.content);
  }

  commitFiles(branch: string, files: { path: string; content: string }[]): void {
    const b = this.getBranch(branch);
    for (const f of files) b.set(f.path, f.content);
  }

  deleteFiles(branch: string, paths: string[]): void {
    const b = this.getBranch(branch);
    for (const p of paths) b.delete(p);
  }

  /** Diff dirty vs main → list of changes */
  getStatus(): { path: string; status: 'added' | 'modified' | 'deleted' }[] {
    const main = this.getBranch(MAIN_BRANCH);
    const dirty = this.getBranch(DIRTY_BRANCH);
    const result: { path: string; status: 'added' | 'modified' | 'deleted' }[] = [];

    // Files in dirty but not main = added; files in both but different = modified
    for (const [path, content] of dirty) {
      if (!main.has(path)) {
        result.push({ path, status: 'added' });
      } else if (main.get(path) !== content) {
        result.push({ path, status: 'modified' });
      }
    }
    // Files in main but not dirty = deleted
    for (const path of main.keys()) {
      if (!dirty.has(path)) {
        result.push({ path, status: 'deleted' });
      }
    }
    return result;
  }

  readFiles(branch: string, paths: string[]): { path: string; content: string | null }[] {
    const b = this.getBranch(branch);
    return paths.map((p) => ({ path: p, content: b.get(p) ?? null }));
  }

  rebaseDirty(): void {
    const main = this.getBranch(MAIN_BRANCH);
    this.branches.set(DIRTY_BRANCH, new Map(main));
  }

  getAllFiles(branch: string): Map<string, string> {
    return new Map(this.getBranch(branch));
  }

  /** Return files on a branch whose paths start with a given folder prefix. */
  getFilesByFolder(branch: string, folderPrefix: string): { path: string; content: string }[] {
    const b = this.getBranch(branch);
    const prefix = folderPrefix.endsWith('/') ? folderPrefix : folderPrefix + '/';
    const result: { path: string; content: string }[] = [];
    for (const [path, content] of b) {
      if (path.startsWith(prefix)) {
        result.push({ path, content });
      }
    }
    return result;
  }

  private getBranch(branch: string): BranchFiles {
    if (!this.branches.has(branch)) {
      this.branches.set(branch, new Map());
    }
    return this.branches.get(branch)!;
  }
}

// ---------------------------------------------------------------------------
// Data generators
// ---------------------------------------------------------------------------

function generateTagData(): {
  sourceTags: { path: string; content: string }[];
  destTags: { path: string; content: string }[];
} {
  const sourceTags: { path: string; content: string }[] = [];
  const destTags: { path: string; content: string }[] = [];

  // Matched tags (exist in both source and destination)
  // Source name differs from dest name so the sync produces a real update
  for (let i = 0; i < MATCH_COUNT; i++) {
    sourceTags.push({
      path: `src-tags/rec_tag_match_${i}.json`,
      content: JSON.stringify({
        id: `rec_tag_match_${i}`,
        fields: { Name: `Tag Match ${i} Updated`, Slug: `tag-match-${i}` },
      }),
    });
    destTags.push({
      path: `dest-tags/tag-match-${i}.json`,
      content: JSON.stringify({ id: 100 + i, name: `Tag Match ${i}`, slug: `tag-match-${i}` }),
    });
  }

  // Source-only tags (creates)
  for (let i = 0; i < CREATE_COUNT; i++) {
    sourceTags.push({
      path: `src-tags/rec_tag_create_${i}.json`,
      content: JSON.stringify({
        id: `rec_tag_create_${i}`,
        fields: { Name: `Tag Create ${i}`, Slug: `tag-create-${i}` },
      }),
    });
  }

  // Dest-only tags (orphans)
  for (let i = 0; i < ORPHAN_DEST_COUNT; i++) {
    destTags.push({
      path: `dest-tags/tag-orphan-${i}.json`,
      content: JSON.stringify({ id: 900 + i, name: `Tag Orphan ${i}`, slug: `tag-orphan-${i}` }),
    });
  }

  return { sourceTags, destTags };
}

function generatePostData(): {
  sourcePosts: { path: string; content: string }[];
  destPosts: { path: string; content: string }[];
} {
  const sourcePosts: { path: string; content: string }[] = [];
  const destPosts: { path: string; content: string }[] = [];

  // Build a pool of source tag IDs for FK references
  const matchedTagIds = Array.from({ length: MATCH_COUNT }, (_, i) => `rec_tag_match_${i}`);
  const createdTagIds = Array.from({ length: CREATE_COUNT }, (_, i) => `rec_tag_create_${i}`);
  const allSourceTagIds = [...matchedTagIds, ...createdTagIds];

  // Matched posts
  // Source title differs from dest title so the sync produces a real update
  for (let i = 0; i < MATCH_COUNT; i++) {
    const tagRefs = [allSourceTagIds[i % allSourceTagIds.length]];
    if (allSourceTagIds.length > 1) {
      tagRefs.push(allSourceTagIds[(i + 1) % allSourceTagIds.length]);
    }
    sourcePosts.push({
      path: `src-posts/rec_post_match_${i}.json`,
      content: JSON.stringify({
        id: `rec_post_match_${i}`,
        fields: { Title: `Post Match ${i} Updated`, Slug: `post-match-${i}`, Tags: tagRefs },
      }),
    });
    destPosts.push({
      path: `dest-posts/post-match-${i}.json`,
      content: JSON.stringify({ id: 200 + i, title: `Post Match ${i}`, slug: `post-match-${i}` }),
    });
  }

  // Source-only posts (creates)
  for (let i = 0; i < CREATE_COUNT; i++) {
    const tagRefs = [allSourceTagIds[i % allSourceTagIds.length]];
    if (allSourceTagIds.length > 1) {
      tagRefs.push(allSourceTagIds[(i + 1) % allSourceTagIds.length]);
    }
    sourcePosts.push({
      path: `src-posts/rec_post_create_${i}.json`,
      content: JSON.stringify({
        id: `rec_post_create_${i}`,
        fields: { Title: `Post Create ${i}`, Slug: `post-create-${i}`, Tags: tagRefs },
      }),
    });
  }

  // Dest-only posts (orphans)
  for (let i = 0; i < ORPHAN_DEST_COUNT; i++) {
    destPosts.push({
      path: `dest-posts/post-orphan-${i}.json`,
      content: JSON.stringify({ id: 950 + i, title: `Post Orphan ${i}`, slug: `post-orphan-${i}` }),
    });
  }

  return { sourcePosts, destPosts };
}
