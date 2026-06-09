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
    } as unknown as jest.Mocked<RefResolverService>;

    const credentialService = {
      decryptCredentials: jest.fn().mockResolvedValue({ apiKey: 'test' }),
    } as unknown as jest.Mocked<CredentialEncryptionService>;

    const schemaService = {
      getTableSpec: jest.fn().mockResolvedValue({
        name: 'Articles',
        idColumnRemoteId: 'id',
        schema: {},
        id: { wsId: 'articles', remoteId: ['base1', 'tbl1'] },
        slug: 'articles',
      }),
      getTableSpecById: jest.fn().mockResolvedValue({
        name: 'Articles',
        idColumnRemoteId: 'id',
        schema: {},
        id: { wsId: 'articles', remoteId: ['base1', 'tbl1'] },
        slug: 'articles',
      }),
    } as unknown as jest.Mocked<SchemaHelperService>;

    const experimentsService = {
      // Flag-off by default in these tests — they assert against the
      // sent-payload commit path, not the connector-returned-rows path.
      getBooleanFlag: jest.fn().mockResolvedValue(false),
    } as unknown as jest.Mocked<ExperimentsService>;

    // Recreate flow isn't exercised by these tests; default the lookups to
    // empty + the upsert to a noop so dispatchCreateBatch's new code path
    // doesn't trip a missing-method when the connector flow happens to run.
    const recreatedIdMapService = {
      upsert: jest.fn().mockResolvedValue(undefined),
      resolveLatest: jest.fn().mockResolvedValue(null),
      resolveLatestBatch: jest.fn().mockResolvedValue(new Map()),
      resolveFkTargetFolders: jest.fn().mockResolvedValue(new Map()),
      deleteForWorkbook: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<RecreatedIdMapService>;

    const refCleanerService = {
      extractForeignKeyPaths: jest.fn().mockReturnValue([]),
      rewriteForeignKeyValues: jest.fn().mockImplementation((content: unknown) => content),
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
  });
});
