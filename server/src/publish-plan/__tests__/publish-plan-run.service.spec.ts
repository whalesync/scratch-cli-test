/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { CredentialEncryptionService } from '../../credential-encryption/credential-encryption.service';
import { DbService } from '../../db/db.service';
import { ExperimentsService } from '../../experiments/experiments.service';
import { Connector } from '../../remote-service/connectors/connector';
import { ConnectorsService } from '../../remote-service/connectors/connectors.service';
import { ScratchGitService } from '../../scratch-git/scratch-git.service';
import { FileIndexService } from '../file-index.service';
import { FileReferenceService } from '../file-reference.service';
import { PublishPlanRunService } from '../publish-plan-run.service';
import { RecreatedIdMapService } from '../recreated-id-map.service';
import { RefCleanerService } from '../ref-cleaner.service';
import { RefResolverService } from '../ref-resolver.service';
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
      fileReference: {
        deleteMany: jest.fn().mockResolvedValue({}),
      },
      fileIndex: {
        deleteMany: jest.fn().mockResolvedValue({}),
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
    } as unknown as jest.Mocked<ScratchGitService>;

    fileIndexService = {
      getRecordId: jest.fn().mockResolvedValue('rec_123'),
      upsertBatch: jest.fn().mockResolvedValue(undefined),
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

    // findMany for pending entries, distinct folders
    db.client.publishPlanOperation.findMany.mockImplementation(
      (args: {
        where?: { phase?: string; status?: string };
        distinct?: string[];
        select?: Record<string, boolean>;
      }) => {
        // distinct dataFolderIds query
        if (args?.distinct) {
          return Promise.resolve([{ dataFolderId: DATA_FOLDER_ID }]);
        }
        // actual entries for the edit phase
        if (args?.where?.phase === 'edit' && args?.where?.status === 'pending') {
          return Promise.resolve(
            entries.map((e) => ({
              ...e,
              planId: PLAN_ID,
              phase: 'edit',
              dataFolderId: DATA_FOLDER_ID,
              status: 'pending',
              error: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            })),
          );
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
    phase: 'edit' | 'create' | 'delete' | 'backfill',
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

    db.client.publishPlanOperation.findMany.mockImplementation(
      (args: {
        where?: { phase?: string; status?: string };
        distinct?: string[];
        select?: Record<string, boolean>;
      }) => {
        if (args?.distinct) {
          return Promise.resolve([{ dataFolderId: DATA_FOLDER_ID }]);
        }
        if (args?.where?.phase === phase && args?.where?.status === 'pending') {
          return Promise.resolve(
            entries.map((e) => ({
              ...e,
              planId: PLAN_ID,
              phase,
              dataFolderId: DATA_FOLDER_ID,
              status: 'pending',
              error: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            })),
          );
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
      const failedData = (failedBatchCall![0] as { data: { status: string; error: string } }).data;
      expect(failedData.error).toBe(serviceValidationMessage);
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
      jest.mocked(db.client.publishPlanOperation.findMany).mockImplementation((args: unknown) => {
        const a = args as {
          where?: { phase?: string; status?: string };
          distinct?: string[];
          select?: Record<string, boolean>;
        };
        if (a?.distinct) return Promise.resolve([{ dataFolderId: DATA_FOLDER_ID }]);
        // The bounded summary query (has a `select`) returns the failed row with
        // its persisted connector message; the retry query (no `select`) returns
        // [] so the failed entry isn't reprocessed.
        if (a?.where?.status === 'failed-batch') {
          return Promise.resolve(
            a.select ? [{ filePath: 'Activities/call-nishant.json', phase: 'edit', error: connectorMessage }] : [],
          );
        }
        // Pending entries only exist for the edit phase in this test.
        if (a?.where?.phase === 'edit' && a?.where?.status === 'pending') {
          return Promise.resolve([
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
          ]);
        }
        return Promise.resolve([]);
      });

      const result = await service.runPipeline(PLAN_ID);

      expect(result.failedCount).toBe(1);
      expect(result.failedOperations).toEqual([
        { filePath: 'Activities/call-nishant.json', phase: 'edit', error: connectorMessage },
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
});
