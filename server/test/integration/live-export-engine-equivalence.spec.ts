import { PrismaClient } from '@prisma/client';
import {
  createConnectorAccountId,
  createDataFolderId,
  createOrganizationId,
  createSyncId,
  createSyncTablePairId,
  createUserId,
  createWorkbookId,
  DataFolderId,
  SyncId,
  type SyncMappingV2,
  WorkbookId,
  WorkbookManager,
} from '@spinner/shared-types';
import { AssetIndexService } from 'src/asset/asset-index.service';
import { AuditLogService } from 'src/audit/audit-log.service';
import { CredentialEncryptionService } from 'src/credential-encryption/credential-encryption.service';
import { DbService } from 'src/db/db.service';
import { ExperimentsService } from 'src/experiments/experiments.service';
import { InMemoryRunStoreClient } from 'src/live-export-run-store/in-memory-run-store-client';
import { runStoreKeyForRoutineRun } from 'src/live-export-run-store/run-store-client';
import { RunStorePullSink } from 'src/live-export-run-store/run-store-pull-sink';
import { StubMetricsService } from 'src/metrics/stub-metrics.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { FileIndexEntry, FileIndexService } from 'src/publish-plan/file-index.service';
import { FileReferenceService } from 'src/publish-plan/file-reference.service';
import { PublishPlanBuildService } from 'src/publish-plan/publish-plan-build.service';
import { PublishPlanCrudService } from 'src/publish-plan/publish-plan-crud.service';
import { PublishPlanRunService } from 'src/publish-plan/publish-plan-run.service';
import { RecreatedIdMapService } from 'src/publish-plan/recreated-id-map.service';
import { RefCleanerService } from 'src/publish-plan/ref-cleaner.service';
import { RefResolverService } from 'src/publish-plan/ref-resolver.service';
import { SchemaHelperService } from 'src/publish-plan/schema-helper.service';
import { Connector } from 'src/remote-service/connectors/connector';
import { ConnectorsService } from 'src/remote-service/connectors/connectors.service';
import { Service } from 'src/remote-service/connectors/service-constants';
import { BaseJsonTableSpec, ConnectorFile, dotPath } from 'src/remote-service/connectors/types';
import { ScheduleService } from 'src/schedule/schedule.service';
import { DIRTY_BRANCH, MAIN_BRANCH, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { SyncService } from 'src/sync/sync.service';
import { Actor } from 'src/users/types';
import type { JsonSafeObject } from 'src/utils/objects';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { WorkbookEventService } from 'src/workbook/workbook-event.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { PublishJobHandler } from 'src/worker/jobs/job-definitions/publish.job';
import type { PullSinkFolder } from 'src/worker/jobs/job-definitions/pull-sink/pull-sink';
import { SyncDataFoldersJobHandler } from 'src/worker/jobs/job-definitions/sync-data-folders.job';
import { createIntegrationTestDataFolderTableSpecStore } from './data-folder-table-spec-store-test-helper';
import { createIntegrationTestDbService } from './integration-db-service';
import { VirtualGitFs } from './virtual-git-fs';

/**
 * P0/P1 guard for the Live Export run-store engine (docs/plans/2026-09-25-live-export-git-free-run-store):
 * the SAME Live Export — pulled records, sync mappings (record matching, a foreign key into another synced
 * table, a delete policy for orphans), destination — runs once through the classic engine (git + Postgres,
 * driven through the virtual git FS) and once through the run-store engine (an in-memory run store), and
 * the destination connector must receive exactly the same creates, updates (edit + backfill) and deletes.
 * The run-store run must also leave git and the Postgres file/sync/plan tables untouched.
 */

const DEST_CONNECTION_DISPLAY_NAME = 'Test Destination';
const TAGS_REMOTE_TABLE_ID = 'wp-tags';

/**
 * Source posts the pull could only partly read in the 'mixed changes, two posts only partly pulled' scenario:
 * each is stored without its `Title`, the way an Intercom conversation Intercom refused in full is stored without
 * its `conversation_parts`. `rec_post_match_0` matches destination post 200; `rec_post_create_1` has no
 * destination record yet.
 */
const PARTLY_PULLED_SOURCE_POST_IDS = ['rec_post_match_0', 'rec_post_create_1'];

interface ConnectorCallLog {
  creates: Array<{ table: string; record: Record<string, unknown> }>;
  updates: Array<{ table: string; record: Record<string, unknown>; changedFields: unknown }>;
  deletes: Array<{ table: string; id: unknown }>;
}

/** A destination connector that assigns deterministic ids (`created-<slug>`) and logs every write. */
function createRecordingDestinationConnector(
  callLog: ConnectorCallLog,
  options: { rejectCreateForSlug?: string } = {},
): Connector {
  const tableOf = (tableSpec: BaseJsonTableSpec) => tableSpec.name;
  return {
    service: Service.WORDPRESS,
    supportsFileUpload: false,
    getBatchSize: () => 2,
    getSuggestedRecordFileNames: (records: unknown[]) => records.map(() => undefined),
    extractConnectorErrorDetails: (error: unknown) => ({
      userFriendlyMessage: error instanceof Error ? error.message : String(error),
    }),
    createRecords: (tableSpec: BaseJsonTableSpec, files: ConnectorFile[]) => {
      if (options.rejectCreateForSlug && files.some((file) => file.slug === options.rejectCreateForSlug)) {
        return Promise.reject(new Error(`The destination rejected "${options.rejectCreateForSlug}"`));
      }
      for (const file of files) callLog.creates.push({ table: tableOf(tableSpec), record: structuredClone(file) });
      return Promise.resolve(files.map((file) => ({ ...file, id: `created-${String(file.slug)}` })));
    },
    updateRecords: (tableSpec: BaseJsonTableSpec, files: ConnectorFile[], changedFields?: unknown[]) => {
      files.forEach((file, index) =>
        callLog.updates.push({
          table: tableOf(tableSpec),
          record: structuredClone(file),
          changedFields: structuredClone(changedFields?.[index]),
        }),
      );
      return Promise.resolve(files);
    },
    deleteRecords: (tableSpec: BaseJsonTableSpec, files: ConnectorFile[]) => {
      for (const file of files) callLog.deletes.push({ table: tableOf(tableSpec), id: file[tableSpec.idPath] });
      return Promise.resolve();
    },
  } as unknown as Connector;
}

/** Order-independent, key-order-independent comparison form of a call log. */
function normalizeCallLog(callLog: ConnectorCallLog): { creates: string[]; updates: string[]; deletes: string[] } {
  const canonical = (value: unknown): string => JSON.stringify(sortKeysDeep(value));
  return {
    creates: callLog.creates.map(canonical).sort(),
    updates: callLog.updates.map(canonical).sort(),
    deletes: callLog.deletes.map(canonical).sort(),
  };
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeysDeep((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

describe('Live Export engines: classic vs run store produce the same publish', () => {
  let prisma: PrismaClient;
  let dbService: DbService;

  let orgId: string;
  let userId: string;
  let workbookId: WorkbookId;
  let syncId: SyncId;
  let destinationConnectorAccountId: string;
  let sourceTagsFolderId: DataFolderId;
  let destTagsFolderId: DataFolderId;
  let sourcePostsFolderId: DataFolderId;
  let destPostsFolderId: DataFolderId;

  const folderPathById = new Map<string, string>();

  const tableSpecByFolderPath = (): Record<string, BaseJsonTableSpec> =>
    ({
      'src-tags': { name: 'src-tags', idPath: 'id' },
      'dest-tags': {
        name: 'dest-tags',
        idPath: 'id',
        slugPath: dotPath('slug'),
        schema: { type: 'object', properties: { name: { type: 'string' }, slug: { type: 'string' } } },
      },
      'src-posts': { name: 'src-posts', idPath: 'id' },
      'dest-posts': {
        name: 'dest-posts',
        idPath: 'id',
        slugPath: dotPath('slug'),
        schema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            slug: { type: 'string' },
            primaryTagName: { type: 'string' },
            tags: {
              type: 'array',
              items: { type: 'string' },
              'x-scratch-foreign-key': { linkedTableId: TAGS_REMOTE_TABLE_ID },
            },
          },
        },
      },
    }) as unknown as Record<string, BaseJsonTableSpec>;

  /** Raw records as the connectors return them (the pull's input), per folder path, per scenario. */
  type Scenario =
    | 'mixed changes'
    | 'first export into an empty destination'
    | 'steady state (nothing changed)'
    | 'mixed changes, two posts only partly pulled';
  const connectorRecordsByFolderPath = (scenario: Scenario): Record<string, Record<string, unknown>[]> => {
    if (scenario === 'mixed changes, two posts only partly pulled') {
      const mixedChangesRecords = connectorRecordsByFolderPath('mixed changes');
      return {
        ...mixedChangesRecords,
        'src-posts': mixedChangesRecords['src-posts'].map((record) => {
          if (!PARTLY_PULLED_SOURCE_POST_IDS.includes(String(record.id))) return record;
          const fieldsThePullCouldRead = Object.fromEntries(
            Object.entries(record.fields as Record<string, unknown>).filter(([fieldName]) => fieldName !== 'Title'),
          );
          return { ...record, fields: fieldsThePullCouldRead };
        }),
      };
    }
    if (scenario === 'steady state (nothing changed)') {
      return {
        'src-tags': [
          { id: 'rec_a', fields: { Name: 'Alpha', Slug: 'alpha' } },
          { id: 'rec_b', fields: { Name: 'Beta', Slug: 'beta' } },
        ],
        'dest-tags': [
          { id: '1', name: 'Alpha', slug: 'alpha' },
          { id: '2', name: 'Beta', slug: 'beta' },
        ],
        'src-posts': [
          { id: 'rec_p', fields: { Title: 'Hello', Slug: 'hello', Tags: ['rec_a', 'rec_b'], PrimaryTag: 'rec_b' } },
        ],
        'dest-posts': [{ id: '10', title: 'Hello', slug: 'hello', primaryTagName: 'Beta', tags: ['1', '2'] }],
      };
    }
    const sourceRecords = {
      'src-tags': [
        { id: 'rec_tag_match_0', fields: { Name: 'Tag Match 0 Updated', Slug: 'tag-match-0' } },
        { id: 'rec_tag_match_1', fields: { Name: 'Tag Match 1 Updated', Slug: 'tag-match-1' } },
        { id: 'rec_tag_unchanged', fields: { Name: 'Tag Unchanged', Slug: 'tag-unchanged' } },
        { id: 'rec_tag_create_0', fields: { Name: 'Tag Create 0', Slug: 'tag-create-0' } },
        { id: 'rec_tag_create_1', fields: { Name: 'Tag Create 1', Slug: 'tag-create-1' } },
      ],
      'src-posts': [
        {
          id: 'rec_post_match_0',
          fields: {
            Title: 'Post Match 0 Updated',
            Slug: 'post-match-0',
            Tags: ['rec_tag_match_0', 'rec_tag_create_0'],
            PrimaryTag: 'rec_tag_create_0',
          },
        },
        {
          id: 'rec_post_match_1',
          fields: {
            Title: 'Post Match 1',
            Slug: 'post-match-1',
            Tags: ['rec_tag_match_1'],
            PrimaryTag: 'rec_tag_match_1',
          },
        },
        {
          id: 'rec_post_create_0',
          fields: {
            Title: 'Post Create 0',
            Slug: 'post-create-0',
            Tags: ['rec_tag_create_1', 'rec_tag_unchanged'],
            PrimaryTag: 'rec_tag_unchanged',
          },
        },
        { id: 'rec_post_create_1', fields: { Title: 'Post Create 1', Slug: 'post-create-1', Tags: [] } },
      ],
    };
    if (scenario === 'first export into an empty destination') {
      return { ...sourceRecords, 'dest-tags': [], 'dest-posts': [] };
    }
    return {
      ...sourceRecords,
      'dest-tags': [
        { id: '100', name: 'Tag Match 0', slug: 'tag-match-0' },
        { id: '101', name: 'Tag Match 1', slug: 'tag-match-1' },
        { id: '102', name: 'Tag Unchanged', slug: 'tag-unchanged' },
        { id: '900', name: 'Tag Orphan', slug: 'tag-orphan' },
      ],
      'dest-posts': [
        { id: '200', title: 'Post Match 0', slug: 'post-match-0', tags: ['100'] },
        // Only the tags (and looked-up tag name) change: FK-phase work.
        { id: '201', title: 'Post Match 1', slug: 'post-match-1', primaryTagName: 'Tag Match 1 Updated', tags: [] },
        { id: '950', title: 'Post Orphan', slug: 'post-orphan', tags: ['102'] },
        // No match key → never managed by the sync, but references the orphan tag that gets deleted.
        { id: '260', title: 'Manual Post', tags: ['900', '101'] },
      ],
    };
  };

  const tableMappings = (): SyncMappingV2['tableMappings'] => [
    {
      sourceDataFolderId: sourceTagsFolderId,
      destinationDataFolderId: destTagsFolderId,
      columnMappings: [
        { source: { kind: 'column', columnId: 'fields.Name' }, destinationColumnId: 'name' },
        { source: { kind: 'column', columnId: 'fields.Slug' }, destinationColumnId: 'slug' },
      ],
      recordMatching: { sourceColumnId: 'fields.Slug', destinationColumnId: 'slug' },
      unmatchedDestinationPolicy: { withMatchKey: 'delete', withoutMatchKey: 'ignore' },
    },
    {
      sourceDataFolderId: sourcePostsFolderId,
      destinationDataFolderId: destPostsFolderId,
      columnMappings: [
        { source: { kind: 'column', columnId: 'fields.Title' }, destinationColumnId: 'title' },
        { source: { kind: 'column', columnId: 'fields.Slug' }, destinationColumnId: 'slug' },
        {
          source: {
            kind: 'column',
            columnId: 'fields.Tags',
            transformer: { type: 'source_fk_to_dest_fk', options: { referencedDataFolderId: sourceTagsFolderId } },
          },
          destinationColumnId: 'tags',
        },
        {
          source: {
            kind: 'column',
            columnId: 'fields.PrimaryTag',
            transformer: {
              type: 'lookup_field',
              options: { referencedDataFolderId: sourceTagsFolderId, referencedFieldPath: 'fields.Name' },
            },
          },
          destinationColumnId: 'primaryTagName',
        },
      ],
      recordMatching: { sourceColumnId: 'fields.Slug', destinationColumnId: 'slug' },
      unmatchedDestinationPolicy: { withMatchKey: 'delete', withoutMatchKey: 'ignore' },
    },
  ];

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  beforeEach(async () => {
    dbService = createIntegrationTestDbService(prisma);
    orgId = createOrganizationId();
    userId = createUserId();
    workbookId = createWorkbookId();
    syncId = createSyncId();
    destinationConnectorAccountId = createConnectorAccountId();
    sourceTagsFolderId = createDataFolderId();
    destTagsFolderId = createDataFolderId();
    sourcePostsFolderId = createDataFolderId();
    destPostsFolderId = createDataFolderId();

    await prisma.organization.create({ data: { id: orgId, name: 'Equivalence Org', clerkId: `clerk_${orgId}` } });
    await prisma.user.create({
      data: { id: userId, email: `equivalence-${Date.now()}@test.com`, organizationId: orgId },
    });
    await prisma.workbook.create({
      data: {
        id: workbookId,
        name: 'Equivalence Workbook',
        userId,
        organizationId: orgId,
        managedBy: WorkbookManager.WS_EXPORT,
      },
    });
    await prisma.connectorAccount.create({
      data: {
        id: destinationConnectorAccountId,
        service: Service.WORDPRESS,
        displayName: DEST_CONNECTION_DISPLAY_NAME,
        workbookId,
        userId,
        encryptedCredentials: {},
      },
    });
    folderPathById.clear();
    const folders: Array<{ id: DataFolderId; path: string; connectorAccountId?: string; tableId: string[] }> = [
      { id: sourceTagsFolderId, path: 'src-tags', tableId: ['src-tags'] },
      {
        id: destTagsFolderId,
        path: 'dest-tags',
        connectorAccountId: destinationConnectorAccountId,
        tableId: [TAGS_REMOTE_TABLE_ID],
      },
      { id: sourcePostsFolderId, path: 'src-posts', tableId: ['src-posts'] },
      {
        id: destPostsFolderId,
        path: 'dest-posts',
        connectorAccountId: destinationConnectorAccountId,
        tableId: ['wp-posts'],
      },
    ];
    for (const folder of folders) {
      await prisma.dataFolder.create({
        data: {
          id: folder.id,
          name: folder.path,
          workbookId,
          path: `/${folder.path}`,
          tableId: folder.tableId,
          ...(folder.connectorAccountId ? { connectorAccountId: folder.connectorAccountId } : {}),
          ...(folder.connectorAccountId ? { connectorService: Service.WORDPRESS } : {}),
        },
      });
      folderPathById.set(folder.id, folder.path);
    }
    await prisma.sync.create({
      data: {
        id: syncId,
        displayName: 'Equivalence Sync',
        workbookId,
        mappings: { version: 1, tableMappings: [] },
        mappingsV2: { version: 2, tableMappings: tableMappings() } as never,
        syncTablePairs: {
          create: [
            {
              id: createSyncTablePairId(),
              sourceDataFolderId: sourceTagsFolderId,
              destinationDataFolderId: destTagsFolderId,
            },
            {
              id: createSyncTablePairId(),
              sourceDataFolderId: sourcePostsFolderId,
              destinationDataFolderId: destPostsFolderId,
            },
          ],
        },
      },
    });
  }, 30_000);

  afterEach(async () => {
    await prisma.liveExportRunFailure.deleteMany({ where: { pipelineId: { startsWith: 'le-rrn_equivalence' } } });
    await prisma.publishPlanOperation.deleteMany({ where: { plan: { workbookId } } });
    await prisma.publishPlan.deleteMany({ where: { workbookId } });
    await prisma.fileIndex.deleteMany({ where: { workbookId } });
    await prisma.fileReference.deleteMany({ where: { workbookId } });
    await prisma.syncMatchKeys.deleteMany({ where: { syncId } });
    await prisma.syncRemoteIdMapping.deleteMany({ where: { syncId } });
    await prisma.syncForeignKeyRecord.deleteMany({ where: { syncId } });
    await prisma.syncTablePair.deleteMany({ where: { syncId } });
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

  /** Services shared by both engines; the git service is a VirtualGitFs-backed mock. */
  function buildServices(vfs: VirtualGitFs, connector: Connector) {
    const specs = tableSpecByFolderPath();
    const scratchGitService = {
      resolveRepoId: jest.fn((id: string) => Promise.resolve(id)),
      resolveConnectionRepoPath: jest.fn((connectorAccountId: string) => Promise.resolve(connectorAccountId)),
      // The publish plan resolves its connection's repo scoped to the workbook (DEV-12337); same repo as above.
      resolveConnectionRepoPathScopedToWorkbook: jest.fn((_workbookId: string, connectorAccountId: string) =>
        Promise.resolve(connectorAccountId),
      ),
      resolveRepoPathForFolder: jest.fn((connectorAccountId: string) => Promise.resolve(connectorAccountId)),
      readSchemaFromGit: jest.fn((_repoId: string, folderPath: string) =>
        Promise.resolve(specs[folderPath.replace(/^\//, '')] ?? null),
      ),
      commitFilesToBranch: jest.fn((_repoId: string, branch: string, files: { path: string; content: string }[]) => {
        vfs.commitFiles(branch, files);
        return Promise.resolve({ created: [], updated: [], unchanged: [] });
      }),
      deleteFilesFromBranch: jest.fn((_repoId: string, branch: string, paths: string[]) => {
        vfs.deleteFiles(branch, paths);
        return Promise.resolve();
      }),
      getRepoStatus: jest.fn(() => Promise.resolve(vfs.getStatus())),
      readRepoFilesByFolder: jest.fn((_repoId: string, branch: string, paths: string[]) =>
        Promise.resolve(vfs.readFiles(branch, paths)),
      ),
      rebaseDirty: jest.fn(() => {
        vfs.rebaseDirty();
        return Promise.resolve();
      }),
      runGitGc: jest.fn().mockResolvedValue(undefined),
      writeSchemaToGit: jest.fn().mockResolvedValue(undefined),
      writeViewToGit: jest.fn().mockResolvedValue(undefined),
      getBranchHead: jest.fn().mockResolvedValue('sha'),
      writeTag: jest.fn().mockResolvedValue(undefined),
    } as unknown as ScratchGitService;

    const dataFolderService = {
      getFileContentsByFolderIdPaginated: jest.fn(
        (_wkb: WorkbookId, folderId: DataFolderId, _a: Actor, branch: string) => {
          const folderPath = folderPathById.get(folderId) ?? '';
          const files = vfs.getFilesByFolder(branch ?? DIRTY_BRANCH, folderPath);
          return Promise.resolve({ files: files.map((file) => ({ folderId, ...file })), nextCursor: undefined });
        },
      ),
    } as unknown as DataFolderService;

    const connectorsService = { getConnector: jest.fn().mockResolvedValue(connector) } as unknown as ConnectorsService;
    const credentialEncryptionService = {
      decryptCredentials: jest.fn().mockResolvedValue({}),
    } as unknown as CredentialEncryptionService;
    const fileIndexService = new FileIndexService(dbService);
    // The classic engine's table spec store: real Postgres, reading and mirroring through the mocked git service.
    const dataFolderTableSpecStore = createIntegrationTestDataFolderTableSpecStore({ prisma, scratchGitService });
    const schemaHelperService = new SchemaHelperService(
      dbService,
      dataFolderTableSpecStore,
      connectorsService,
      credentialEncryptionService,
    );
    // The classic plan build refreshes specs from the connector; this test's specs are static.
    jest.spyOn(schemaHelperService, 'refreshSchemasForConnection').mockResolvedValue(undefined);
    const refCleanerService = new RefCleanerService();
    const fileReferenceService = new FileReferenceService(dbService, refCleanerService, schemaHelperService);
    const syncService = new SyncService(
      dbService,
      dataFolderService,
      {} as PostHogService,
      {} as ScheduleService,
      scratchGitService,
      {} as never,
      {} as WorkbookService,
      dataFolderTableSpecStore,
    );
    const publishPlanBuildService = new PublishPlanBuildService(
      dbService,
      scratchGitService,
      fileIndexService,
      fileReferenceService,
      refCleanerService,
      schemaHelperService,
      new AssetIndexService(dbService),
      connectorsService,
      credentialEncryptionService,
    );
    const publishPlanRunService = new PublishPlanRunService(
      dbService,
      connectorsService,
      credentialEncryptionService,
      fileIndexService,
      fileReferenceService,
      scratchGitService,
      schemaHelperService,
      new RefResolverService(fileIndexService, dbService),
      { getBooleanFlag: jest.fn().mockResolvedValue(false) } as unknown as ExperimentsService,
      new RecreatedIdMapService(dbService),
      refCleanerService,
      new StubMetricsService(),
      dataFolderTableSpecStore,
    );
    const workbookEventService = { sendWorkbookEvent: jest.fn() } as unknown as WorkbookEventService;
    return {
      scratchGitService,
      dataFolderTableSpecStore,
      syncService,
      fileIndexService,
      fileReferenceService,
      refCleanerService,
      publishPlanBuildService,
      publishPlanRunService,
      workbookEventService,
    };
  }

  function createSyncJobHandler(
    services: ReturnType<typeof buildServices>,
    liveExportRunStoreDependencies?: ConstructorParameters<typeof SyncDataFoldersJobHandler>[9],
  ): SyncDataFoldersJobHandler {
    return new SyncDataFoldersJobHandler(
      prisma,
      services.syncService,
      services.workbookEventService,
      services.scratchGitService,
      {} as BullEnqueuerService,
      services.publishPlanBuildService,
      { trackSyncCompleted: jest.fn() } as unknown as PostHogService,
      new StubMetricsService(),
      { logEvent: jest.fn() } as unknown as AuditLogService,
      liveExportRunStoreDependencies,
    );
  }

  const noopJobPlumbing = () => ({
    progress: { publicProgress: { totalFilesSynced: 0, tables: [] }, jobProgress: {} } as never,
    abortSignal: new AbortController().signal,
    checkpoint: jest.fn().mockResolvedValue(undefined),
  });

  async function runClassicEngine(
    scenario: Scenario,
    options: { sourceRecordRemoteIdsToLeaveUnsyncedByDataFolderId?: Record<string, string[]> } = {},
  ): Promise<ConnectorCallLog> {
    const callLog: ConnectorCallLog = { creates: [], updates: [], deletes: [] };
    const vfs = new VirtualGitFs();
    const services = buildServices(vfs, createRecordingDestinationConnector(callLog));
    const records = connectorRecordsByFolderPath(scenario);
    const toFiles = (folderPath: string, idOf: (record: Record<string, unknown>) => string) =>
      records[folderPath].map((record) => ({
        path: `${folderPath}/${idOf(record)}.json`,
        content: JSON.stringify(record),
      }));
    // What a classic pull leaves behind: destination on main + dirty, sources on dirty, destination indexed.
    const destinationFiles = [
      ...toFiles('dest-tags', (record) => String(record.slug)),
      ...toFiles('dest-posts', (record) =>
        typeof record.slug === 'string' ? record.slug : `manual-${String(record.id)}`,
      ),
    ];
    vfs.seed(MAIN_BRANCH, destinationFiles);
    vfs.seed(DIRTY_BRANCH, destinationFiles);
    vfs.seed('merge_base', destinationFiles); // a real pull rebases dirty, leaving merge_base = main
    vfs.seed(DIRTY_BRANCH, [
      ...toFiles('src-tags', (record) => String(record.id)),
      ...toFiles('src-posts', (record) => String(record.id)),
    ]);
    const fileIndexEntries: FileIndexEntry[] = destinationFiles.map((file) => {
      const [folderPath, filename] = file.path.split('/');
      return {
        workbookId,
        folderPath,
        filename,
        recordId: String((JSON.parse(file.content) as { id: string }).id),
        connectorAccountId: destinationConnectorAccountId,
      };
    });
    await services.fileIndexService.upsertBatch(fileIndexEntries);
    const specs = tableSpecByFolderPath();
    await services.fileReferenceService.updateRefsForFiles(
      workbookId,
      MAIN_BRANCH,
      destinationFiles
        .filter((file) => file.path.startsWith('dest-posts/'))
        .map((file) => ({ path: file.path, content: JSON.parse(file.content) as JsonSafeObject })),
      specs['dest-posts'].schema,
    );

    await createSyncJobHandler(services).run({
      jobId: 'classic-sync',
      data: {
        type: 'sync-data-folders',
        workbookId,
        syncId,
        organizationId: orgId,
        userId,
        trigger: 'web',
        sourceRecordRemoteIdsToLeaveUnsyncedByDataFolderId: options.sourceRecordRemoteIdsToLeaveUnsyncedByDataFolderId,
      },
      ...noopJobPlumbing(),
    });
    const plan = await services.publishPlanBuildService.buildPipeline(
      workbookId,
      userId,
      destinationConnectorAccountId,
    );
    const runResult = await services.publishPlanRunService.runPipeline(plan.pipelineId);
    expect(runResult.status).toBe('completed');
    return callLog;
  }

  /** Pulls + sync of a run-store run; returns what's needed to run (and re-run) its publish. */
  async function pullAndSyncWithRunStoreEngine(
    scenario: Scenario,
    options: {
      rejectCreateForSlug?: string;
      routineRunId?: string;
      syncJobDeliveries?: number;
      sourceRecordRemoteIdsToLeaveUnsyncedByDataFolderId?: Record<string, string[]>;
    } = {},
  ) {
    const callLog: ConnectorCallLog = { creates: [], updates: [], deletes: [] };
    const vfs = new VirtualGitFs();
    const connector = createRecordingDestinationConnector(callLog, options);
    const services = buildServices(vfs, connector);
    // The run store engine keeps its specs in the run store; it must never reach the classic store (Postgres or
    // its git mirror). Pass-through spies, so a stray call still behaves and the test can assert on it.
    const dataFolderTableSpecStoreSpies = {
      readTableSpec: jest.spyOn(services.dataFolderTableSpecStore, 'readTableSpec'),
      readDefaultView: jest.spyOn(services.dataFolderTableSpecStore, 'readDefaultView'),
      writeTableSpec: jest.spyOn(services.dataFolderTableSpecStore, 'writeTableSpec'),
      writeDefaultView: jest.spyOn(services.dataFolderTableSpecStore, 'writeDefaultView'),
    };
    const runStoreClient = new InMemoryRunStoreClient();
    const runStoreKey = runStoreKeyForRoutineRun(options.routineRunId ?? 'rrn_equivalence');
    await runStoreClient.createOrClearRunStore(runStoreKey);

    // What the run-store pulls leave behind: every folder's spec and records in the run store.
    const pullSink = new RunStorePullSink(runStoreClient, runStoreKey);
    const specs = tableSpecByFolderPath();
    const records = connectorRecordsByFolderPath(scenario);
    for (const [folderId, folderPath] of folderPathById) {
      const connectorAccountId = folderPath.startsWith('dest-') ? destinationConnectorAccountId : null;
      await pullSink.storeFolderTableSpec(
        { dataFolderId: folderId, connectorAccountId, folderPath: `/${folderPath}` },
        specs[folderPath],
      );
      const folder = {
        dataFolder: {
          id: folderId,
          workbookId,
          name: folderPath,
          path: `/${folderPath}`,
          connectorService: 'x',
          connectorAccountId: connectorAccountId ?? '',
        },
        connector,
        tableSpec: specs[folderPath],
      } as unknown as PullSinkFolder;
      await pullSink.writeConnectorRecordPage(folder, records[folderPath] as ConnectorFile[]);
    }

    // More than one delivery simulates the queue redelivering the sync job (worker crash, redeploy).
    for (let delivery = 0; delivery < (options.syncJobDeliveries ?? 1); delivery++) {
      await createSyncJobHandler(services, { runStoreClient, db: dbService }).run({
        jobId: 'run-store-sync',
        data: {
          type: 'sync-data-folders',
          workbookId,
          syncId,
          organizationId: orgId,
          userId,
          trigger: 'routine',
          liveExportRunStoreKey: runStoreKey,
          sourceRecordRemoteIdsToLeaveUnsyncedByDataFolderId:
            options.sourceRecordRemoteIdsToLeaveUnsyncedByDataFolderId,
        },
        ...noopJobPlumbing(),
      });
    }

    /** Runs the run's publish step (call again to simulate a redelivered job); returns its terminal progress. */
    const runPublishStep = async (): Promise<{ status: string; failedCount: number; pipelineId: string }> => {
      const publishCheckpoint = jest.fn().mockResolvedValue(undefined);
      await new PublishJobHandler(
        services.publishPlanBuildService,
        services.publishPlanRunService,
        dbService,
        services.workbookEventService,
        undefined,
        undefined,
        {
          runStoreClient,
          refCleanerService: services.refCleanerService,
          fileReferenceService: services.fileReferenceService,
          fileIndexService: services.fileIndexService,
        },
      ).run({
        jobId: 'run-store-publish',
        data: {
          type: 'publish',
          workbookId,
          userId,
          connectorAccountId: destinationConnectorAccountId,
          runAfterPlan: true,
          trigger: 'routine',
          liveExportRunStoreKey: runStoreKey,
        } as never,
        progress: { publicProgress: {}, jobProgress: {} } as never,
        abortSignal: new AbortController().signal,
        checkpoint: publishCheckpoint,
      });
      const publishCheckpointCalls = publishCheckpoint.mock.calls as Array<
        [{ publicProgress: { status: string; failedCount: number; pipelineId: string } }]
      >;
      const [terminalCheckpoint] = publishCheckpointCalls[publishCheckpointCalls.length - 1];
      return terminalCheckpoint.publicProgress;
    };
    return { callLog, services, dataFolderTableSpecStoreSpies, runPublishStep };
  }

  const SCENARIOS: Scenario[] = [
    'mixed changes',
    'first export into an empty destination',
    'steady state (nothing changed)',
  ];

  it.each(SCENARIOS)(
    '%s: sends the destination the same writes, and the run store touches no git or file tables',
    async (scenario) => {
      const classicCallLog = await runClassicEngine(scenario);

      const postgresRowCountsBefore = await countPerRecordPostgresRows();
      const runStoreRun = await pullAndSyncWithRunStoreEngine(scenario);
      const terminalProgress = await runStoreRun.runPublishStep();
      const postgresRowCountsAfter = await countPerRecordPostgresRows();

      expect(terminalProgress).toMatchObject({ status: 'completed', failedCount: 0 });
      assertScenarioFixtureIsExercised(scenario, classicCallLog);

      // The run-store engine sends exactly the same writes...
      expect(normalizeCallLog(runStoreRun.callLog)).toEqual(normalizeCallLog(classicCallLog));

      // ...without any git or Postgres per-record state.
      for (const gitMethod of [
        'commitFilesToBranch',
        'deleteFilesFromBranch',
        'getRepoStatus',
        'readRepoFilesByFolder',
        'rebaseDirty',
        'runGitGc',
        'readSchemaFromGit',
        'writeSchemaToGit',
      ] as const) {
        expect(runStoreRun.services.scratchGitService[gitMethod]).not.toHaveBeenCalled();
      }
      for (const dataFolderTableSpecStoreSpy of Object.values(runStoreRun.dataFolderTableSpecStoreSpies)) {
        expect(dataFolderTableSpecStoreSpy).not.toHaveBeenCalled();
      }
      expect(postgresRowCountsAfter).toEqual(postgresRowCountsBefore);
    },
    60_000,
  );

  it('run store: a redelivered sync job recomputes from the pulled records and creates nothing twice', async () => {
    const singleDelivery = await pullAndSyncWithRunStoreEngine('mixed changes');
    await singleDelivery.runPublishStep();
    const redelivered = await pullAndSyncWithRunStoreEngine('mixed changes', { syncJobDeliveries: 2 });
    await redelivered.runPublishStep();

    expect(normalizeCallLog(redelivered.callLog)).toEqual(normalizeCallLog(singleDelivery.callLog));
  }, 60_000);

  it('run store: a redelivered publish job resumes its plan and sends nothing twice', async () => {
    const runStoreRun = await pullAndSyncWithRunStoreEngine('mixed changes');
    await runStoreRun.runPublishStep();
    const writesAfterFirstDelivery = normalizeCallLog(runStoreRun.callLog);

    const secondDelivery = await runStoreRun.runPublishStep();

    expect(secondDelivery).toMatchObject({ status: 'completed', failedCount: 0 });
    expect(normalizeCallLog(runStoreRun.callLog)).toEqual(writesAfterFirstDelivery);
  }, 60_000);

  it('run store: a record the destination rejects is reported and kept in LiveExportRunFailure', async () => {
    const routineRunId = `rrn_equivalence${Date.now()}`;
    await prisma.routineRun.create({
      data: {
        id: routineRunId,
        workbookId,
        routineFilePath: 'routines/run.yaml',
        routineName: 'run',
        trigger: 'manual',
      },
    });
    const runStoreRun = await pullAndSyncWithRunStoreEngine('mixed changes', {
      rejectCreateForSlug: 'tag-create-1',
      routineRunId,
    });

    const terminalProgress = await runStoreRun.runPublishStep();

    expect(terminalProgress).toMatchObject({ status: 'completed', failedCount: 1 });
    const failures = await prisma.liveExportRunFailure.findMany({ where: { routineRunId } });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      pipelineId: terminalProgress.pipelineId,
      filePath: 'dest-tags/tag-create-1.json',
      phase: 'create',
    });
    expect(failures[0].error).toContain('The destination rejected "tag-create-1"');
    // The operations list serves the failures, honouring its filters and pagination.
    const crudService = new PublishPlanCrudService(dbService, {} as BullEnqueuerService);
    const listedOperations = await crudService.listPublishPlanOperations(terminalProgress.pipelineId, {
      phase: 'create',
      pageSize: 10,
    });
    expect(listedOperations).toMatchObject({
      total: 1,
      page: 1,
      pageSize: 10,
      data: [{ filePath: 'dest-tags/tag-create-1.json', status: 'failed-batch' }],
    });
    expect(await crudService.listPublishPlanOperations(terminalProgress.pipelineId, { phase: 'edit' })).toMatchObject({
      total: 0,
      data: [],
    });
    await prisma.routineRun.delete({ where: { id: routineRunId } });
  }, 60_000);

  describe('source records the pull could only partly read', () => {
    const PARTLY_PULLED_SCENARIO: Scenario = 'mixed changes, two posts only partly pulled';
    const leaveOutThePartlyPulledPosts = () => ({ [sourcePostsFolderId]: [...PARTLY_PULLED_SOURCE_POST_IDS] });
    const writesToDestinationPost = (callLog: ConnectorCallLog, destinationPostId: string) => [
      ...callLog.updates.filter((call) => call.table === 'dest-posts' && call.record.id === destinationPostId),
      ...callLog.deletes.filter((call) => call.table === 'dest-posts' && call.id === destinationPostId),
    ];
    const createdSlugs = (callLog: ConnectorCallLog) => callLog.creates.map((call) => call.record.slug);

    it('both engines leave them out of the sync and the publish, and the rest of the export still goes out', async () => {
      const classicCallLog = await runClassicEngine(PARTLY_PULLED_SCENARIO, {
        sourceRecordRemoteIdsToLeaveUnsyncedByDataFolderId: leaveOutThePartlyPulledPosts(),
      });
      const runStoreRun = await pullAndSyncWithRunStoreEngine(PARTLY_PULLED_SCENARIO, {
        sourceRecordRemoteIdsToLeaveUnsyncedByDataFolderId: leaveOutThePartlyPulledPosts(),
      });
      const terminalProgress = await runStoreRun.runPublishStep();

      expect(terminalProgress).toMatchObject({ status: 'completed', failedCount: 0 });
      expect(normalizeCallLog(runStoreRun.callLog)).toEqual(normalizeCallLog(classicCallLog));
      // Destination post 200 keeps its title: its partly-pulled source post neither updates it nor (despite the
      // delete policy) deletes it...
      expect(writesToDestinationPost(classicCallLog, '200')).toEqual([]);
      // ...and the partly-pulled new post is not created.
      expect(createdSlugs(classicCallLog)).not.toContain('post-create-1');
      // Everything else in the export still goes out.
      expect(createdSlugs(classicCallLog).sort()).toEqual(['post-create-0', 'tag-create-0', 'tag-create-1']);
      expect(classicCallLog.deletes).toEqual(
        expect.arrayContaining([
          { table: 'dest-tags', id: '900' },
          { table: 'dest-posts', id: '950' },
        ]),
      );
    }, 60_000);

    it('without the leave-out list, the partial copies would clear the matched post and create the new one', async () => {
      const classicCallLog = await runClassicEngine(PARTLY_PULLED_SCENARIO);

      const titlesSentToDestinationPost200 = classicCallLog.updates
        .filter((call) => call.table === 'dest-posts' && call.record.id === '200')
        .map((call) => call.record.title);
      expect(titlesSentToDestinationPost200).toContain(null);
      expect(createdSlugs(classicCallLog)).toContain('post-create-1');
    }, 60_000);
  });

  function assertScenarioFixtureIsExercised(scenario: Scenario, classicCallLog: ConnectorCallLog): void {
    if (scenario === 'steady state (nothing changed)') {
      expect(classicCallLog).toEqual({ creates: [], updates: [], deletes: [] });
      return;
    }
    if (scenario === 'first export into an empty destination') {
      expect(classicCallLog.creates.length).toBe(9); // 5 tags + 4 posts
      expect(classicCallLog.deletes).toEqual([]);
      return;
    }
    expect(classicCallLog.creates.length).toBe(4); // 2 tags + 2 posts
    expect(classicCallLog.deletes).toEqual(
      expect.arrayContaining([
        { table: 'dest-tags', id: '900' },
        { table: 'dest-posts', id: '950' },
      ]),
    );
    const destinationPostUpdates = classicCallLog.updates.filter((call) => call.table === 'dest-posts');
    // A record the sync never touched loses its reference to the deleted tag.
    expect(
      destinationPostUpdates.filter((call) => call.record.id === '260').map((call) => call.changedFields),
    ).toContainEqual({ tags: ['101'] });
    // A foreign key to a tag created in the same run is backfilled with the id the create returned,
    // and a lookup_field reads the referenced source record.
    expect(destinationPostUpdates.flatMap((call) => (call.record.tags as unknown[] | undefined) ?? [])).toContain(
      'created-tag-create-0',
    );
    expect([...classicCallLog.creates, ...classicCallLog.updates].map((call) => call.record.primaryTagName)).toEqual(
      expect.arrayContaining(['Tag Create 0', 'Tag Unchanged']),
    );
  }

  async function countPerRecordPostgresRows() {
    return {
      fileIndex: await prisma.fileIndex.count({ where: { workbookId } }),
      fileReference: await prisma.fileReference.count({ where: { workbookId } }),
      syncMatchKeys: await prisma.syncMatchKeys.count({ where: { syncId } }),
      syncRemoteIdMapping: await prisma.syncRemoteIdMapping.count({ where: { syncId } }),
      syncForeignKeyRecord: await prisma.syncForeignKeyRecord.count({ where: { syncId } }),
      publishPlanOperation: await prisma.publishPlanOperation.count({ where: { plan: { workbookId } } }),
    };
  }
});
