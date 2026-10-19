/**
 * MySQL incremental pull through the real pull job (DEV-12035) — the MySQL twin of postgres-incremental-pull.spec.ts.
 *
 * The connector's incremental predicate is unit-tested with a mocked knex (`library/mysql/__tests__`). This spec runs
 * the real `PullLinkedFolderFilesJobHandler` against a real MySQL 8.4 / MariaDB 11.4 table and asserts the JOB-level
 * contract end to end, for both kinds of modified-at column the connector accepts:
 *   - `TIMESTAMP(3) … ON UPDATE CURRENT_TIMESTAMP(3)` (MySQL bumps it; compared as an instant);
 *   - `DATETIME(3)` written in UTC by the application (compared as UTC wall clock — the documented assumption).
 *
 *   1. A full pull bootstraps the folder: every row's file is committed and both watermarks are set.
 *   2. After one row changes (via the admin connection, as the customer's application would), an incremental pull
 *      fetches ONLY that row (mode stays 'incremental'), the other files stay byte-identical, and the persisted
 *      watermark is the connector's own clock reading taken BEFORE the first query (so a row changed mid-pull is
 *      re-pulled next time), not the previous pinned value.
 *   3. With the watermark past the change, the next incremental pull fetches nothing and leaves git untouched.
 *   4. The 60-second clock-skew overlap: with the watermark at W, rows modified at W−30s and W−60s+1ms are re-pulled,
 *      rows at exactly W−60s (the bound is exclusive) and W−90s are not.
 *   5. A typo'd (or non-time) `modifiedAtField` fails the incremental pull fast with a friendly message listing the
 *      usable columns, stages no files and leaves the watermark alone.
 *
 * Harness (cloned from the Postgres spec): real Prisma against the app Postgres (DATABASE_URL, default
 * postgresql://postgres:postgres@localhost:5432/scratchpad), an encrypted ConnectorAccount holding the DISCRETE MySQL
 * keys (never a connection string), real ConnectorsService / FileIndexService / FileReferenceService, an in-memory
 * VirtualGitFs standing in for scratch-git, and mocks for events, assets and analytics. Every Prisma row a test
 * creates is deleted in afterEach; MySQL tables are `scratch_mysql_it_incremental_*`, dropped in beforeAll / afterAll
 * (`SKIP_CLEANUP=1` keeps both for inspection).
 *
 * Run (from server/, with server/localdev/docker-compose.mysql.yml and the app Postgres up):
 *   MYSQL_TEST_URL=mysql://test:test@127.0.0.1:3306/test_db MYSQL_TEST_ROOT_URL=mysql://root:root@127.0.0.1:3306/test_db \
 *   MARIADB_TEST_URL=mysql://test:test@127.0.0.1:3307/test_db MARIADB_TEST_ROOT_URL=mysql://root:root@127.0.0.1:3307/test_db \
 *   yarn test:integration test/integration/mysql-incremental-pull --runInBand
 */
