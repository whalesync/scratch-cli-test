import { PrismaClient } from '@prisma/client';
import {
  ColumnMapping,
  createAssetId,
  createConnectorAccountId,
  createDataFolderId,
  createOrganizationId,
  createSyncId,
  createSyncTablePairId,
  createUserId,
  createWorkbookId,
  DataFolderId,
  SyncId,
  SyncMapping,
  TableMapping,
  WorkbookId,
} from '@spinner/shared-types';
import axios from 'axios';
import { SchemaHelperService } from 'server/src/publish-plan/schema-helper.service';
import { AssetIndexService } from 'src/asset/asset-index.service';
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
import { Service } from 'src/remote-service/connectors/service-constants';
import { BaseJsonTableSpec, ConnectorFile } from 'src/remote-service/connectors/types';
import { ScheduleService } from 'src/schedule/schedule.service';
import { DIRTY_BRANCH, getDefaultRepoPath, MAIN_BRANCH, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { SyncService } from 'src/sync/sync.service';
import { Actor } from 'src/users/types';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { WorkbookEventService } from 'src/workbook/workbook-event.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { StubMetricsService } from 'src/metrics/stub-metrics.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { SyncDataFoldersJobHandler } from 'src/worker/jobs/job-definitions/sync-data-folders.job';

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
    supportsFileUpload: boolean;
    getBatchSize: jest.Mock;
    createRecords: jest.Mock;
    updateRecords: jest.Mock;
    deleteRecords: jest.Mock;
    uploadFile: jest.Mock;
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

    // ---- Mock: ScratchGitService ----
    scratchGitService = {
      resolveRepoId: jest.fn().mockImplementation((wkbId: WorkbookId) => Promise.resolve(wkbId)),
      readSchemaFromGit: jest.fn().mockImplementation((_repoId: string, folderPath: string) => {
        const schemas: Record<string, Record<string, unknown>> = {
          '/src-tags': { idColumnRemoteId: 'id' },
          '/dest-tags': { idColumnRemoteId: 'id', slugColumnRemoteId: 'slug' },
          '/src-posts': { idColumnRemoteId: 'id' },
          '/dest-posts': {
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
        };
        return Promise.resolve(schemas[folderPath] ?? null);
      }),
      commitFilesToBranch: jest
        .fn()
        .mockImplementation((_wkbId: WorkbookId, branch: string, files: { path: string; content: string }[]) => {
          vfs.commitFiles(branch, files);
          return Promise.resolve({ created: [], updated: [], unchanged: [] });
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
      runGitGc: jest.fn().mockResolvedValue(undefined),
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
      updateRecords: jest
        .fn()
        .mockImplementation(
          (tableSpec: BaseJsonTableSpec, files: ConnectorFile[], changedKeys?: (string[] | undefined)[]) => {
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
            // Validate changedKeys contains only string arrays, not data objects
            if (changedKeys) {
              for (const ck of changedKeys) {
                if (!ck) continue;
                if (!Array.isArray(ck) || ck.some((k) => typeof k !== 'string')) {
                  throw new Error(`updateRecords: changedKeys should be string arrays, but got: ${JSON.stringify(ck)}`);
                }
              }
            }
            return Promise.resolve(undefined);
          },
        ),
      deleteRecords: jest.fn().mockResolvedValue(undefined),
      supportsFileUpload: true,
      uploadFile: jest.fn(),
    };

    connectorsService = {
      getConnector: jest.fn().mockResolvedValue(mockConnector),
    } as unknown as ConnectorsService;

    credentialEncryptionService = {
      decryptCredentials: jest.fn().mockResolvedValue({}),
    } as unknown as CredentialEncryptionService;

    // ---- Real services ----
    fileIndexService = new FileIndexService(dbService);
    publishSchemaService = new SchemaHelperService(
      dbService,
      scratchGitService,
      connectorsService,
      credentialEncryptionService,
    );
    refCleanerService = new RefCleanerService();
    publishRefResolverService = new RefResolverService(fileIndexService, dbService);
    fileReferenceService = new FileReferenceService(dbService, refCleanerService, publishSchemaService);

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
      new AssetIndexService(dbService),
      connectorsService,
      credentialEncryptionService,
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

    // Posts now have `tags` field containing dest-tags remote IDs or refs for records to create.
    const allPostPaths = [...postsFkResult.updatedPaths];
    for (const postPath of allPostPaths) {
      const postContent = vfs.getAllFiles(DIRTY_BRANCH).get(postPath);
      expect(postContent).toBeDefined();
      const parsed = JSON.parse(postContent!) as ParsedRecord;
      expect(parsed.tags).toBeDefined();
      expect(Array.isArray(parsed.tags)).toBe(true);

      // Each pseudo-ref should be a valid path to a dest-tags file
      const tags = parsed.tags as string[];
      const failures: string[] = [];

      let targetPath = '';
      for (const tag of tags) {
        if (tag.includes('tag-create-')) {
          targetPath = tag.substring(2); // strip @/ prefix.
        } else {
          const file = destFileIndexEntries.find((entry) => entry.recordId === tag);
          if (!file) {
            failures.push(`No file index entry found for tag: ${tag}`);
            continue;
          }
          targetPath = file.folderPath + '/' + file.filename;
        }

        const targetFile = vfs.getAllFiles(DIRTY_BRANCH).get(targetPath);
        if (!targetFile) {
          failures.push(`Target file not found: ${targetPath} for tag: ${tag}`);
        }
      }
      expect(failures).toEqual([]);
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

    // Backfill entries should exist for every post that had pseudo-refs stripped.
    // Not every post references a created tag — only those whose tag-index arithmetic
    // picks up a tag-create-* entry will have @/ refs and thus need backfill.
    expect(backfillEntries.length).toBeGreaterThan(0);
    // Every backfill entry should be a post (tags don't have FK fields)
    for (const entry of backfillEntries) {
      expect(entry.filePath).toMatch(/^dest-posts\//);
    }

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

  it('should sync records with source_asset_to_dest_asset transformer and resolve asset references', async () => {
    // =====================================================================
    // Setup: Source folder needs connectorService for asset lookup.
    // We'll use source-posts (Airtable) → dest-posts (WordPress) with an
    // "images" field that uses the asset transformer.
    // =====================================================================

    // Update folders to have connectorService so asset lookups work
    await prisma.dataFolder.update({
      where: { id: sourcePostsFolderId },
      data: { connectorService: Service.AIRTABLE },
    });
    await prisma.dataFolder.update({
      where: { id: destPostsFolderId },
      data: { connectorService: Service.WORDPRESS },
    });

    // Create source assets in the DB (simulating a completed pull with rehosted assets)
    const sourceAssetA = createAssetId(); // will need creation during sync
    const sourceAssetB = createAssetId(); // already has a destination asset
    const sourceAssetC = createAssetId(); // another asset needing creation

    await prisma.asset.createMany({
      data: [
        {
          id: sourceAssetA,
          workbookId,
          dataFolderId: sourcePostsFolderId,
          service: Service.AIRTABLE,
          remoteAssetId: 'att_img_alpha',
          filename: 'alpha.png',
          mimeType: 'image/png',
          rehostedUrl: 'https://storage.example.com/alpha.png',
          rehostedAt: new Date(),
        },
        {
          id: sourceAssetB,
          workbookId,
          dataFolderId: sourcePostsFolderId,
          service: Service.AIRTABLE,
          remoteAssetId: 'att_img_beta',
          filename: 'beta.jpg',
          mimeType: 'image/jpeg',
          rehostedUrl: 'https://storage.example.com/beta.jpg',
          rehostedAt: new Date(),
        },
        {
          id: sourceAssetC,
          workbookId,
          dataFolderId: sourcePostsFolderId,
          service: Service.AIRTABLE,
          remoteAssetId: 'att_img_gamma',
          filename: 'gamma.webp',
          mimeType: 'image/webp',
          rehostedUrl: 'https://storage.example.com/gamma.webp',
          rehostedAt: new Date(),
        },
      ],
    });

    // Pre-create a destination asset for sourceAssetB (simulating a previous sync/publish cycle)
    const existingDestAssetId = createAssetId();
    const existingDestRemoteId = 'wp_img_42'; // already uploaded to WordPress
    await prisma.asset.create({
      data: {
        id: existingDestAssetId,
        workbookId,
        dataFolderId: destPostsFolderId,
        service: Service.WORDPRESS,
        remoteAssetId: existingDestRemoteId,
        sourceAssetId: sourceAssetB,
        filename: 'beta.jpg',
        mimeType: 'image/jpeg',
        rehostedUrl: 'https://storage.example.com/beta.jpg',
        rehostedAt: new Date(),
        uploadedAt: new Date(), // already uploaded
      },
    });

    // =====================================================================
    // Seed VFS with source/dest post files that reference assets
    // =====================================================================

    // Source posts with varying asset references:
    // post-0: multiple assets (alpha + beta) — one needs creation, one exists
    // post-1: single asset (gamma) — needs creation
    // post-2: no assets (empty array)
    // post-3: multiple assets (beta + gamma) — one exists, one needs creation
    const sourcePostsWithAssets = [
      {
        path: 'src-posts/rec_asset_post_0.json',
        content: JSON.stringify({
          id: 'rec_asset_post_0',
          fields: {
            Title: 'Post With Multiple Assets',
            Slug: 'post-asset-0',
            Images: ['att_img_alpha', 'att_img_beta'],
          },
        }),
      },
      {
        path: 'src-posts/rec_asset_post_1.json',
        content: JSON.stringify({
          id: 'rec_asset_post_1',
          fields: { Title: 'Post With New Asset', Slug: 'post-asset-1', Images: ['att_img_gamma'] },
        }),
      },
      {
        path: 'src-posts/rec_asset_post_2.json',
        content: JSON.stringify({
          id: 'rec_asset_post_2',
          fields: { Title: 'Post With No Assets', Slug: 'post-asset-2', Images: [] },
        }),
      },
      {
        path: 'src-posts/rec_asset_post_3.json',
        content: JSON.stringify({
          id: 'rec_asset_post_3',
          fields: {
            Title: 'Post With Mixed Assets',
            Slug: 'post-asset-3',
            Images: ['att_img_beta', 'att_img_gamma'],
          },
        }),
      },
    ];

    // Dest posts — all new (no matching slugs), so sync creates them
    vfs.seed(DIRTY_BRANCH, sourcePostsWithAssets);

    // =====================================================================
    // Store table mapping in the Sync record and create SyncTablePair
    // =====================================================================

    const assetPostsMapping: TableMapping = {
      sourceDataFolderId: sourcePostsFolderId,
      destinationDataFolderId: destPostsFolderId,
      columnMappings: [
        { sourceColumnId: 'fields.Title', destinationColumnId: 'title' },
        { sourceColumnId: 'fields.Slug', destinationColumnId: 'slug' },
        {
          sourceColumnId: 'fields.Images',
          destinationColumnId: 'images',
          transformer: {
            type: 'source_asset_to_dest_asset' as const,
            options: {
              sourceDataFolderId: sourcePostsFolderId,
              destinationDataFolderId: destPostsFolderId,
            },
          },
        },
      ] as ColumnMapping[],
      recordMatching: {
        sourceColumnId: 'fields.Slug',
        destinationColumnId: 'slug',
      },
    };

    const syncMappings: SyncMapping = {
      version: 1,
      tableMappings: [assetPostsMapping],
    };

    await prisma.sync.update({
      where: { id: syncId },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      data: { mappings: JSON.parse(JSON.stringify(syncMappings)) },
    });

    await prisma.syncTablePair.create({
      data: {
        id: createSyncTablePairId(),
        syncId,
        sourceDataFolderId: sourcePostsFolderId,
        destinationDataFolderId: destPostsFolderId,
      },
    });

    // =====================================================================
    // Run sync via SyncDataFoldersJobHandler (handles both DATA and FK phases)
    // =====================================================================

    const workbookEventService = {
      sendWorkbookEvent: jest.fn(),
    } as unknown as WorkbookEventService;

    const jobHandler = new SyncDataFoldersJobHandler(
      prisma,
      syncService,
      workbookEventService,
      scratchGitService,
      {} as BullEnqueuerService,
      publishPlanService,
      { trackSyncCompleted: jest.fn() } as unknown as PostHogService,
      new StubMetricsService(),
    );

    const noopCheckpoint = jest.fn().mockResolvedValue(undefined);
    const noopProgress = { publicProgress: { totalFilesSynced: 0, tables: [] }, jobProgress: {} };

    await jobHandler.run({
      jobId: 'test-asset-sync-job',
      data: {
        type: 'sync-data-folders' as const,
        workbookId,
        syncId,
        organizationId: orgId,
        userId,
        trigger: 'web',
      },
      progress: noopProgress as never,
      abortSignal: new AbortController().signal,
      checkpoint: noopCheckpoint,
    });

    // =====================================================================
    // Verify asset references in each synced file
    // =====================================================================

    // post-asset-0: [alpha (new → @asset/), beta (existing → wp_img_42)]
    const post0Content = vfs.getAllFiles(DIRTY_BRANCH).get('dest-posts/post-asset-0.json');
    expect(post0Content).toBeDefined();
    const post0 = JSON.parse(post0Content!) as Record<string, unknown>;
    const post0Images = post0.images as string[];
    expect(post0Images).toHaveLength(2);
    expect(post0Images[0]).toMatch(/^@asset\//); // alpha — new, gets @asset/ ref
    expect(post0Images[1]).toBe(existingDestRemoteId); // beta — existing, gets raw ID

    // post-asset-1: [gamma (new → @asset/)]
    const post1Content = vfs.getAllFiles(DIRTY_BRANCH).get('dest-posts/post-asset-1.json');
    expect(post1Content).toBeDefined();
    const post1 = JSON.parse(post1Content!) as Record<string, unknown>;
    const post1Images = post1.images as string[];
    expect(post1Images).toHaveLength(1);
    expect(post1Images[0]).toMatch(/^@asset\//); // gamma — new

    // post-asset-2: [] (empty array preserved)
    const post2Content = vfs.getAllFiles(DIRTY_BRANCH).get('dest-posts/post-asset-2.json');
    expect(post2Content).toBeDefined();
    const post2 = JSON.parse(post2Content!) as Record<string, unknown>;
    const post2Images = post2.images as unknown[];
    expect(post2Images).toEqual([]);

    // post-asset-3: [beta (existing → wp_img_42), gamma (new → @asset/)]
    const post3Content = vfs.getAllFiles(DIRTY_BRANCH).get('dest-posts/post-asset-3.json');
    expect(post3Content).toBeDefined();
    const post3 = JSON.parse(post3Content!) as Record<string, unknown>;
    const post3Images = post3.images as string[];
    expect(post3Images).toHaveLength(2);
    expect(post3Images[0]).toBe(existingDestRemoteId); // beta — existing
    expect(post3Images[1]).toMatch(/^@asset\//); // gamma — new

    // =====================================================================
    // Verify: @asset/ refs for alpha and gamma point to the same dest asset
    // across posts (idempotent upsert)
    // =====================================================================

    // Alpha's @asset/ ref should be the same in post-0
    const alphaRef = post0Images[0];

    // Gamma's @asset/ ref should be the same in post-1 and post-3
    const gammaRefInPost1 = post1Images[0];
    const gammaRefInPost3 = post3Images[1];
    expect(gammaRefInPost1).toBe(gammaRefInPost3);

    // All @asset/ refs should point to distinct destination asset IDs
    const allAssetRefs = [alphaRef, gammaRefInPost1];
    const uniqueRefs = new Set(allAssetRefs);
    expect(uniqueRefs.size).toBe(2); // alpha and gamma are distinct assets

    // =====================================================================
    // Verify: destination Asset records were created in DB
    // =====================================================================

    // Alpha should have a new destination asset
    const alphaDestAssets = await prisma.asset.findMany({
      where: { sourceAssetId: sourceAssetA, dataFolderId: destPostsFolderId },
    });
    expect(alphaDestAssets).toHaveLength(1);
    expect(alphaDestAssets[0].remoteAssetId).toMatch(/^scratch_pending_publish_/);
    expect(alphaDestAssets[0].rehostedUrl).toBe('https://storage.example.com/alpha.png');

    // Beta's existing destination asset should be unchanged
    const betaDestAssets = await prisma.asset.findMany({
      where: { sourceAssetId: sourceAssetB, dataFolderId: destPostsFolderId },
    });
    expect(betaDestAssets).toHaveLength(1);
    expect(betaDestAssets[0].id).toBe(existingDestAssetId);
    expect(betaDestAssets[0].remoteAssetId).toBe(existingDestRemoteId);

    // Gamma should have a new destination asset
    const gammaDestAssets = await prisma.asset.findMany({
      where: { sourceAssetId: sourceAssetC, dataFolderId: destPostsFolderId },
    });
    expect(gammaDestAssets).toHaveLength(1);
    expect(gammaDestAssets[0].remoteAssetId).toMatch(/^scratch_pending_publish_/);
    expect(gammaDestAssets[0].rehostedUrl).toBe('https://storage.example.com/gamma.webp');

    // =====================================================================
    // Phase E: Build Publish Pipeline
    // =====================================================================

    const buildResult = await publishPlanService.buildPipeline(workbookId, userId, connectorAccountId);
    expect(buildResult.status).toBe('planned');

    const planEntries = await prisma.publishPlanOperation.findMany({
      where: { planId: buildResult.pipelineId },
    });
    expect(planEntries.length).toBeGreaterThan(0);

    const assetUploadEntries = planEntries.filter((e) => e.phase === 'asset-upload');
    const createEntries = planEntries.filter((e) => e.phase === 'create');
    const backfillEntries = planEntries.filter((e) => e.phase === 'backfill');

    // 2 new assets to upload (alpha + gamma; beta already uploaded)
    expect(assetUploadEntries).toHaveLength(2);

    // 4 new posts to create
    expect(createEntries).toHaveLength(4);

    // Backfill entries for posts whose @asset/ refs were stripped during build
    // post-0 had @asset/ for alpha, post-1 had @asset/ for gamma, post-3 had @asset/ for gamma
    expect(backfillEntries.length).toBeGreaterThan(0);
    for (const entry of backfillEntries) {
      expect(entry.filePath).toMatch(/^dest-posts\//);
    }

    // =====================================================================
    // Phase F: Run Publish Pipeline
    // =====================================================================

    // Mock axios.get for asset downloads from rehosted URLs
    const axiosGetSpy = jest.spyOn(axios, 'get').mockResolvedValue({
      data: Buffer.from('fake-image-data'),
    } as never);

    // Mock uploadFile to return real remote asset IDs
    let nextUploadedAssetId = 5001;
    mockConnector.uploadFile.mockImplementation((_buffer: Buffer, filename: string) => {
      const remoteId = `wp_uploaded_${nextUploadedAssetId++}`;
      return Promise.resolve({
        remoteAssetId: remoteId,
        url: `https://wordpress.example.com/assets/${remoteId}`,
        filename,
      });
    });

    const runResult = await publishRunService.runPipeline(buildResult.pipelineId);
    expect(runResult.status).toBe('completed');

    // Restore axios
    axiosGetSpy.mockRestore();

    // =====================================================================
    // Verify publish results
    // =====================================================================

    // All plan operations should succeed
    const finalEntries = await prisma.publishPlanOperation.findMany({
      where: { planId: buildResult.pipelineId },
    });
    for (const entry of finalEntries) {
      expect(entry.status).toBe('success');
    }

    // uploadFile should have been called for alpha and gamma (not beta — already uploaded)
    expect(mockConnector.uploadFile).toHaveBeenCalledTimes(2);

    // createRecords should have been called for the 4 posts
    expect(mockConnector.createRecords).toHaveBeenCalled();

    // Asset records should now have real remote IDs (no more scratch_pending_publish_)
    const alphaDestAfterPublish = await prisma.asset.findFirst({
      where: { sourceAssetId: sourceAssetA, dataFolderId: destPostsFolderId },
    });
    expect(alphaDestAfterPublish).not.toBeNull();
    expect(alphaDestAfterPublish!.remoteAssetId).toMatch(/^wp_uploaded_/);
    expect(alphaDestAfterPublish!.uploadedAt).not.toBeNull();

    const gammaDestAfterPublish = await prisma.asset.findFirst({
      where: { sourceAssetId: sourceAssetC, dataFolderId: destPostsFolderId },
    });
    expect(gammaDestAfterPublish).not.toBeNull();
    expect(gammaDestAfterPublish!.remoteAssetId).toMatch(/^wp_uploaded_/);
    expect(gammaDestAfterPublish!.uploadedAt).not.toBeNull();

    // Beta should still have its original remote ID (was already uploaded)
    const betaDestAfterPublish = await prisma.asset.findFirst({
      where: { sourceAssetId: sourceAssetB, dataFolderId: destPostsFolderId },
    });
    expect(betaDestAfterPublish).not.toBeNull();
    expect(betaDestAfterPublish!.remoteAssetId).toBe(existingDestRemoteId);

    // Main branch files: images arrays should contain real remote IDs
    // (no @asset/ pseudo-refs and no scratch_pending_publish_ temp IDs)
    const mainBranchPostFiles = vfs.getFilesByFolder(MAIN_BRANCH, 'dest-posts');
    for (const postFile of mainBranchPostFiles) {
      const parsed = JSON.parse(postFile.content) as ParsedRecord;
      const images = parsed.images;
      if (images && Array.isArray(images)) {
        for (const imageValue of images as string[]) {
          expect(imageValue).not.toMatch(/^@asset\//); // No pseudo-refs remaining
          expect(imageValue).not.toMatch(/^scratch_pending_publish_/); // No temp IDs leaked
        }
      }
    }

    // Verify specific post files have correct resolved asset IDs
    const mainPost0 = vfs.getAllFiles(MAIN_BRANCH).get('dest-posts/post-asset-0.json');
    expect(mainPost0).toBeDefined();
    const mainPost0Parsed = JSON.parse(mainPost0!) as ParsedRecord;
    const mainPost0Images = mainPost0Parsed.images as string[];
    expect(mainPost0Images).toHaveLength(2);
    // Alpha was uploaded → real wp_uploaded_ ID; beta was already wp_img_42
    expect(mainPost0Images[0]).toMatch(/^wp_uploaded_/);
    expect(mainPost0Images[1]).toBe(existingDestRemoteId);

    // rebaseDirty should have been called
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(scratchGitService.rebaseDirty).toHaveBeenCalled();

    // Clean up assets and sync table pairs (afterEach doesn't handle these)
    await prisma.asset.deleteMany({ where: { workbookId } });
    await prisma.syncTablePair.deleteMany({ where: { syncId } });
  }, 60_000);
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
    supportsFileUpload: boolean;
    getBatchSize: jest.Mock;
    createRecords: jest.Mock;
    updateRecords: jest.Mock;
    deleteRecords: jest.Mock;
    uploadFile: jest.Mock;
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

    // ---- Mock: ScratchGitService (V2-aware) ----
    // resolveRepoId returns the composite ID for V2 workbooks
    scratchGitService = {
      resolveRepoId: jest
        .fn()
        .mockImplementation((wkbId: WorkbookId, connAcctId?: string) =>
          Promise.resolve(connAcctId ? getDefaultRepoPath(orgId, wkbId, connAcctId) : wkbId),
        ),
      readSchemaFromGit: jest.fn().mockImplementation((_repoId: string, folderPath: string) => {
        const schemas: Record<string, Record<string, unknown>> = {
          '/src-tags': { idColumnRemoteId: 'id' },
          '/dest-tags': { idColumnRemoteId: 'id', slugColumnRemoteId: 'slug' },
          '/src-posts': { idColumnRemoteId: 'id' },
          '/dest-posts': {
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
        };
        return Promise.resolve(schemas[folderPath] ?? null);
      }),
      commitFilesToBranch: jest
        .fn()
        .mockImplementation((_repoId: string, branch: string, files: { path: string; content: string }[]) => {
          vfs.commitFiles(branch, files);
          return Promise.resolve({ created: [], updated: [], unchanged: [] });
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
      runGitGc: jest.fn().mockResolvedValue(undefined),
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
      updateRecords: jest
        .fn()
        .mockImplementation(
          (tableSpec: BaseJsonTableSpec, files: ConnectorFile[], changedKeys?: (string[] | undefined)[]) => {
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
            // Validate changedKeys contains only string arrays, not data objects
            if (changedKeys) {
              for (const ck of changedKeys) {
                if (!ck) continue;
                if (!Array.isArray(ck) || ck.some((k) => typeof k !== 'string')) {
                  throw new Error(`updateRecords: changedKeys should be string arrays, but got: ${JSON.stringify(ck)}`);
                }
              }
            }
            return Promise.resolve(undefined);
          },
        ),
      deleteRecords: jest.fn().mockResolvedValue(undefined),
      supportsFileUpload: true,
      uploadFile: jest.fn(),
    };

    connectorsService = {
      getConnector: jest.fn().mockResolvedValue(mockConnector),
    } as unknown as ConnectorsService;

    credentialEncryptionService = {
      decryptCredentials: jest.fn().mockResolvedValue({}),
    } as unknown as CredentialEncryptionService;

    // ---- Real services ----
    fileIndexService = new FileIndexService(dbService);
    publishSchemaService = new SchemaHelperService(
      dbService,
      scratchGitService,
      connectorsService,
      credentialEncryptionService,
    );
    refCleanerService = new RefCleanerService();
    publishRefResolverService = new RefResolverService(fileIndexService, dbService);
    fileReferenceService = new FileReferenceService(dbService, refCleanerService, publishSchemaService);

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
      new AssetIndexService(dbService),
      connectorsService,
      credentialEncryptionService,
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
        repoPath: getDefaultRepoPath(orgId, workbookId, connectorAccountId),
      },
    });

    // Source Tags folder (no connector)
    await prisma.dataFolder.create({
      data: {
        id: sourceTagsFolderId,
        name: 'Source Tags',
        workbookId,
        path: '/src-tags',
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

  it('should resolve composite V2 repo ID (orgId/workbookId/connAccountId) when building pipeline', async () => {
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
    const expectedRepoId = getDefaultRepoPath(orgId, workbookId, connectorAccountId);
    expect(expectedRepoId).toBe(`${orgId}/${workbookId}/${connectorAccountId}`);

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
    // which uses getDefaultRepoPath for each connector account — not resolveRepoId.
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
    const expectedRepoId = getDefaultRepoPath(orgId, workbookId, connectorAccountId);
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
    this.branches.set('merge_base', new Map());
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

  /** Diff merge_base vs dirty → list of user changes */
  getStatus(): { path: string; status: 'added' | 'modified' | 'deleted' }[] {
    const base = this.getBranch('merge_base');
    const dirty = this.getBranch(DIRTY_BRANCH);
    const result: { path: string; status: 'added' | 'modified' | 'deleted' }[] = [];

    for (const [path, content] of dirty) {
      if (!base.has(path)) {
        result.push({ path, status: 'added' });
      } else if (base.get(path) !== content) {
        result.push({ path, status: 'modified' });
      }
    }
    for (const path of base.keys()) {
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

  /** Rebase dirty onto main, preserving user edits relative to merge_base. */
  rebaseDirty(): void {
    const main = this.getBranch(MAIN_BRANCH);
    const base = this.getBranch('merge_base');
    const dirty = this.getBranch(DIRTY_BRANCH);

    const userAdded = new Map<string, string>();
    const userModified = new Map<string, string>();
    const userDeleted = new Set<string>();

    for (const [path, content] of dirty) {
      if (!base.has(path)) userAdded.set(path, content);
      else if (base.get(path) !== content) userModified.set(path, content);
    }
    for (const path of base.keys()) {
      if (!dirty.has(path)) userDeleted.add(path);
    }

    const newDirty = new Map(main);
    for (const [path, content] of userAdded) newDirty.set(path, content);
    for (const [path, content] of userModified) newDirty.set(path, content);
    for (const path of userDeleted) newDirty.delete(path);

    this.branches.set(DIRTY_BRANCH, newDirty);
    this.branches.set('merge_base', new Map(main));
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
