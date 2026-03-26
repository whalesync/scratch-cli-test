/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { CredentialEncryptionService } from '../../credential-encryption/credential-encryption.service';
import { DbService } from '../../db/db.service';
import { Connector } from '../../remote-service/connectors/connector';
import { ConnectorsService } from '../../remote-service/connectors/connectors.service';
import { ScratchGitService } from '../../scratch-git/scratch-git.service';
import { FileIndexService } from '../file-index.service';
import { FileReferenceService } from '../file-reference.service';
import { PublishPlanRunService } from '../publish-plan-run.service';
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
      expect(cfArr![0]).toEqual({ title: 'New1' });
      expect(cfArr![1]).toEqual({ body: 'New2' });
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

    it('passes undefined changedFields for legacy plans (null changedFields)', async () => {
      setupEditPhaseEntries([
        {
          id: 'op_1',
          filePath: 'articles/a1.json',
          content: { id: 'rec_1', title: 'Hello' },
          changedFields: null,
          remoteRecordId: 'rec_1',
        },
      ]);

      await service.runPipeline(PLAN_ID);

      expect(connector.updateRecords).toHaveBeenCalledTimes(1);
      const updateMock = jest.mocked(connector.updateRecords);
      const [, , cfArg] = updateMock.mock.calls[0];
      // When no entry has changedFields, pass undefined
      expect(cfArg).toBeUndefined();
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
});
