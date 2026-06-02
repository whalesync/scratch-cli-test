/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/**
 * Postgres incremental-pull integration test (full job pipeline).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * What this validates that the unit tests don't
 * ═══════════════════════════════════════════════════════════════════════════
 * The Postgres connector's incremental SQL is unit-tested with a mocked Knex
 * client (postgres-connector.spec.ts). This test runs the real
 * PullLinkedFolderFilesJobHandler against a real Postgres table and asserts the
 * *job-level* contract end-to-end:
 *
 *   1. A full pull bootstraps the folder: every row's file is committed and
 *      `lastIncrementalPullAt` is set.
 *   2. After one row changes, an incremental pull fetches ONLY that row
 *      (totalFiles === 1, effective mode stays 'incremental' — no demotion),
 *      its file content updates, the others are byte-identical, and the
 *      watermark advances.
 *   3. With the watermark advanced past the changed row, the next incremental
 *      pull fetches NOTHING (totalFiles === 0) and leaves git untouched.
 *
 * It mirrors the fetch-edit-publish harness: real pg.Pool source DB, real
 * Prisma (scratchpad), real services, in-memory VirtualGitFs for the Rust git
 * service, and a mocked ExperimentsService without a PostHog dependency.
 *
 * Run via: cd server && yarn test:integration -- postgres-incremental-pull
 */