import { PrismaClient } from '@prisma/client';
import {
  AuthType,
  createConnectorAccountId,
  createDataFolderId,
  createWorkbookId,
  type DataFolderId,
  type PullLinkedFolderFilesPublicProgress,
  type WorkbookId,
} from '@spinner/shared-types';
import type mysql2Promise from 'mysql2/promise';
import { type AssetExtractorService } from 'src/asset/asset-extractor.service';
import { type AssetIndexService } from 'src/asset/asset-index.service';
import { CredentialEncryptionService } from 'src/credential-encryption/credential-encryption.service';
import { type ExperimentsService } from 'src/experiments/experiments.service';
import { type OAuthService } from 'src/oauth/oauth.service';
import { type PostHogService } from 'src/posthog/posthog.service';
import { FileIndexService } from 'src/publish-plan/file-index.service';
import { FileReferenceService } from 'src/publish-plan/file-reference.service';
import { RefCleanerService } from 'src/publish-plan/ref-cleaner.service';
import { SchemaHelperService } from 'src/publish-plan/schema-helper.service';
import { type RateLimiterFactory } from 'src/rate-limiter/rate-limiter-factory.service';
import { type ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { ConnectorsService } from 'src/remote-service/connectors/connectors.service';
import { PG_INCREMENTAL_CLOCK_SKEW_MS } from 'src/remote-service/connectors/library/pg-common/pg-incremental';
import { Service } from 'src/remote-service/connectors/service-constants';
import { MAIN_BRANCH, type ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { EncryptionService, type EncryptedData } from 'src/utils/encryption';
import { type WorkbookEventService } from 'src/workbook/workbook-event.service';
import { PullLinkedFolderFilesJobHandler } from 'src/worker/jobs/job-definitions/pull-linked-folder-files.job';
import { createIntegrationTestDbService } from './integration-db-service';
import {
  buildMySqlConnectorCredentialsForIntegrationTest,
  describeForEachConfiguredMySqlIntegrationFlavor,
  dropAllMySqlIntegrationTables,
  MYSQL_INTEGRATION_IDENTIFIER_PREFIX,
  openMySqlAdminConnection,
  waitForMySqlServerToAcceptConnections,
} from './mysql-integration-helpers';
import { VirtualGitFs } from './virtual-git-fs';

jest.setTimeout(60_000);

const WAIT_FOR_MYSQL_SERVER_HOOK_TIMEOUT_MILLISECONDS = 120_000;
const PRODUCTS_FOLDER_NAME_IN_GIT = 'products';
const MODIFIED_AT_COLUMN_NAME = 'updated_at';

/** Un-edited rows: far outside any incremental window. */
const OLD_MODIFIED_AT_INSTANT = new Date('2020-01-01T00:00:00.000Z');
/** A fixed watermark for the clock-skew boundary test (inside TIMESTAMP's 1970–2038 range). */
const PINNED_WATERMARK_FOR_CLOCK_SKEW_BOUNDARY = new Date('2026-06-01T02:00:00.000Z');

type PullJobRunParameters = Parameters<PullLinkedFolderFilesJobHandler['run']>[0];

/** `2026-06-01 01:59:30.000`: an instant as the UTC wall-clock text MySQL prints for DATETIME(3) / TIMESTAMP(3). */
function formatInstantAsUtcWallClockMillisecondsText(instant: Date): string {
  return instant.toISOString().replace('T', ' ').replace('Z', '');
}

function parseUtcWallClockMillisecondsText(utcWallClockText: string): Date {
  return new Date(`${utcWallClockText.replace(' ', 'T')}Z`);
}

interface MySqlModifiedAtColumnVariant {
  readonly variantName: string;
  readonly tableNameSuffix: string;
  readonly modifiedAtColumnDefinition: string;
  /** What the customer's application adds to an UPDATE to mark the row changed; '' when MySQL does it itself. */
  readonly modifiedAtAssignmentWhenTheApplicationEditsARow: string;
  /** How a pulled record file renders this column's value (TIMESTAMP → RFC 3339 UTC, DATETIME → verbatim). */
  readonly renderPulledModifiedAtValue: (instant: Date) => string;
}

const MYSQL_MODIFIED_AT_COLUMN_VARIANTS: readonly MySqlModifiedAtColumnVariant[] = [
  {
    variantName: 'TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)',
    tableNameSuffix: 'timestamp',
    modifiedAtColumnDefinition: 'TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)',
    modifiedAtAssignmentWhenTheApplicationEditsARow: '',
    renderPulledModifiedAtValue: (instant) => instant.toISOString(),
  },
  {
    variantName: 'DATETIME(3) written in UTC',
    tableNameSuffix: 'datetime',
    modifiedAtColumnDefinition: 'DATETIME(3) NOT NULL',
    modifiedAtAssignmentWhenTheApplicationEditsARow: `, ${MODIFIED_AT_COLUMN_NAME} = UTC_TIMESTAMP(3)`,
    renderPulledModifiedAtValue: formatInstantAsUtcWallClockMillisecondsText,
  },
];

function buildIncrementalSpecTableName(tableNameSuffix: string): string {
  return `${MYSQL_INTEGRATION_IDENTIFIER_PREFIX}incremental_${tableNameSuffix}`;
}

function buildInitialPullJobProgress(): PullJobRunParameters['progress'] {
  return {
    publicProgress: {
      totalFiles: 0,
      folderCount: 1,
      connectionName: '',
      folderId: '',
      folderName: '',
      connector: Service.MYSQL,
      filter: null,
      status: 'pending',
      createdPaths: [],
      updatedPaths: [],
      deletedPaths: [],
      createdCount: 0,
      updatedCount: 0,
      deletedCount: 0,
      folders: [],
    },
    jobProgress: {},
    connectorProgress: {},
    timestamp: Date.now(),
  };
}

function mapRecordFilesByPath(recordFiles: { path: string; content: string }[]): Map<string, string> {
  return new Map(recordFiles.map((recordFile) => [recordFile.path, recordFile.content]));
}

function parseRecordFileContent(recordFileContent: string | undefined): Record<string, unknown> {
  if (recordFileContent === undefined) throw new Error('record file missing');
  return JSON.parse(recordFileContent) as Record<string, unknown>;
}

/** The `name` of every record whose file content differs between two snapshots of the folder, sorted. */
function listNamesOfRecordsWhoseFilesChanged(
  recordFileContentByPathBefore: Map<string, string>,
  recordFileContentByPathAfter: Map<string, string>,
): string[] {
  return [...recordFileContentByPathAfter.keys()]
    .filter(
      (recordFilePath) =>
        recordFileContentByPathAfter.get(recordFilePath) !== recordFileContentByPathBefore.get(recordFilePath),
    )
    .map((recordFilePath) => String(parseRecordFileContent(recordFileContentByPathAfter.get(recordFilePath)).name))
    .sort();
}

describeForEachConfiguredMySqlIntegrationFlavor('MySQL incremental pull through the pull job', (flavor) => {
  const databaseName = flavor.applicationUserServerAddress.databaseName;
  let adminConnection: mysql2Promise.Connection;
  let prisma: PrismaClient;
  let encryptionService: EncryptionService;

  /** Prisma rows the running test created (deleted in afterEach). */
  let scratchFixtureIdsForCurrentTest:
    | {
        organizationId: string;
        userId: string;
        workbookId: WorkbookId;
        connectorAccountId: string;
        productsDataFolderId: DataFolderId;
      }
    | undefined;
  let pullJobHandler: PullLinkedFolderFilesJobHandler;
  let virtualGitFs: VirtualGitFs;
  /** When scratch-git first received staged files for each job id: the first page arrived after the first query. */
  let firstStageFilesCallMillisecondsByJobId: Map<string, number>;

  beforeAll(async () => {
    await waitForMySqlServerToAcceptConnections(flavor.rootUserServerAddress);
    adminConnection = await openMySqlAdminConnection(flavor.rootUserServerAddress);
    await dropAllMySqlIntegrationTables(adminConnection, databaseName);
    prisma = new PrismaClient();
    const encryptionMasterKey = process.env.ENCRYPTION_MASTER_KEY ?? 'test-master-key-at-least-32-chars-long!!';
    encryptionService = new EncryptionService(encryptionMasterKey);
    process.env.ENCRYPTION_MASTER_KEY = encryptionMasterKey;
  }, WAIT_FOR_MYSQL_SERVER_HOOK_TIMEOUT_MILLISECONDS);

  afterAll(async () => {
    if (adminConnection) {
      if (process.env.SKIP_CLEANUP !== '1') {
        await dropAllMySqlIntegrationTables(adminConnection, databaseName);
      }
      await adminConnection.end();
    }
    if (prisma) await prisma.$disconnect();
  });

  afterEach(async () => {
    const scratchFixtureIds = scratchFixtureIdsForCurrentTest;
    scratchFixtureIdsForCurrentTest = undefined;
    if (!scratchFixtureIds || process.env.SKIP_CLEANUP === '1') return;
    const { workbookId, userId, organizationId } = scratchFixtureIds;
    await prisma.fileReference.deleteMany({ where: { workbookId } });
    await prisma.fileIndex.deleteMany({ where: { workbookId } });
    await prisma.dataFolder.deleteMany({ where: { workbookId } });
    await prisma.connectorAccount.deleteMany({ where: { workbookId } });
    await prisma.workbook.delete({ where: { id: workbookId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.organization.delete({ where: { id: organizationId } });
  });

  // ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────

  /** A products table on the MySQL server, every row last modified at {@link OLD_MODIFIED_AT_INSTANT}. */
  async function createProductsTableAsAdmin(
    tableName: string,
    modifiedAtColumnDefinition: string,
    productNames: readonly string[],
  ): Promise<void> {
    await adminConnection.query('DROP TABLE IF EXISTS ??.??', [databaseName, tableName]);
    await adminConnection.query(
      `CREATE TABLE ??.?? (
         product_id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
         name VARCHAR(100) NOT NULL,
         price DECIMAL(10,2) NOT NULL DEFAULT 0,
         ${MODIFIED_AT_COLUMN_NAME} ${modifiedAtColumnDefinition}
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      [databaseName, tableName],
    );
    for (const [productIndex, productName] of productNames.entries()) {
      await adminConnection.query(`INSERT INTO ??.?? (name, price, ${MODIFIED_AT_COLUMN_NAME}) VALUES (?, ?, ?)`, [
        databaseName,
        tableName,
        productName,
        `${10 + productIndex}.50`,
        formatInstantAsUtcWallClockMillisecondsText(OLD_MODIFIED_AT_INSTANT),
      ]);
    }
  }

  async function readStoredModifiedAtOfProductAsAdmin(tableName: string, productName: string): Promise<string> {
    const [storedRows] = await adminConnection.query<mysql2Promise.RowDataPacket[]>(
      `SELECT ${MODIFIED_AT_COLUMN_NAME} AS modified_at FROM ??.?? WHERE name = ?`,
      [databaseName, tableName, productName],
    );
    return String(storedRows[0]?.modified_at);
  }

  /**
   * Org / user / workbook, a MySQL ConnectorAccount holding the encrypted DISCRETE keys, a products DataFolder
   * (`tableId` = `[database, table]`, `options.modifiedAtField`), and a fresh pull job wired to a VirtualGitFs.
   */
  async function setUpScratchWorkbookWithMySqlProductsFolder(
    tableName: string,
    modifiedAtField: string,
  ): Promise<{ productsDataFolderId: DataFolderId }> {
    const uniqueFixtureSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const organization = await prisma.organization.create({
      data: {
        id: `org_mysql_inc_${uniqueFixtureSuffix}`,
        name: 'MySQL Incremental Test Org',
        clerkId: `clerk_mysql_inc_${uniqueFixtureSuffix}`,
      },
    });
    const user = await prisma.user.create({
      data: {
        id: `user_mysql_inc_${uniqueFixtureSuffix}`,
        email: `mysql-inc-${uniqueFixtureSuffix}@example.com`,
        organizationId: organization.id,
      },
    });
    const workbookId = createWorkbookId();
    await prisma.workbook.create({
      data: {
        id: workbookId,
        name: 'MySQL Incremental Test Workbook',
        userId: user.id,
        organizationId: organization.id,
      },
    });
    // Track before creating anything that could fail, so afterEach still removes what was created.
    const connectorAccountId = createConnectorAccountId();
    const productsDataFolderId = createDataFolderId();
    scratchFixtureIdsForCurrentTest = {
      organizationId: organization.id,
      userId: user.id,
      workbookId,
      connectorAccountId,
      productsDataFolderId,
    };

    const discreteMySqlCredentials = buildMySqlConnectorCredentialsForIntegrationTest(
      flavor.applicationUserServerAddress,
    );
    expect(discreteMySqlCredentials).not.toHaveProperty('connectionString');
    const encryptedDiscreteMySqlCredentials: EncryptedData =
      await encryptionService.encryptObject(discreteMySqlCredentials);
    await prisma.connectorAccount.create({
      data: {
        id: connectorAccountId,
        workbookId,
        service: Service.MYSQL,
        displayName: `Incremental Test ${flavor.flavorName}`,
        authType: AuthType.USER_PROVIDED_PARAMS,
        encryptedCredentials: encryptedDiscreteMySqlCredentials,
      },
    });
    await prisma.dataFolder.create({
      data: {
        id: productsDataFolderId,
        name: 'Products',
        path: `/${PRODUCTS_FOLDER_NAME_IN_GIT}`,
        workbookId,
        connectorAccountId,
        connectorService: Service.MYSQL,
        tableId: [databaseName, tableName],
        options: { modifiedAtField },
      },
    });

    wireFreshPullJobHandler();
    return { productsDataFolderId };
  }

  /** The Postgres spec's harness: real connector + index services, in-memory two-phase git staging, other mocks. */
  function wireFreshPullJobHandler(): void {
    virtualGitFs = new VirtualGitFs();
    firstStageFilesCallMillisecondsByJobId = new Map();
    const stagedFileContentByPathByStagingKey = new Map<string, Map<string, string>>();
    const processedStagedPathsByStagingKey = new Map<string, Set<string>>();
    const committedStagedPathsByStagingKey = new Map<string, Set<string>>();
    const getOrCreate = <TValue>(map: Map<string, TValue>, key: string, create: () => TValue): TValue => {
      const existingValue = map.get(key);
      if (existingValue !== undefined) return existingValue;
      const createdValue = create();
      map.set(key, createdValue);
      return createdValue;
    };

    const scratchGitServiceDouble = {
      initRepo: jest.fn().mockResolvedValue(undefined),
      resolveRepoId: jest.fn().mockImplementation((repoWorkbookId: WorkbookId) => Promise.resolve(repoWorkbookId)),
      resolveConnectionRepoPath: jest
        .fn()
        .mockImplementation((repoConnectorAccountId: string) => Promise.resolve(repoConnectorAccountId)),
      rebaseDirty: jest.fn().mockImplementation(() => Promise.resolve(virtualGitFs.rebaseDirty())),
      listRepoFiles: jest
        .fn()
        .mockImplementation((_repoId: string, branch: string, folderPath: string) =>
          Promise.resolve(virtualGitFs.listFiles(branch, folderPath)),
        ),
      deleteFilesFromBranch: jest
        .fn()
        .mockImplementation((_repoId: string, branch: string, filePaths: string[]) =>
          Promise.resolve(virtualGitFs.deleteFiles(branch, filePaths)),
        ),
      runGitGc: jest.fn().mockResolvedValue(undefined),
      readSchemaFromGit: jest.fn().mockResolvedValue(null),
      writeSchemaToGit: jest.fn().mockResolvedValue(undefined),
      writeViewToGit: jest.fn().mockResolvedValue(undefined),
      buildIndex: jest.fn().mockResolvedValue({ count: 0 }),
      countRecordFilesByFolder: jest.fn().mockResolvedValue(new Map<string, number>()),
      stageFiles: jest
        .fn()
        .mockImplementation((jobId: string, folder: string, filesToStage: { path: string; content: string }[]) => {
          if (!firstStageFilesCallMillisecondsByJobId.has(jobId)) {
            firstStageFilesCallMillisecondsByJobId.set(jobId, Date.now());
          }
          const stagedFileContentByPath = getOrCreate(
            stagedFileContentByPathByStagingKey,
            `${jobId}/${folder}`,
            () => new Map<string, string>(),
          );
          for (const fileToStage of filesToStage) stagedFileContentByPath.set(fileToStage.path, fileToStage.content);
          return Promise.resolve();
        }),
      readStagedFiles: jest.fn().mockImplementation((jobId: string, folder: string, batchSize: number) => {
        const stagingKey = `${jobId}/${folder}`;
        const stagedFileContentByPath =
          stagedFileContentByPathByStagingKey.get(stagingKey) ?? new Map<string, string>();
        const processedStagedPaths = processedStagedPathsByStagingKey.get(stagingKey) ?? new Set<string>();
        const unprocessedStagedFiles: { path: string; content: string }[] = [];
        for (const [stagedPath, stagedContent] of stagedFileContentByPath) {
          if (processedStagedPaths.has(stagedPath)) continue;
          unprocessedStagedFiles.push({ path: stagedPath, content: stagedContent });
          if (unprocessedStagedFiles.length >= batchSize) break;
        }
        return Promise.resolve({ files: unprocessedStagedFiles });
      }),
      markStagedFilesProcessed: jest
        .fn()
        .mockImplementation((jobId: string, folder: string, processedPaths: string[]) => {
          const processedStagedPaths = getOrCreate(
            processedStagedPathsByStagingKey,
            `${jobId}/${folder}`,
            () => new Set<string>(),
          );
          for (const processedPath of processedPaths) processedStagedPaths.add(processedPath);
          return Promise.resolve();
        }),
      commitStagedFiles: jest
        .fn()
        .mockImplementation(
          (jobId: string, _repoId: string, branch: string, folder: string, _message: string, batchSize: number) => {
            const stagingKey = `${jobId}/${folder}`;
            const stagedFileContentByPath =
              stagedFileContentByPathByStagingKey.get(stagingKey) ?? new Map<string, string>();
            const committedStagedPaths = getOrCreate(
              committedStagedPathsByStagingKey,
              stagingKey,
              () => new Set<string>(),
            );
            const filesToCommit: { path: string; content: string }[] = [];
            for (const [stagedPath, stagedContent] of stagedFileContentByPath) {
              if (committedStagedPaths.has(stagedPath)) continue;
              filesToCommit.push({ path: `${folder}/${stagedPath}`, content: stagedContent });
              if (filesToCommit.length >= batchSize) break;
            }
            if (filesToCommit.length > 0) {
              virtualGitFs.commitFiles(branch, filesToCommit);
              for (const committedFile of filesToCommit) {
                committedStagedPaths.add(committedFile.path.slice(folder.length + 1));
              }
            }
            return Promise.resolve({
              committed: filesToCommit.length,
              created: filesToCommit.map((committedFile) => committedFile.path),
              updated: [],
            });
          },
        ),
      cleanupStaging: jest.fn().mockImplementation((jobId: string) => {
        for (const stagingKey of [...stagedFileContentByPathByStagingKey.keys()]) {
          if (!stagingKey.startsWith(`${jobId}/`)) continue;
          stagedFileContentByPathByStagingKey.delete(stagingKey);
          processedStagedPathsByStagingKey.delete(stagingKey);
          committedStagedPathsByStagingKey.delete(stagingKey);
        }
        return Promise.resolve();
      }),
    } as unknown as ScratchGitService;

    const dbService = createIntegrationTestDbService(prisma);
    const realConnectorsService = new ConnectorsService(
      {} as unknown as OAuthService,
      {} as unknown as RateLimiterFactory,
      dbService,
      {} as unknown as ExperimentsService,
    );
    const schemaHelperService = new SchemaHelperService(
      dbService,
      scratchGitServiceDouble,
      realConnectorsService,
      new CredentialEncryptionService(),
    );
    const fileReferenceService = new FileReferenceService(dbService, new RefCleanerService(), schemaHelperService);
    const connectorAccountServiceDouble = {
      findOneByIdUnscoped: jest.fn().mockImplementation(async (connectorAccountId: string) => {
        const connectorAccount = await prisma.connectorAccount.findUnique({ where: { id: connectorAccountId } });
        if (!connectorAccount) return null;
        const decryptedCredentials = await encryptionService.decryptObject(
          connectorAccount.encryptedCredentials as EncryptedData,
        );
        // Same shape as the real service: the account row spread with its decrypted credentials.
        return { ...connectorAccount, ...decryptedCredentials };
      }),
    } as unknown as ConnectorAccountService;

    pullJobHandler = new PullLinkedFolderFilesJobHandler(
      prisma,
      realConnectorsService,
      connectorAccountServiceDouble,
      { sendWorkbookEvent: jest.fn() } as unknown as WorkbookEventService,
      scratchGitServiceDouble,
      new FileIndexService(dbService),
      fileReferenceService,
      { extractAssets: jest.fn().mockReturnValue([]) } as unknown as AssetExtractorService,
      { upsertBatch: jest.fn().mockResolvedValue(undefined) } as unknown as AssetIndexService,
      { trackPullCompleted: jest.fn() } as unknown as PostHogService,
      { isGenericConnectorEnabledForUser: jest.fn().mockResolvedValue(true) } as unknown as ExperimentsService,
    );
  }

  /** Run the pull job for the products folder; returns the terminal publicProgress checkpoint. */
  async function runProductsPullJob(
    jobId: string,
    pullMode: 'full' | 'incremental',
  ): Promise<PullLinkedFolderFilesPublicProgress> {
    const scratchFixtureIds = scratchFixtureIdsForCurrentTest;
    if (!scratchFixtureIds) throw new Error('set up the Scratch workbook fixture first');
    let latestPublicProgress: PullLinkedFolderFilesPublicProgress | undefined;
    await pullJobHandler.run({
      jobId,
      data: {
        type: 'pull-linked-folder-files',
        workbookId: scratchFixtureIds.workbookId,
        dataFolderIds: [scratchFixtureIds.productsDataFolderId],
        userId: scratchFixtureIds.userId,
        organizationId: scratchFixtureIds.organizationId,
        pullMode,
      },
      progress: buildInitialPullJobProgress(),
      abortSignal: new AbortController().signal,
      checkpoint: (checkpointedProgress) => {
        latestPublicProgress = checkpointedProgress.publicProgress;
        return Promise.resolve();
      },
    });
    if (!latestPublicProgress) throw new Error('the pull job checkpointed no publicProgress');
    return latestPublicProgress;
  }

  function readProductRecordFilesFromMainBranch(): { path: string; content: string }[] {
    return virtualGitFs
      .getFilesByFolder(MAIN_BRANCH, PRODUCTS_FOLDER_NAME_IN_GIT)
      .sort((firstFile, secondFile) => firstFile.path.localeCompare(secondFile.path));
  }

  async function readProductsDataFolder(productsDataFolderId: DataFolderId) {
    return prisma.dataFolder.findUniqueOrThrow({ where: { id: productsDataFolderId } });
  }

  async function pinIncrementalWatermark(productsDataFolderId: DataFolderId, pinnedWatermark: Date): Promise<void> {
    await prisma.dataFolder.update({
      where: { id: productsDataFolderId },
      data: { lastIncrementalPullAt: pinnedWatermark },
    });
  }

  // ── per modified-at column type ─────────────────────────────────────────────────────────────────────────────

  describe.each(MYSQL_MODIFIED_AT_COLUMN_VARIANTS)('with a $variantName modified-at column', (variant) => {
    it('bootstraps with a full pull, then an incremental pull fetches only the changed row, then nothing', async () => {
      const tableName = buildIncrementalSpecTableName(`${variant.tableNameSuffix}_changed_row`);
      await createProductsTableAsAdmin(tableName, variant.modifiedAtColumnDefinition, [
        'Aluminum Water Bottle',
        'Organic Cotton T-Shirt',
        'Wireless Charging Pad',
      ]);
      const { productsDataFolderId } = await setUpScratchWorkbookWithMySqlProductsFolder(
        tableName,
        MODIFIED_AT_COLUMN_NAME,
      );

      // ── 1. Full pull bootstraps the folder ───────────────────────────────────────────────────────────────
      const fullPullProgress = await runProductsPullJob('job-full', 'full');
      expect(fullPullProgress.folderErrors).toBeUndefined();
      expect(fullPullProgress.mode).toBe('full');
      expect(fullPullProgress.totalFiles).toBe(3);
      const recordFilesAfterFullPull = readProductRecordFilesFromMainBranch();
      expect(recordFilesAfterFullPull).toHaveLength(3);
      for (const recordFileAfterFullPull of recordFilesAfterFullPull) {
        expect(parseRecordFileContent(recordFileAfterFullPull.content)[MODIFIED_AT_COLUMN_NAME]).toBe(
          variant.renderPulledModifiedAtValue(OLD_MODIFIED_AT_INSTANT),
        );
      }
      const productsFolderAfterFullPull = await readProductsDataFolder(productsDataFolderId);
      expect(productsFolderAfterFullPull.lastFullPullAt).not.toBeNull();
      // A full scan is a superset of an incremental one, so it sets the watermark too (the next run isn't demoted).
      expect(productsFolderAfterFullPull.lastIncrementalPullAt).not.toBeNull();

      // ── 2. The customer's application changes exactly one row ────────────────────────────────────────────
      const [editResultHeader] = await adminConnection.query<mysql2Promise.ResultSetHeader>(
        `UPDATE ??.?? SET price = 99.99${variant.modifiedAtAssignmentWhenTheApplicationEditsARow} WHERE name = ?`,
        [databaseName, tableName, 'Aluminum Water Bottle'],
      );
      expect(editResultHeader.affectedRows).toBe(1);
      const editedRowModifiedAtText = await readStoredModifiedAtOfProductAsAdmin(tableName, 'Aluminum Water Bottle');
      // TIMESTAMP variant: ON UPDATE CURRENT_TIMESTAMP(3) moved it; DATETIME variant: the application wrote UTC now.
      expect(editedRowModifiedAtText).not.toBe(formatInstantAsUtcWallClockMillisecondsText(OLD_MODIFIED_AT_INSTANT));
      const editedRowModifiedAt = parseUtcWallClockMillisecondsText(editedRowModifiedAtText);

      // Pin the watermark 10 minutes back, so the window holds the edit however the host and MySQL clocks differ
      // (within minutes), and never the 2020 rows.
      const pinnedWatermarkBeforeEdit = new Date(Date.now() - 10 * 60_000);
      await pinIncrementalWatermark(productsDataFolderId, pinnedWatermarkBeforeEdit);

      // ── 3. Incremental pull: only the edited row comes back ──────────────────────────────────────────────
      const millisecondsBeforeIncrementalPull = Date.now();
      const incrementalPullProgress = await runProductsPullJob('job-incremental-1', 'incremental');
      expect(incrementalPullProgress.folderErrors).toBeUndefined();
      // A demotion (capability check / bootstrap) would report 'full' and all 3 rows.
      expect(incrementalPullProgress.mode).toBe('incremental');
      expect(incrementalPullProgress.totalFiles).toBe(1);

      const recordFilesAfterIncrementalPull = readProductRecordFilesFromMainBranch();
      expect(recordFilesAfterIncrementalPull).toHaveLength(3); // incremental pulls never delete
      const recordFileContentByPathAfterFullPull = mapRecordFilesByPath(recordFilesAfterFullPull);
      const recordFileContentByPathAfterIncrementalPull = mapRecordFilesByPath(recordFilesAfterIncrementalPull);
      expect(
        listNamesOfRecordsWhoseFilesChanged(
          recordFileContentByPathAfterFullPull,
          recordFileContentByPathAfterIncrementalPull,
        ),
      ).toEqual(['Aluminum Water Bottle']);
      const editedRecordFile = recordFilesAfterIncrementalPull.find(
        (recordFile) => parseRecordFileContent(recordFile.content).name === 'Aluminum Water Bottle',
      );
      expect(parseRecordFileContent(editedRecordFile?.content)).toMatchObject({
        name: 'Aluminum Water Bottle',
        price: '99.99',
        [MODIFIED_AT_COLUMN_NAME]: variant.renderPulledModifiedAtValue(editedRowModifiedAt),
      });

      // The persisted watermark is the connector's clock reading taken before its first query: after the job
      // started, and no later than the first page reaching scratch-git (which needs the first query's rows).
      const productsFolderAfterIncrementalPull = await readProductsDataFolder(productsDataFolderId);
      const persistedWatermarkMilliseconds = productsFolderAfterIncrementalPull.lastIncrementalPullAt?.getTime();
      const firstStageFilesCallMilliseconds = firstStageFilesCallMillisecondsByJobId.get('job-incremental-1');
      expect(persistedWatermarkMilliseconds).toBeDefined();
      expect(firstStageFilesCallMilliseconds).toBeDefined();
      expect(persistedWatermarkMilliseconds).not.toBe(pinnedWatermarkBeforeEdit.getTime());
      expect(persistedWatermarkMilliseconds).toBeGreaterThanOrEqual(millisecondsBeforeIncrementalPull - 1000);
      expect(persistedWatermarkMilliseconds).toBeLessThanOrEqual(firstStageFilesCallMilliseconds ?? 0);

      // ── 4. Watermark past the edit (and its 60s overlap): the next incremental pull is a no-op ────────────
      await pinIncrementalWatermark(
        productsDataFolderId,
        new Date(editedRowModifiedAt.getTime() + PG_INCREMENTAL_CLOCK_SKEW_MS + 60_000),
      );
      const noOpPullProgress = await runProductsPullJob('job-incremental-2', 'incremental');
      expect(noOpPullProgress.folderErrors).toBeUndefined();
      expect(noOpPullProgress.mode).toBe('incremental');
      expect(noOpPullProgress.totalFiles).toBe(0);
      expect(firstStageFilesCallMillisecondsByJobId.has('job-incremental-2')).toBe(false);
      expect(mapRecordFilesByPath(readProductRecordFilesFromMainBranch())).toEqual(
        recordFileContentByPathAfterIncrementalPull,
      );
    });

    it('re-pulls rows changed within the 60-second clock-skew overlap before the watermark, and only those', async () => {
      const tableName = buildIncrementalSpecTableName(`${variant.tableNameSuffix}_clock_skew`);
      const productModifiedAtOffsetFromWatermarkByName: Record<string, number> = {
        'inside the overlap (W-30s)': -30_000,
        'just inside the bound (W-60s+1ms)': -PG_INCREMENTAL_CLOCK_SKEW_MS + 1,
        'exactly on the exclusive bound (W-60s)': -PG_INCREMENTAL_CLOCK_SKEW_MS,
        'outside the overlap (W-90s)': -90_000,
      };
      await createProductsTableAsAdmin(
        tableName,
        variant.modifiedAtColumnDefinition,
        Object.keys(productModifiedAtOffsetFromWatermarkByName),
      );
      const { productsDataFolderId } = await setUpScratchWorkbookWithMySqlProductsFolder(
        tableName,
        MODIFIED_AT_COLUMN_NAME,
      );
      const fullPullProgress = await runProductsPullJob('job-full', 'full');
      expect(fullPullProgress.totalFiles).toBe(4);
      const recordFileContentByPathAfterFullPull = mapRecordFilesByPath(readProductRecordFilesFromMainBranch());

      // An explicit value also wins over ON UPDATE CURRENT_TIMESTAMP, so both variants store exactly these instants.
      for (const [productName, offsetFromWatermarkMilliseconds] of Object.entries(
        productModifiedAtOffsetFromWatermarkByName,
      )) {
        await adminConnection.query(
          `UPDATE ??.?? SET price = price + 1, ${MODIFIED_AT_COLUMN_NAME} = ? WHERE name = ?`,
          [
            databaseName,
            tableName,
            formatInstantAsUtcWallClockMillisecondsText(
              new Date(PINNED_WATERMARK_FOR_CLOCK_SKEW_BOUNDARY.getTime() + offsetFromWatermarkMilliseconds),
            ),
            productName,
          ],
        );
      }
      await pinIncrementalWatermark(productsDataFolderId, PINNED_WATERMARK_FOR_CLOCK_SKEW_BOUNDARY);

      const incrementalPullProgress = await runProductsPullJob('job-incremental-skew', 'incremental');

      expect(incrementalPullProgress.folderErrors).toBeUndefined();
      expect(incrementalPullProgress.mode).toBe('incremental');
      expect(incrementalPullProgress.totalFiles).toBe(2);
      expect(
        listNamesOfRecordsWhoseFilesChanged(
          recordFileContentByPathAfterFullPull,
          mapRecordFilesByPath(readProductRecordFilesFromMainBranch()),
        ),
      ).toEqual(['inside the overlap (W-30s)', 'just inside the bound (W-60s+1ms)']);
      const productsFolderAfterIncrementalPull = await readProductsDataFolder(productsDataFolderId);
      expect(productsFolderAfterIncrementalPull.lastIncrementalPullAt?.getTime()).toBeGreaterThan(
        PINNED_WATERMARK_FOR_CLOCK_SKEW_BOUNDARY.getTime(),
      );
    });
  });

  // ── a modifiedAtField the connector can't use ───────────────────────────────────────────────────────────────

  it('fails an incremental pull fast when modifiedAtField is a typo or not a time column, keeping the watermark', async () => {
    const tableName = buildIncrementalSpecTableName('unusable_modified_at_field');
    await createProductsTableAsAdmin(tableName, MYSQL_MODIFIED_AT_COLUMN_VARIANTS[0].modifiedAtColumnDefinition, [
      'Aluminum Water Bottle',
      'Organic Cotton T-Shirt',
    ]);
    const typoModifiedAtField = `${MODIFIED_AT_COLUMN_NAME}_typo`;
    const { productsDataFolderId } = await setUpScratchWorkbookWithMySqlProductsFolder(tableName, typoModifiedAtField);

    // A full pull never reads modifiedAtField, so it bootstraps normally.
    const fullPullProgress = await runProductsPullJob('job-full', 'full');
    expect(fullPullProgress.folderErrors).toBeUndefined();
    expect(fullPullProgress.totalFiles).toBe(2);
    const recordFileContentByPathAfterFullPull = mapRecordFilesByPath(readProductRecordFilesFromMainBranch());
    const watermarkAfterFullPull = (await readProductsDataFolder(productsDataFolderId)).lastIncrementalPullAt;
    expect(watermarkAfterFullPull).not.toBeNull();

    const expectedFriendlyMessageByUnusableModifiedAtField: Record<string, string> = {
      [typoModifiedAtField]: `The update field "${typoModifiedAtField}" isn't a column of the table "${tableName}". Choose one of its TIMESTAMP or DATETIME columns in the folder's advanced settings: ${MODIFIED_AT_COLUMN_NAME}.`,
      name: `The update field "name" of the table "${tableName}" isn't a TIMESTAMP or DATETIME column, so it can't tell which rows changed since the last pull. Choose one of its TIMESTAMP or DATETIME columns in the folder's advanced settings: ${MODIFIED_AT_COLUMN_NAME}.`,
    };
    for (const [unusableModifiedAtField, expectedFriendlyMessage] of Object.entries(
      expectedFriendlyMessageByUnusableModifiedAtField,
    )) {
      await prisma.dataFolder.update({
        where: { id: productsDataFolderId },
        data: { options: { modifiedAtField: unusableModifiedAtField } },
      });
      const failedPullJobId = `job-incremental-${unusableModifiedAtField}`;

      const failedPullProgress = await runProductsPullJob(failedPullJobId, 'incremental');

      expect(failedPullProgress.folderErrors?.[productsDataFolderId]?.message).toBe(expectedFriendlyMessage);
      expect(failedPullProgress.folders.find((folder) => folder.id === productsDataFolderId)?.status).toBe('failed');
      expect(failedPullProgress.totalFiles).toBe(0);
      // Rejected before any page was fetched, so nothing was staged or committed and the watermark stayed put.
      expect(firstStageFilesCallMillisecondsByJobId.has(failedPullJobId)).toBe(false);
      expect(mapRecordFilesByPath(readProductRecordFilesFromMainBranch())).toEqual(
        recordFileContentByPathAfterFullPull,
      );
      const productsFolderAfterFailedPull = await readProductsDataFolder(productsDataFolderId);
      expect(productsFolderAfterFailedPull.lastIncrementalPullAt).toEqual(watermarkAfterFullPull);
      expect(productsFolderAfterFailedPull.lock).toBeNull();
    }
  });
});
