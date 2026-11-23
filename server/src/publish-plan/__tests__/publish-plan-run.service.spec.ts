/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { ConnectorErrorCode } from '@spinner/shared-types';
import { CredentialEncryptionService } from '../../credential-encryption/credential-encryption.service';
import { DbService } from '../../db/db.service';
import { ExperimentsService } from '../../experiments/experiments.service';
import { CustomMetric } from '../../metrics/custom-metrics';
import { CustomMetricsService } from '../../metrics/custom-metrics-service';
import { Connector } from '../../remote-service/connectors/connector';
import { ConnectorsService } from '../../remote-service/connectors/connectors.service';
import { PartialBatchCreateError } from '../../remote-service/connectors/error';
import { ScratchGitService } from '../../scratch-git/scratch-git.service';
import { DataFolderTableSpecStoreService } from '../../workbook/table-spec-store/data-folder-table-spec-store.service';
import type { TableSpecStore } from '../../workbook/table-spec-store/table-spec-store';
import {
  clearWorkerProcessShutdownStarted,
  markWorkerProcessShutdownStarted,
} from '../../worker/worker-process-shutdown-state';
import { FileIndexService } from '../file-index.service';
import { FileReferenceService } from '../file-reference.service';
import { PublishPlanRunService } from '../publish-plan-run.service';
import { RecreatedIdMapService } from '../recreated-id-map.service';
import { RefCleanerService } from '../ref-cleaner.service';
import { RefResolverService } from '../ref-resolver.service';
import { ClassicPublishPlanRunStorage } from '../run-storage/classic-publish-plan-run-storage';
import type { PublishPlanRunStorage, PublishPseudoRefResolver } from '../run-storage/publish-plan-run-storage-ports';
import { SchemaHelperService } from '../schema-helper.service';

const WORKBOOK_ID = 'wkb_test';
const PLAN_ID = 'plan_test';
const CONNECTOR_ACCOUNT_ID = 'ca_test';
const REPO_ID = 'wkb_test';
const DATA_FOLDER_ID = 'df_1';

/**
 * Creates a minimal mock connector with jest spies on all required methods.
 */
function makeMockConnector() {
  return {
    service: 'AIRTABLE',
    getBatchSize: jest.fn().mockReturnValue(100),
    updateRecords: jest.fn().mockResolvedValue(undefined),
    createRecords: jest.fn().mockResolvedValue([]),
    deleteRecords: jest.fn().mockResolvedValue(undefined),
    // Default: no suggestion for any record (the rename phase then falls back
    // to the record id). The rename tests override this per case.
    getSuggestedRecordFileNames: jest.fn((records: unknown[]) => records.map(() => undefined)),
    // Default passthrough: surface the raw message. Tests that exercise the
    // failure path override this to assert the extracted, user-facing reason
    // (e.g. a service's validation message) is what gets persisted/logged.
    extractConnectorErrorDetails: jest.fn((error: unknown) => ({
      userFriendlyMessage: error instanceof Error ? error.message : String(error),
    })),
  } as unknown as jest.Mocked<Connector>;
}