import { PrismaClient } from '@prisma/client';
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
import { RefCleanerService } from 'src/publish-plan/ref-cleaner.service';
import { SchemaHelperService } from 'src/publish-plan/schema-helper.service';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { ConnectorsService } from 'src/remote-service/connectors/connectors.service';
import { Service } from 'src/remote-service/connectors/service-constants';
import { MAIN_BRANCH, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { EncryptionService } from 'src/utils/encryption';
import { WorkbookEventService } from 'src/workbook/workbook-event.service';
import {
  PullLinkedFolderFilesJobHandler,
  PullLinkedFolderFilesPublicProgress,
} from 'src/worker/jobs/job-definitions/pull-linked-folder-files.job';
import { VirtualGitFs } from './virtual-git-fs';

const TABLE = 'test_inc_products';
const PRODUCTS_FOLDER = 'products';

// Controlled reference timestamps (UTC). The full pull sets the real watermark;
// we then overwrite lastIncrementalPullAt with these fixed values so the
// incremental window is exact and the test needs no clock-skew sleep.
const WATERMARK_1 = new Date('2026-06-01T00:00:00.000Z'); // since for incremental #1
const EDITED_ROW_TS = new Date('2026-06-01T01:00:00.000Z'); // after WATERMARK_1
const WATERMARK_2 = new Date('2026-06-01T02:00:00.000Z'); // past EDITED_ROW_TS + 60s skew
const OLD_TS = new Date('2020-01-01T00:00:00.000Z'); // un-edited rows: well outside any window

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

describe('Postgres incremental pull — full bootstrap → incremental → no-op', () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let encryptionService: EncryptionService;

  let workbookId: WorkbookId;
  let orgId: string;
  let userId: string;
  let productsFolderId: DataFolderId;
  let connectorAccountId: string;

  let pullHandler: PullLinkedFolderFilesJobHandler;
  let vfs: VirtualGitFs;

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

  beforeEach(async () => {
    // ── Clean leftover state ─────────────────────────────────────────────────
    await pool.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    if (workbookId) {
      await prisma.fileReference.deleteMany({ where: { workbookId } });
      await prisma.fileIndex.deleteMany({ where: { workbookId } });
      await prisma.dataFolder.deleteMany({ where: { workbookId } });
      await prisma.connectorAccount.deleteMany({ where: { workbookId } });
      await prisma.workbook.delete({ where: { id: workbookId } }).catch(() => {});
    }
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});

    // ── Source table + 3 rows, all backdated to OLD_TS ───────────────────────
    await pool.query(`
      CREATE TABLE ${TABLE} (
        product_id SERIAL PRIMARY KEY,
        name       TEXT NOT NULL,
        price      NUMERIC(10,2) NOT NULL DEFAULT 0,
        category   TEXT NOT NULL DEFAULT 'uncategorized',
        updated_dt TIMESTAMPTZ NOT NULL
      )
    `);
    await pool.query(
      `INSERT INTO ${TABLE} (name, price, category, updated_dt) VALUES
         ('Aluminum Water Bottle', 24.99, 'drinkware',   $1),
         ('Organic Cotton T-Shirt', 19.50, 'apparel',    $1),
         ('Wireless Charging Pad',  39.95, 'electronics', $1)`,
      [OLD_TS.toISOString()],
    );

    // ── Scratch org / user / workbook ────────────────────────────────────────
    const ts = Date.now();
    const org = await prisma.organization.create({
      data: { id: `org_inc_${ts}`, name: 'Inc Test Org', clerkId: `clerk_inc_${ts}` },
    });
    orgId = org.id;
    const user = await prisma.user.create({
      data: { id: `user_inc_${ts}`, email: `inc-${ts}@example.com`, organizationId: org.id },
    });
    userId = user.id;
    workbookId = createWorkbookId();
    await prisma.workbook.create({
      data: { id: workbookId, name: 'Inc Test Workbook', userId: user.id, organizationId: org.id },
    });

    // ── ConnectorAccount (encrypted PG creds) ────────────────────────────────
    const dbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/scratchpad?schema=public';
    const encryptedCreds = await encryptionService.encryptObject({ connectionString: dbUrl });
    connectorAccountId = createConnectorAccountId();
    await prisma.connectorAccount.create({
      data: {
        id: connectorAccountId,
        workbookId,
        service: Service.POSTGRES,
        displayName: 'Inc Test PostgreSQL',
        authType: AuthType.USER_PROVIDED_PARAMS,
        encryptedCredentials: encryptedCreds as unknown as any,
      },
    });

    // ── DataFolder with updated_dt declared as the last-modified field ───────
    productsFolderId = createDataFolderId();
    await prisma.dataFolder.create({
      data: {
        id: productsFolderId,
        name: 'Products',
        path: `/${PRODUCTS_FOLDER}`,
        workbookId,
        connectorAccountId,
        connectorService: Service.POSTGRES,
        tableId: ['public', TABLE],
        options: { modifiedAtField: 'updated_dt' },
      },
    });

    // ── VirtualGitFs + ScratchGitService mock (in-memory two-phase staging) ──
    vfs = new VirtualGitFs();
    const stagingStore = new Map<string, Map<string, string>>();
    const processedPaths = new Map<string, Set<string>>();
    const committedPaths = new Map<string, Set<string>>();

    const mockScratchGitService = {
      initRepo: jest.fn().mockResolvedValue(undefined),
      resolveRepoId: jest.fn().mockImplementation(async (wkbId: WorkbookId) => wkbId),
      resolveConnectionRepoPath: jest.fn().mockImplementation(async (caId: string) => caId),
      rebaseDirty: jest.fn().mockImplementation(async () => vfs.rebaseDirty()),
      listRepoFiles: jest
        .fn()
        .mockImplementation(async (_r: string, branch: string, folderPath: string) =>
          vfs.listFiles(branch, folderPath),
        ),
      deleteFilesFromBranch: jest
        .fn()
        .mockImplementation(async (_r: string, branch: string, paths: string[]) => vfs.deleteFiles(branch, paths)),
      runGitGc: jest.fn().mockResolvedValue(undefined),
      readSchemaFromGit: jest.fn().mockResolvedValue(null),
      writeSchemaToGit: jest.fn().mockResolvedValue(undefined),
      writeViewToGit: jest.fn().mockResolvedValue(undefined),
      buildIndex: jest.fn().mockResolvedValue({ count: 0 }),
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
        for (const [p, content] of store) {
          if (processed.has(p)) continue;
          files.push({ path: p, content });
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
            _repoId: string,
            branch: string,
            folder: string,
            _message: string,
            batchSize: number,
          ) => {
            const key = `${jobId}/${folder}`;
            const store = stagingStore.get(key) ?? new Map<string, string>();
            const committed = committedPaths.get(key) ?? new Set<string>();
            const filesToCommit: { path: string; content: string }[] = [];
            for (const [p, content] of store) {
              if (committed.has(p)) continue;
              filesToCommit.push({ path: `${folder}/${p}`, content });
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

    // ── Wire services (real connector + index; mocks elsewhere) ──────────────
    const dbService = makeDbService(prisma);
    const realConnectorsService = new ConnectorsService({} as any, {} as any, {} as any);
    const credentialEncryptionService = new CredentialEncryptionService();
    const fileIndexService = new FileIndexService(dbService);
    const refCleanerService = new RefCleanerService();
    const schemaHelperService = new SchemaHelperService(
      dbService,
      mockScratchGitService,
      realConnectorsService,
      credentialEncryptionService,
    );
    const fileReferenceService = new FileReferenceService(dbService, refCleanerService, schemaHelperService);

    const mockConnectorAccountService = {
      findOneById: jest.fn().mockImplementation(async (id: string) => {
        const account = await prisma.connectorAccount.findUnique({ where: { id } });
        if (!account) return null;
        const creds = await encryptionService.decryptObject(account.encryptedCredentials as any);
        return { ...account, ...creds };
      }),
    } as unknown as ConnectorAccountService;

    const mockWorkbookEventService = { sendWorkbookEvent: jest.fn() } as unknown as WorkbookEventService;
    const mockAssetExtractorService = {
      extractAssets: jest.fn().mockReturnValue([]),
    } as unknown as AssetExtractorService;
    const mockAssetIndexService = {
      upsertBatch: jest.fn().mockResolvedValue(undefined),
    } as unknown as AssetIndexService;
    const mockPostHogService = { trackPullCompleted: jest.fn() } as unknown as PostHogService;

    const mockExperimentsService = {
      isGenericConnectorEnabledForUser: jest.fn().mockResolvedValue(true),
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
  });

  afterEach(async () => {
    if (process.env.SKIP_CLEANUP === '1') return;
    await pool.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    if (workbookId) {
      await prisma.fileReference.deleteMany({ where: { workbookId } });
      await prisma.fileIndex.deleteMany({ where: { workbookId } });
      await prisma.dataFolder.deleteMany({ where: { workbookId } });
      await prisma.connectorAccount.deleteMany({ where: { workbookId } });
      await prisma.workbook.delete({ where: { id: workbookId } });
    }
    if (userId) await prisma.user.delete({ where: { id: userId } });
    if (orgId) await prisma.organization.delete({ where: { id: orgId } });
  });

  /**
   * Run the pull handler for the products folder and return the final
   * publicProgress (the handler mutates one object across the run; the
   * capturing checkpoint records the latest reference).
   */
  async function pull(jobId: string, pullMode: 'full' | 'incremental'): Promise<PullLinkedFolderFilesPublicProgress> {
    let latest: PullLinkedFolderFilesPublicProgress | undefined;
    await pullHandler.run({
      jobId,
      data: {
        type: 'pull-linked-folder-files',
        workbookId,
        dataFolderIds: [productsFolderId],
        userId,
        organizationId: orgId,
        pullMode,
      },
      progress: makeNoopProgress(),
      abortSignal: new AbortController().signal,
      checkpoint: async (p: any) => {
        if (p?.publicProgress) latest = p.publicProgress as PullLinkedFolderFilesPublicProgress;
      },
    });
    if (!latest) throw new Error('pull produced no publicProgress');
    return latest;
  }

  function productFiles(): { path: string; content: string }[] {
    return vfs.getFilesByFolder(MAIN_BRANCH, PRODUCTS_FOLDER).sort((a, b) => a.path.localeCompare(b.path));
  }

  it('bootstraps with a full pull, then incremental fetches only the changed row, then nothing', async () => {
    jest.setTimeout(60_000);

    // ── 1. Full pull bootstraps the folder ───────────────────────────────────
    const fullProgress = await pull('job-full', 'full');
    expect(fullProgress.mode).toBe('full');
    expect(fullProgress.totalFiles).toBe(3);

    const afterFull = productFiles();
    expect(afterFull).toHaveLength(3);

    let folder = await prisma.dataFolder.findUniqueOrThrow({ where: { id: productsFolderId } });
    expect(folder.lastFullPullAt).not.toBeNull();
    // A full scan is a superset of incremental, so it advances the watermark
    // too — this is what lets the *first* incremental run not demote as a
    // bootstrap.
    expect(folder.lastIncrementalPullAt).not.toBeNull();

    // ── 2. Change exactly one row, then pin the watermark for an exact window ─
    const edited = await pool.query(
      `UPDATE ${TABLE} SET price = 99.99, updated_dt = $1 WHERE name = 'Aluminum Water Bottle' RETURNING product_id`,
      [EDITED_ROW_TS.toISOString()],
    );
    expect(edited.rowCount).toBe(1);

    // Overwrite the real full-pull watermark with a fixed value so the
    // incremental predicate window is deterministic (no clock-skew sleep):
    //   WHERE updated_dt > (WATERMARK_1 - 60s)
    // edited row (WATERMARK_1 + 1h) matches; the two OLD_TS rows do not.
    await prisma.dataFolder.update({
      where: { id: productsFolderId },
      data: { lastIncrementalPullAt: WATERMARK_1 },
    });

    // ── 3. Incremental pull — only the edited row comes back ─────────────────
    // Bracket the call with real wall-clock so we can assert the connector's
    // watermark capture (`new Date()` before its first query) lands in-window.
    // The pinned WATERMARK_1 is a fabricated future date used only to size the
    // SQL predicate; the persisted watermark is real-now, so it must be
    // compared against real time, not the pin.
    const tBefore = Date.now();
    const incProgress = await pull('job-inc-1', 'incremental');
    const tAfter = Date.now();
    // If the kill switch / capability check had demoted this, mode would be
    // 'full' and totalFiles 3. Asserting both pins the real incremental path.
    expect(incProgress.mode).toBe('incremental');
    expect(incProgress.totalFiles).toBe(1);

    const afterInc = productFiles();
    expect(afterInc).toHaveLength(3); // incremental never deletes; all 3 files remain

    const byPath = (files: { path: string; content: string }[]) => new Map(files.map((f) => [f.path, f.content]));
    const beforeMap = byPath(afterFull);
    const afterMap = byPath(afterInc);

    const changed = [...afterMap.keys()].filter((p) => afterMap.get(p) !== beforeMap.get(p));
    expect(changed).toHaveLength(1);
    const changedRecord = JSON.parse(afterMap.get(changed[0])!) as Record<string, unknown>;
    expect(changedRecord.name).toBe('Aluminum Water Bottle');
    expect(Number(changedRecord.price)).toBe(99.99);

    folder = await prisma.dataFolder.findUniqueOrThrow({ where: { id: productsFolderId } });
    // Watermark advanced off the pinned value to the connector's real-clock
    // capture, which must fall within the bracket around the pull (±1s slack
    // for Date vs Date.now rounding).
    const persistedWm = folder.lastIncrementalPullAt!.getTime();
    expect(persistedWm).not.toBe(WATERMARK_1.getTime());
    expect(persistedWm).toBeGreaterThanOrEqual(tBefore - 1000);
    expect(persistedWm).toBeLessThanOrEqual(tAfter + 1000);

    // ── 4. Advance the watermark past the edited row → next pull is a no-op ──
    await prisma.dataFolder.update({
      where: { id: productsFolderId },
      data: { lastIncrementalPullAt: WATERMARK_2 }, // > EDITED_ROW_TS + 60s skew
    });

    const noopProgress = await pull('job-inc-2', 'incremental');
    expect(noopProgress.mode).toBe('incremental');
    expect(noopProgress.totalFiles).toBe(0);

    // Git is untouched: every file byte-identical to after incremental #1.
    const afterNoop = byPath(productFiles());
    expect(afterNoop.size).toBe(afterMap.size);
    for (const [p, content] of afterMap) expect(afterNoop.get(p)).toBe(content);
  });
});
