/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/**
 * Fetch → Edit → Publish Integration Test
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * DOMAIN MODEL
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Tables (real PostgreSQL, prefixed test_fep_):
 *   authors (id SERIAL PK, name, best_friend_id FK→authors, favorite_post_id FK→posts)
 *   posts   (id SERIAL PK, title, author_id FK→authors)
 *
 * Initial seeded data:
 *   Authors: Alice (best_friend=Alice self-ref, favorite_post=Post1)
 *            Bob   (best_friend=Cleo,           favorite_post=Post3)
 *            Cleo  (best_friend=NULL,            favorite_post=Post2)
 *   Posts:   Post1 (author=Alice)
 *            Post2 (author=Bob)
 *            Post3 (author=Cleo)
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * TEST PHASES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Phase 1 — Pull
 *   • Run PullLinkedFolderFilesJobHandler for authors then posts.
 *   • Verify 3+3 files land on main branch in VirtualGitFs.
 *   • Verify FileIndex has 3+3 entries with numeric recordIds and derived filenames.
 *   • Verify FileReferences: authors→authors (self+Bob→Cleo), authors→posts (3),
 *     posts→authors (3).
 *   • Spot-check file content (Alice self-ref, Post1→Alice author_id).
 *   • Spot-check cross-ref integrity: every ref.targetRemoteId resolves to a known
 *     FileIndex entry in the target folder.
 *
 * Phase 2 — Edit dirty branch then publish
 *   Edits applied to dirty branch of VirtualGitFs before publish:
 *
 *   (a) Standalone new author "Dave" — created with a pseudo-ref (@/posts/...) for
 *       favorite_post pointing at Post1 (which is already published → has a real ID
 *       in FileIndex).  Also carries best_friend_id = Alice's real numeric ID.
 *       Tests: CREATE with an already-known FK resolved by backfill,
 *              and a pseudo-ref to an already-indexed file.
 *
 *   (b) Edit Bob — change his name, set best_friend_id to Cleo's real numeric ID.
 *       The plan's Pass 1 (deleted-record ref stripping) removes it since Cleo is deleted.
 *       Result: best_friend_id=null in remote, no backfill needed for Bob.
 *
 *   (c) Delete Cleo — she is referenced by Bob (best_friend) and Post3 (author_id).
 *       Tests circular/FK-constrained delete: the plan must strip those refs in EDIT
 *       before the DELETE phase runs.
 *
 *   (d) New post "Post4" authored by Dave — but Dave doesn't exist in the remote yet,
 *       so Post4 carries a pseudo-ref (@/authors/dave.json) for author_id.
 *       Tests: CREATE with a pseudo-ref that resolves only after Dave's CREATE phase
 *              completes (BACKFILL path).
 *
 *   Publish plan phases expected:
 *     EDIT    — Bob (name change + strip Cleo ref), Post3 (strip Cleo ref)
 *     CREATE  — Dave, Post4 (Post4 backfilled after Dave)
 *     DELETE  — Cleo
 *     BACKFILL— Dave (pseudo-ref for favorite_post resolved to Post1's real ID),
 *               Post4 (pseudo-ref for author_id resolved to Dave's new real ID)
 *
 *   Final PostgreSQL state verified:
 *     • Dave exists in test_fep_authors with a real numeric ID.
 *     • Bob's name is updated; best_friend_id is null (Cleo deleted → stripped).
 *     • Cleo is gone from test_fep_authors.
 *     • Post4 exists in test_fep_posts with author_id = Dave's real ID.
 *     • Post3's author_id is null (Cleo deleted → stripped).
 *     • Dave's favorite_post_id equals Post1's real ID.
 */

import { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import {
  AuthType,
  createConnectorAccountId,
  createDataFolderId,
  createWorkbookId,
  DataFolderId,
  WorkbookId,
} from '@spinner/shared-types';
import { Pool } from 'pg';
import { AssetExtractorService } from 'src/asset/asset-extractor.service';
import { AssetIndexService } from 'src/asset/asset-index.service';
import { CredentialEncryptionService } from 'src/credential-encryption/credential-encryption.service';
import { DbService } from 'src/db/db.service';
import { ExperimentsService } from 'src/experiments/experiments.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { FileIndexService } from 'src/publish-plan/file-index.service';
import { FileReferenceService } from 'src/publish-plan/file-reference.service';
import { PublishPlanBuildService } from 'src/publish-plan/publish-plan-build.service';
import { PublishPlanRunService } from 'src/publish-plan/publish-plan-run.service';
import { RecreatedIdMapService } from 'src/publish-plan/recreated-id-map.service';
import { RefCleanerService } from 'src/publish-plan/ref-cleaner.service';
import { RefResolverService } from 'src/publish-plan/ref-resolver.service';
import { SchemaHelperService } from 'src/publish-plan/schema-helper.service';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { ConnectorsService } from 'src/remote-service/connectors/connectors.service';
import { Service } from 'src/remote-service/connectors/service-constants';
import { DIRTY_BRANCH, MAIN_BRANCH, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { EncryptionService } from 'src/utils/encryption';
import { WorkbookEventService } from 'src/workbook/workbook-event.service';
import { PullLinkedFolderFilesJobHandler } from 'src/worker/jobs/job-definitions/pull-linked-folder-files.job';
import { VirtualGitFs } from './virtual-git-fs';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Prefix for test tables to avoid conflicts with Prisma-managed tables */
const TABLE_PREFIX = 'test_fep_';
const AUTHORS_TABLE = `${TABLE_PREFIX}authors`;
const POSTS_TABLE = `${TABLE_PREFIX}posts`;

// Table IDs used in x-scratch-foreign-key annotations (match remoteId)
const AUTHORS_REMOTE_TABLE_ID = AUTHORS_TABLE;
const POSTS_REMOTE_TABLE_ID = POSTS_TABLE;

// Folder paths (no leading slash for FileIndex / git; leading slash for DataFolder.path)
const AUTHORS_FOLDER = 'authors';
const POSTS_FOLDER = 'posts';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDbService(prisma: PrismaClient): DbService {
  return { client: prisma } as unknown as DbService;
}

function makeNoopProgress() {
  return {
    publicProgress: null as any,
    jobProgress: {} as any,
    connectorProgress: {} as any,
    timestamp: Date.now(),
  };
}

function makeCheckpoint() {
  return jest.fn().mockResolvedValue(undefined);
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Fetch → Edit → Publish Integration', () => {
  let prisma: PrismaClient;
  let pool: Pool; // Direct PG pool for source-DB DDL/DML and final state assertions
  let encryptionService: EncryptionService;

  // Scratch entities
  let workbookId: WorkbookId;
  let orgId: string;
  let userId: string;
  let authorsFolderId: DataFolderId;
  let postsFolderId: DataFolderId;
  let connectorAccountId: string;

  // Services
  let pullHandler: PullLinkedFolderFilesJobHandler;
  let publishPlanService: PublishPlanBuildService;
  let publishRunService: PublishPlanRunService;
  let fileIndexService: FileIndexService;
  let fileReferenceService: FileReferenceService;
  let vfs: VirtualGitFs;
  let mockScratchGitService: ScratchGitService;
  // ─── beforeAll / afterAll ──────────────────────────────────────────────────

  beforeAll(() => {
    prisma = new PrismaClient();

    const dbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/scratchpad?schema=public';
    pool = new Pool({ connectionString: dbUrl });

    const masterKey = process.env.ENCRYPTION_MASTER_KEY ?? 'test-master-key-at-least-32-chars-long!!';
    encryptionService = new EncryptionService(masterKey);
    process.env.ENCRYPTION_MASTER_KEY = masterKey;
  });

  afterAll(async () => {
    await pool.end();
    await prisma.$disconnect();
  });

  // ─── beforeEach ───────────────────────────────────────────────────────────

  beforeEach(async () => {
    // ── 0. Clean up any leftover state from a previous run ───────────────────
    await pool.query(`DROP TABLE IF EXISTS ${POSTS_TABLE} CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${AUTHORS_TABLE} CASCADE`);
    // Clean Scratch DB by workbookId if it was set from a prior run
    if (workbookId) {
      await prisma.publishPlanOperation.deleteMany({ where: { plan: { workbookId } } });
      await prisma.publishPlan.deleteMany({ where: { workbookId } });
      await prisma.fileReference.deleteMany({ where: { workbookId } });
      await prisma.fileIndex.deleteMany({ where: { workbookId } });
      await prisma.dataFolder.deleteMany({ where: { workbookId } });
      await prisma.connectorAccount.deleteMany({ where: { workbookId } });
      await prisma.workbook.delete({ where: { id: workbookId } }).catch(() => {});
    }
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});

    // ── 1. Create test tables (with FK constraints for pg_catalog detection) ─
    // Create posts first (without author_id FK, since authors doesn't exist yet)
    await pool.query(`
      CREATE TABLE ${POSTS_TABLE} (
        id        SERIAL PRIMARY KEY,
        title     VARCHAR(255) NOT NULL,
        author_id INTEGER
      )
    `);
    // Create authors with FKs to itself (best_friend_id) and posts (favorite_post_id)
    await pool.query(`
      CREATE TABLE ${AUTHORS_TABLE} (
        id               SERIAL PRIMARY KEY,
        name             VARCHAR(255) NOT NULL,
        best_friend_id   INTEGER REFERENCES ${AUTHORS_TABLE}(id),
        favorite_post_id INTEGER REFERENCES ${POSTS_TABLE}(id)
      )
    `);
    // Now add the author_id FK from posts → authors
    await pool.query(`
      ALTER TABLE ${POSTS_TABLE}
        ADD CONSTRAINT fk_posts_author FOREIGN KEY (author_id) REFERENCES ${AUTHORS_TABLE}(id)
    `);

    // ── 2. Seed initial data ─────────────────────────────────────────────────
    const authorsResult = await pool.query<{ id: number; name: string }>(`
      INSERT INTO ${AUTHORS_TABLE} (name, best_friend_id, favorite_post_id)
      VALUES ('Alice', NULL, NULL), ('Bob', NULL, NULL), ('Cleo', NULL, NULL)
      RETURNING id, name
    `);
    const authorByName = new Map(authorsResult.rows.map((r) => [r.name, r.id]));
    const aliceId = authorByName.get('Alice')!;
    const bobId = authorByName.get('Bob')!;
    const cleoId = authorByName.get('Cleo')!;

    const postsResult = await pool.query<{ id: number; title: string }>(`
      INSERT INTO ${POSTS_TABLE} (title, author_id)
      VALUES ('Post 1', ${aliceId}), ('Post 2', ${bobId}), ('Post 3', ${cleoId})
      RETURNING id, title
    `);
    const postByTitle = new Map(postsResult.rows.map((r) => [r.title, r.id]));
    const post1Id = postByTitle.get('Post 1')!;
    const post2Id = postByTitle.get('Post 2')!;
    const post3Id = postByTitle.get('Post 3')!;

    await pool.query(`UPDATE ${AUTHORS_TABLE} SET best_friend_id=$1, favorite_post_id=$2 WHERE id=$3`, [
      aliceId,
      post1Id,
      aliceId,
    ]);
    await pool.query(`UPDATE ${AUTHORS_TABLE} SET best_friend_id=$1, favorite_post_id=$2 WHERE id=$3`, [
      cleoId,
      post3Id,
      bobId,
    ]);
    await pool.query(`UPDATE ${AUTHORS_TABLE} SET best_friend_id=NULL, favorite_post_id=$1 WHERE id=$2`, [
      post2Id,
      cleoId,
    ]);

    // ── 3. Scratch org / user / workbook ────────────────────────────────────
    const ts = Date.now();
    const org = await prisma.organization.create({
      data: { id: `org_fep_${ts}`, name: 'FEP Test Org', clerkId: `clerk_fep_${ts}` },
    });
    orgId = org.id;

    const user = await prisma.user.create({
      data: { id: `user_fep_${ts}`, email: `fep-${ts}@example.com`, organizationId: org.id },
    });
    userId = user.id;

    workbookId = createWorkbookId();
    await prisma.workbook.create({
      data: { id: workbookId, name: 'FEP Test Workbook', userId: user.id, organizationId: org.id },
    });

    // ── 4. ConnectorAccount with encrypted PostgreSQL credentials ────────────
    const dbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/scratchpad?schema=public';
    const encryptedCreds = await encryptionService.encryptObject({ connectionString: dbUrl });

    connectorAccountId = createConnectorAccountId();
    await prisma.connectorAccount.create({
      data: {
        id: connectorAccountId,
        workbookId,
        service: Service.POSTGRES,
        displayName: 'FEP Test PostgreSQL',
        authType: AuthType.USER_PROVIDED_PARAMS,
        encryptedCredentials: encryptedCreds as unknown as any,
      },
    });

    // ── 5. Schemas with x-scratch-foreign-key annotations ───────────────────
    const authorsSchema = Type.Object(
      {
        id: Type.Integer(),
        name: Type.String(),
        best_friend_id: Type.Optional(
          Type.Union([Type.Integer({ 'x-scratch-foreign-key': AUTHORS_REMOTE_TABLE_ID } as object), Type.Null()]),
        ),
        favorite_post_id: Type.Optional(
          Type.Union([Type.Integer({ 'x-scratch-foreign-key': POSTS_REMOTE_TABLE_ID } as object), Type.Null()]),
        ),
      },
      { $id: `postgres/${AUTHORS_TABLE}`, title: AUTHORS_TABLE },
    );

    const postsSchema = Type.Object(
      {
        id: Type.Integer(),
        title: Type.String(),
        author_id: Type.Optional(
          Type.Union([Type.Integer({ 'x-scratch-foreign-key': AUTHORS_REMOTE_TABLE_ID } as object), Type.Null()]),
        ),
      },
      { $id: `postgres/${POSTS_TABLE}`, title: POSTS_TABLE },
    );

    const authorsTableSpec = {
      id: { wsId: AUTHORS_TABLE, remoteId: ['public', AUTHORS_TABLE] },
      slug: AUTHORS_TABLE,
      name: AUTHORS_TABLE,
      schema: authorsSchema,
      idColumnRemoteId: 'id',
      titleColumnRemoteId: ['name'],
      basePath: ['public'],
      generatedAt: new Date().toISOString(),
    };

    const postsTableSpec = {
      id: { wsId: POSTS_TABLE, remoteId: ['public', POSTS_TABLE] },
      slug: POSTS_TABLE,
      name: POSTS_TABLE,
      schema: postsSchema,
      idColumnRemoteId: 'id',
      titleColumnRemoteId: ['title'],
      basePath: ['public'],
      generatedAt: new Date().toISOString(),
    };

    // ── 6. DataFolders ───────────────────────────────────────────────────────
    authorsFolderId = createDataFolderId();
    await prisma.dataFolder.create({
      data: {
        id: authorsFolderId,
        name: 'Authors',
        path: `/${AUTHORS_FOLDER}`,
        workbookId,
        connectorAccountId,
        connectorService: Service.POSTGRES,
        tableId: ['public', AUTHORS_TABLE],
      },
    });

    postsFolderId = createDataFolderId();
    await prisma.dataFolder.create({
      data: {
        id: postsFolderId,
        name: 'Posts',
        path: `/${POSTS_FOLDER}`,
        workbookId,
        connectorAccountId,
        connectorService: Service.POSTGRES,
        tableId: ['public', POSTS_TABLE],
      },
    });

    // ── 7. VirtualGitFs + ScratchGitService mock ─────────────────────────────
    vfs = new VirtualGitFs();

    // In-memory staging area for the two-phase pull handler
    const stagingStore = new Map<string, Map<string, string>>(); // key: `${jobId}/${folder}`, value: Map<path, content>
    const processedPaths = new Map<string, Set<string>>(); // key: `${jobId}/${folder}`, value: Set<path>
    const committedPaths = new Map<string, Set<string>>(); // key: `${jobId}/${folder}`, value: Set<path>

    mockScratchGitService = {
      initRepo: jest.fn().mockResolvedValue(undefined),
      resolveRepoId: jest.fn().mockImplementation(async (wkbId: WorkbookId) => wkbId),
      resolveConnectionRepoPath: jest.fn().mockImplementation(async (connectorAccountId: string) => connectorAccountId),
      commitFilesToBranch: jest
        .fn()
        .mockImplementation(async (_repoId: string, branch: string, files: { path: string; content: string }[]) => {
          vfs.commitFiles(branch, files);
          return { created: [], updated: [], unchanged: [] };
        }),
      rebaseDirty: jest.fn().mockImplementation(async () => {
        vfs.rebaseDirty();
      }),
      listRepoFiles: jest
        .fn()
        .mockImplementation(async (_repoId: string, branch: string, folderPath: string) =>
          vfs.listFiles(branch, folderPath),
        ),
      deleteFilesFromBranch: jest.fn().mockImplementation(async (_repoId: string, branch: string, paths: string[]) => {
        vfs.deleteFiles(branch, paths);
      }),
      getRepoStatus: jest.fn().mockImplementation(async () => vfs.getStatus()),
      readRepoFilesByFolder: jest
        .fn()
        .mockImplementation(async (_repoId: string, branch: string, paths: string[]) => vfs.readFiles(branch, paths)),
      runGitGc: jest.fn().mockResolvedValue(undefined),
      readSchemaFromGit: jest.fn().mockImplementation(async (_repoId: string, folderPath: string) => {
        const schemas: Record<string, unknown> = {
          [`/${AUTHORS_FOLDER}`]: authorsTableSpec,
          [`/${POSTS_FOLDER}`]: postsTableSpec,
        };
        return schemas[folderPath] ?? null;
      }),
      writeSchemaToGit: jest.fn().mockResolvedValue(undefined),
      writeViewToGit: jest.fn().mockResolvedValue(undefined),
      buildIndex: jest.fn().mockResolvedValue({ count: 0 }),
      // Staging methods for two-phase pull handler
      stageFiles: jest
        .fn()
        .mockImplementation(async (jobId: string, folder: string, files: { path: string; content: string }[]) => {
          const key = `${jobId}/${folder}`;
          if (!stagingStore.has(key)) stagingStore.set(key, new Map());
          const store = stagingStore.get(key)!;
          for (const f of files) store.set(f.path, f.content);
        }),
      readStagedFiles: jest.fn().mockImplementation(async (jobId: string, folder: string, batchSize: number) => {
        const key = `${jobId}/${folder}`;
        const store = stagingStore.get(key) ?? new Map<string, string>();
        const processed = processedPaths.get(key) ?? new Set<string>();
        const files: { path: string; content: string }[] = [];
        for (const [path, content] of store) {
          if (processed.has(path)) continue;
          files.push({ path, content });
          if (files.length >= batchSize) break;
        }
        return { files };
      }),
      markStagedFilesProcessed: jest.fn().mockImplementation(async (jobId: string, folder: string, paths: string[]) => {
        const key = `${jobId}/${folder}`;
        if (!processedPaths.has(key)) processedPaths.set(key, new Set());
        const processed = processedPaths.get(key)!;
        for (const p of paths) processed.add(p);
      }),
      commitStagedFiles: jest
        .fn()
        .mockImplementation(
          async (
            jobId: string,
            repoId: string,
            branch: string,
            folder: string,
            _message: string,
            batchSize: number,
          ) => {
            const key = `${jobId}/${folder}`;
            const store = stagingStore.get(key) ?? new Map<string, string>();
            const committed = committedPaths.get(key) ?? new Set<string>();
            const filesToCommit: { path: string; content: string }[] = [];
            for (const [path, content] of store) {
              if (committed.has(path)) continue;
              filesToCommit.push({ path: `${folder}/${path}`, content });
              if (filesToCommit.length >= batchSize) break;
            }
            if (filesToCommit.length > 0) {
              vfs.commitFiles(branch, filesToCommit);
              if (!committedPaths.has(key)) committedPaths.set(key, new Set());
              const committedSet = committedPaths.get(key)!;
              for (const f of filesToCommit) committedSet.add(f.path.slice(folder.length + 1));
            }
            return { committed: filesToCommit.length, created: filesToCommit.map((f) => f.path), updated: [] };
          },
        ),
      cleanupStaging: jest.fn().mockImplementation(async (jobId: string) => {
        for (const key of [...stagingStore.keys()]) {
          if (key.startsWith(`${jobId}/`)) {
            stagingStore.delete(key);
            processedPaths.delete(key);
            committedPaths.delete(key);
          }
        }
      }),
    } as unknown as ScratchGitService;

    // ── 8. Wire up all services ──────────────────────────────────────────────
    const dbService = makeDbService(prisma);

    // Real PostgresConnector — used for both pull and publish
    const realConnectorsService = new ConnectorsService({} as any, {} as any, {} as any, {} as any);

    const credentialEncryptionService = new CredentialEncryptionService();

    fileIndexService = new FileIndexService(dbService);
    const refCleanerService = new RefCleanerService();
    const schemaHelperService = new SchemaHelperService(
      dbService,
      mockScratchGitService,
      realConnectorsService,
      credentialEncryptionService,
    );
    fileReferenceService = new FileReferenceService(dbService, refCleanerService, schemaHelperService);
    const refResolverService = new RefResolverService(fileIndexService, dbService);

    const mockConnectorAccountService = {
      findOneById: jest.fn().mockImplementation(async (id: string) => {
        const account = await prisma.connectorAccount.findUnique({ where: { id } });
        if (!account) return null;
        const creds = await encryptionService.decryptObject(account.encryptedCredentials as any);
        return { ...account, ...creds };
      }),
    } as unknown as ConnectorAccountService;

    const mockWorkbookEventService = {
      sendWorkbookEvent: jest.fn(),
    } as unknown as WorkbookEventService;

    const mockAssetExtractorService = {
      extractAssets: jest.fn().mockReturnValue([]),
    } as unknown as AssetExtractorService;

    const mockAssetIndexService = {
      upsertBatch: jest.fn().mockResolvedValue(undefined),
    } as unknown as AssetIndexService;

    const mockPostHogService = {
      trackPullCompleted: jest.fn(),
    } as unknown as PostHogService;

    // This round-trip test never requests pullMode='incremental', so the
    // requested mode resolves to 'full' regardless of the flag value. The
    // mock just has to exist so run()'s kill-switch check doesn't throw.
    const mockExperimentsService = {
      getBooleanFlag: jest.fn().mockResolvedValue(false),
    } as unknown as ExperimentsService;

    pullHandler = new PullLinkedFolderFilesJobHandler(
      prisma,
      realConnectorsService,
      mockConnectorAccountService,
      mockWorkbookEventService,
      mockScratchGitService,
      fileIndexService,
      fileReferenceService,
      mockAssetExtractorService,
      mockAssetIndexService,
      mockPostHogService,
      mockExperimentsService,
    );

    publishPlanService = new PublishPlanBuildService(
      dbService,
      mockScratchGitService,
      fileIndexService,
      fileReferenceService,
      refCleanerService,
      schemaHelperService,
      mockAssetIndexService,
      realConnectorsService,
      credentialEncryptionService,
    );

    publishRunService = new PublishPlanRunService(
      dbService,
      realConnectorsService,
      credentialEncryptionService,
      fileIndexService,
      fileReferenceService,
      mockScratchGitService,
      schemaHelperService,
      refResolverService,
      // Flag always off → tests exercise the pre-existing sent-payload path.
      { getBooleanFlag: jest.fn().mockResolvedValue(false) } as unknown as ExperimentsService,
      // Recreate flow isn't exercised here — defaults to noops so any code
      // path that happens to touch the service won't blow up on undefined.
      {
        upsert: jest.fn().mockResolvedValue(undefined),
        resolveLatest: jest.fn().mockResolvedValue(null),
        resolveLatestBatch: jest.fn().mockResolvedValue(new Map()),
        resolveFkTargetFolders: jest.fn().mockResolvedValue(new Map()),
        deleteForWorkbook: jest.fn().mockResolvedValue(undefined),
      } as unknown as RecreatedIdMapService,
      refCleanerService,
    );
  });

  // ─── afterEach ────────────────────────────────────────────────────────────
  // Set SKIP_CLEANUP=1 locally to leave DB state in place for inspection.
  // The next beforeEach will still clean up before the next run.

  afterEach(async () => {
    if (process.env.SKIP_CLEANUP === '1') return;

    await pool.query(`DROP TABLE IF EXISTS ${POSTS_TABLE} CASCADE`);
    await pool.query(`DROP TABLE IF EXISTS ${AUTHORS_TABLE} CASCADE`);
    if (workbookId) {
      await prisma.publishPlanOperation.deleteMany({ where: { plan: { workbookId } } });
      await prisma.publishPlan.deleteMany({ where: { workbookId } });
      await prisma.fileReference.deleteMany({ where: { workbookId } });
      await prisma.fileIndex.deleteMany({ where: { workbookId } });
      await prisma.dataFolder.deleteMany({ where: { workbookId } });
      await prisma.connectorAccount.deleteMany({ where: { workbookId } });
      await prisma.workbook.delete({ where: { id: workbookId } });
    }
    if (userId) await prisma.user.delete({ where: { id: userId } });
    if (orgId) await prisma.organization.delete({ where: { id: orgId } });
  });

  // ─── Helper: pull a single folder ─────────────────────────────────────────

  async function pullFolder(jobId: string, folderId: DataFolderId) {
    await pullHandler.run({
      jobId,
      data: {
        type: 'pull-linked-folder-files',
        workbookId,
        dataFolderIds: [folderId],
        userId,
        organizationId: orgId,
      },
      progress: makeNoopProgress(),
      abortSignal: new AbortController().signal,
      checkpoint: makeCheckpoint(),
    });
  }

  // ─── Helper: find a file in the VFS by matching a field value ─────────────

  function findFileByField(
    branch: string,
    folderPrefix: string,
    field: string,
    value: unknown,
  ): { path: string; content: Record<string, unknown> } | undefined {
    for (const [path, raw] of vfs.getAllFiles(branch)) {
      if (!path.startsWith(`${folderPrefix}/`)) continue;
      const content = JSON.parse(raw) as Record<string, unknown>;
      if (content[field] === value) return { path, content };
    }
    return undefined;
  }

  it('fetch → edit → publish end-to-end scenario', async () => {
    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 1 — Pull authors only, verify refs to posts are stored even
    //           though posts haven't been pulled yet, then pull posts and
    //           verify full cross-ref integrity.
    // ═══════════════════════════════════════════════════════════════════════

    // ── 1a: Pull authors ──────────────────────────────────────────────────
    await pullFolder('job-authors', authorsFolderId);

    const authorFiles = [...vfs.getAllFiles(MAIN_BRANCH).keys()].filter((p) => p.startsWith(`${AUTHORS_FOLDER}/`));
    expect(authorFiles).toHaveLength(3);

    // FileIndex populated for authors
    const authorIdx = await prisma.fileIndex.findMany({ where: { workbookId, folderPath: AUTHORS_FOLDER } });
    expect(authorIdx).toHaveLength(3);
    for (const e of authorIdx) {
      expect(e.recordId).toMatch(/^\d+$/);
      expect(e.filename).toMatch(/\.json$/);
    }
    const authorFilenames = authorIdx.map((e) => e.filename);
    expect(authorFilenames.some((f) => f.includes('alice'))).toBe(true);
    expect(authorFilenames.some((f) => f.includes('bob'))).toBe(true);
    expect(authorFilenames.some((f) => f.includes('cleo'))).toBe(true);

    // FileReferences for authors already written — including refs to posts
    // (posts haven't been pulled yet, so targetRemoteId is set but the posts
    //  FileIndex has no entries yet — cross-ref resolution will complete after
    //  the posts pull below)
    const authorRefsAfterAuthorPull = await prisma.fileReference.findMany({
      where: { workbookId, branch: MAIN_BRANCH, sourceFilePath: { startsWith: `${AUTHORS_FOLDER}/` } },
    });
    expect(authorRefsAfterAuthorPull.length).toBeGreaterThanOrEqual(5); // Alice×2, Bob×2, Cleo×1
    const authorsToPosts = authorRefsAfterAuthorPull.filter((r) => r.targetRemoteTableId === POSTS_REMOTE_TABLE_ID);
    expect(authorsToPosts.length).toBeGreaterThanOrEqual(3); // each author's favorite_post ref is stored
    // Posts FileIndex is empty — so these refs can't resolve yet
    const postIdxBeforePull = await prisma.fileIndex.findMany({ where: { workbookId, folderPath: POSTS_FOLDER } });
    expect(postIdxBeforePull).toHaveLength(0);

    // Content spot-check: Alice self-ref already in git
    const alice = findFileByField(MAIN_BRANCH, AUTHORS_FOLDER, 'name', 'Alice');
    expect(alice).toBeDefined();
    expect(alice!.content['best_friend_id']).toBe(alice!.content['id']);

    // ── 1b: Pull posts — now both sides are present ───────────────────────
    await pullFolder('job-posts', postsFolderId);

    const postFiles = [...vfs.getAllFiles(MAIN_BRANCH).keys()].filter((p) => p.startsWith(`${POSTS_FOLDER}/`));
    expect(postFiles).toHaveLength(3);

    // FileIndex populated for posts
    const postIdx = await prisma.fileIndex.findMany({ where: { workbookId, folderPath: POSTS_FOLDER } });
    expect(postIdx).toHaveLength(3);
    for (const e of postIdx) {
      expect(e.recordId).toMatch(/^\d+$/);
      expect(e.filename).toMatch(/\.json$/);
    }

    // FileReferences — posts → authors (3: Post1→Alice, Post2→Bob, Post3→Cleo)
    const postRefs = await prisma.fileReference.findMany({
      where: { workbookId, branch: MAIN_BRANCH, sourceFilePath: { startsWith: `${POSTS_FOLDER}/` } },
    });
    expect(postRefs).toHaveLength(3);
    for (const r of postRefs) expect(r.targetRemoteTableId).toBe(AUTHORS_REMOTE_TABLE_ID);

    // Re-read author refs to get the final state after both pulls
    const authorRefs = await prisma.fileReference.findMany({
      where: { workbookId, branch: MAIN_BRANCH, sourceFilePath: { startsWith: `${AUTHORS_FOLDER}/` } },
    });
    const authorsToAuthors = authorRefs.filter((r) => r.targetRemoteTableId === AUTHORS_REMOTE_TABLE_ID);
    const authorsToPostsFinal = authorRefs.filter((r) => r.targetRemoteTableId === POSTS_REMOTE_TABLE_ID);
    expect(authorsToAuthors.length).toBeGreaterThanOrEqual(2); // Alice self + Bob→Cleo
    expect(authorsToPostsFinal.length).toBeGreaterThanOrEqual(3);

    // Content spot-check: Post1 → Alice
    const post1 = findFileByField(MAIN_BRANCH, POSTS_FOLDER, 'title', 'Post 1');
    expect(post1).toBeDefined();
    expect(post1!.content['author_id']).toBe(alice!.content['id']);

    // Cross-ref integrity: every ref.targetRemoteId resolves to a known FileIndex entry
    const authorIdxMap = new Map(authorIdx.map((e) => [e.recordId, e.filename]));
    const postIdxMap = new Map(postIdx.map((e) => [e.recordId, e.filename]));
    for (const r of postRefs) expect(authorIdxMap.get(r.targetRemoteId!)).toBeDefined();
    for (const r of authorsToPostsFinal) expect(postIdxMap.get(r.targetRemoteId!)).toBeDefined();
    for (const r of authorsToAuthors) expect(authorIdxMap.get(r.targetRemoteId!)).toBeDefined();

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 2 — Edit dirty branch, build plan, run publish, verify state
    // ═══════════════════════════════════════════════════════════════════════

    // Collect the filenames we need for edits below
    const aliceFile = findFileByField(MAIN_BRANCH, AUTHORS_FOLDER, 'name', 'Alice')!;
    const bobFile = findFileByField(MAIN_BRANCH, AUTHORS_FOLDER, 'name', 'Bob')!;
    const cleoFile = findFileByField(MAIN_BRANCH, AUTHORS_FOLDER, 'name', 'Cleo')!;
    const post1File = findFileByField(MAIN_BRANCH, POSTS_FOLDER, 'title', 'Post 1')!;
    const post3File = findFileByField(MAIN_BRANCH, POSTS_FOLDER, 'title', 'Post 3')!;

    expect(aliceFile).toBeDefined();
    expect(bobFile).toBeDefined();
    expect(cleoFile).toBeDefined();
    expect(post1File).toBeDefined();
    expect(post3File).toBeDefined();

    const aliceRecordId = Number(aliceFile.content['id']);
    const cleoRecordId = Number(cleoFile.content['id']);

    // ── Step 2: Apply edits to dirty branch ──────────────────────────────

    // (a) Create Dave — best_friend_id = Alice's real ID (already indexed),
    //     favorite_post_id as a pseudo-ref to Post1 (resolved at backfill time)
    const davePath = `${AUTHORS_FOLDER}/dave.json`;
    vfs.commitFiles(DIRTY_BRANCH, [
      {
        path: davePath,
        content: JSON.stringify({
          name: 'Dave',
          best_friend_id: aliceRecordId,
          favorite_post_id: `@/${post1File.path}`,
        }),
      },
    ]);

    // (b) Edit Bob — change name, keep best_friend_id as Cleo's real numeric ID.
    //     The plan's Pass 1 will strip it (deleted-record ref stripping),
    //     leaving best_friend_id=null in the final EDIT content. No backfill needed.
    const bobUpdated = {
      ...bobFile.content,
      name: 'Bob Updated',
      best_friend_id: cleoRecordId,
    };
    vfs.commitFiles(DIRTY_BRANCH, [{ path: bobFile.path, content: JSON.stringify(bobUpdated) }]);

    // (c) Delete Cleo from dirty branch
    vfs.deleteFiles(DIRTY_BRANCH, [cleoFile.path]);

    // (d) Create Post4 — author_id as pseudo-ref to Dave (not yet in remote)
    const post4Path = `${POSTS_FOLDER}/post-4.json`;
    vfs.commitFiles(DIRTY_BRANCH, [
      {
        path: post4Path,
        content: JSON.stringify({ title: 'Post 4', author_id: `@/${davePath}` }),
      },
    ]);

    // ── Step 3: Build publish plan ────────────────────────────────────────
    const plan = await publishPlanService.buildPipeline(workbookId, userId, connectorAccountId);
    expect(plan.status).toBe('planned');

    const ops = await prisma.publishPlanOperation.findMany({
      where: { plan: { workbookId } },
      orderBy: [{ phase: 'asc' }, { filePath: 'asc' }],
    });

    // Expect operations in all four relevant phases
    const opsByPhase = new Map<string, typeof ops>();
    for (const op of ops) {
      if (!opsByPhase.has(op.phase)) opsByPhase.set(op.phase, []);
      opsByPhase.get(op.phase)!.push(op);
    }

    // EDIT: Bob (name change) and Post3 (Cleo deleted → author_id stripped)
    const editOps = opsByPhase.get('edit') ?? [];
    expect(editOps.length).toBeGreaterThanOrEqual(2);
    expect(editOps.some((o) => o.filePath === bobFile.path)).toBe(true);
    expect(editOps.some((o) => o.filePath === post3File.path)).toBe(true);

    // CREATE: Dave and Post4
    const createOps = opsByPhase.get('create') ?? [];
    expect(createOps.length).toBeGreaterThanOrEqual(2);
    expect(createOps.some((o) => o.filePath === davePath)).toBe(true);
    expect(createOps.some((o) => o.filePath === post4Path)).toBe(true);

    // DELETE: Cleo
    const deleteOps = opsByPhase.get('delete') ?? [];
    expect(deleteOps.some((o) => o.filePath === cleoFile.path)).toBe(true);

    // BACKFILL: Dave (pseudo-ref for favorite_post_id) and Post4 (pseudo-ref for author_id)
    const backfillOps = opsByPhase.get('backfill') ?? [];
    expect(backfillOps.length).toBeGreaterThanOrEqual(2);
    expect(backfillOps.some((o) => o.filePath === davePath)).toBe(true);
    expect(backfillOps.some((o) => o.filePath === post4Path)).toBe(true);

    // ── Step 4: Run publish ───────────────────────────────────────────────
    const result = await publishRunService.runPipeline(plan.pipelineId);
    expect(result.status).toBe('completed');

    // All operations should have succeeded
    const finalOps = await prisma.publishPlanOperation.findMany({
      where: { plan: { workbookId } },
    });
    for (const op of finalOps) {
      expect(op.status).toBe('success');
    }

    // ── Step 5: Verify final PostgreSQL state ─────────────────────────────
    // The real PostgresConnector wrote to the test tables, so we can query them directly.

    const dbAuthors = await pool.query<{
      id: number;
      name: string;
      best_friend_id: number | null;
      favorite_post_id: number | null;
    }>(`SELECT id, name, best_friend_id, favorite_post_id FROM ${AUTHORS_TABLE} ORDER BY id`);
    const dbPosts = await pool.query<{ id: number; title: string; author_id: number | null }>(
      `SELECT id, title, author_id FROM ${POSTS_TABLE} ORDER BY id`,
    );

    const authorsByName = new Map(dbAuthors.rows.map((r) => [r.name, r]));
    const postsByTitle = new Map(dbPosts.rows.map((r) => [r.title, r]));

    // Cleo is deleted
    expect(authorsByName.has('Cleo')).toBe(false);

    // Dave was created with a real serial ID
    const dave = authorsByName.get('Dave');
    expect(dave).toBeDefined();

    // Dave's best_friend_id = Alice's real ID (passed as a numeric value, not a pseudo-ref)
    expect(dave!.best_friend_id).toBe(aliceRecordId);

    // Dave's favorite_post_id = Post1's real ID (pseudo-ref resolved by backfill)
    const post1RecordId = Number(post1File.content['id']);
    expect(dave!.favorite_post_id).toBe(post1RecordId);

    // Bob's name updated; best_friend_id null (Cleo deleted → ref stripped before publish)
    const bobDb = authorsByName.get('Bob Updated');
    expect(bobDb).toBeDefined();
    expect(bobDb!.best_friend_id).toBeNull();

    // Post4 was created; author_id = Dave's new real ID (pseudo-ref resolved by backfill)
    const post4Db = postsByTitle.get('Post 4');
    expect(post4Db).toBeDefined();
    expect(post4Db!.author_id).toBe(dave!.id);

    // Post3's author_id is null (Cleo deleted → ref stripped before delete phase)
    const post3Db = postsByTitle.get('Post 3');
    expect(post3Db).toBeDefined();
    expect(post3Db!.author_id).toBeNull();

    // ── Step 6: Verify FileIndex updated for new records ──────────────────
    const daveIdx = await prisma.fileIndex.findFirst({
      where: { workbookId, folderPath: AUTHORS_FOLDER, filename: 'dave.json' },
    });
    expect(daveIdx).toBeDefined();
    expect(daveIdx!.recordId).toBe(String(dave!.id));

    const post4Idx = await prisma.fileIndex.findFirst({
      where: { workbookId, folderPath: POSTS_FOLDER, filename: 'post-4.json' },
    });
    expect(post4Idx).toBeDefined();
    expect(post4Idx!.recordId).toBe(String(post4Db!.id));

    // Cleo's FileIndex entry should be gone
    const cleoIdx = await prisma.fileIndex.findFirst({
      where: { workbookId, folderPath: AUTHORS_FOLDER, recordId: cleoFile.content['id']?.toString() },
    });
    expect(cleoIdx).toBeNull();
  });
});
