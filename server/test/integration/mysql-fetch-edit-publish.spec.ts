/**
 * MySQL through the real pull and publish jobs (DEV-12035) — the MySQL twin of fetch-edit-publish.spec.ts.
 *
 * The connector-level specs (`mysql-connector`, `mysql-record-writes`) call createRecords / updateRecords /
 * deleteRecords directly. This spec drives the same writes the way production does: the real
 * `PullLinkedFolderFilesJobHandler` commits records to git, the test edits the dirty branch, `PublishPlanBuildService`
 * plans the change set from the connector's OWN table spec (stored by the pull, not hand-built), and
 * `PublishPlanRunService` runs it against a real MySQL 8.4 / MariaDB 11.4 server. It covers what only exists at that
 * level:
 *   a. FK round trip — pull two FK-linked InnoDB tables whose ids are past 2^53, edit / create (with canonical
 *      pseudo-refs, one to a co-pending record) / FK-referenced delete, and publish through every phase (edit, create,
 *      delete, backfill). With UPDATE_RECORDS_RETURNS_REMOTE_DATA on, a re-pull right after the publish changes nothing.
 *   b. Batch rollback → per-record retry on edit — a row deleted in MySQL after the pull makes the connector throw
 *      RecordNotFound for the whole batch (rolled back); the runner's single-record retry lands the other edits and
 *      leaves only the vanished record failed, with the connector's message and error code.
 *   c. Batch rollback → per-record retry on create — a too-long value (1406 under STRICT_TRANS_TABLES) rolls the
 *      create batch back; the retry inserts the other records exactly once (no duplicates from the rolled-back batch).
 *   d. An edited id is refused (IdColumnEdited) and no row changes — the id would otherwise address another row.
 *   e. The by-id pull job (`PullFilesJobHandler`) refreshes files whose FileIndex record ids are past 2^53.
 *
 * Harness (fetch-edit-publish's, with MySQL's connector account from mysql-incremental-pull): real Prisma against the
 * app Postgres (DATABASE_URL, default postgresql://postgres:postgres@localhost:5432/scratchpad), an encrypted
 * ConnectorAccount holding the DISCRETE MySQL keys, real connector / index / publish services, an in-memory VirtualGitFs
 * standing in for scratch-git (its schema store keeps the spec the pull wrote), and mocks for events, assets and
 * analytics. Every Prisma row a test creates is deleted in afterEach; MySQL tables are `scratch_mysql_it_fep_*`,
 * recreated per test and dropped in beforeAll / afterAll (`SKIP_CLEANUP=1` keeps both for inspection).
 *
 * Run (from server/, with server/localdev/docker-compose.mysql.yml and the app Postgres up):
 *   MYSQL_TEST_URL=mysql://test:test@127.0.0.1:3306/test_db MYSQL_TEST_ROOT_URL=mysql://root:root@127.0.0.1:3306/test_db \
 *   MARIADB_TEST_URL=mysql://test:test@127.0.0.1:3307/test_db MARIADB_TEST_ROOT_URL=mysql://root:root@127.0.0.1:3307/test_db \
 *   yarn test:integration test/integration/mysql-fetch-edit-publish --runInBand
 */