function makeDbMock() {
  return {
    client: {
      publishPlan: {
        findUnique: jest.fn().mockResolvedValue({
          id: PLAN_ID,
          workbookId: WORKBOOK_ID,
          userId: 'user_test',
          branchName: 'publish/user_test/plan_test',
          status: 'planned',
          connectorAccountId: CONNECTOR_ACCOUNT_ID,
          createdAt: new Date(),
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      publishPlanOperation: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
        // The dispatch loop reads a folder's operation IDs first and then reads
        // each batch's full rows by ID, so `findMany` mocks must serve both
        // shapes. `findUnique` backs the same two-step read in the failed-batch
        // retry loop.
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({}),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      connectorAccount: {
        findUnique: jest.fn().mockResolvedValue({
          id: CONNECTOR_ACCOUNT_ID,
          service: 'AIRTABLE',
          encryptedCredentials: {},
        }),
      },
      // The dispatch loop reads each folder's options to hand to the connector's
      // write calls (e.g. Notion `excludePageContent`).
      dataFolder: {
        findUnique: jest.fn().mockResolvedValue({ options: null }),
      },
      fileReference: {
        deleteMany: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({}),
      },
      fileIndex: {
        deleteMany: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
      user: {
        // runPipeline looks up the plan's user to scope the
        // UPDATE_RECORDS_RETURNS_REMOTE_DATA flag eval. Returning null is
        // benign — the flag evaluates to false and the old (sent-payload)
        // path is taken, which is what these tests assert against.
        findUnique: jest.fn().mockResolvedValue(null),
      },
    },
  };
}

describe('PublishPlanRunService', () => {
  let service: PublishPlanRunService;
  let db: ReturnType<typeof makeDbMock>;
  let connector: ReturnType<typeof makeMockConnector>;
  let connectorsService: jest.Mocked<ConnectorsService>;
  let scratchGitService: jest.Mocked<ScratchGitService>;
  let fileIndexService: jest.Mocked<FileIndexService>;
  let fileReferenceService: jest.Mocked<FileReferenceService>;
  let refResolverService: jest.Mocked<RefResolverService>;
  let refCleanerService: jest.Mocked<RefCleanerService>;
  let schemaService: jest.Mocked<SchemaHelperService>;
  let experimentsService: jest.Mocked<ExperimentsService>;
  let recreatedIdMapService: jest.Mocked<RecreatedIdMapService>;
  let metricsService: { logValue: jest.Mock };
  let dataFolderTableSpecStore: jest.Mocked<DataFolderTableSpecStoreService>;

  beforeEach(async () => {
    db = makeDbMock();
    connector = makeMockConnector();

    connectorsService = {
      getConnector: jest.fn().mockReturnValue(connector),
    } as unknown as jest.Mocked<ConnectorsService>;

    scratchGitService = {
      resolveConnectionRepoPath: jest.fn().mockResolvedValue(REPO_ID),
      commitFilesToBranch: jest.fn().mockResolvedValue({ created: [], updated: [], unchanged: [] }),
      deleteFilesFromBranch: jest.fn().mockResolvedValue(undefined),
      rebaseDirty: jest.fn().mockResolvedValue(undefined),
      renameFiles: jest.fn().mockResolvedValue(undefined),
      readRepoFilesFromFolder: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<ScratchGitService>;

    fileIndexService = {
      getRecordId: jest.fn().mockResolvedValue('rec_123'),
      upsertBatch: jest.fn().mockResolvedValue(undefined),
      listFilenamesForFolder: jest.fn().mockResolvedValue([]),
      getRecordIdsByFilenamesInFolder: jest.fn().mockResolvedValue(new Map()),
    } as unknown as jest.Mocked<FileIndexService>;

    fileReferenceService = {
      updateRefsForFiles: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<FileReferenceService>;

    refResolverService = {
      resolveBatchPseudoRefs: jest.fn().mockImplementation((_wkbId, contents) => Promise.resolve(contents)),
      // Default: every pseudo-ref resolves (empty unresolvable set), so the backfill drop
      // path is a noop unless a test models a failed relation target (DEV-10954).
      findUnresolvablePseudoRefs: jest.fn().mockResolvedValue(new Set<string>()),
    } as unknown as jest.Mocked<RefResolverService>;

    const credentialService = {
      decryptCredentials: jest.fn().mockResolvedValue({ apiKey: 'test' }),
    } as unknown as jest.Mocked<CredentialEncryptionService>;

    schemaService = {
      getTableSpec: jest.fn().mockResolvedValue({
        name: 'Articles',
        idPath: 'id',
        schema: {},
        id: { wsId: 'articles', remoteId: ['base1', 'tbl1'] },
        slug: 'articles',
      }),
      getTableSpecById: jest.fn().mockResolvedValue({
        name: 'Articles',
        idPath: 'id',
        schema: {},
        id: { wsId: 'articles', remoteId: ['base1', 'tbl1'] },
        slug: 'articles',
      }),
    } as unknown as jest.Mocked<SchemaHelperService>;

    experimentsService = {
      // Flag-off by default in these tests — they assert against the
      // sent-payload commit path, not the connector-returned-rows path.
      getBooleanFlag: jest.fn().mockResolvedValue(false),
    } as unknown as jest.Mocked<ExperimentsService>;

    // Recreate flow defaults: lookups empty + upsert noop; the recreate
    // sentinel tests assert against this mock directly.
    recreatedIdMapService = {
      upsert: jest.fn().mockResolvedValue(undefined),
      resolveLatest: jest.fn().mockResolvedValue(null),
      resolveLatestBatch: jest.fn().mockResolvedValue(new Map()),
      resolveFkTargetFolders: jest.fn().mockResolvedValue(new Map()),
      deleteForWorkbook: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<RecreatedIdMapService>;

    refCleanerService = {
      extractForeignKeyPaths: jest.fn().mockReturnValue([]),
      rewriteForeignKeyValues: jest.fn().mockImplementation((content: unknown) => content),
      // Default: passthrough (nothing to strip). The backfill drop test overrides this.
      stripSpecificPseudoRefs: jest.fn().mockImplementation((content: unknown) => content),
    } as unknown as jest.Mocked<RefCleanerService>;

    // Spy-backed stub so tests can assert the anomaly counter is (or isn't) emitted.
    metricsService = { logValue: jest.fn() };

    // The classic run's default table spec store. `schemaService` is mocked, so the store is only passed through.
    dataFolderTableSpecStore = {
      readTableSpec: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<DataFolderTableSpecStoreService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PublishPlanRunService,
        { provide: DbService, useValue: db },
        { provide: ConnectorsService, useValue: connectorsService },
        { provide: CredentialEncryptionService, useValue: credentialService },
        { provide: ScratchGitService, useValue: scratchGitService },
        { provide: FileIndexService, useValue: fileIndexService },
        { provide: FileReferenceService, useValue: fileReferenceService },
        { provide: RefResolverService, useValue: refResolverService },
        { provide: SchemaHelperService, useValue: schemaService },
        { provide: ExperimentsService, useValue: experimentsService },
        { provide: RecreatedIdMapService, useValue: recreatedIdMapService },
        { provide: RefCleanerService, useValue: refCleanerService },
        { provide: CustomMetricsService, useValue: metricsService },
        { provide: DataFolderTableSpecStoreService, useValue: dataFolderTableSpecStore },
      ],
    }).compile();

    service = module.get<PublishPlanRunService>(PublishPlanRunService);
  });

  /**
   * Sets up DB mocks so `runPipeline` processes the given entries in the edit phase.
   */
  function setupEditPhaseEntries(
    entries: Array<{
      id: string;
      filePath: string;
      content: Record<string, unknown>;
      changedFields?: Record<string, unknown> | null;
      remoteRecordId?: string | null;
    }>,
  ) {
    // count() calls for phase totals
    db.client.publishPlanOperation.count.mockImplementation((args: { where: { phase?: string; status?: string } }) => {
      if (args?.where?.phase === 'edit') return Promise.resolve(entries.length);
      return Promise.resolve(0);
    });

    const pendingRows = entries.map((e) => ({
      ...e,
      planId: PLAN_ID,
      phase: 'edit',
      dataFolderId: DATA_FOLDER_ID,
      status: 'pending',
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    // findMany for pending entries, distinct folders
    db.client.publishPlanOperation.findMany.mockImplementation(
      (args: {
        where?: { phase?: string; status?: string; id?: { in: string[] } };
        distinct?: string[];
        select?: Record<string, boolean>;
      }) => {
        // distinct dataFolderIds query
        if (args?.distinct) {
          return Promise.resolve([{ dataFolderId: DATA_FOLDER_ID }]);
        }
        // Per-batch read of full rows by the IDs the folder scan collected.
        if (args?.where?.id?.in) {
          const requestedIds = new Set(args.where.id.in);
          return Promise.resolve(pendingRows.filter((row) => requestedIds.has(row.id)));
        }
        // actual entries for the edit phase (also serves the ID-only folder scan)
        if (args?.where?.phase === 'edit' && args?.where?.status === 'pending') {
          return Promise.resolve(pendingRows);
        }
        // failed-batch retry query
        if (args?.where?.status === 'failed-batch') {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      },
    );

    // groupBy for final status
    db.client.publishPlanOperation.groupBy.mockResolvedValue(
      entries.map(() => ({ status: 'success', phase: 'edit', _count: 1 })),
    );
  }

  /**
   * Sets the table spec's `idPath` for both schema lookups. Used by
   * the flat-vs-nested id-path tests; `'id'` matches every flat-id connector,
   * `'id.record_id'` matches Attio's nested id triple.
   */
  function setTableSpecIdColumnRemoteId(idColumnRemoteIdDotPath: string) {
    const tableSpecWithIdPath = {
      name: 'Articles',
      idPath: idColumnRemoteIdDotPath,
      schema: {},
      id: { wsId: 'articles', remoteId: ['base1', 'tbl1'] },
      slug: 'articles',
    };
    jest.mocked(schemaService.getTableSpec).mockResolvedValue(tableSpecWithIdPath as never);
    jest.mocked(schemaService.getTableSpecById).mockResolvedValue(tableSpecWithIdPath as never);
  }

  /**
   * Sets up DB mocks so `runPipeline` processes the given entries in the given
   * phase. Generalization of `setupEditPhaseEntries` for create/delete.
   */
  function setupPhaseEntries(
    phase: 'edit' | 'create' | 'delete' | 'backfill' | 'rename-files',
    entries: Array<{
      id: string;
      filePath: string;
      content: Record<string, unknown> | null;
      changedFields?: Record<string, unknown> | null;
      remoteRecordId?: string | null;
    }>,
  ) {
    db.client.publishPlanOperation.count.mockImplementation((args: { where: { phase?: string; status?: string } }) => {
      if (args?.where?.phase === phase) return Promise.resolve(entries.length);
      return Promise.resolve(0);
    });

    const pendingRows = entries.map((e) => ({
      ...e,
      planId: PLAN_ID,
      phase,
      dataFolderId: DATA_FOLDER_ID,
      status: 'pending',
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));

    db.client.publishPlanOperation.findMany.mockImplementation(
      (args: {
        where?: { phase?: string; status?: string; id?: { in: string[] } };
        distinct?: string[];
        select?: Record<string, boolean>;
      }) => {
        if (args?.distinct) {
          return Promise.resolve([{ dataFolderId: DATA_FOLDER_ID }]);
        }
        // Per-batch read of full rows by the IDs the folder scan collected.
        if (args?.where?.id?.in) {
          const requestedIds = new Set(args.where.id.in);
          return Promise.resolve(pendingRows.filter((row) => requestedIds.has(row.id)));
        }
        if (args?.where?.phase === phase && args?.where?.status === 'pending') {
          return Promise.resolve(pendingRows);
        }
        if (args?.where?.status === 'failed-batch') {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      },
    );

    db.client.publishPlanOperation.groupBy.mockResolvedValue(
      entries.map(() => ({ status: 'success', phase, _count: 1 })),
    );
  }

  describe('remote-id path handling (flat vs nested idPath)', () => {
    describe('dispatchCreateBatch — FileIndex row extraction', () => {
      it('flat id path: indexes the created record by its top-level string id (regression for every flat-id connector)', async () => {
        setTableSpecIdColumnRemoteId('id');
        jest.mocked(connector.createRecords).mockResolvedValue([{ id: 'rec_created_9', title: 'T' }]);
        setupPhaseEntries('create', [
          { id: 'op_1', filePath: 'articles/new.json', content: { title: 'T' }, remoteRecordId: null },
        ]);

        await service.runPipeline(PLAN_ID);

        expect(fileIndexService.upsertBatch).toHaveBeenCalledWith([
          {
            workbookId: WORKBOOK_ID,
            folderPath: 'articles',
            filename: 'new.json',
            recordId: 'rec_created_9',
            connectorAccountId: CONNECTOR_ACCOUNT_ID,
          },
        ]);
      });

      it('flat id path: coerces a numeric id (e.g. Postgres serial) to a string index key', async () => {
        setTableSpecIdColumnRemoteId('id');
        jest.mocked(connector.createRecords).mockResolvedValue([{ id: 42, title: 'T' }]);
        setupPhaseEntries('create', [
          { id: 'op_1', filePath: 'articles/new.json', content: { title: 'T' }, remoteRecordId: null },
        ]);

        await service.runPipeline(PLAN_ID);

        expect(fileIndexService.upsertBatch).toHaveBeenCalledWith([
          {
            workbookId: WORKBOOK_ID,
            folderPath: 'articles',
            filename: 'new.json',
            recordId: '42',
            connectorAccountId: CONNECTOR_ACCOUNT_ID,
          },
        ]);
      });

      it('nested id path: indexes the created record by the id nested inside the id object (the Attio bug)', async () => {
        setTableSpecIdColumnRemoteId('id.record_id');
        jest
          .mocked(connector.createRecords)
          .mockResolvedValue([{ id: { workspace_id: 'ws1', record_id: 'uuid-nested-1' }, values: {} }]);
        setupPhaseEntries('create', [
          { id: 'op_1', filePath: 'Companies/new.json', content: { values: {} }, remoteRecordId: null },
        ]);

        await service.runPipeline(PLAN_ID);

        expect(fileIndexService.upsertBatch).toHaveBeenCalledWith([
          {
            workbookId: WORKBOOK_ID,
            folderPath: 'Companies',
            filename: 'new.json',
            recordId: 'uuid-nested-1',
            connectorAccountId: CONNECTOR_ACCOUNT_ID,
          },
        ]);
      });

      it('writes no index row (and does not throw) when the value at the id path is not a scalar', async () => {
        setTableSpecIdColumnRemoteId('id');
        jest.mocked(connector.createRecords).mockResolvedValue([{ id: { unexpected: 'object' }, title: 'T' }]);
        setupPhaseEntries('create', [
          { id: 'op_1', filePath: 'articles/new.json', content: { title: 'T' }, remoteRecordId: null },
        ]);

        await service.runPipeline(PLAN_ID);

        expect(fileIndexService.upsertBatch).not.toHaveBeenCalled();
      });
    });

    describe('dispatchCreateBatch — pending-publish sentinel stripping', () => {
      it('flat id path: strips the sentinel id before the connector create and does not mutate the entry content', async () => {
        setTableSpecIdColumnRemoteId('id');
        const entryContentWithSentinelId = { id: 'scratch_pending_publish_abc123', title: 'T' };
        setupPhaseEntries('create', [
          { id: 'op_1', filePath: 'articles/new.json', content: entryContentWithSentinelId, remoteRecordId: null },
        ]);

        await service.runPipeline(PLAN_ID);

        expect(connector.createRecords).toHaveBeenCalledTimes(1);
        const [, operations] = jest.mocked(connector.createRecords).mock.calls[0];
        expect(operations[0]).toEqual({ title: 'T' });
        // The shared plan-entry content must not be mutated by the strip.
        expect(entryContentWithSentinelId.id).toBe('scratch_pending_publish_abc123');
      });

      it('nested id path: strips the sentinel at the nested path and does not mutate the shared nested id object', async () => {
        setTableSpecIdColumnRemoteId('id.record_id');
        const sharedNestedIdObject = { workspace_id: 'ws1', record_id: 'scratch_pending_publish_xyz' };
        const entryContentWithSentinelId = { id: sharedNestedIdObject, values: { a: 1 } };
        setupPhaseEntries('create', [
          { id: 'op_1', filePath: 'Companies/new.json', content: entryContentWithSentinelId, remoteRecordId: null },
        ]);

        await service.runPipeline(PLAN_ID);

        expect(connector.createRecords).toHaveBeenCalledTimes(1);
        const [, operations] = jest.mocked(connector.createRecords).mock.calls[0];
        expect(operations[0]).toEqual({ id: { workspace_id: 'ws1' }, values: { a: 1 } });
        // Deep-clone guard: stripping through a shallow copy would have
        // deleted record_id from this shared object too.
        expect(sharedNestedIdObject.record_id).toBe('scratch_pending_publish_xyz');
      });

      it('flat id path: a real (non-sentinel) id passes through to the connector unchanged', async () => {
        setTableSpecIdColumnRemoteId('id');
        setupPhaseEntries('create', [
          {
            id: 'op_1',
            filePath: 'articles/new.json',
            content: { id: 'rec_real_1', title: 'T' },
            remoteRecordId: null,
          },
        ]);

        await service.runPipeline(PLAN_ID);

        const [, operations] = jest.mocked(connector.createRecords).mock.calls[0];
        expect(operations[0]).toEqual({ id: 'rec_real_1', title: 'T' });
      });

      it('a record with no id field at all (the normal CLI create) passes through untouched', async () => {
        setTableSpecIdColumnRemoteId('id.record_id');
        const contentWithoutAnyId = { values: { name: 'fresh' } };
        setupPhaseEntries('create', [
          { id: 'op_1', filePath: 'Companies/new.json', content: contentWithoutAnyId, remoteRecordId: null },
        ]);

        await service.runPipeline(PLAN_ID);

        const [, operations] = jest.mocked(connector.createRecords).mock.calls[0];
        expect(operations[0]).toEqual({ values: { name: 'fresh' } });
      });

      it('nested id path: stripping the only leaf prunes the empty id husk from the payload', async () => {
        setTableSpecIdColumnRemoteId('id.record_id');
        setupPhaseEntries('create', [
          {
            id: 'op_1',
            filePath: 'Companies/new.json',
            content: { id: { record_id: 'scratch_pending_publish_solo' }, values: { a: 1 } },
            remoteRecordId: null,
          },
        ]);

        await service.runPipeline(PLAN_ID);

        const [, operations] = jest.mocked(connector.createRecords).mock.calls[0];
        // No `id: {}` husk left behind for the connector to choke on.
        expect(operations[0]).toEqual({ values: { a: 1 } });
      });
    });

    describe('dispatchCreateBatch — revert-recreate sentinel (RecreatedIdMap remap)', () => {
      it('flat id path: strips the recreate sentinel and upserts the (prior → new) remap row', async () => {
        setTableSpecIdColumnRemoteId('id');
        jest.mocked(connector.createRecords).mockResolvedValue([{ id: 'rec_new_1', title: 'T' }]);
        setupPhaseEntries('create', [
          {
            id: 'op_1',
            filePath: 'articles/reverted.json',
            content: { id: 'scratch_pending_recreate_old_1', title: 'T' },
            remoteRecordId: null,
          },
        ]);

        await service.runPipeline(PLAN_ID);

        const [, operations] = jest.mocked(connector.createRecords).mock.calls[0];
        expect(operations[0]).toEqual({ title: 'T' });
        expect(recreatedIdMapService.upsert).toHaveBeenCalledWith({
          workbookId: WORKBOOK_ID,
          connectorAccountId: CONNECTOR_ACCOUNT_ID,
          folder: 'articles',
          priorRemoteId: 'old_1',
          newRemoteId: 'rec_new_1',
        });
      });

      it('nested id path, ROOT sentinel shape (what the CLI revert actually writes): detected, stripped, and remapped', async () => {
        // scratch-git-2's `replace_pk_with_recreate_sentinel` swaps the whole
        // nested id object for a sentinel STRING at the path root:
        // `{ id: "scratch_pending_recreate_<old>" }` — not at the leaf.
        setTableSpecIdColumnRemoteId('id.record_id');
        jest
          .mocked(connector.createRecords)
          .mockResolvedValue([{ id: { workspace_id: 'ws1', record_id: 'uuid-new-2' }, values: {} }]);
        setupPhaseEntries('create', [
          {
            id: 'op_1',
            filePath: 'Companies/reverted.json',
            content: { id: 'scratch_pending_recreate_uuid-old-2', values: { a: 1 } },
            remoteRecordId: null,
          },
        ]);

        await service.runPipeline(PLAN_ID);

        const [, operations] = jest.mocked(connector.createRecords).mock.calls[0];
        expect(operations[0]).toEqual({ values: { a: 1 } });
        expect(recreatedIdMapService.upsert).toHaveBeenCalledWith({
          workbookId: WORKBOOK_ID,
          connectorAccountId: CONNECTOR_ACCOUNT_ID,
          folder: 'Companies',
          priorRemoteId: 'uuid-old-2',
          newRemoteId: 'uuid-new-2',
        });
      });

      it('nested id path, LEAF sentinel shape: detected, stripped, and remapped', async () => {
        setTableSpecIdColumnRemoteId('id.record_id');
        jest.mocked(connector.createRecords).mockResolvedValue([{ id: { record_id: 'uuid-new-3' }, values: {} }]);
        setupPhaseEntries('create', [
          {
            id: 'op_1',
            filePath: 'Companies/reverted.json',
            content: { id: { record_id: 'scratch_pending_recreate_uuid-old-3' }, values: { a: 1 } },
            remoteRecordId: null,
          },
        ]);

        await service.runPipeline(PLAN_ID);

        const [, operations] = jest.mocked(connector.createRecords).mock.calls[0];
        expect(operations[0]).toEqual({ values: { a: 1 } });
        expect(recreatedIdMapService.upsert).toHaveBeenCalledWith({
          workbookId: WORKBOOK_ID,
          connectorAccountId: CONNECTOR_ACCOUNT_ID,
          folder: 'Companies',
          priorRemoteId: 'uuid-old-3',
          newRemoteId: 'uuid-new-3',
        });
      });

      it('keeps op arrays aligned when a null-content entry sits before the sentinel entry', async () => {
        setTableSpecIdColumnRemoteId('id');
        jest.mocked(connector.createRecords).mockResolvedValue([{ id: 'rec_aligned', title: 'T' }]);
        setupPhaseEntries('create', [
          { id: 'op_0', filePath: 'articles/empty.json', content: null, remoteRecordId: null },
          {
            id: 'op_1',
            filePath: 'articles/reverted.json',
            content: { id: 'scratch_pending_recreate_old_a', title: 'T' },
            remoteRecordId: null,
          },
        ]);

        await service.runPipeline(PLAN_ID);

        // Only the non-null entry reaches the connector, and the remap row
        // pairs the sentinel's prior id with THAT entry's returned id.
        const [, operations] = jest.mocked(connector.createRecords).mock.calls[0];
        expect(operations).toHaveLength(1);
        expect(recreatedIdMapService.upsert).toHaveBeenCalledWith(
          expect.objectContaining({ priorRemoteId: 'old_a', newRemoteId: 'rec_aligned' }),
        );
      });
    });

    describe('dispatchCreateBatch — id-value boundary cases', () => {
      it('an empty-string id from the connector is not indexed', async () => {
        setTableSpecIdColumnRemoteId('id');
        jest.mocked(connector.createRecords).mockResolvedValue([{ id: '', title: 'T' }]);
        setupPhaseEntries('create', [
          { id: 'op_1', filePath: 'articles/new.json', content: { title: 'T' }, remoteRecordId: null },
        ]);

        await service.runPipeline(PLAN_ID);

        expect(fileIndexService.upsertBatch).not.toHaveBeenCalled();
      });

      it('a numeric 0 id from the connector IS indexed (truthiness must not drop a legal id)', async () => {
        setTableSpecIdColumnRemoteId('id');
        jest.mocked(connector.createRecords).mockResolvedValue([{ id: 0, title: 'T' }]);
        setupPhaseEntries('create', [
          { id: 'op_1', filePath: 'articles/new.json', content: { title: 'T' }, remoteRecordId: null },
        ]);

        await service.runPipeline(PLAN_ID);

        expect(fileIndexService.upsertBatch).toHaveBeenCalledWith([expect.objectContaining({ recordId: '0' })]);
      });
    });

    describe('dispatchUpdateBatch — id already present is left untouched', () => {
      it('flat id path: a native integer id is passed to the connector with its type preserved (no fill, no stringification)', async () => {
        setTableSpecIdColumnRemoteId('id');
        setupPhaseEntries('edit', [
          {
            id: 'op_1',
            filePath: 'articles/a1.json',
            content: { id: 42, title: 'New' },
            changedFields: { title: 'New' },
            remoteRecordId: '42',
          },
        ]);

        await service.runPipeline(PLAN_ID);

        const [, files] = jest.mocked(connector.updateRecords).mock.calls[0];
        expect(files[0].id).toBe(42);
      });

      it('nested id path: a present nested id is passed through unchanged', async () => {
        setTableSpecIdColumnRemoteId('id.record_id');
        const presentNestedId = { workspace_id: 'ws1', record_id: 'uuid-present' };
        setupPhaseEntries('edit', [
          {
            id: 'op_1',
            filePath: 'Companies/c1.json',
            content: { id: presentNestedId, values: { name: 'New' } },
            changedFields: { values: { name: 'New' } },
            remoteRecordId: 'uuid-present',
          },
        ]);

        await service.runPipeline(PLAN_ID);

        const [, files] = jest.mocked(connector.updateRecords).mock.calls[0];
        expect(files[0].id).toEqual(presentNestedId);
      });
    });

    describe('dispatchDeleteBatch — entries without a remote id', () => {
      it('skips entries with no remoteRecordId and only cleans up the deleted ones', async () => {
        setTableSpecIdColumnRemoteId('id');
        setupPhaseEntries('delete', [
          { id: 'op_1', filePath: 'articles/never-published.json', content: null, remoteRecordId: null },
          { id: 'op_2', filePath: 'articles/published.json', content: null, remoteRecordId: 'rec_pub_1' },
        ]);

        await service.runPipeline(PLAN_ID);

        const [, filters] = jest.mocked(connector.deleteRecords).mock.calls[0];
        expect(filters).toEqual([{ id: 'rec_pub_1' }]);
        // Local cleanup (refs) must align with what was actually deleted.
        expect(db.client.fileReference.deleteMany).toHaveBeenCalledWith({
          where: { workbookId: WORKBOOK_ID, sourceFilePath: { in: ['articles/published.json'] } },
        });
      });

      it('does not call the connector at all when no entry has a remote id', async () => {
        setTableSpecIdColumnRemoteId('id');
        setupPhaseEntries('delete', [
          { id: 'op_1', filePath: 'articles/never-published.json', content: null, remoteRecordId: null },
        ]);

        await service.runPipeline(PLAN_ID);

        expect(connector.deleteRecords).not.toHaveBeenCalled();
      });

      // DEV-10595: an un-executed delete must NOT be reported as a remote success.
      it('marks a delete with no remoteRecordId failed-batch (not success) while the real delete succeeds', async () => {
        setTableSpecIdColumnRemoteId('id');
        setupPhaseEntries('delete', [
          { id: 'op_null', filePath: 'articles/unindexed.json', content: null, remoteRecordId: null },
          { id: 'op_valid', filePath: 'articles/published.json', content: null, remoteRecordId: 'rec_pub_1' },
        ]);

        await service.runPipeline(PLAN_ID);

        const updateManyCalls = jest.mocked(db.client.publishPlanOperation.updateMany).mock.calls;

        // The record that actually deleted is marked success — and only it.
        const successCall = updateManyCalls.find(
          (call) => (call[0] as { data?: { status?: string } }).data?.status === 'success',
        );
        expect(successCall).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect((successCall![0] as { where: { id: { in: string[] } } }).where.id.in).toEqual(['op_valid']);

        // The un-executed delete is marked failed-batch with a clear, user-facing reason.
        const failedCall = updateManyCalls.find(
          (call) => (call[0] as { data?: { status?: string } }).data?.status === 'failed-batch',
        );
        expect(failedCall).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const failedArg = failedCall![0] as { where: { id: { in: string[] } }; data: { error: string } };
        expect(failedArg.where.id.in).toEqual(['op_null']);
        expect(failedArg.data.error).toEqual(expect.stringContaining('remote record ID'));

        // The null-id delete is NEVER swept into a success update.
        const nullIdMarkedSuccess = updateManyCalls.some(
          (call) =>
            (call[0] as { data?: { status?: string } }).data?.status === 'success' &&
            ((call[0] as { where?: { id?: { in?: string[] } } }).where?.id?.in ?? []).includes('op_null'),
        );
        expect(nullIdMarkedSuccess).toBe(false);
      });

      // DEV-11385: a mixed delete batch must count only the un-executed (null
      // remoteRecordId) delete as an error, not the whole batch size. The valid
      // delete succeeds and the null-id delete is marked failed-batch, so
      // processBatch returns 1 (not the batch size of 2) and the surfaced
      // errorCount matches the number that actually failed.
      it('counts only the null-remoteRecordId delete as an error, not the whole batch', async () => {
        setTableSpecIdColumnRemoteId('id');
        setupPhaseEntries('delete', [
          { id: 'op_null', filePath: 'articles/unindexed.json', content: null, remoteRecordId: null },
          { id: 'op_valid', filePath: 'articles/published.json', content: null, remoteRecordId: 'rec_pub_1' },
        ]);
        const onError = jest.fn();

        await service.runPipeline(PLAN_ID, undefined, undefined, undefined, onError);

        expect(onError).toHaveBeenCalledWith(
          expect.objectContaining({
            errorCount: 1,
            lastSyncError: expect.stringContaining('1 of 2 entries') as string,
          }),
        );
      });

      // DEV-10595: the anomaly is charted so its prod frequency is visible.
      it('emits the publish-delete-missing-remote-id counter with the terminal failed count', async () => {
        setTableSpecIdColumnRemoteId('id');
        setupPhaseEntries('delete', [
          { id: 'op_null', filePath: 'articles/unindexed.json', content: null, remoteRecordId: null },
        ]);
        // The end-of-run counter reads terminal DB state: model one failed-batch
        // delete carrying the sentinel reason. The anomaly query is the only
        // count() with an `error` filter; the phase-scoped counts keep the value
        // setupPhaseEntries would return so the pipeline flow is unchanged.
        db.client.publishPlanOperation.count.mockImplementation(
          (args: { where?: { phase?: string; error?: unknown } }) => {
            if (args?.where?.error) return Promise.resolve(1);
            if (args?.where?.phase === 'delete') return Promise.resolve(1);
            return Promise.resolve(0);
          },
        );

        await service.runPipeline(PLAN_ID);

        expect(metricsService.logValue).toHaveBeenCalledWith(CustomMetric.PUBLISH_DELETE_MISSING_REMOTE_ID, 1);
      });
    });

    describe('dispatchUpdateBatch — identity assertion with connector-returned rows (flag on)', () => {
      beforeEach(() => {
        jest.mocked(experimentsService.getBooleanFlag).mockResolvedValue(true);
        jest.mocked(db.client.user.findUnique).mockResolvedValue({ id: 'user_test' });
      });

      it('nested id path: commits the connector-returned row when ids match at the nested path', async () => {
        setTableSpecIdColumnRemoteId('id.record_id');
        jest
          .mocked(connector.updateRecords)
          .mockResolvedValue([{ id: { record_id: 'uuid-match' }, values: { name: 'Server Normalized' } }] as never);
        setupPhaseEntries('edit', [
          {
            id: 'op_1',
            filePath: 'Companies/c1.json',
            content: { id: { record_id: 'uuid-match' }, values: { name: 'New' } },
            changedFields: { values: { name: 'New' } },
            remoteRecordId: 'uuid-match',
          },
        ]);

        await service.runPipeline(PLAN_ID);

        const mainCommit = scratchGitService.commitFilesToBranch.mock.calls.find(([, branch]) => branch === 'main');
        expect(mainCommit).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const committedContent = JSON.parse(mainCommit![2][0].content) as Record<string, unknown>;
        expect(committedContent).toMatchObject({ values: { name: 'Server Normalized' } });
      });

      it('nested id path: falls back to the sent payload when the connector echoes a different id (misorder guard now works for nested ids)', async () => {
        setTableSpecIdColumnRemoteId('id.record_id');
        jest
          .mocked(connector.updateRecords)
          .mockResolvedValue([{ id: { record_id: 'uuid-SOMEONE-ELSE' }, values: { name: 'Wrong Row' } }] as never);
        setupPhaseEntries('edit', [
          {
            id: 'op_1',
            filePath: 'Companies/c1.json',
            content: { id: { record_id: 'uuid-mine' }, values: { name: 'New' } },
            changedFields: { values: { name: 'New' } },
            remoteRecordId: 'uuid-mine',
          },
        ]);

        await service.runPipeline(PLAN_ID);

        const mainCommit = scratchGitService.commitFilesToBranch.mock.calls.find(([, branch]) => branch === 'main');
        expect(mainCommit).toBeDefined();
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const committedContent = JSON.parse(mainCommit![2][0].content) as Record<string, unknown>;
        // The misordered echo must NOT be committed under this file's path.
        expect(committedContent).toMatchObject({ values: { name: 'New' } });
      });
    });

    describe('dispatchDeleteBatch — id filter shape', () => {
      it('flat id path: passes the same flat `{ id }` stub as before (regression for every flat-id connector)', async () => {
        setTableSpecIdColumnRemoteId('id');
        setupPhaseEntries('delete', [
          { id: 'op_1', filePath: 'articles/gone.json', content: null, remoteRecordId: 'rec_del_1' },
        ]);

        await service.runPipeline(PLAN_ID);

        expect(connector.deleteRecords).toHaveBeenCalledTimes(1);
        const [, filters] = jest.mocked(connector.deleteRecords).mock.calls[0];
        expect(filters).toEqual([{ id: 'rec_del_1' }]);
      });

      it('nested id path: builds a nested id stub the connector extractor can read, not a flat dotted key', async () => {
        setTableSpecIdColumnRemoteId('id.record_id');
        setupPhaseEntries('delete', [
          { id: 'op_1', filePath: 'Companies/gone.json', content: null, remoteRecordId: 'uuid-del-1' },
        ]);

        await service.runPipeline(PLAN_ID);

        expect(connector.deleteRecords).toHaveBeenCalledTimes(1);
        const [, filters] = jest.mocked(connector.deleteRecords).mock.calls[0];
        expect(filters).toEqual([{ id: { record_id: 'uuid-del-1' } }]);
        expect(filters[0]).not.toHaveProperty(['id.record_id']);
      });
    });

    describe('dispatchUpdateBatch — id backfill into content', () => {
      it('flat id path: fills a missing id from the resolved remote id before the connector update', async () => {
        setTableSpecIdColumnRemoteId('id');
        setupPhaseEntries('edit', [
          {
            id: 'op_1',
            filePath: 'articles/a1.json',
            content: { title: 'New' },
            changedFields: { title: 'New' },
            remoteRecordId: 'rec_fill_1',
          },
        ]);

        await service.runPipeline(PLAN_ID);

        const [, files] = jest.mocked(connector.updateRecords).mock.calls[0];
        expect(files[0]).toMatchObject({ id: 'rec_fill_1', title: 'New' });
      });

      it('nested id path: fills a missing id at the nested path (not as a flat dotted key)', async () => {
        setTableSpecIdColumnRemoteId('id.record_id');
        setupPhaseEntries('edit', [
          {
            id: 'op_1',
            filePath: 'Companies/c1.json',
            content: { values: { name: 'New' } },
            changedFields: { values: { name: 'New' } },
            remoteRecordId: 'uuid-fill-1',
          },
        ]);

        await service.runPipeline(PLAN_ID);

        const [, files] = jest.mocked(connector.updateRecords).mock.calls[0];
        expect(files[0]).toMatchObject({ id: { record_id: 'uuid-fill-1' }, values: { name: 'New' } });
        expect(files[0]).not.toHaveProperty(['id.record_id']);
      });

      it('nested id path: falls back to the FileIndex when the plan row has no remote id (publish-created record)', async () => {
        setTableSpecIdColumnRemoteId('id.record_id');
        jest.mocked(fileIndexService.getRecordId).mockResolvedValue('uuid-from-index');
        setupPhaseEntries('edit', [
          {
            id: 'op_1',
            filePath: 'Companies/c1.json',
            content: { values: { name: 'New' } },
            changedFields: { values: { name: 'New' } },
            remoteRecordId: null,
          },
        ]);

        await service.runPipeline(PLAN_ID);

        expect(fileIndexService.getRecordId).toHaveBeenCalledWith(
          WORKBOOK_ID,
          'Companies',
          'c1.json',
          CONNECTOR_ACCOUNT_ID,
        );
        const [, files] = jest.mocked(connector.updateRecords).mock.calls[0];
        expect(files[0]).toMatchObject({ id: { record_id: 'uuid-from-index' } });
      });
    });
  });

  // The storage seam: a caller-supplied PublishPlanRunStorage's table spec store and pseudo-ref
  // resolver are what the run uses — not the git copy or the FileIndex-backed RefResolverService.
  describe('with a caller-supplied PublishPlanRunStorage', () => {
    it('reads table specs and resolves pseudo-refs through the supplied storage', async () => {
      setupEditPhaseEntries([
        {
          id: 'op_1',
          filePath: 'articles/a1.json',
          content: { id: 'rec_1', title: 'New' },
          changedFields: { title: 'New' },
          remoteRecordId: 'rec_1',
        },
      ]);
      const classicStorage = new ClassicPublishPlanRunStorage(
        db as unknown as DbService,
        scratchGitService,
        fileIndexService,
        fileReferenceService,
        refResolverService,
        dataFolderTableSpecStore,
      );
      const suppliedTableSpecStore: TableSpecStore = { readTableSpec: jest.fn() };
      const suppliedPseudoRefResolver: PublishPseudoRefResolver = {
        findUnresolvablePseudoRefs: jest.fn().mockResolvedValue(new Set<string>()),
        resolveBatchPseudoRefs: jest.fn((_workbookId: string, contents: Record<string, unknown>[]) =>
          Promise.resolve(contents),
        ),
      };
      const suppliedStorage: PublishPlanRunStorage = {
        openPlanStore: (planId) => classicStorage.openPlanStore(planId),
        openRecordWriteback: (plan, planStore) => classicStorage.openRecordWriteback(plan, planStore),
        tableSpecStore: suppliedTableSpecStore,
        pseudoRefResolver: suppliedPseudoRefResolver,
      };

      await service.runPipeline(PLAN_ID, undefined, undefined, undefined, undefined, undefined, suppliedStorage);

      expect(connector.updateRecords).toHaveBeenCalledTimes(1);
      expect(schemaService.getTableSpecById).toHaveBeenCalledWith(
        DATA_FOLDER_ID,
        expect.any(Map),
        suppliedTableSpecStore,
      );
      expect(suppliedPseudoRefResolver.resolveBatchPseudoRefs).toHaveBeenCalled();
      expect(refResolverService.resolveBatchPseudoRefs).not.toHaveBeenCalled();
      expect(refResolverService.findUnresolvablePseudoRefs).not.toHaveBeenCalled();
    });
  });

  describe('dispatchUpdateBatch with changedFields', () => {
    it('passes deep changedFields to connector.updateRecords', async () => {
      setupEditPhaseEntries([
        {
          id: 'op_1',
          filePath: 'articles/a1.json',
          content: { id: 'rec_1', title: 'New', body: 'Same' },
          changedFields: { title: 'New' },
          remoteRecordId: 'rec_1',
        },
      ]);

      await service.runPipeline(PLAN_ID);

      expect(connector.updateRecords).toHaveBeenCalledTimes(1);
      const updateMock = jest.mocked(connector.updateRecords);
      const [, , cfArg] = updateMock.mock.calls[0];
      expect(cfArg).toEqual([{ title: 'New' }]);
    });

    it("passes the folder's options to connector.updateRecords (DEV-11258)", async () => {
      db.client.dataFolder.findUnique.mockResolvedValue({ options: { excludePageContent: true } });
      setupEditPhaseEntries([
        {
          id: 'op_1',
          filePath: 'articles/a1.json',
          content: { id: 'rec_1', title: 'New', body: 'Same' },
          changedFields: { title: 'New' },
          remoteRecordId: 'rec_1',
        },
      ]);

      await service.runPipeline(PLAN_ID);

      expect(connector.updateRecords).toHaveBeenCalledTimes(1);
      const [, , , folderOptions] = jest.mocked(connector.updateRecords).mock.calls[0];
      expect(folderOptions).toEqual({ excludePageContent: true });
      expect(db.client.dataFolder.findUnique).toHaveBeenCalledWith({
        where: { id: DATA_FOLDER_ID },
        select: { options: true },
      });
    });

    it('aligns changedFields parallel array with files', async () => {
      setupEditPhaseEntries([
        {
          id: 'op_1',
          filePath: 'articles/a1.json',
          content: { id: 'rec_1', title: 'New1', body: 'Same' },
          changedFields: { title: 'New1' },
          remoteRecordId: 'rec_1',
        },
        {
          id: 'op_2',
          filePath: 'articles/a2.json',
          content: { id: 'rec_2', title: 'Same', body: 'New2' },
          changedFields: { body: 'New2' },
          remoteRecordId: 'rec_2',
        },
      ]);

      await service.runPipeline(PLAN_ID);

      const [, files, cfArr] = connector.updateRecords.mock.calls[0];
      expect(files).toHaveLength(2);
      expect(cfArr).toHaveLength(2);
      expect(cfArr[0]).toEqual({ title: 'New1' });
      expect(cfArr[1]).toEqual({ body: 'New2' });
    });

    it('skips no-op edits where changedFields is empty object', async () => {
      setupEditPhaseEntries([
        {
          id: 'op_1',
          filePath: 'articles/a1.json',
          content: { id: 'rec_1', title: 'Same' },
          changedFields: {},
          remoteRecordId: 'rec_1',
        },
      ]);

      await service.runPipeline(PLAN_ID);

      // No connector call since the only entry was a no-op
      expect(jest.mocked(connector.updateRecords)).not.toHaveBeenCalled();
    });

    it('sends only changed entries in mixed batch (some no-op, some changed)', async () => {
      setupEditPhaseEntries([
        {
          id: 'op_1',
          filePath: 'articles/a1.json',
          content: { id: 'rec_1', title: 'Same' },
          changedFields: {},
          remoteRecordId: 'rec_1',
        },
        {
          id: 'op_2',
          filePath: 'articles/a2.json',
          content: { id: 'rec_2', title: 'New' },
          changedFields: { title: 'New' },
          remoteRecordId: 'rec_2',
        },
      ]);

      await service.runPipeline(PLAN_ID);

      expect(connector.updateRecords).toHaveBeenCalledTimes(1);
      const updateMock = jest.mocked(connector.updateRecords);
      const [, files] = updateMock.mock.calls[0];
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ id: 'rec_2' });
    });

    it('commits full content to git even with partial changedFields', async () => {
      const fullContent = { id: 'rec_1', title: 'New', body: 'Same', slug: 'test' };
      setupEditPhaseEntries([
        {
          id: 'op_1',
          filePath: 'articles/a1.json',
          content: fullContent,
          changedFields: { title: 'New' },
          remoteRecordId: 'rec_1',
        },
      ]);

      await service.runPipeline(PLAN_ID);

      // Git commit should use full content, not changedFields
      const commitCalls = scratchGitService.commitFilesToBranch.mock.calls;
      expect(commitCalls.length).toBeGreaterThan(0);
      const mainCommit = commitCalls.find(([, branch]) => branch === 'main');
      expect(mainCommit).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const gitContent = JSON.parse(mainCommit![2][0].content) as Record<string, unknown>;
      expect(gitContent).toMatchObject(fullContent);
    });

    it('uses transformed values from resolvedContent, not raw changedFields values', async () => {
      // Simulate FK transformation: ref resolver transforms @/path refs to real IDs
      refResolverService.resolveBatchPseudoRefs.mockImplementation((_wkbId, contents) => {
        return Promise.resolve(
          (contents as Record<string, unknown>[]).map((c) => ({
            ...c,
            // FK transformer resolves the author ref to a real remote ID
            author: c.author === '@/authors/hemingway.json' ? 'author_remote_456' : c.author,
          })),
        );
      });

      setupEditPhaseEntries([
        {
          id: 'op_1',
          filePath: 'articles/a1.json',
          content: { id: 'rec_1', title: 'Old Man', author: '@/authors/hemingway.json' },
          // changedFields stores the raw (untransformed) diff value
          changedFields: { author: '@/authors/hemingway.json' },
          remoteRecordId: 'rec_1',
        },
      ]);

      await service.runPipeline(PLAN_ID);

      expect(connector.updateRecords).toHaveBeenCalledTimes(1);
      const [, , cfArg] = connector.updateRecords.mock.calls[0];
      // changedFields passed to connector should contain the TRANSFORMED value,
      // not the raw @/ pseudo-ref from the DB
      expect(cfArg).toEqual([{ author: 'author_remote_456' }]);
    });
  });

  describe('dispatchUpdateBatch — backfill relation cascade (DEV-10954)', () => {
    it('drops an unresolvable relation link in the backfill phase and still publishes the record', async () => {
      const failedRelationRef = '@/Notion/companies/scratch_pending_publish_failed.json';
      refResolverService.findUnresolvablePseudoRefs.mockResolvedValue(new Set([failedRelationRef]));
      // The cleaner drops the failed relation element, leaving the resolvable one behind.
      refCleanerService.stripSpecificPseudoRefs.mockReturnValue({
        id: 'rec_1',
        properties: { Companies: { type: 'relation', relation: [{ id: 'real-company-id' }] } },
      } as never);

      setupPhaseEntries('backfill', [
        {
          id: 'op_1',
          filePath: 'deals/d1.json',
          content: {
            id: 'rec_1',
            properties: {
              Companies: { type: 'relation', relation: [{ id: failedRelationRef }, { id: 'real-company-id' }] },
            },
          },
          changedFields: {
            properties: { Companies: { relation: [{ id: failedRelationRef }, { id: 'real-company-id' }] } },
          },
          remoteRecordId: 'rec_1',
        },
      ]);

      await service.runPipeline(PLAN_ID);

      // The unresolvable ref was detected and stripped (not thrown), and the record published
      // with only the resolvable link.
      expect(refResolverService.findUnresolvablePseudoRefs).toHaveBeenCalled();
      expect(refCleanerService.stripSpecificPseudoRefs).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        new Set([failedRelationRef]),
      );
      expect(connector.updateRecords).toHaveBeenCalledTimes(1);
      const [, files] = connector.updateRecords.mock.calls[0];
      expect(files[0]).toEqual({
        id: 'rec_1',
        properties: { Companies: { type: 'relation', relation: [{ id: 'real-company-id' }] } },
      });
    });

    it("skips a backfill op (no update, no throw) when the record's own create never landed", async () => {
      // The dependent record's OWN create failed, so its id is absent from the FileIndex.
      // The orphaned backfill must be skipped rather than throwing "Could not resolve remote ID".
      jest.mocked(fileIndexService.getRecordId).mockResolvedValue(null as never);

      setupPhaseEntries('backfill', [
        {
          id: 'op_1',
          filePath: 'deals/d1.json',
          content: { title: 'X' },
          changedFields: { title: 'X' },
          remoteRecordId: null,
        },
      ]);

      await expect(service.runPipeline(PLAN_ID)).resolves.not.toThrow();
      expect(connector.updateRecords).not.toHaveBeenCalled();
    });

    it('does NOT consult findUnresolvablePseudoRefs in the edit phase (only backfill drops)', async () => {
      setupEditPhaseEntries([
        {
          id: 'op_1',
          filePath: 'articles/a1.json',
          content: { id: 'rec_1', title: 'New' },
          changedFields: { title: 'New' },
          remoteRecordId: 'rec_1',
        },
      ]);

      await service.runPipeline(PLAN_ID);

      expect(refResolverService.findUnresolvablePseudoRefs).not.toHaveBeenCalled();
    });
  });

  describe('connector resolution (DEV-12337)', () => {
    it("loads the plan's connector account scoped to the plan's own workbook", async () => {
      setupEditPhaseEntries([
        {
          id: 'op_1',
          filePath: 'articles/a1.json',
          content: { id: 'rec_1', title: 'New' },
          changedFields: { title: 'New' },
          remoteRecordId: 'rec_1',
        },
      ]);

      await service.runPipeline(PLAN_ID);

      expect(db.client.connectorAccount.findUnique).toHaveBeenCalledWith({
        where: { id: CONNECTOR_ACCOUNT_ID, workbookId: WORKBOOK_ID },
      });
    });
  });

  describe('a pipeline interrupted by the worker shutting down (DEV-12428)', () => {
    const CONNECTION_CLOSED_BY_SHUTDOWN_ERROR_MESSAGE = 'Connection is closed.';

    function setupOneEditPhaseEntry() {
      setupEditPhaseEntries([
        {
          id: 'op_1',
          filePath: 'articles/a1.json',
          content: { id: 'rec_1', title: 'New' },
          changedFields: { title: 'New' },
          remoteRecordId: 'rec_1',
        },
      ]);
    }

    function listPlanStatusesWritten(): string[] {
      return jest
        .mocked(db.client.publishPlan.update)
        .mock.calls.map((call) => (call[0] as { data?: { status?: string } }).data?.status)
        .filter((status): status is string => typeof status === 'string');
    }

    afterEach(() => {
      clearWorkerProcessShutdownStarted();
    });

    it('leaves the plan at its running status instead of marking it failed', async () => {
      setupOneEditPhaseEntry();
      // The incident's shape: the job's progress checkpoint hits a Redis client the shutdown just closed.
      const onProgressAfterTheShutdownClosedRedis = jest.fn(() => {
        markWorkerProcessShutdownStarted();
        return Promise.reject(new Error(CONNECTION_CLOSED_BY_SHUTDOWN_ERROR_MESSAGE));
      });

      await expect(
        service.runPipeline(PLAN_ID, undefined, undefined, onProgressAfterTheShutdownClosedRedis),
      ).rejects.toThrow(CONNECTION_CLOSED_BY_SHUTDOWN_ERROR_MESSAGE);

      const planStatusesWritten = listPlanStatusesWritten();
      expect(planStatusesWritten[planStatusesWritten.length - 1]).toBe('edits-running');
      expect(planStatusesWritten).not.toContain('failed');
    });

    it('still marks the plan failed when the same error happens while the worker is not shutting down', async () => {
      setupOneEditPhaseEntry();
      const onProgressThatFails = jest.fn(() => Promise.reject(new Error(CONNECTION_CLOSED_BY_SHUTDOWN_ERROR_MESSAGE)));

      await expect(service.runPipeline(PLAN_ID, undefined, undefined, onProgressThatFails)).rejects.toThrow(
        CONNECTION_CLOSED_BY_SHUTDOWN_ERROR_MESSAGE,
      );

      expect(listPlanStatusesWritten()).toContain('failed');
    });

    it('lets the redelivered job resume the interrupted phase and finish the plan', async () => {
      setupOneEditPhaseEntry();
      const onProgressAfterTheShutdownClosedRedis = jest.fn(() => {
        markWorkerProcessShutdownStarted();
        return Promise.reject(new Error(CONNECTION_CLOSED_BY_SHUTDOWN_ERROR_MESSAGE));
      });
      await expect(
        service.runPipeline(PLAN_ID, undefined, undefined, onProgressAfterTheShutdownClosedRedis),
      ).rejects.toThrow(CONNECTION_CLOSED_BY_SHUTDOWN_ERROR_MESSAGE);

      // The redelivered job runs on another instance (not shutting down) and reads back whatever status the
      // interrupted run left on the plan.
      clearWorkerProcessShutdownStarted();
      const planStatusesWrittenByTheInterruptedRun = listPlanStatusesWritten();
      const planStatusLeftByTheInterruptedRun =
        planStatusesWrittenByTheInterruptedRun[planStatusesWrittenByTheInterruptedRun.length - 1];
      db.client.publishPlan.findUnique.mockResolvedValue({
        id: PLAN_ID,
        workbookId: WORKBOOK_ID,
        userId: 'user_test',
        branchName: 'publish/user_test/plan_test',
        status: planStatusLeftByTheInterruptedRun,
        connectorAccountId: CONNECTOR_ACCOUNT_ID,
        createdAt: new Date(),
      });
      jest.mocked(db.client.publishPlan.update).mockClear();

      await expect(service.runPipeline(PLAN_ID)).resolves.toBeDefined();

      // Resumed at the edit phase (a fresh plan would start with asset-upload-running) and finished it.
      const planStatusesWrittenByTheRedeliveredRun = listPlanStatusesWritten();
      expect(planStatusesWrittenByTheRedeliveredRun[0]).toBe('edits-running');
      expect(planStatusesWrittenByTheRedeliveredRun).toContain('edits-completed');
      expect(planStatusesWrittenByTheRedeliveredRun).not.toContain('failed');
    });
  });

  describe('connector error surfacing on batch failure', () => {
    it('persists the connector-extracted user-facing reason, not the raw HTTP error', async () => {
      setupEditPhaseEntries([
        {
          id: 'op_1',
          filePath: 'Organizations/9x-updated.json',
          content: { id: 'rec_1', custom_fields: { numberField: 'Custom field' } },
          changedFields: { custom_fields: { numberField: 'Custom field' } },
          remoteRecordId: 'rec_1',
        },
      ]);

      // The dispatch rejects with an opaque axios message...
      const rawAxiosError = new Error('Request failed with status code 400');
      jest.mocked(connector.updateRecords).mockRejectedValue(rawAxiosError);

      // ...but the connector knows how to read the service's real reason out of
      // the 400 response body. That extracted message is what users should see.
      const serviceValidationMessage =
        "Validation failed: custom_fields: Expected 'number' as value for organization custom field 'numberField'";
      jest.mocked(connector.extractConnectorErrorDetails).mockReturnValue({
        userFriendlyMessage: serviceValidationMessage,
        additionalContext: { status: 400 },
      });

      await service.runPipeline(PLAN_ID);

      // The runner asks the connector to interpret the raw error...
      expect(connector.extractConnectorErrorDetails).toHaveBeenCalledWith(rawAxiosError);

      // ...and persists the extracted reason (not "Request failed with status
      // code 400") onto the failed-batch operation, which the review UI shows.
      const failedBatchCall = jest
        .mocked(db.client.publishPlanOperation.updateMany)
        .mock.calls.find((call) => (call[0] as { data?: { status?: string } }).data?.status === 'failed-batch');
      expect(failedBatchCall).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const failedData = (failedBatchCall![0] as { data: { status: string; error: string; errorCode: string | null } })
        .data;
      expect(failedData.error).toBe(serviceValidationMessage);
      // The connector didn't classify this failure, so no stale code may linger.
      expect(failedData.errorCode).toBeNull();
    });

    it("persists the connector's stable errorCode alongside the message when the failure is classified", async () => {
      setupEditPhaseEntries([
        {
          id: 'op_1',
          filePath: 'Pages/archived-page.json',
          content: { id: 'pg_1', properties: {} },
          changedFields: { properties: {} },
          remoteRecordId: 'pg_1',
        },
      ]);

      jest.mocked(connector.updateRecords).mockRejectedValue(new Error('Request failed with status code 400'));
      // e.g. Notion classifying "Can't edit block that is archived" — the
      // message copy is connector-owned prose; the code is the stable contract
      // frontends branch on (DEV-11407).
      jest.mocked(connector.extractConnectorErrorDetails).mockReturnValue({
        userFriendlyMessage:
          "Notion API error (validation_error): Can't edit block that is archived. You must unarchive the block before editing.",
        errorCode: ConnectorErrorCode.RemoteRecordNotFound,
      });

      await service.runPipeline(PLAN_ID);

      const failedBatchCall = jest
        .mocked(db.client.publishPlanOperation.updateMany)
        .mock.calls.find((call) => (call[0] as { data?: { status?: string } }).data?.status === 'failed-batch');
      expect(failedBatchCall).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const failedData = (failedBatchCall![0] as { data: { errorCode: string | null } }).data;
      expect(failedData.errorCode).toBe('remote_record_not_found');
    });

    it('returns failedOperations (filePath/phase/connector message) so the job can surface why a record failed', async () => {
      setupEditPhaseEntries([
        {
          id: 'op_1',
          filePath: 'Activities/call-nishant.json',
          content: { id: 'rec_1', person_id: 5022 },
          changedFields: { person_id: 5022 },
          remoteRecordId: 'rec_1',
        },
      ]);

      const connectorMessage =
        "'person_id' is a read-only field. Add a primary participant to set 'person_id' instead.";
      jest.mocked(connector.updateRecords).mockRejectedValue(new Error('Request failed with status code 400'));
      jest.mocked(connector.extractConnectorErrorDetails).mockReturnValue({
        userFriendlyMessage: connectorMessage,
        additionalContext: { status: 400 },
      });

      // Final status reflects the rejection...
      db.client.publishPlanOperation.groupBy.mockResolvedValue([{ status: 'failed-batch', phase: 'edit', _count: 1 }]);
      // ...and the bounded summary query (the one with a `select`) returns the
      // failed row carrying the connector's persisted message. The retry query
      // (no `select`) returns [] so the entry isn't reprocessed.
      const pendingRows = [
        {
          id: 'op_1',
          filePath: 'Activities/call-nishant.json',
          content: { id: 'rec_1', person_id: 5022 },
          changedFields: { person_id: 5022 },
          remoteRecordId: 'rec_1',
          planId: PLAN_ID,
          phase: 'edit',
          dataFolderId: DATA_FOLDER_ID,
          status: 'pending',
          error: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];
      jest.mocked(db.client.publishPlanOperation.findMany).mockImplementation((args: unknown) => {
        const a = args as {
          where?: { phase?: string; status?: string; id?: { in: string[] } };
          distinct?: string[];
          select?: Record<string, boolean>;
        };
        if (a?.distinct) return Promise.resolve([{ dataFolderId: DATA_FOLDER_ID }]);
        // The bounded summary query (has a `select`) returns the failed row with
        // its persisted connector message; the retry scan (also projected, but
        // selecting only `id`) returns [] so the entry isn't reprocessed.
        if (
          a?.where?.status === 'failed-batch' ||
          (a?.where?.status as { in?: string[] } | undefined)?.in?.includes('failed-batch')
        ) {
          return Promise.resolve(
            a.select?.filePath
              ? [{ filePath: 'Activities/call-nishant.json', phase: 'edit', error: connectorMessage, errorCode: null }]
              : [],
          );
        }
        // Per-batch read of full rows by the IDs the folder scan collected.
        if (a?.where?.id?.in) {
          const requestedIds = new Set(a.where.id.in);
          return Promise.resolve(pendingRows.filter((row) => requestedIds.has(row.id)));
        }
        // Pending entries only exist for the edit phase in this test.
        if (a?.where?.phase === 'edit' && a?.where?.status === 'pending') {
          return Promise.resolve(pendingRows);
        }
        return Promise.resolve([]);
      });

      const result = await service.runPipeline(PLAN_ID);

      expect(result.failedCount).toBe(1);
      expect(result.failedOperations).toEqual([
        { filePath: 'Activities/call-nishant.json', phase: 'edit', error: connectorMessage, errorCode: null },
      ]);
    });
  });

  // DEV-10048: the post-publish reconcile hands `rebaseDirty` a set of paths to
  // converge to `main` (skip re-applying), scoped to what the plan touched.
  describe('post-publish dirty reconcile exclude-set (DEV-10048)', () => {
    // The plan touched two records: one published cleanly, one the connector rejected.
    function mockReconcilePlanOps() {
      db.client.publishPlanOperation.findMany.mockImplementation(
        (args: { where?: { planId?: string }; distinct?: string[]; select?: Record<string, boolean> }) => {
          if (args?.where?.planId === PLAN_ID && args?.select?.filePath) {
            return Promise.resolve([
              { filePath: 'Articles/ok.json', status: 'success' },
              { filePath: 'Articles/bad.json', status: 'failed-batch' },
            ]);
          }
          return Promise.resolve([]);
        },
      );
    }

    it('web publish converges succeeded/no-op paths and keeps failed paths on dirty', async () => {
      mockReconcilePlanOps();
      await service.runPipeline(PLAN_ID, undefined, undefined, undefined, undefined, 'web');
      // Failed path is NOT excluded — it stays on `dirty` (re-applied) for the web.
      expect(scratchGitService.rebaseDirty).toHaveBeenCalledWith(REPO_ID, ['Articles/ok.json']);
    });

    it('desktop publish converges ALL plan paths (failed edits travel back to the client)', async () => {
      mockReconcilePlanOps();
      await service.runPipeline(PLAN_ID, undefined, undefined, undefined, undefined, 'desktop');
      const calls = jest.mocked(scratchGitService.rebaseDirty).mock.calls;
      const lastArgs = calls[calls.length - 1];
      expect(lastArgs[0]).toBe(REPO_ID);
      expect([...(lastArgs[1] as string[])].sort()).toEqual(['Articles/bad.json', 'Articles/ok.json']);
    });

    it('single-phase run leaves still-pending paths on dirty (does not converge un-run phases)', async () => {
      // The "Execute 1 Phase" case: the edit phase ran (success) but a later
      // phase's create op is still `pending`. The pending path must NOT converge —
      // it was never published — or its create would vanish from `dirty`.
      db.client.publishPlanOperation.findMany.mockImplementation(
        (args: { where?: { planId?: string }; distinct?: string[]; select?: Record<string, boolean> }) => {
          if (args?.where?.planId === PLAN_ID && args?.select?.filePath) {
            return Promise.resolve([
              { filePath: 'Articles/edited.json', status: 'success' },
              { filePath: 'Articles/pending-create.json', status: 'pending' },
            ]);
          }
          return Promise.resolve([]);
        },
      );
      await service.runPipeline(PLAN_ID, true, undefined, undefined, undefined, 'web');
      // Only the executed (success) path converges; the pending one stays on dirty.
      expect(scratchGitService.rebaseDirty).toHaveBeenCalledWith(REPO_ID, ['Articles/edited.json']);
    });
  });

  // DEV-10200: a batched connector create can land SOME records. The connector
  // reports both halves via PartialBatchCreateError; the runner persists the
  // created ones like a clean batch and marks only the failed ones failed-batch
  // (with their own reason) for the ordinary per-record retry.
  describe('dispatchCreateBatch — partially-landed batch (PartialBatchCreateError)', () => {
    function updateManyCalls(): unknown[] {
      const calls = jest.mocked(db.client.publishPlanOperation.updateMany).mock.calls as unknown[][];
      return calls.map((call) => call[0]);
    }

    it('persists only the created records, marks them success, and marks the failed entry failed-batch with its own reason', async () => {
      setTableSpecIdColumnRemoteId('id');
      jest.mocked(connector.createRecords).mockRejectedValue(
        new PartialBatchCreateError({
          createdRecordsByInputIndex: new Map([
            [0, { id: 'rec_a', title: 'A' }],
            [2, { id: 'rec_c', title: 'C' }],
          ]),
          failureMessagesByInputIndex: new Map([[1, 'Email address is invalid']]),
        }),
      );
      setupPhaseEntries('create', [
        { id: 'op_a', filePath: 'articles/a.json', content: { title: 'A' }, remoteRecordId: null },
        { id: 'op_b', filePath: 'articles/b.json', content: { title: 'B' }, remoteRecordId: null },
        { id: 'op_c', filePath: 'articles/c.json', content: { title: 'C' }, remoteRecordId: null },
      ]);

      await service.runPipeline(PLAN_ID);

      // Only the two created records are indexed and committed.
      expect(fileIndexService.upsertBatch).toHaveBeenCalledWith([
        expect.objectContaining({ filename: 'a.json', recordId: 'rec_a' }),
        expect.objectContaining({ filename: 'c.json', recordId: 'rec_c' }),
      ]);
      expect(scratchGitService.commitFilesToBranch).toHaveBeenCalledWith(
        REPO_ID,
        'main',
        [
          { path: 'articles/a.json', content: expect.stringContaining('rec_a') as string },
          { path: 'articles/c.json', content: expect.stringContaining('rec_c') as string },
        ],
        expect.any(String),
      );
      // Statuses: a, c → success; b → failed-batch with the connector's reason.
      expect(updateManyCalls()).toContainEqual({
        where: { id: { in: ['op_a', 'op_c'] } },
        data: { status: 'success', error: null, errorCode: null },
      });
      expect(updateManyCalls()).toContainEqual({
        where: { id: 'op_b' },
        data: { status: 'failed-batch', error: 'Email address is invalid', errorCode: null },
      });
      expect(connector.createRecords).toHaveBeenCalledTimes(1);
    });

    it('counts only the rejected entries as errors in progress reporting, not the whole batch', async () => {
      setTableSpecIdColumnRemoteId('id');
      jest.mocked(connector.createRecords).mockRejectedValue(
        new PartialBatchCreateError({
          createdRecordsByInputIndex: new Map([
            [0, { id: 'rec_a', title: 'A' }],
            [2, { id: 'rec_c', title: 'C' }],
          ]),
          failureMessagesByInputIndex: new Map([[1, 'Email address is invalid']]),
        }),
      );
      setupPhaseEntries('create', [
        { id: 'op_a', filePath: 'articles/a.json', content: { title: 'A' }, remoteRecordId: null },
        { id: 'op_b', filePath: 'articles/b.json', content: { title: 'B' }, remoteRecordId: null },
        { id: 'op_c', filePath: 'articles/c.json', content: { title: 'C' }, remoteRecordId: null },
      ]);
      const onError = jest.fn();

      await service.runPipeline(PLAN_ID, undefined, undefined, undefined, onError);

      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ errorCount: 1, lastSyncError: expect.stringContaining('1 of 3 entries') as string }),
      );
    });

    it('a plain connector error on a create batch still marks every entry failed-batch (unchanged contract)', async () => {
      setTableSpecIdColumnRemoteId('id');
      jest.mocked(connector.createRecords).mockRejectedValue(new Error('HubSpot is down'));
      setupPhaseEntries('create', [
        { id: 'op_a', filePath: 'articles/a.json', content: { title: 'A' }, remoteRecordId: null },
        { id: 'op_b', filePath: 'articles/b.json', content: { title: 'B' }, remoteRecordId: null },
      ]);

      await service.runPipeline(PLAN_ID);

      expect(fileIndexService.upsertBatch).not.toHaveBeenCalled();
      expect(updateManyCalls()).toContainEqual({
        where: { id: { in: ['op_a', 'op_b'] } },
        data: { status: 'failed-batch', error: 'HubSpot is down', errorCode: null },
      });
    });
  });
  describe('dispatchRenameBatch — connector-suggested filenames for published creates (DEV-11438)', () => {
    const PENDING_A = 'scratch_pending_aaa.json';
    const PENDING_B = 'scratch_pending_bbb.json';

    /**
     * Models the state the create phase leaves behind: the pending-named file
     * is indexed under its real record id, and `main` holds the
     * connector-returned record at the pending path.
     */
    function setupPublishedCreates(
      files: Array<{ pendingFilename: string; recordId: string; committedRecord: Record<string, unknown> }>,
    ) {
      setupPhaseEntries(
        'rename-files',
        files.map((f, i) => ({ id: `op_rename_${i}`, filePath: `articles/${f.pendingFilename}`, content: {} })),
      );
      jest
        .mocked(fileIndexService.getRecordIdsByFilenamesInFolder)
        .mockResolvedValue(new Map(files.map((f) => [f.pendingFilename, f.recordId])));
      jest
        .mocked(scratchGitService.readRepoFilesFromFolder)
        .mockResolvedValue(
          files.map((f) => ({ path: `articles/${f.pendingFilename}`, content: JSON.stringify(f.committedRecord) })),
        );
    }

    function renamesSent(): { oldName: string; newName: string }[] {
      const calls = jest.mocked(scratchGitService.renameFiles).mock.calls;
      return calls.flatMap((call) => call[2]);
    }

    it("renames a pending file to the connector's suggested name, normalized like a pulled file", async () => {
      setTableSpecIdColumnRemoteId('id');
      setupPublishedCreates([
        { pendingFilename: PENDING_A, recordId: 'rec_1', committedRecord: { id: 'rec_1', title: 'Google Inc.' } },
      ]);
      jest.mocked(connector.getSuggestedRecordFileNames).mockReturnValue(['Google Inc.']);

      await service.runPipeline(PLAN_ID);

      expect(connector.getSuggestedRecordFileNames).toHaveBeenCalledWith(
        [{ id: 'rec_1', title: 'Google Inc.' }],
        expect.objectContaining({ idPath: 'id' }),
      );
      expect(scratchGitService.readRepoFilesFromFolder).toHaveBeenCalledWith(REPO_ID, 'main', 'articles', [PENDING_A]);
      expect(renamesSent()).toEqual([{ oldName: PENDING_A, newName: 'google-inc.json' }]);
      expect(fileIndexService.upsertBatch).toHaveBeenCalledWith([
        {
          workbookId: WORKBOOK_ID,
          folderPath: 'articles',
          recordId: 'rec_1',
          filename: 'google-inc.json',
          connectorAccountId: CONNECTOR_ACCOUNT_ID,
        },
      ]);
      expect(db.client.fileReference.updateMany).toHaveBeenCalledWith({
        where: { workbookId: WORKBOOK_ID, sourceFilePath: `articles/${PENDING_A}` },
        data: { sourceFilePath: 'articles/google-inc.json' },
      });
    });

    it('falls back to <recordId>.json when the connector has no suggestion (previous behavior)', async () => {
      setTableSpecIdColumnRemoteId('id');
      setupPublishedCreates([{ pendingFilename: PENDING_A, recordId: 'rec_1', committedRecord: { id: 'rec_1' } }]);

      await service.runPipeline(PLAN_ID);

      expect(renamesSent()).toEqual([{ oldName: PENDING_A, newName: 'rec_1.json' }]);
    });

    it('falls back to the record id when the suggestion normalizes to nothing usable', async () => {
      setTableSpecIdColumnRemoteId('id');
      setupPublishedCreates([{ pendingFilename: PENDING_A, recordId: 'rec_1', committedRecord: { id: 'rec_1' } }]);
      jest.mocked(connector.getSuggestedRecordFileNames).mockReturnValue(['???']);

      await service.runPipeline(PLAN_ID);

      expect(renamesSent()).toEqual([{ oldName: PENDING_A, newName: 'rec_1.json' }]);
    });

    it('suffixes the record id when the suggested name collides with an existing file in the folder', async () => {
      setTableSpecIdColumnRemoteId('id');
      setupPublishedCreates([
        { pendingFilename: PENDING_A, recordId: 'rec_1', committedRecord: { id: 'rec_1', title: 'Atlas' } },
      ]);
      jest.mocked(fileIndexService.listFilenamesForFolder).mockResolvedValue(['atlas.json', PENDING_A]);
      jest.mocked(connector.getSuggestedRecordFileNames).mockReturnValue(['Atlas']);

      await service.runPipeline(PLAN_ID);

      expect(renamesSent()).toEqual([{ oldName: PENDING_A, newName: 'atlas-rec_1.json' }]);
    });

    it('deduplicates within the batch when two created records suggest the same name', async () => {
      setTableSpecIdColumnRemoteId('id');
      setupPublishedCreates([
        { pendingFilename: PENDING_A, recordId: 'rec_1', committedRecord: { id: 'rec_1', title: 'Atlas' } },
        { pendingFilename: PENDING_B, recordId: 'rec_2', committedRecord: { id: 'rec_2', title: 'Atlas' } },
      ]);
      jest.mocked(connector.getSuggestedRecordFileNames).mockReturnValue(['Atlas', 'Atlas']);

      await service.runPipeline(PLAN_ID);

      expect(renamesSent()).toEqual([
        { oldName: PENDING_A, newName: 'atlas.json' },
        { oldName: PENDING_B, newName: 'atlas-rec_2.json' },
      ]);
    });

    it('sanitizes a path-like record id in the fallback name (Shopify GIDs must not become nested paths)', async () => {
      setTableSpecIdColumnRemoteId('id');
      setupPublishedCreates([
        {
          pendingFilename: PENDING_A,
          recordId: 'gid://shopify/Product/123',
          committedRecord: { id: 'gid://shopify/Product/123' },
        },
      ]);

      await service.runPipeline(PLAN_ID);

      expect(renamesSent()).toEqual([{ oldName: PENDING_A, newName: 'gid-shopify-Product-123.json' }]);
    });

    it('still renames to the record id when the committed file cannot be read back', async () => {
      setTableSpecIdColumnRemoteId('id');
      setupPublishedCreates([{ pendingFilename: PENDING_A, recordId: 'rec_1', committedRecord: { id: 'rec_1' } }]);
      jest.mocked(scratchGitService.readRepoFilesFromFolder).mockRejectedValue(new Error('git down'));
      jest.mocked(connector.getSuggestedRecordFileNames).mockReturnValue(['Never Used']);

      await service.runPipeline(PLAN_ID);

      expect(connector.getSuggestedRecordFileNames).not.toHaveBeenCalled();
      expect(renamesSent()).toEqual([{ oldName: PENDING_A, newName: 'rec_1.json' }]);
    });

    it('still renames to the record id when the connector throws while suggesting', async () => {
      setTableSpecIdColumnRemoteId('id');
      setupPublishedCreates([{ pendingFilename: PENDING_A, recordId: 'rec_1', committedRecord: { id: 'rec_1' } }]);
      jest.mocked(connector.getSuggestedRecordFileNames).mockImplementation(() => {
        throw new Error('bad record shape');
      });

      await service.runPipeline(PLAN_ID);

      expect(renamesSent()).toEqual([{ oldName: PENDING_A, newName: 'rec_1.json' }]);
    });

    it('reads committed records back in chunks of 100 so a large rename batch never holds every record at once', async () => {
      setTableSpecIdColumnRemoteId('id');
      const files = Array.from({ length: 250 }, (_, i) => ({
        pendingFilename: `scratch_pending_${i}.json`,
        recordId: `rec_${i}`,
        committedRecord: { id: `rec_${i}`, title: `Record ${i}` },
      }));
      setupPublishedCreates(files);
      // Serve exactly the filenames each chunk asks for, so the assertion
      // below proves the chunks are what got read (not the whole batch).
      jest
        .mocked(scratchGitService.readRepoFilesFromFolder)
        .mockImplementation((_repoId, _branch, _folder, filenames: string[]) =>
          Promise.resolve(
            filenames.map((filename) => {
              const file = files.find((f) => f.pendingFilename === filename);
              return { path: `articles/${filename}`, content: file ? JSON.stringify(file.committedRecord) : null };
            }),
          ),
        );
      jest
        .mocked(connector.getSuggestedRecordFileNames)
        .mockImplementation((records: unknown[]) => records.map((r) => (r as { title: string }).title));

      await service.runPipeline(PLAN_ID);

      const readCalls = jest.mocked(scratchGitService.readRepoFilesFromFolder).mock.calls;
      expect(readCalls.map((call) => call[3].length)).toEqual([100, 100, 50]);
      expect(jest.mocked(connector.getSuggestedRecordFileNames).mock.calls.map((call) => call[0].length)).toEqual([
        100, 100, 50,
      ]);
      const renames = renamesSent();
      expect(renames).toHaveLength(250);
      expect(renames[0]).toEqual({ oldName: 'scratch_pending_0.json', newName: 'record-0.json' });
      expect(renames[249]).toEqual({ oldName: 'scratch_pending_249.json', newName: 'record-249.json' });
    });

    /** 1100 published creates → two rename batches (1000 + 100) in one folder. */
    function setupTwoRenameBatchesOfPublishedCreates(titleForRecordIndex: (i: number) => string) {
      setTableSpecIdColumnRemoteId('id');
      const files = Array.from({ length: 1100 }, (_, i) => ({
        pendingFilename: `scratch_pending_${i}.json`,
        recordId: `rec_${i}`,
        committedRecord: { id: `rec_${i}`, title: titleForRecordIndex(i) },
      }));
      setupPublishedCreates(files);
      jest
        .mocked(scratchGitService.readRepoFilesFromFolder)
        .mockImplementation((_repoId, _branch, _folder, filenames: string[]) =>
          Promise.resolve(
            filenames.map((filename) => {
              const file = files.find((f) => f.pendingFilename === filename);
              return { path: `articles/${filename}`, content: file ? JSON.stringify(file.committedRecord) : null };
            }),
          ),
        );
      jest
        .mocked(connector.getSuggestedRecordFileNames)
        .mockImplementation((records: unknown[]) => records.map((r) => (r as { title: string }).title));
    }

    it('reads the folder’s taken filenames once for the whole rename phase, not once per 1000-entry batch', async () => {
      // Record 1050 (second batch) suggests the same name record 0 (first batch) was just renamed to.
      setupTwoRenameBatchesOfPublishedCreates((i) => (i === 1050 ? 'Record 0' : `Record ${i}`));

      await service.runPipeline(PLAN_ID);

      expect(fileIndexService.listFilenamesForFolder).toHaveBeenCalledTimes(1);
      // The first batch's rename is remembered in memory across batches, so the collision is
      // still caught without re-reading the folder.
      expect(renamesSent()).toContainEqual({ oldName: 'scratch_pending_0.json', newName: 'record-0.json' });
      expect(renamesSent()).toContainEqual({
        oldName: 'scratch_pending_1050.json',
        newName: 'record-0-rec_1050.json',
      });
    });

    it('re-reads the folder’s taken filenames after a rename batch fails, instead of trusting the in-memory set', async () => {
      setupTwoRenameBatchesOfPublishedCreates((i) => `Record ${i}`);
      jest.mocked(scratchGitService.renameFiles).mockRejectedValueOnce(new Error('scratch-git 504'));

      await service.runPipeline(PLAN_ID);

      expect(fileIndexService.listFilenamesForFolder).toHaveBeenCalledTimes(2);
    });

    it('leaves a pending file alone (no rename) when its create never produced an index row', async () => {
      setTableSpecIdColumnRemoteId('id');
      setupPublishedCreates([{ pendingFilename: PENDING_A, recordId: 'rec_1', committedRecord: { id: 'rec_1' } }]);
      jest.mocked(fileIndexService.getRecordIdsByFilenamesInFolder).mockResolvedValue(new Map());
      jest.mocked(connector.getSuggestedRecordFileNames).mockReturnValue(['Orphan']);

      await service.runPipeline(PLAN_ID);

      expect(scratchGitService.renameFiles).not.toHaveBeenCalled();
      expect(fileIndexService.upsertBatch).not.toHaveBeenCalled();
    });
  });
});