import { PrismaClient } from '@prisma/client';
import {
  AuthType,
  ConnectorErrorCode,
  createConnectorAccountId,
  createDataFolderId,
  createWorkbookId,
  JobType,
  type DataFolderId,
  type WorkbookId,
} from '@spinner/shared-types';
import type mysql2Promise from 'mysql2/promise';
import { type AssetExtractorService } from 'src/asset/asset-extractor.service';
import { type AssetIndexService } from 'src/asset/asset-index.service';
import { CredentialEncryptionService } from 'src/credential-encryption/credential-encryption.service';
import { type ExperimentsService } from 'src/experiments/experiments.service';
import { StubMetricsService } from 'src/metrics/stub-metrics.service';
import { type OAuthService } from 'src/oauth/oauth.service';
import { type PostHogService } from 'src/posthog/posthog.service';
import { FileIndexService } from 'src/publish-plan/file-index.service';
import { FileReferenceService } from 'src/publish-plan/file-reference.service';
import { PublishPlanBuildService } from 'src/publish-plan/publish-plan-build.service';
import { PublishPlanRunService } from 'src/publish-plan/publish-plan-run.service';
import { type RecreatedIdMapService } from 'src/publish-plan/recreated-id-map.service';
import { RefCleanerService } from 'src/publish-plan/ref-cleaner.service';
import { RefResolverService } from 'src/publish-plan/ref-resolver.service';
import { SchemaHelperService } from 'src/publish-plan/schema-helper.service';
import { PublishPlanStatus } from 'src/publish-plan/types';
import { type RateLimiterFactory } from 'src/rate-limiter/rate-limiter-factory.service';
import { type ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { ConnectorsService } from 'src/remote-service/connectors/connectors.service';
import { Service } from 'src/remote-service/connectors/service-constants';
import { type BaseJsonTableSpec } from 'src/remote-service/connectors/types';
import { DIRTY_BRANCH, MAIN_BRANCH, type ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { EncryptionService, type EncryptedData } from 'src/utils/encryption';
import { type WorkbookEventService } from 'src/workbook/workbook-event.service';
import { PullFilesJobHandler } from 'src/worker/jobs/job-definitions/pull-files.job';
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

const AUTHORS_TABLE_NAME = `${MYSQL_INTEGRATION_IDENTIFIER_PREFIX}fep_authors`;
const POSTS_TABLE_NAME = `${MYSQL_INTEGRATION_IDENTIFIER_PREFIX}fep_posts`;
/** FK constraint names are database-wide in MySQL, so they carry the integration prefix too. */
const AUTHORS_BEST_FRIEND_FOREIGN_KEY_NAME = `${MYSQL_INTEGRATION_IDENTIFIER_PREFIX}fep_fk_best_friend`;
const AUTHORS_FAVORITE_POST_FOREIGN_KEY_NAME = `${MYSQL_INTEGRATION_IDENTIFIER_PREFIX}fep_fk_favorite_post`;
const POSTS_AUTHOR_FOREIGN_KEY_NAME = `${MYSQL_INTEGRATION_IDENTIFIER_PREFIX}fep_fk_author`;

const AUTHORS_FOLDER_NAME_IN_GIT = 'authors';
const POSTS_FOLDER_NAME_IN_GIT = 'posts';

/** 2^53 + 1: every author id is past Number.MAX_SAFE_INTEGER, so it only survives as an exact decimal string. */
const FIRST_AUTHOR_ID_PAST_MAX_SAFE_INTEGER = '9007199254740993';
/** `authors.name` is VARCHAR(16): a longer value fails with 1406 under the connector's STRICT_TRANS_TABLES. */
const AUTHOR_NAME_THAT_IS_TOO_LONG_FOR_VARCHAR_16 = 'Franklin Delano Roosevelt Jr';

type PullLinkedFolderFilesJobRunParameters = Parameters<PullLinkedFolderFilesJobHandler['run']>[0];
type PullFilesJobRunParameters = Parameters<PullFilesJobHandler['run']>[0];

interface SeededAuthorAndPostIds {
  /** Author name → id as MySQL prints it (an exact decimal string; the ids are past 2^53). */
  authorIdByName: Map<string, string>;
  postIdByTitle: Map<string, number>;
}

interface RecordFileOnBranch {
  path: string;
  content: Record<string, unknown>;
}

function buildInitialPullLinkedFolderFilesJobProgress(): PullLinkedFolderFilesJobRunParameters['progress'] {
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

function buildInitialPullFilesJobProgress(): PullFilesJobRunParameters['progress'] {
  return {
    publicProgress: {
      status: 'pending',
      folderId: '',
      folderName: '',
      connector: Service.MYSQL,
      totalRequested: 0,
      createdPaths: [],
      updatedPaths: [],
    },
    jobProgress: {},
    connectorProgress: {},
    timestamp: Date.now(),
  };
}

function readRequiredMapValue<TKey, TValue>(map: Map<TKey, TValue>, key: TKey, description: string): TValue {
  const value = map.get(key);
  if (value === undefined) throw new Error(`${description} ${String(key)} is missing`);
  return value;
}

describeForEachConfiguredMySqlIntegrationFlavor('MySQL through the real pull and publish jobs', (flavor) => {
  const databaseName = flavor.applicationUserServerAddress.databaseName;
  /** The FK annotation's `linkedTableId` — what FileReference rows carry as `targetRemoteTableId`. */
  const authorsLinkedTableId = `${databaseName}.${AUTHORS_TABLE_NAME}`;
  /** First segment of a canonical, workspace-absolute pseudo-ref (`@/<connection>/<folder>/<file>.json`). */
  const connectionDisplayName = `FEP Test MySQL ${flavor.flavorName}`;

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
        authorsDataFolderId: DataFolderId;
        postsDataFolderId: DataFolderId;
      }
    | undefined;
  let seededAuthorAndPostIds: SeededAuthorAndPostIds;

  let virtualGitFs: VirtualGitFs;
  let pullLinkedFolderFilesJobHandler: PullLinkedFolderFilesJobHandler;
  let pullFilesByIdJobHandler: PullFilesJobHandler;
  let publishPlanBuildService: PublishPlanBuildService;
  let publishPlanRunService: PublishPlanRunService;
  /** What the publish run's `UPDATE_RECORDS_RETURNS_REMOTE_DATA` flag evaluates to. */
  let updateRecordsReturnsRemoteDataFlagValue: boolean;

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

  beforeEach(async () => {
    updateRecordsReturnsRemoteDataFlagValue = false;
    seededAuthorAndPostIds = await createAndSeedAuthorsAndPostsTablesAsAdmin();
    await setUpScratchWorkbookWithMySqlAuthorsAndPostsFolders();
    wireFreshPullAndPublishServices();
  });

  afterEach(async () => {
    const scratchFixtureIds = scratchFixtureIdsForCurrentTest;
    scratchFixtureIdsForCurrentTest = undefined;
    if (!scratchFixtureIds || process.env.SKIP_CLEANUP === '1') return;
    const { workbookId, userId, organizationId } = scratchFixtureIds;
    await prisma.publishPlanOperation.deleteMany({ where: { plan: { workbookId } } });
    await prisma.publishPlan.deleteMany({ where: { workbookId } });
    await prisma.fileReference.deleteMany({ where: { workbookId } });
    await prisma.fileIndex.deleteMany({ where: { workbookId } });
    await prisma.dataFolder.deleteMany({ where: { workbookId } });
    await prisma.connectorAccount.deleteMany({ where: { workbookId } });
    await prisma.workbook.deleteMany({ where: { id: workbookId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
  });

  // ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * fetch-edit-publish's graph on InnoDB, with author ids past 2^53:
   *   Alice (best friend Alice, favorite Post 1) · Bob (best friend Cleo, favorite Post 3) · Cleo (favorite Post 2)
   *   Post 1 by Alice · Post 2 by Bob · Post 3 by Cleo
   * `rating` (DECIMAL) and `updated_at` (TIMESTAMP(3) ON UPDATE) make MySQL's stored row differ from what was sent.
   */
  async function createAndSeedAuthorsAndPostsTablesAsAdmin(): Promise<SeededAuthorAndPostIds> {
    await adminConnection.query('SET SESSION FOREIGN_KEY_CHECKS = 0');
    try {
      await adminConnection.query('DROP TABLE IF EXISTS ??.??', [databaseName, AUTHORS_TABLE_NAME]);
      await adminConnection.query('DROP TABLE IF EXISTS ??.??', [databaseName, POSTS_TABLE_NAME]);
    } finally {
      await adminConnection.query('SET SESSION FOREIGN_KEY_CHECKS = 1');
    }
    await adminConnection.query(
      `CREATE TABLE ??.?? (
         id INT AUTO_INCREMENT PRIMARY KEY,
         title VARCHAR(255) NOT NULL,
         author_id BIGINT UNSIGNED NULL
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      [databaseName, POSTS_TABLE_NAME],
    );
    await adminConnection.query(
      `CREATE TABLE ??.?? (
         id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
         name VARCHAR(16) NOT NULL,
         rating DECIMAL(10,2) NULL,
         updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
         best_friend_id BIGINT UNSIGNED NULL,
         favorite_post_id INT NULL,
         CONSTRAINT ?? FOREIGN KEY (best_friend_id) REFERENCES ??.?? (id),
         CONSTRAINT ?? FOREIGN KEY (favorite_post_id) REFERENCES ??.?? (id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 AUTO_INCREMENT=${FIRST_AUTHOR_ID_PAST_MAX_SAFE_INTEGER}`,
      [
        databaseName,
        AUTHORS_TABLE_NAME,
        AUTHORS_BEST_FRIEND_FOREIGN_KEY_NAME,
        databaseName,
        AUTHORS_TABLE_NAME,
        AUTHORS_FAVORITE_POST_FOREIGN_KEY_NAME,
        databaseName,
        POSTS_TABLE_NAME,
      ],
    );
    await adminConnection.query('ALTER TABLE ??.?? ADD CONSTRAINT ?? FOREIGN KEY (author_id) REFERENCES ??.?? (id)', [
      databaseName,
      POSTS_TABLE_NAME,
      POSTS_AUTHOR_FOREIGN_KEY_NAME,
      databaseName,
      AUTHORS_TABLE_NAME,
    ]);

    await adminConnection.query(
      "INSERT INTO ??.?? (name, rating) VALUES ('Alice', '3.50'), ('Bob', NULL), ('Cleo', '1.25')",
      [databaseName, AUTHORS_TABLE_NAME],
    );
    const authorIdByName = new Map(
      (await selectRowsAsAdmin('SELECT id, name FROM ??.??', [databaseName, AUTHORS_TABLE_NAME])).map((authorRow) => [
        String(authorRow.name),
        String(authorRow.id),
      ]),
    );
    const aliceId = readRequiredMapValue(authorIdByName, 'Alice', 'seeded author');
    const bobId = readRequiredMapValue(authorIdByName, 'Bob', 'seeded author');
    const cleoId = readRequiredMapValue(authorIdByName, 'Cleo', 'seeded author');
    expect(aliceId).toBe(FIRST_AUTHOR_ID_PAST_MAX_SAFE_INTEGER);

    await adminConnection.query(
      "INSERT INTO ??.?? (title, author_id) VALUES ('Post 1', ?), ('Post 2', ?), ('Post 3', ?)",
      [databaseName, POSTS_TABLE_NAME, aliceId, bobId, cleoId],
    );
    const postIdByTitle = new Map(
      (await selectRowsAsAdmin('SELECT id, title FROM ??.??', [databaseName, POSTS_TABLE_NAME])).map((postRow) => [
        String(postRow.title),
        Number(postRow.id),
      ]),
    );

    const setAuthorLinksStatement = 'UPDATE ??.?? SET best_friend_id = ?, favorite_post_id = ? WHERE id = ?';
    await adminConnection.query(setAuthorLinksStatement, [
      databaseName,
      AUTHORS_TABLE_NAME,
      aliceId,
      readRequiredMapValue(postIdByTitle, 'Post 1', 'seeded post'),
      aliceId,
    ]);
    await adminConnection.query(setAuthorLinksStatement, [
      databaseName,
      AUTHORS_TABLE_NAME,
      cleoId,
      readRequiredMapValue(postIdByTitle, 'Post 3', 'seeded post'),
      bobId,
    ]);
    await adminConnection.query(setAuthorLinksStatement, [
      databaseName,
      AUTHORS_TABLE_NAME,
      null,
      readRequiredMapValue(postIdByTitle, 'Post 2', 'seeded post'),
      cleoId,
    ]);
    return { authorIdByName, postIdByTitle };
  }

  async function selectRowsAsAdmin(sql: string, values: unknown[]): Promise<mysql2Promise.RowDataPacket[]> {
    const [rows] = await adminConnection.query<mysql2Promise.RowDataPacket[]>(sql, values);
    return rows;
  }

  async function selectAuthorRowsOrderedByIdAsAdmin(): Promise<mysql2Promise.RowDataPacket[]> {
    return selectRowsAsAdmin(
      'SELECT id, name, rating, updated_at, best_friend_id, favorite_post_id FROM ??.?? ORDER BY id',
      [databaseName, AUTHORS_TABLE_NAME],
    );
  }

  async function selectPostRowsOrderedByIdAsAdmin(): Promise<mysql2Promise.RowDataPacket[]> {
    return selectRowsAsAdmin('SELECT id, title, author_id FROM ??.?? ORDER BY id', [databaseName, POSTS_TABLE_NAME]);
  }

  /**
   * Org / user / workbook, a MySQL ConnectorAccount holding the encrypted DISCRETE keys, and an authors and a posts
   * DataFolder (`tableId` = `[database, table]`).
   */
  async function setUpScratchWorkbookWithMySqlAuthorsAndPostsFolders(): Promise<void> {
    const uniqueFixtureSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const organization = await prisma.organization.create({
      data: {
        id: `org_mysql_fep_${uniqueFixtureSuffix}`,
        name: 'MySQL FEP Test Org',
        clerkId: `clerk_mysql_fep_${uniqueFixtureSuffix}`,
      },
    });
    const user = await prisma.user.create({
      data: {
        id: `user_mysql_fep_${uniqueFixtureSuffix}`,
        email: `mysql-fep-${uniqueFixtureSuffix}@example.com`,
        organizationId: organization.id,
      },
    });
    const workbookId = createWorkbookId();
    await prisma.workbook.create({
      data: { id: workbookId, name: 'MySQL FEP Test Workbook', userId: user.id, organizationId: organization.id },
    });
    // Track before creating anything that could fail, so afterEach still removes what was created.
    const connectorAccountId = createConnectorAccountId();
    const authorsDataFolderId = createDataFolderId();
    const postsDataFolderId = createDataFolderId();
    scratchFixtureIdsForCurrentTest = {
      organizationId: organization.id,
      userId: user.id,
      workbookId,
      connectorAccountId,
      authorsDataFolderId,
      postsDataFolderId,
    };

    const encryptedDiscreteMySqlCredentials: EncryptedData = await encryptionService.encryptObject(
      buildMySqlConnectorCredentialsForIntegrationTest(flavor.applicationUserServerAddress),
    );
    await prisma.connectorAccount.create({
      data: {
        id: connectorAccountId,
        workbookId,
        service: Service.MYSQL,
        displayName: connectionDisplayName,
        authType: AuthType.USER_PROVIDED_PARAMS,
        encryptedCredentials: encryptedDiscreteMySqlCredentials,
      },
    });
    for (const { dataFolderId, name, folderNameInGit, tableName } of [
      {
        dataFolderId: authorsDataFolderId,
        name: 'Authors',
        folderNameInGit: AUTHORS_FOLDER_NAME_IN_GIT,
        tableName: AUTHORS_TABLE_NAME,
      },
      {
        dataFolderId: postsDataFolderId,
        name: 'Posts',
        folderNameInGit: POSTS_FOLDER_NAME_IN_GIT,
        tableName: POSTS_TABLE_NAME,
      },
    ]) {
      await prisma.dataFolder.create({
        data: {
          id: dataFolderId,
          name,
          path: `/${folderNameInGit}`,
          workbookId,
          connectorAccountId,
          connectorService: Service.MYSQL,
          tableId: [databaseName, tableName],
        },
      });
    }
  }

  function readScratchFixtureIds(): NonNullable<typeof scratchFixtureIdsForCurrentTest> {
    const scratchFixtureIds = scratchFixtureIdsForCurrentTest;
    if (!scratchFixtureIds) throw new Error('set up the Scratch workbook fixture first');
    return scratchFixtureIds;
  }

  /**
   * fetch-edit-publish's harness: real connector, index and publish services over an in-memory two-phase git. The
   * schema store keeps whatever spec the pull (or the publish's schema refresh) wrote, so publish reads the
   * connector's own spec — read-only id, id binding kind, FK annotations — instead of a hand-built one.
   */
  function wireFreshPullAndPublishServices(): void {
    virtualGitFs = new VirtualGitFs();
    const tableSpecByFolderPathInGit = new Map<string, BaseJsonTableSpec>();
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
    const normalizeFolderPathInGit = (folderPath: string) => folderPath.replace(/^\//, '');

    const scratchGitServiceDouble = {
      initRepo: jest.fn().mockResolvedValue(undefined),
      resolveRepoId: jest.fn().mockImplementation((repoWorkbookId: WorkbookId) => Promise.resolve(repoWorkbookId)),
      resolveConnectionRepoPath: jest
        .fn()
        .mockImplementation((repoConnectorAccountId: string) => Promise.resolve(repoConnectorAccountId)),
      // The publish plan resolves its connection's repo scoped to the workbook (DEV-12337); same repo as above.
      resolveConnectionRepoPathScopedToWorkbook: jest
        .fn()
        .mockImplementation((_repoWorkbookId: WorkbookId, repoConnectorAccountId: string) =>
          Promise.resolve(repoConnectorAccountId),
        ),
      commitFilesToBranch: jest
        .fn()
        .mockImplementation((_repoId: string, branch: string, filesToCommit: { path: string; content: string }[]) => {
          const fileContentByPathBeforeCommit = virtualGitFs.getAllFiles(branch);
          virtualGitFs.commitFiles(branch, filesToCommit);
          return Promise.resolve({
            created: filesToCommit
              .filter((committedFile) => !fileContentByPathBeforeCommit.has(committedFile.path))
              .map((committedFile) => committedFile.path),
            updated: filesToCommit
              .filter((committedFile) => {
                const contentBeforeCommit = fileContentByPathBeforeCommit.get(committedFile.path);
                return contentBeforeCommit !== undefined && contentBeforeCommit !== committedFile.content;
              })
              .map((committedFile) => committedFile.path),
            unchanged: filesToCommit
              .filter(
                (committedFile) => fileContentByPathBeforeCommit.get(committedFile.path) === committedFile.content,
              )
              .map((committedFile) => committedFile.path),
          });
        }),
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
      getRepoStatus: jest.fn().mockImplementation(() => Promise.resolve(virtualGitFs.getStatus())),
      readRepoFilesByFolder: jest
        .fn()
        .mockImplementation((_repoId: string, branch: string, filePaths: string[]) =>
          Promise.resolve(virtualGitFs.readFiles(branch, filePaths)),
        ),
      runGitGc: jest.fn().mockResolvedValue(undefined),
      readSchemaFromGit: jest
        .fn()
        .mockImplementation((_repoId: string, folderPath: string) =>
          Promise.resolve(tableSpecByFolderPathInGit.get(normalizeFolderPathInGit(folderPath)) ?? null),
        ),
      writeSchemaToGit: jest
        .fn()
        .mockImplementation((_repoId: string, folderPath: string, tableSpec: BaseJsonTableSpec) => {
          tableSpecByFolderPathInGit.set(normalizeFolderPathInGit(folderPath), structuredClone(tableSpec));
          return Promise.resolve();
        }),
      writeViewToGit: jest.fn().mockResolvedValue(undefined),
      buildIndex: jest.fn().mockResolvedValue({ count: 0 }),
      countRecordFilesByFolder: jest.fn().mockResolvedValue(new Map<string, number>()),
      stageFiles: jest
        .fn()
        .mockImplementation((jobId: string, folder: string, filesToStage: { path: string; content: string }[]) => {
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
    const credentialEncryptionService = new CredentialEncryptionService();
    const fileIndexService = new FileIndexService(dbService);
    const refCleanerService = new RefCleanerService();
    const schemaHelperService = new SchemaHelperService(
      dbService,
      scratchGitServiceDouble,
      realConnectorsService,
      credentialEncryptionService,
    );
    const fileReferenceService = new FileReferenceService(dbService, refCleanerService, schemaHelperService);
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
    const workbookEventServiceDouble = { sendWorkbookEvent: jest.fn() } as unknown as WorkbookEventService;
    const assetExtractorServiceDouble = {
      extractAssets: jest.fn().mockReturnValue([]),
    } as unknown as AssetExtractorService;
    const assetIndexServiceDouble = {
      upsertBatch: jest.fn().mockResolvedValue(undefined),
    } as unknown as AssetIndexService;
    const postHogServiceDouble = { trackPullCompleted: jest.fn() } as unknown as PostHogService;

    pullLinkedFolderFilesJobHandler = new PullLinkedFolderFilesJobHandler(
      prisma,
      realConnectorsService,
      connectorAccountServiceDouble,
      workbookEventServiceDouble,
      scratchGitServiceDouble,
      fileIndexService,
      fileReferenceService,
      assetExtractorServiceDouble,
      assetIndexServiceDouble,
      postHogServiceDouble,
      // Full pulls only (no incremental kill-switch check matters); MYSQL isn't the generic connector.
      {
        getBooleanFlag: jest.fn().mockResolvedValue(false),
        isGenericConnectorEnabledForUser: jest.fn().mockResolvedValue(true),
      } as unknown as ExperimentsService,
    );
    pullFilesByIdJobHandler = new PullFilesJobHandler(
      prisma,
      realConnectorsService,
      connectorAccountServiceDouble,
      workbookEventServiceDouble,
      scratchGitServiceDouble,
      fileIndexService,
      fileReferenceService,
      assetExtractorServiceDouble,
      assetIndexServiceDouble,
      postHogServiceDouble,
    );
    publishPlanBuildService = new PublishPlanBuildService(
      dbService,
      scratchGitServiceDouble,
      fileIndexService,
      fileReferenceService,
      refCleanerService,
      schemaHelperService,
      assetIndexServiceDouble,
      realConnectorsService,
      credentialEncryptionService,
    );
    publishPlanRunService = new PublishPlanRunService(
      dbService,
      realConnectorsService,
      credentialEncryptionService,
      fileIndexService,
      fileReferenceService,
      scratchGitServiceDouble,
      schemaHelperService,
      new RefResolverService(fileIndexService, dbService),
      {
        getBooleanFlag: jest.fn().mockImplementation(() => Promise.resolve(updateRecordsReturnsRemoteDataFlagValue)),
      } as unknown as ExperimentsService,
      // The recreate flow isn't exercised here.
      {
        upsert: jest.fn().mockResolvedValue(undefined),
        resolveLatest: jest.fn().mockResolvedValue(null),
        resolveLatestBatch: jest.fn().mockResolvedValue(new Map()),
        resolveFkTargetFolders: jest.fn().mockResolvedValue(new Map()),
        deleteForWorkbook: jest.fn().mockResolvedValue(undefined),
      } as unknown as RecreatedIdMapService,
      refCleanerService,
      new StubMetricsService(),
    );
  }

  // ── job / pipeline drivers ──────────────────────────────────────────────────────────────────────────────────

  async function runFullPullJobForFolder(jobId: string, dataFolderId: DataFolderId): Promise<void> {
    const { workbookId, userId, organizationId } = readScratchFixtureIds();
    await pullLinkedFolderFilesJobHandler.run({
      jobId,
      data: { type: 'pull-linked-folder-files', workbookId, dataFolderIds: [dataFolderId], userId, organizationId },
      progress: buildInitialPullLinkedFolderFilesJobProgress(),
      abortSignal: new AbortController().signal,
      checkpoint: () => Promise.resolve(),
    });
  }

  /** Authors first, then posts (the authors' refs to posts are stored before the posts are indexed). */
  async function runFullPullJobsForAuthorsThenPosts(jobIdPrefix: string): Promise<void> {
    const { authorsDataFolderId, postsDataFolderId } = readScratchFixtureIds();
    await runFullPullJobForFolder(`${jobIdPrefix}-authors`, authorsDataFolderId);
    await runFullPullJobForFolder(`${jobIdPrefix}-posts`, postsDataFolderId);
  }

  async function runPullFilesByIdJob(jobId: string, dataFolderId: DataFolderId, filePaths: string[]): Promise<void> {
    const { workbookId, userId, organizationId } = readScratchFixtureIds();
    await pullFilesByIdJobHandler.run({
      jobId,
      data: { type: JobType.RefreshRecords, workbookId, dataFolderId, userId, organizationId, filePaths },
      progress: buildInitialPullFilesJobProgress(),
      abortSignal: new AbortController().signal,
      checkpoint: () => Promise.resolve(),
    });
  }

  async function buildPublishPipelineForConnection(): Promise<string> {
    const { workbookId, userId, connectorAccountId } = readScratchFixtureIds();
    const plan = await publishPlanBuildService.buildPipeline(workbookId, userId, connectorAccountId);
    expect(plan.status).toBe('planned');
    return plan.pipelineId;
  }

  async function readPublishPlanOperationsOrderedByPhaseAndPath() {
    const { workbookId } = readScratchFixtureIds();
    return prisma.publishPlanOperation.findMany({
      where: { plan: { workbookId } },
      orderBy: [{ phase: 'asc' }, { filePath: 'asc' }],
    });
  }

  async function readFileIndexRecordIdByFilename(folderNameInGit: string): Promise<Map<string, string>> {
    const { workbookId } = readScratchFixtureIds();
    const fileIndexEntries = await prisma.fileIndex.findMany({ where: { workbookId, folderPath: folderNameInGit } });
    return new Map(fileIndexEntries.map((fileIndexEntry) => [fileIndexEntry.filename, fileIndexEntry.recordId]));
  }

  function readRecordFilesInFolder(branch: string, folderNameInGit: string): RecordFileOnBranch[] {
    return virtualGitFs
      .getFilesByFolder(branch, folderNameInGit)
      .map((recordFile) => ({
        path: recordFile.path,
        content: JSON.parse(recordFile.content) as Record<string, unknown>,
      }))
      .sort((firstRecordFile, secondRecordFile) => firstRecordFile.path.localeCompare(secondRecordFile.path));
  }

  function findRecordFileByFieldValue(
    branch: string,
    folderNameInGit: string,
    fieldName: string,
    fieldValue: unknown,
  ): RecordFileOnBranch {
    const matchingRecordFile = readRecordFilesInFolder(branch, folderNameInGit).find(
      (recordFile) => recordFile.content[fieldName] === fieldValue,
    );
    if (!matchingRecordFile) {
      throw new Error(`no ${folderNameInGit} record on ${branch} has ${fieldName} = ${JSON.stringify(fieldValue)}`);
    }
    return matchingRecordFile;
  }

  function readRecordFileContentByPathInRecordFolders(branch: string): Map<string, string> {
    return new Map(
      [...virtualGitFs.getAllFiles(branch)].filter(
        ([recordFilePath]) =>
          recordFilePath.startsWith(`${AUTHORS_FOLDER_NAME_IN_GIT}/`) ||
          recordFilePath.startsWith(`${POSTS_FOLDER_NAME_IN_GIT}/`),
      ),
    );
  }

  function writeRecordFileToDirtyBranch(recordFilePath: string, recordContent: Record<string, unknown>): void {
    virtualGitFs.commitFiles(DIRTY_BRANCH, [{ path: recordFilePath, content: JSON.stringify(recordContent) }]);
  }

  function filenameOf(recordFilePath: string): string {
    return recordFilePath.slice(recordFilePath.lastIndexOf('/') + 1);
  }

  // ── a. FK round trip ────────────────────────────────────────────────────────────────────────────────────────

  describe.each([
    { flagDescription: 'off (write-back from the sent payload)', updateRecordsReturnsRemoteData: false },
    { flagDescription: 'on (write-back from the rows MySQL re-selects)', updateRecordsReturnsRemoteData: true },
  ])('with UPDATE_RECORDS_RETURNS_REMOTE_DATA $flagDescription', ({ updateRecordsReturnsRemoteData }) => {
    it('pulls FK-linked tables with ids past 2^53, then publishes an edit, two creates with pseudo-refs and an FK-referenced delete', async () => {
      updateRecordsReturnsRemoteDataFlagValue = updateRecordsReturnsRemoteData;
      const { authorIdByName, postIdByTitle } = seededAuthorAndPostIds;
      const aliceId = readRequiredMapValue(authorIdByName, 'Alice', 'seeded author');
      const bobId = readRequiredMapValue(authorIdByName, 'Bob', 'seeded author');
      const cleoId = readRequiredMapValue(authorIdByName, 'Cleo', 'seeded author');
      const post1Id = readRequiredMapValue(postIdByTitle, 'Post 1', 'seeded post');
      const post3Id = readRequiredMapValue(postIdByTitle, 'Post 3', 'seeded post');

      // ── Phase 1: pull ──────────────────────────────────────────────────────────────────────────────────────
      await runFullPullJobsForAuthorsThenPosts('job-initial-pull');

      expect(readRecordFilesInFolder(MAIN_BRANCH, AUTHORS_FOLDER_NAME_IN_GIT)).toHaveLength(3);
      expect(readRecordFilesInFolder(MAIN_BRANCH, POSTS_FOLDER_NAME_IN_GIT)).toHaveLength(3);

      // Ids past 2^53 reach git and the FileIndex as exact decimal strings.
      const authorRecordIdByFilenameAfterPull = await readFileIndexRecordIdByFilename(AUTHORS_FOLDER_NAME_IN_GIT);
      expect(new Set(authorRecordIdByFilenameAfterPull.values())).toEqual(new Set([aliceId, bobId, cleoId]));
      const aliceFile = findRecordFileByFieldValue(MAIN_BRANCH, AUTHORS_FOLDER_NAME_IN_GIT, 'name', 'Alice');
      expect(aliceFile.content.id).toBe(aliceId);
      expect(aliceFile.content.best_friend_id).toBe(aliceId);
      expect(aliceFile.content.favorite_post_id).toBe(post1Id);
      const postRecordIdByFilenameAfterPull = await readFileIndexRecordIdByFilename(POSTS_FOLDER_NAME_IN_GIT);
      expect(new Set(postRecordIdByFilenameAfterPull.values())).toEqual(
        new Set([...postIdByTitle.values()].map(String)),
      );

      // FileReferences come from the MySQL FK annotation (`linkedTableId` = `db.table`) and resolve across folders.
      const { workbookId } = readScratchFixtureIds();
      const postToAuthorReferences = await prisma.fileReference.findMany({
        where: { workbookId, branch: MAIN_BRANCH, sourceFilePath: { startsWith: `${POSTS_FOLDER_NAME_IN_GIT}/` } },
      });
      expect(postToAuthorReferences).toHaveLength(3);
      const authorRecordIds = new Set(authorRecordIdByFilenameAfterPull.values());
      for (const postToAuthorReference of postToAuthorReferences) {
        expect(postToAuthorReference.targetRemoteTableId).toBe(authorsLinkedTableId);
        expect(authorRecordIds.has(String(postToAuthorReference.targetRemoteId))).toBe(true);
      }

      // ── Phase 2: edit the dirty branch ─────────────────────────────────────────────────────────────────────
      const bobFile = findRecordFileByFieldValue(MAIN_BRANCH, AUTHORS_FOLDER_NAME_IN_GIT, 'name', 'Bob');
      const cleoFile = findRecordFileByFieldValue(MAIN_BRANCH, AUTHORS_FOLDER_NAME_IN_GIT, 'name', 'Cleo');
      const post1File = findRecordFileByFieldValue(MAIN_BRANCH, POSTS_FOLDER_NAME_IN_GIT, 'title', 'Post 1');
      const post3File = findRecordFileByFieldValue(MAIN_BRANCH, POSTS_FOLDER_NAME_IN_GIT, 'title', 'Post 3');

      // (a) New author Dave: a real FK id (Alice) and a canonical pseudo-ref to the already-published Post 1.
      const davePath = `${AUTHORS_FOLDER_NAME_IN_GIT}/dave.json`;
      writeRecordFileToDirtyBranch(davePath, {
        name: 'Dave',
        best_friend_id: aliceId,
        favorite_post_id: `@/${connectionDisplayName}/${post1File.path}`,
      });
      // (b) Bob: new name and rating (MySQL stores DECIMAL(10,2) 4.5 as "4.50"); his ref to Cleo must be stripped.
      writeRecordFileToDirtyBranch(bobFile.path, { ...bobFile.content, name: 'Bob Updated', rating: 4.5 });
      // (c) Delete Cleo, whom Bob (best_friend_id) and Post 3 (author_id) reference through real InnoDB FKs.
      virtualGitFs.deleteFiles(DIRTY_BRANCH, [cleoFile.path]);
      // (d) New Post 4 by Dave, who doesn't exist in MySQL yet: resolved only after Dave's create (backfill).
      const post4Path = `${POSTS_FOLDER_NAME_IN_GIT}/post-4.json`;
      writeRecordFileToDirtyBranch(post4Path, { title: 'Post 4', author_id: `@/${connectionDisplayName}/${davePath}` });

      // ── Phase 3: build the plan ─────────────────────────────────────────────────────────────────────────────
      const pipelineId = await buildPublishPipelineForConnection();
      const plannedOperations = await readPublishPlanOperationsOrderedByPhaseAndPath();
      const plannedFilePathsByPhase = new Map<string, string[]>();
      for (const plannedOperation of plannedOperations) {
        plannedFilePathsByPhase.set(plannedOperation.phase, [
          ...(plannedFilePathsByPhase.get(plannedOperation.phase) ?? []),
          plannedOperation.filePath,
        ]);
      }
      expect(plannedFilePathsByPhase.get('edit')).toEqual(expect.arrayContaining([bobFile.path, post3File.path]));
      expect(plannedFilePathsByPhase.get('create')).toEqual(expect.arrayContaining([davePath, post4Path]));
      expect(plannedFilePathsByPhase.get('delete')).toEqual([cleoFile.path]);
      expect(plannedFilePathsByPhase.get('backfill')).toEqual(expect.arrayContaining([davePath, post4Path]));

      // ── Phase 4: run it against MySQL ───────────────────────────────────────────────────────────────────────
      const publishResult = await publishPlanRunService.runPipeline(pipelineId);
      const operationsAfterRun = await readPublishPlanOperationsOrderedByPhaseAndPath();
      expect(
        operationsAfterRun.filter((operation) => operation.status !== 'success').map((operation) => operation.error),
      ).toEqual([]);
      expect(publishResult.status).toBe(PublishPlanStatus.Completed);

      const authorRowByName = new Map(
        (await selectAuthorRowsOrderedByIdAsAdmin()).map((authorRow) => [String(authorRow.name), authorRow]),
      );
      const postRowByTitle = new Map(
        (await selectPostRowsOrderedByIdAsAdmin()).map((postRow) => [String(postRow.title), postRow]),
      );
      expect(authorRowByName.has('Cleo')).toBe(false);
      const daveRow = readRequiredMapValue(authorRowByName, 'Dave', 'author row');
      // AUTO_INCREMENT continues past 2^53: Dave's id is exact, never rounded through a JS number.
      expect(String(daveRow.id)).toBe((BigInt(FIRST_AUTHOR_ID_PAST_MAX_SAFE_INTEGER) + 3n).toString());
      expect(String(daveRow.best_friend_id)).toBe(aliceId);
      expect(Number(daveRow.favorite_post_id)).toBe(post1Id);
      const bobRow = readRequiredMapValue(authorRowByName, 'Bob Updated', 'author row');
      expect(String(bobRow.id)).toBe(bobId);
      expect(bobRow.best_friend_id).toBeNull();
      expect(String(bobRow.rating)).toBe('4.50');
      const post4Row = readRequiredMapValue(postRowByTitle, 'Post 4', 'post row');
      expect(String(post4Row.author_id)).toBe(String(daveRow.id));
      const post3Row = readRequiredMapValue(postRowByTitle, 'Post 3', 'post row');
      expect(Number(post3Row.id)).toBe(post3Id);
      expect(post3Row.author_id).toBeNull();

      const authorRecordIdByFilenameAfterPublish = await readFileIndexRecordIdByFilename(AUTHORS_FOLDER_NAME_IN_GIT);
      expect(authorRecordIdByFilenameAfterPublish.get(filenameOf(davePath))).toBe(String(daveRow.id));
      expect(authorRecordIdByFilenameAfterPublish.has(filenameOf(cleoFile.path))).toBe(false);
      const postRecordIdByFilenameAfterPublish = await readFileIndexRecordIdByFilename(POSTS_FOLDER_NAME_IN_GIT);
      expect(postRecordIdByFilenameAfterPublish.get(filenameOf(post4Path))).toBe(String(post4Row.id));

      if (updateRecordsReturnsRemoteData) {
        // Main holds what MySQL stored (re-selected DECIMAL text, the bumped TIMESTAMP), so the next pull is a no-op.
        const recordFileContentByPathAfterPublish = readRecordFileContentByPathInRecordFolders(MAIN_BRANCH);
        await runFullPullJobsForAuthorsThenPosts('job-pull-after-publish');
        expect(readRecordFileContentByPathInRecordFolders(MAIN_BRANCH)).toEqual(recordFileContentByPathAfterPublish);
      }
    });
  });

  // ── b. edit batch rollback → per-record retry ───────────────────────────────────────────────────────────────

  it('retries a rolled-back edit batch one record at a time: the other edits land, the vanished row fails alone', async () => {
    const cleoId = readRequiredMapValue(seededAuthorAndPostIds.authorIdByName, 'Cleo', 'seeded author');
    await runFullPullJobsForAuthorsThenPosts('job-initial-pull');
    const aliceFile = findRecordFileByFieldValue(MAIN_BRANCH, AUTHORS_FOLDER_NAME_IN_GIT, 'name', 'Alice');
    const bobFile = findRecordFileByFieldValue(MAIN_BRANCH, AUTHORS_FOLDER_NAME_IN_GIT, 'name', 'Bob');
    const cleoFile = findRecordFileByFieldValue(MAIN_BRANCH, AUTHORS_FOLDER_NAME_IN_GIT, 'name', 'Cleo');
    const cleoFileContentOnMainBeforePublish = virtualGitFs.getAllFiles(MAIN_BRANCH).get(cleoFile.path);
    writeRecordFileToDirtyBranch(aliceFile.path, { ...aliceFile.content, name: 'Alice v2' });
    writeRecordFileToDirtyBranch(bobFile.path, { ...bobFile.content, name: 'Bob v2' });
    writeRecordFileToDirtyBranch(cleoFile.path, { ...cleoFile.content, name: 'Cleo v2' });

    // The customer's application removes Cleo after the pull (clearing the FKs that point at her first).
    await adminConnection.query('UPDATE ??.?? SET best_friend_id = NULL WHERE best_friend_id = ?', [
      databaseName,
      AUTHORS_TABLE_NAME,
      cleoId,
    ]);
    await adminConnection.query('UPDATE ??.?? SET author_id = NULL WHERE author_id = ?', [
      databaseName,
      POSTS_TABLE_NAME,
      cleoId,
    ]);
    await adminConnection.query('DELETE FROM ??.?? WHERE id = ?', [databaseName, AUTHORS_TABLE_NAME, cleoId]);

    const pipelineId = await buildPublishPipelineForConnection();
    const plannedEditFilePaths = (await readPublishPlanOperationsOrderedByPhaseAndPath())
      .filter((operation) => operation.phase === 'edit')
      .map((operation) => operation.filePath);
    // One batch: Cleo's update comes after Alice's and Bob's, so the rollback has their statements to undo.
    expect(plannedEditFilePaths).toEqual([aliceFile.path, bobFile.path, cleoFile.path]);

    const publishResult = await publishPlanRunService.runPipeline(pipelineId);

    expect(publishResult.status).toBe(PublishPlanStatus.CompletedWithErrors);
    expect(publishResult.failedCount).toBe(1);
    const editOperationByFilePath = new Map(
      (await readPublishPlanOperationsOrderedByPhaseAndPath()).map((operation) => [operation.filePath, operation]),
    );
    expect(readRequiredMapValue(editOperationByFilePath, aliceFile.path, 'operation').status).toBe('success');
    expect(readRequiredMapValue(editOperationByFilePath, bobFile.path, 'operation').status).toBe('success');
    const cleoEditOperation = readRequiredMapValue(editOperationByFilePath, cleoFile.path, 'operation');
    expect(cleoEditOperation.status).toBe('failed-batch');
    expect(cleoEditOperation.errorCode).toBe(ConnectorErrorCode.RemoteRecordNotFound);
    expect(cleoEditOperation.error).toContain("The row this record points to doesn't exist");

    expect((await selectAuthorRowsOrderedByIdAsAdmin()).map((authorRow) => String(authorRow.name))).toEqual([
      'Alice v2',
      'Bob v2',
    ]);
    expect(
      findRecordFileByFieldValue(MAIN_BRANCH, AUTHORS_FOLDER_NAME_IN_GIT, 'id', aliceFile.content.id).content.name,
    ).toBe('Alice v2');
    expect(
      findRecordFileByFieldValue(MAIN_BRANCH, AUTHORS_FOLDER_NAME_IN_GIT, 'id', bobFile.content.id).content.name,
    ).toBe('Bob v2');
    // The failed record keeps its last-pulled state on main and its FileIndex row; the user's edit stays on dirty.
    expect(virtualGitFs.getAllFiles(MAIN_BRANCH).get(cleoFile.path)).toBe(cleoFileContentOnMainBeforePublish);
    expect((await readFileIndexRecordIdByFilename(AUTHORS_FOLDER_NAME_IN_GIT)).get(filenameOf(cleoFile.path))).toBe(
      cleoId,
    );
  });

  // ── c. create batch rollback → per-record retry ─────────────────────────────────────────────────────────────

  it('retries a rolled-back create batch one record at a time without inserting any record twice', async () => {
    await runFullPullJobsForAuthorsThenPosts('job-initial-pull');
    const authorRowCountBeforePublish = (await selectAuthorRowsOrderedByIdAsAdmin()).length;
    const newErinPath = `${AUTHORS_FOLDER_NAME_IN_GIT}/new-erin.json`;
    const newFranklinPath = `${AUTHORS_FOLDER_NAME_IN_GIT}/new-franklin.json`;
    const newGusPath = `${AUTHORS_FOLDER_NAME_IN_GIT}/new-gus.json`;
    writeRecordFileToDirtyBranch(newErinPath, { name: 'Erin' });
    writeRecordFileToDirtyBranch(newFranklinPath, { name: AUTHOR_NAME_THAT_IS_TOO_LONG_FOR_VARCHAR_16 });
    writeRecordFileToDirtyBranch(newGusPath, { name: 'Gus' });

    const pipelineId = await buildPublishPipelineForConnection();
    const plannedCreateFilePaths = (await readPublishPlanOperationsOrderedByPhaseAndPath())
      .filter((operation) => operation.phase === 'create')
      .map((operation) => operation.filePath);
    expect(plannedCreateFilePaths).toEqual([newErinPath, newFranklinPath, newGusPath]);

    const publishResult = await publishPlanRunService.runPipeline(pipelineId);

    expect(publishResult.status).toBe(PublishPlanStatus.CompletedWithErrors);
    expect(publishResult.failedCount).toBe(1);
    const authorRowsAfterPublish = await selectAuthorRowsOrderedByIdAsAdmin();
    // Exactly two new rows: Erin's insert, rolled back with the batch, isn't left behind next to her retried one.
    expect(authorRowsAfterPublish).toHaveLength(authorRowCountBeforePublish + 2);
    const authorIdByNameAfterPublish = new Map(
      authorRowsAfterPublish.map((authorRow) => [String(authorRow.name), String(authorRow.id)]),
    );
    expect([...authorIdByNameAfterPublish.keys()].sort()).toEqual(['Alice', 'Bob', 'Cleo', 'Erin', 'Gus']);

    const createOperationByFilePath = new Map(
      (await readPublishPlanOperationsOrderedByPhaseAndPath()).map((operation) => [operation.filePath, operation]),
    );
    expect(readRequiredMapValue(createOperationByFilePath, newErinPath, 'operation').status).toBe('success');
    expect(readRequiredMapValue(createOperationByFilePath, newGusPath, 'operation').status).toBe('success');
    const franklinCreateOperation = readRequiredMapValue(createOperationByFilePath, newFranklinPath, 'operation');
    expect(franklinCreateOperation.status).toBe('failed-batch');
    expect(franklinCreateOperation.error).toContain('A value is too long for its column.');
    expect(franklinCreateOperation.error).toContain("'name'");

    const authorRecordIdByFilename = await readFileIndexRecordIdByFilename(AUTHORS_FOLDER_NAME_IN_GIT);
    expect(authorRecordIdByFilename.get(filenameOf(newErinPath))).toBe(
      readRequiredMapValue(authorIdByNameAfterPublish, 'Erin', 'author id'),
    );
    expect(authorRecordIdByFilename.get(filenameOf(newGusPath))).toBe(
      readRequiredMapValue(authorIdByNameAfterPublish, 'Gus', 'author id'),
    );
    expect(authorRecordIdByFilename.has(filenameOf(newFranklinPath))).toBe(false);
  });

  // ── d. an edited id ─────────────────────────────────────────────────────────────────────────────────────────

  it("refuses an edit that changes a record's id and leaves every row as it was", async () => {
    const aliceId = readRequiredMapValue(seededAuthorAndPostIds.authorIdByName, 'Alice', 'seeded author');
    await runFullPullJobsForAuthorsThenPosts('job-initial-pull');
    const bobFile = findRecordFileByFieldValue(MAIN_BRANCH, AUTHORS_FOLDER_NAME_IN_GIT, 'name', 'Bob');
    const authorRowsBeforePublish = await selectAuthorRowsOrderedByIdAsAdmin();
    // Rows are found by the id in the file: published as-is, this edit would rename ALICE's row.
    writeRecordFileToDirtyBranch(bobFile.path, { ...bobFile.content, id: aliceId, name: 'Hijacked' });

    const pipelineId = await buildPublishPipelineForConnection();
    const publishResult = await publishPlanRunService.runPipeline(pipelineId);

    expect(publishResult.status).toBe(PublishPlanStatus.CompletedWithErrors);
    const operationsAfterRun = await readPublishPlanOperationsOrderedByPhaseAndPath();
    expect(operationsAfterRun.map((operation) => [operation.phase, operation.filePath, operation.status])).toEqual([
      ['edit', bobFile.path, 'failed-batch'],
    ]);
    expect(operationsAfterRun[0]?.error).toContain('The ID field "id" was edited');
    expect(await selectAuthorRowsOrderedByIdAsAdmin()).toEqual(authorRowsBeforePublish);
  });

  // ── e. the by-id pull job ───────────────────────────────────────────────────────────────────────────────────

  it('refreshes specific files through the by-id pull job, binding FileIndex record ids past 2^53 exactly', async () => {
    const { authorIdByName } = seededAuthorAndPostIds;
    const aliceId = readRequiredMapValue(authorIdByName, 'Alice', 'seeded author');
    const bobId = readRequiredMapValue(authorIdByName, 'Bob', 'seeded author');
    const { authorsDataFolderId } = readScratchFixtureIds();
    await runFullPullJobsForAuthorsThenPosts('job-initial-pull');
    const aliceFile = findRecordFileByFieldValue(MAIN_BRANCH, AUTHORS_FOLDER_NAME_IN_GIT, 'name', 'Alice');
    const bobFile = findRecordFileByFieldValue(MAIN_BRANCH, AUTHORS_FOLDER_NAME_IN_GIT, 'name', 'Bob');
    const cleoFile = findRecordFileByFieldValue(MAIN_BRANCH, AUTHORS_FOLDER_NAME_IN_GIT, 'name', 'Cleo');
    const cleoFileContentOnMainBeforeRefresh = virtualGitFs.getAllFiles(MAIN_BRANCH).get(cleoFile.path);

    // The customer's application edits Alice and Bob — Cleo changes too, but isn't asked for.
    await adminConnection.query("UPDATE ??.?? SET name = 'Alice Remote', rating = '7.25' WHERE id = ?", [
      databaseName,
      AUTHORS_TABLE_NAME,
      aliceId,
    ]);
    await adminConnection.query("UPDATE ??.?? SET name = 'Bob Remote' WHERE id = ?", [
      databaseName,
      AUTHORS_TABLE_NAME,
      bobId,
    ]);
    await adminConnection.query("UPDATE ??.?? SET name = 'Cleo Remote' WHERE name = 'Cleo'", [
      databaseName,
      AUTHORS_TABLE_NAME,
    ]);

    await runPullFilesByIdJob('job-refresh-alice-and-bob', authorsDataFolderId, [aliceFile.path, bobFile.path]);

    const authorFilesAfterRefresh = readRecordFilesInFolder(MAIN_BRANCH, AUTHORS_FOLDER_NAME_IN_GIT);
    expect(authorFilesAfterRefresh.map((authorFile) => authorFile.path)).toEqual(
      [aliceFile.path, bobFile.path, cleoFile.path].sort(),
    );
    const refreshedAliceContent = authorFilesAfterRefresh.find(
      (authorFile) => authorFile.path === aliceFile.path,
    )?.content;
    expect(refreshedAliceContent).toMatchObject({ id: aliceId, name: 'Alice Remote', rating: '7.25' });
    const refreshedBobContent = authorFilesAfterRefresh.find((authorFile) => authorFile.path === bobFile.path)?.content;
    expect(refreshedBobContent).toMatchObject({ id: bobId, name: 'Bob Remote' });
    expect(virtualGitFs.getAllFiles(MAIN_BRANCH).get(cleoFile.path)).toBe(cleoFileContentOnMainBeforeRefresh);
  });
});
