/* eslint-disable @typescript-eslint/unbound-method */
import { Test, TestingModule } from '@nestjs/testing';
import { AssetIndexService } from '../../asset/asset-index.service';
import { CredentialEncryptionService } from '../../credential-encryption/credential-encryption.service';
import { DbService } from '../../db/db.service';
import { WSLogger } from '../../logger';
import { ConnectorsService } from '../../remote-service/connectors/connectors.service';
import { ScratchGitService } from '../../scratch-git/scratch-git.service';
import { FileIndexService } from '../file-index.service';
import { FileReferenceService } from '../file-reference.service';
import { PublishDirtyDriftError, PublishPlanBuildService } from '../publish-plan-build.service';
import { RefCleanerService } from '../ref-cleaner.service';
import { SchemaHelperService } from '../schema-helper.service';

const WORKBOOK_ID = 'wkb_test';
const USER_ID = 'user_test';
const PIPELINE_ID = 'pipeline_test';
const BRANCH_NAME = `publish/${USER_ID}/${PIPELINE_ID}`;

// Minimal Prisma mock that captures createMany calls
function makeDbMock() {
  return {
    client: {
      publishPlan: {
        create: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ id: PIPELINE_ID, branchName: BRANCH_NAME }),
        update: jest.fn().mockResolvedValue({}),
      },
      publishPlanOperation: {
        createMany: jest.fn().mockResolvedValue({}),
      },
      dataFolder: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      // Plan-build joins UploadPatchMeta to set PublishPlanOperation.isRecreate.
      // Default to no flagged paths — individual tests can override per case.
      uploadPatchMeta: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      connectorAccount: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ca_test',
          service: 'AIRTABLE',
          encryptedCredentials: {},
        }),
      },
    },
  };
}

describe('PublishPlanService', () => {
  let service: PublishPlanBuildService;
  let db: ReturnType<typeof makeDbMock>;
  let scratchGitService: jest.Mocked<ScratchGitService>;
  let fileIndexService: jest.Mocked<FileIndexService>;
  let fileReferenceService: jest.Mocked<FileReferenceService>;
  let refCleanerService: jest.Mocked<RefCleanerService>;
  let schemaService: jest.Mocked<SchemaHelperService>;

  beforeEach(async () => {
    db = makeDbMock();

    scratchGitService = {
      resolveConnectionRepoPath: jest.fn().mockImplementation((wkbId: string) => Promise.resolve(wkbId)),
      getRepoStatus: jest.fn().mockResolvedValue([]),
      readRepoFilesByFolder: jest.fn().mockResolvedValue([]),
      rebaseDirty: jest.fn().mockResolvedValue(undefined),
      // DEV-10316 dirty-drift gate. Only consulted when an expectedBaseDirtyHead
      // is passed; default to a stable HEAD + zero pending so unrelated tests
      // never trip the gate.
      getBranchHead: jest.fn().mockResolvedValue('headsha'),
      getPendingChangeCountVsMain: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<ScratchGitService>;

    fileIndexService = {
      getRecordIds: jest.fn().mockResolvedValue(new Map()),
    } as unknown as jest.Mocked<FileIndexService>;

    fileReferenceService = {
      findRefsToFiles: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<FileReferenceService>;

    refCleanerService = {
      // Pass content through unchanged by default
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      stripDeletedRecordRefs: jest.fn().mockImplementation((content) => content),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      stripPseudoRefs: jest.fn().mockImplementation((content) => content),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      stripAssetPseudoRefs: jest.fn().mockImplementation((content) => content),
      // pass4 default: identity (no FKs stripped). Individual tests override
      // mockReturnValueOnce to simulate the FK-strip on a revert path.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      nullifyAllForeignKeyFields: jest.fn().mockImplementation((content) => content),
    } as unknown as jest.Mocked<RefCleanerService>;

    schemaService = {
      getDataFolderInfo: jest.fn().mockResolvedValue({ id: 'df_1', spec: { schema: {} } }),
      refreshSchemasForConnection: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<SchemaHelperService>;

    const assetIndexService = {
      findUnuploadedDestinationAssets: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<AssetIndexService>;

    const connectorsService = {
      getConnector: jest.fn().mockReturnValue({ supportsFileUpload: false }),
    } as unknown as jest.Mocked<ConnectorsService>;

    const credentialEncryptionService = {
      decryptCredentials: jest.fn().mockResolvedValue({}),
    } as unknown as jest.Mocked<CredentialEncryptionService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PublishPlanBuildService,
        { provide: DbService, useValue: db },
        { provide: ScratchGitService, useValue: scratchGitService },
        { provide: FileIndexService, useValue: fileIndexService },
        { provide: FileReferenceService, useValue: fileReferenceService },
        { provide: RefCleanerService, useValue: refCleanerService },
        { provide: SchemaHelperService, useValue: schemaService },
        { provide: AssetIndexService, useValue: assetIndexService },
        { provide: ConnectorsService, useValue: connectorsService },
        { provide: CredentialEncryptionService, useValue: credentialEncryptionService },
      ],
    }).compile();

    service = module.get<PublishPlanBuildService>(PublishPlanBuildService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('buildPipeline with existingPipelineId', () => {
    it('returns a planned result with no phases when there are no changes', async () => {
      scratchGitService.getRepoStatus.mockResolvedValue([]);

      const result = await service.buildPipeline(WORKBOOK_ID, USER_ID, undefined, PIPELINE_ID);

      expect(result.pipelineId).toBe(PIPELINE_ID);
      expect(result.status).toBe('planned');
      expect(db.client.publishPlan.update).toHaveBeenCalledWith({
        where: { id: PIPELINE_ID },
        data: { status: 'planned' },
      });
      expect(db.client.publishPlanOperation.createMany).not.toHaveBeenCalled();
    });
  });

  // DEV-10316 publish-time TOCTOU gate. When the desktop passes the dirty HEAD
  // it captured at upload (`expectedBaseDirtyHead`), the build must abort BEFORE
  // `rebaseDirty` (which force-moves the HEAD) if the connection's current dirty
  // HEAD has drifted — proving the publish ships exactly what was uploaded.
  describe('DEV-10316 dirty-drift gate', () => {
    const CONN = 'ca_test';
    const UPLOAD_HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    it('aborts with PublishDirtyDriftError when the dirty HEAD drifted since upload', async () => {
      scratchGitService.getBranchHead.mockResolvedValue('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
      scratchGitService.getPendingChangeCountVsMain.mockResolvedValue(47);

      await expect(
        service.buildPipeline(WORKBOOK_ID, USER_ID, CONN, PIPELINE_ID, undefined, undefined, UPLOAD_HEAD),
      ).rejects.toBeInstanceOf(PublishDirtyDriftError);

      // The whole point: the comparison happens before rebaseDirty force-moves
      // the HEAD, and the diff/plan is never built on the drifted staging area.
      expect(scratchGitService.rebaseDirty).not.toHaveBeenCalled();
      expect(scratchGitService.getRepoStatus).not.toHaveBeenCalled();
      // The error carries the count for the desktop's count-only redirect.
      expect(scratchGitService.getPendingChangeCountVsMain).toHaveBeenCalledWith(CONN);
    });

    it('carries the connection + pending count on the thrown error', async () => {
      scratchGitService.getBranchHead.mockResolvedValue('cccccccccccccccccccccccccccccccccccccccc');
      scratchGitService.getPendingChangeCountVsMain.mockResolvedValue(12);

      const err = await service
        .buildPipeline(WORKBOOK_ID, USER_ID, CONN, PIPELINE_ID, undefined, undefined, UPLOAD_HEAD)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PublishDirtyDriftError);
      const drift = err as PublishDirtyDriftError;
      expect(drift.connectorAccountId).toBe(CONN);
      expect(drift.dirtyCount).toBe(12);
      expect(drift.expectedBaseDirtyHead).toBe(UPLOAD_HEAD);
    });

    it('proceeds (rebases + plans) when the dirty HEAD still matches the token', async () => {
      scratchGitService.getBranchHead.mockResolvedValue(UPLOAD_HEAD);

      const result = await service.buildPipeline(
        WORKBOOK_ID,
        USER_ID,
        CONN,
        PIPELINE_ID,
        undefined,
        undefined,
        UPLOAD_HEAD,
      );

      expect(result.status).toBe('planned');
      expect(scratchGitService.rebaseDirty).toHaveBeenCalledWith(CONN);
      expect(scratchGitService.getPendingChangeCountVsMain).not.toHaveBeenCalled();
    });

    it('skips the gate entirely when no expectedBaseDirtyHead is provided (legacy / CLI publish)', async () => {
      await service.buildPipeline(WORKBOOK_ID, USER_ID, CONN, PIPELINE_ID);

      expect(scratchGitService.getBranchHead).not.toHaveBeenCalled();
      expect(scratchGitService.rebaseDirty).toHaveBeenCalledWith(CONN);
    });
  });

  describe('Phase 1: edit', () => {
    it('creates an edit entry for a modified file', async () => {
      const filePath = 'articles/article1.json';
      const content = JSON.stringify({ title: 'Hello' });

      scratchGitService.getRepoStatus.mockResolvedValue([{ path: filePath, status: 'modified' }]);
      scratchGitService.readRepoFilesByFolder.mockResolvedValue([{ path: filePath, content }]);

      await service.buildPipeline(WORKBOOK_ID, USER_ID, undefined, PIPELINE_ID);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const saved = db.client.publishPlanOperation.createMany.mock.calls[0][0].data as Array<{ phase: string }>;
      expect(saved.some((e) => e.phase === 'edit')).toBe(true);
    });

    it('falls back to main branch when file is missing from dirty', async () => {
      const filePath = 'articles/ref-clearer.json';
      const content = JSON.stringify({ title: 'Ref file' });

      // Simulate a file that refers to deleted content — present in main but not dirty
      scratchGitService.getRepoStatus.mockResolvedValue([{ path: 'articles/deleted.json', status: 'deleted' }]);
      fileIndexService.getRecordIds.mockResolvedValue(new Map([['articles:deleted.json', 'rec_deleted']]));
      fileReferenceService.findRefsToFiles.mockResolvedValue([{ sourceFilePath: filePath, branch: 'main' }]);

      // dirty returns nothing for the ref-clearing candidate; main has it
      scratchGitService.readRepoFilesByFolder.mockImplementation((_wkb, branch, paths) => {
        if (branch === 'main') {
          return Promise.resolve(paths.map((p) => ({ path: p, content: p === filePath ? content : null })));
        }
        return Promise.resolve(paths.map((p) => ({ path: p, content: null })));
      });

      await service.buildPipeline(WORKBOOK_ID, USER_ID, undefined, PIPELINE_ID);

      // readRepoFilesByFolder should have been called for both dirty and main
      const calls = scratchGitService.readRepoFilesByFolder.mock.calls;
      expect(calls.some(([, branch]) => branch === 'dirty')).toBe(true);
      expect(calls.some(([, branch]) => branch === 'main')).toBe(true);
    });

    it('creates a backfill entry when pseudo-ref stripping changes the content', async () => {
      const filePath = 'articles/article1.json';
      const originalContent = { title: 'Hello', ref: '@/new/record.json' };
      const strippedContent = { title: 'Hello', ref: null };

      scratchGitService.getRepoStatus.mockResolvedValue([{ path: filePath, status: 'modified' }]);
      scratchGitService.readRepoFilesByFolder.mockResolvedValue([
        { path: filePath, content: JSON.stringify(originalContent) },
      ]);

      // Pass 1 (deleted record IDs): no change; Pass 2 (pseudo-refs): strips the ref
      refCleanerService.stripDeletedRecordRefs.mockReturnValueOnce(originalContent);
      refCleanerService.stripPseudoRefs.mockReturnValueOnce(strippedContent);

      await service.buildPipeline(WORKBOOK_ID, USER_ID, undefined, PIPELINE_ID);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const saved = db.client.publishPlanOperation.createMany.mock.calls[0][0].data as Array<{ phase: string }>;
      expect(saved.some((e) => e.phase === 'edit')).toBe(true);
      expect(saved.some((e) => e.phase === 'backfill')).toBe(true);
    });
  });

  describe('Phase 2: create', () => {
    it('creates a create entry for an added file', async () => {
      const filePath = 'articles/new.json';
      const content = JSON.stringify({ title: 'New Article' });

      scratchGitService.getRepoStatus.mockResolvedValue([{ path: filePath, status: 'added' }]);
      scratchGitService.readRepoFilesByFolder.mockResolvedValue([{ path: filePath, content }]);

      await service.buildPipeline(WORKBOOK_ID, USER_ID, undefined, PIPELINE_ID);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const saved = db.client.publishPlanOperation.createMany.mock.calls[0][0].data as Array<{ phase: string }>;
      expect(saved.some((e) => e.phase === 'create')).toBe(true);
    });

    it('skips a file that is not found in dirty', async () => {
      const filePath = 'articles/ghost.json';

      scratchGitService.getRepoStatus.mockResolvedValue([{ path: filePath, status: 'added' }]);
      scratchGitService.readRepoFilesByFolder.mockResolvedValue([{ path: filePath, content: null }]);

      await service.buildPipeline(WORKBOOK_ID, USER_ID, undefined, PIPELINE_ID);

      expect(db.client.publishPlanOperation.createMany).not.toHaveBeenCalled();
    });

    it('logs a warning when an added file has null content', async () => {
      const warnSpy = jest.spyOn(WSLogger, 'warn').mockImplementation();
      const filePath = 'articles/ghost.json';

      scratchGitService.getRepoStatus.mockResolvedValue([{ path: filePath, status: 'added' }]);
      scratchGitService.readRepoFilesByFolder.mockResolvedValue([{ path: filePath, content: null }]);

      await service.buildPipeline(WORKBOOK_ID, USER_ID, undefined, PIPELINE_ID);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining(filePath) as string,
        }),
      );
      warnSpy.mockRestore();
    });

    it('still creates other files when one file in the batch has null content', async () => {
      const warnSpy = jest.spyOn(WSLogger, 'warn').mockImplementation();
      const goodFile = 'articles/good.json';
      const badFile = 'articles/bad.json';
      const content = JSON.stringify({ title: 'Good Article' });

      scratchGitService.getRepoStatus.mockResolvedValue([
        { path: goodFile, status: 'added' },
        { path: badFile, status: 'added' },
      ]);
      scratchGitService.readRepoFilesByFolder.mockResolvedValue([
        { path: goodFile, content },
        { path: badFile, content: null },
      ]);

      await service.buildPipeline(WORKBOOK_ID, USER_ID, undefined, PIPELINE_ID);

      // The good file should still get a create operation
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const saved = db.client.publishPlanOperation.createMany.mock.calls[0][0].data as Array<{
        phase: string;
        filePath: string;
      }>;
      expect(saved.some((e) => e.phase === 'create' && e.filePath === goodFile)).toBe(true);
      expect(saved.some((e) => e.filePath === badFile)).toBe(false);

      // Warning should be logged for the bad file
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining(badFile) as string,
        }),
      );
      warnSpy.mockRestore();
    });
  });

  describe('Phase 3: delete', () => {
    it('creates a delete entry for a deleted file', async () => {
      const filePath = 'articles/old.json';

      scratchGitService.getRepoStatus.mockResolvedValue([{ path: filePath, status: 'deleted' }]);
      fileIndexService.getRecordIds.mockResolvedValue(new Map([['articles:old.json', 'rec_old']]));
      fileReferenceService.findRefsToFiles.mockResolvedValue([]);

      await service.buildPipeline(WORKBOOK_ID, USER_ID, undefined, PIPELINE_ID);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const saved = db.client.publishPlanOperation.createMany.mock.calls[0][0].data as Array<{
        phase: string;
        remoteRecordId: string | null;
      }>;
      const deleteEntry = saved.find((e) => e.phase === 'delete');
      expect(deleteEntry).toBeDefined();
      expect(deleteEntry?.remoteRecordId).toBe('rec_old');
    });
  });

  describe('changedFields computation', () => {
    // Helper to extract saved operations from createMany calls
    const getSavedOps = () => {
      const allCalls = db.client.publishPlanOperation.createMany.mock.calls;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
      return allCalls.flatMap((call) => call[0].data) as Array<{
        phase: string;
        filePath: string;
        content: Record<string, unknown>;
        changedFields: Record<string, unknown> | null;
      }>;
    };

    it('computes changedFields with only the changed field for an edit', async () => {
      const filePath = 'articles/article1.json';
      const mainContent = { title: 'Old Title', body: 'Same' };
      const dirtyContent = { title: 'New Title', body: 'Same' };

      scratchGitService.getRepoStatus.mockResolvedValue([{ path: filePath, status: 'modified' }]);
      scratchGitService.readRepoFilesByFolder.mockImplementation((_wkb, branch, paths) => {
        const content = branch === 'dirty' ? JSON.stringify(dirtyContent) : JSON.stringify(mainContent);
        return Promise.resolve(paths.map((p) => ({ path: p, content })));
      });

      await service.buildPipeline(WORKBOOK_ID, USER_ID, undefined, PIPELINE_ID);

      const ops = getSavedOps();
      const editOp = ops.find((e) => e.phase === 'edit');
      expect(editOp?.changedFields).toEqual({ title: 'New Title' });
    });

    it('computes changedFields with multiple changed fields', async () => {
      const filePath = 'articles/article1.json';
      const mainContent = { title: 'Old', body: 'Old Body', slug: 'same' };
      const dirtyContent = { title: 'New', body: 'New Body', slug: 'same' };

      scratchGitService.getRepoStatus.mockResolvedValue([{ path: filePath, status: 'modified' }]);
      scratchGitService.readRepoFilesByFolder.mockImplementation((_wkb, branch, paths) => {
        const content = branch === 'dirty' ? JSON.stringify(dirtyContent) : JSON.stringify(mainContent);
        return Promise.resolve(paths.map((p) => ({ path: p, content })));
      });

      await service.buildPipeline(WORKBOOK_ID, USER_ID, undefined, PIPELINE_ID);

      const ops = getSavedOps();
      const editOp = ops.find((e) => e.phase === 'edit');
      expect(editOp?.changedFields).toEqual({ title: 'New', body: 'New Body' });
    });

    it('computes empty changedFields when content is identical but status is modified', async () => {
      const filePath = 'articles/article1.json';
      const content = { title: 'Same' };

      scratchGitService.getRepoStatus.mockResolvedValue([{ path: filePath, status: 'modified' }]);
      scratchGitService.readRepoFilesByFolder.mockResolvedValue([{ path: filePath, content: JSON.stringify(content) }]);

      await service.buildPipeline(WORKBOOK_ID, USER_ID, undefined, PIPELINE_ID);

      const ops = getSavedOps();
      const editOp = ops.find((e) => e.phase === 'edit');
      expect(editOp?.changedFields).toEqual({});
    });

    it('computes nested changedFields (e.g., Airtable fields wrapper)', async () => {
      const filePath = 'articles/article1.json';
      const mainContent = { id: 'rec1', fields: { Name: 'Old', Notes: 'Same' } };
      const dirtyContent = { id: 'rec1', fields: { Name: 'New', Notes: 'Same' } };

      scratchGitService.getRepoStatus.mockResolvedValue([{ path: filePath, status: 'modified' }]);
      scratchGitService.readRepoFilesByFolder.mockImplementation((_wkb, branch, paths) => {
        const content = branch === 'dirty' ? JSON.stringify(dirtyContent) : JSON.stringify(mainContent);
        return Promise.resolve(paths.map((p) => ({ path: p, content })));
      });

      await service.buildPipeline(WORKBOOK_ID, USER_ID, undefined, PIPELINE_ID);

      const ops = getSavedOps();
      const editOp = ops.find((e) => e.phase === 'edit');
      expect(editOp?.changedFields).toEqual({ fields: { Name: 'New' } });
    });

    it('reads main branch for the full edit batch', async () => {
      const filePath = 'articles/article1.json';
      const content = JSON.stringify({ title: 'Hello' });

      scratchGitService.getRepoStatus.mockResolvedValue([{ path: filePath, status: 'modified' }]);
      scratchGitService.readRepoFilesByFolder.mockResolvedValue([{ path: filePath, content }]);

      await service.buildPipeline(WORKBOOK_ID, USER_ID, undefined, PIPELINE_ID);

      // Should have been called for both dirty AND main
      const calls = scratchGitService.readRepoFilesByFolder.mock.calls;
      expect(calls.some(([, branch]) => branch === 'dirty')).toBe(true);
      expect(calls.some(([, branch]) => branch === 'main')).toBe(true);
    });

    it('sets changedFields to full content when main version is missing', async () => {
      const filePath = 'articles/article1.json';
      const dirtyContent = { title: 'New' };

      scratchGitService.getRepoStatus.mockResolvedValue([{ path: filePath, status: 'modified' }]);
      scratchGitService.readRepoFilesByFolder.mockImplementation((_wkb, branch, paths) => {
        if (branch === 'dirty') {
          return Promise.resolve(paths.map((p) => ({ path: p, content: JSON.stringify(dirtyContent) })));
        }
        // main returns null
        return Promise.resolve(paths.map((p) => ({ path: p, content: null })));
      });

      await service.buildPipeline(WORKBOOK_ID, USER_ID, undefined, PIPELINE_ID);

      const ops = getSavedOps();
      const editOp = ops.find((e) => e.phase === 'edit');
      expect(editOp?.changedFields).toEqual(dirtyContent);
    });

    it('computes changedFields for backfill entries (pseudo-ref diff)', async () => {
      const filePath = 'articles/article1.json';
      const originalContent = { title: 'Hello', ref: '@/new/record.json' };
      const strippedContent = { title: 'Hello', ref: null };

      scratchGitService.getRepoStatus.mockResolvedValue([{ path: filePath, status: 'modified' }]);
      scratchGitService.readRepoFilesByFolder.mockResolvedValue([
        { path: filePath, content: JSON.stringify(originalContent) },
      ]);

      refCleanerService.stripDeletedRecordRefs.mockReturnValueOnce(originalContent);
      refCleanerService.stripPseudoRefs.mockReturnValueOnce(strippedContent);

      await service.buildPipeline(WORKBOOK_ID, USER_ID, undefined, PIPELINE_ID);

      const ops = getSavedOps();
      const backfillOp = ops.find((e) => e.phase === 'backfill');
      expect(backfillOp).toBeDefined();
      // Backfill changedFields = diff(pass2 → pass1), capturing only the pseudo-ref field
      expect(backfillOp?.changedFields).toEqual({ ref: '@/new/record.json' });
    });

    it('does not set changedFields for create operations', async () => {
      const filePath = 'articles/new.json';
      const content = JSON.stringify({ title: 'New Article' });

      scratchGitService.getRepoStatus.mockResolvedValue([{ path: filePath, status: 'added' }]);
      scratchGitService.readRepoFilesByFolder.mockResolvedValue([{ path: filePath, content }]);

      await service.buildPipeline(WORKBOOK_ID, USER_ID, undefined, PIPELINE_ID);

      const ops = getSavedOps();
      const createOp = ops.find((e) => e.phase === 'create');
      expect(createOp?.changedFields).toBeUndefined();
    });

    it('does not set changedFields for delete operations', async () => {
      const filePath = 'articles/old.json';

      scratchGitService.getRepoStatus.mockResolvedValue([{ path: filePath, status: 'deleted' }]);
      fileIndexService.getRecordIds.mockResolvedValue(new Map([['articles:old.json', 'rec_old']]));
      fileReferenceService.findRefsToFiles.mockResolvedValue([]);

      await service.buildPipeline(WORKBOOK_ID, USER_ID, undefined, PIPELINE_ID);

      const ops = getSavedOps();
      const deleteOp = ops.find((e) => e.phase === 'delete');
      expect(deleteOp?.changedFields).toBeUndefined();
    });
  });

  describe('batching', () => {
    it('calls readRepoFiles in batches of 100 for large edit sets', async () => {
      // 150 modified files → 2 batches
      const files = Array.from({ length: 150 }, (_, i) => ({
        path: `articles/file${i}.json`,
        status: 'modified' as const,
      }));
      const content = JSON.stringify({ title: 'x' });

      scratchGitService.getRepoStatus.mockResolvedValue(files);
      scratchGitService.readRepoFilesByFolder.mockImplementation((_wkb, _branch, paths) =>
        Promise.resolve(paths.map((p) => ({ path: p, content }))),
      );

      await service.buildPipeline(WORKBOOK_ID, USER_ID, undefined, PIPELINE_ID);

      // Two dirty-branch batches for the edit phase
      const dirtyCalls = scratchGitService.readRepoFilesByFolder.mock.calls.filter(([, branch]) => branch === 'dirty');
      expect(dirtyCalls.length).toBe(2);
      expect(dirtyCalls[0][2].length).toBe(100);
      expect(dirtyCalls[1][2].length).toBe(50);
    });

    it('calls savePlanEntries after each batch', async () => {
      // 150 files → 2 edit batches → 2 createMany calls
      const files = Array.from({ length: 150 }, (_, i) => ({
        path: `articles/file${i}.json`,
        status: 'modified' as const,
      }));
      const content = JSON.stringify({ title: 'x' });

      scratchGitService.getRepoStatus.mockResolvedValue(files);
      scratchGitService.readRepoFilesByFolder.mockImplementation((_wkb, _branch, paths) =>
        Promise.resolve(paths.map((p) => ({ path: p, content }))),
      );

      await service.buildPipeline(WORKBOOK_ID, USER_ID, undefined, PIPELINE_ID);

      expect(db.client.publishPlanOperation.createMany).toHaveBeenCalledTimes(2);
    });
  });

  describe('read-only folder enforcement (DEV-9928)', () => {
    const CONNECTOR_ACCOUNT_ID = 'ca_test';

    it('excludes files under a read-only folder from the plan', async () => {
      const writableFile = 'writable/article.json';
      const readOnlyFile = 'locked/article.json';
      const content = JSON.stringify({ title: 'Hi' });

      db.client.dataFolder.findMany.mockResolvedValue([
        { id: 'df_writable', path: '/writable', options: {} },
        { id: 'df_locked', path: '/locked', options: { readOnly: true } },
      ]);
      scratchGitService.getRepoStatus.mockResolvedValue([
        { path: writableFile, status: 'modified' },
        { path: readOnlyFile, status: 'modified' },
      ]);
      scratchGitService.readRepoFilesByFolder.mockImplementation((_wkb, _branch, paths) =>
        Promise.resolve(paths.map((p) => ({ path: p, content }))),
      );

      await service.buildPipeline(WORKBOOK_ID, USER_ID, CONNECTOR_ACCOUNT_ID, PIPELINE_ID);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const saved = db.client.publishPlanOperation.createMany.mock.calls[0][0].data as Array<{
        phase: string;
        filePath: string;
      }>;
      expect(saved.some((e) => e.filePath === writableFile)).toBe(true);
      expect(saved.some((e) => e.filePath === readOnlyFile)).toBe(false);
    });

    it('produces no operations when every folder is read-only', async () => {
      const readOnlyFile = 'locked/article.json';
      const content = JSON.stringify({ title: 'Hi' });

      db.client.dataFolder.findMany.mockResolvedValue([
        { id: 'df_locked', path: '/locked', options: { readOnly: true } },
      ]);
      scratchGitService.getRepoStatus.mockResolvedValue([{ path: readOnlyFile, status: 'modified' }]);
      scratchGitService.readRepoFilesByFolder.mockImplementation((_wkb, _branch, paths) =>
        Promise.resolve(paths.map((p) => ({ path: p, content }))),
      );

      await service.buildPipeline(WORKBOOK_ID, USER_ID, CONNECTOR_ACCOUNT_ID, PIPELINE_ID);

      expect(db.client.publishPlanOperation.createMany).not.toHaveBeenCalled();
    });
  });

  describe('revert (pass4 FK strip + isRecreate emission)', () => {
    // The plan-build's pass4 nullifies FK fields on edits/creates whose path
    // is flagged `revert: true` in UploadPatchMeta (the CLI revert-plan
    // command sets this when restoring a pre-publish blob). FK literals
    // captured by that nullification flow into a separate BACKFILL op,
    // which the run-time backfill phase resolves against RecreatedIdMap
    // after the create phase has populated every (prior → new) row.
    //
    // The flag also propagates to PublishPlanOperation.isRecreate so the
    // dispatch and any downstream consumers can tell a revert apart from a
    // normal edit/create.

    it('emits isRecreate=true on create ops for paths flagged revert in UploadPatchMeta', async () => {
      const filePath = 'articles/recreate.json';
      const content = JSON.stringify({ id: 'scratch_pending_recreate_5', title: 'Revived' });

      scratchGitService.getRepoStatus.mockResolvedValue([{ path: filePath, status: 'added' }]);
      scratchGitService.readRepoFilesByFolder.mockResolvedValue([{ path: filePath, content }]);
      db.client.uploadPatchMeta.findMany.mockResolvedValue([{ filePath }]);

      // Connector-account-scoped plan: writable folders must be declared
      // explicitly so the plan-build's read-only filter doesn't drop the
      // path before it ever gets to pass4.
      db.client.dataFolder.findMany.mockResolvedValue([
        { id: 'df_articles', path: '/articles', options: null },
        { id: 'df_posts', path: '/posts', options: null },
      ]);
      await service.buildPipeline(WORKBOOK_ID, USER_ID, 'ca_test', PIPELINE_ID);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const saved = db.client.publishPlanOperation.createMany.mock.calls[0][0].data as Array<{
        phase: string;
        filePath: string;
        isRecreate: boolean;
      }>;
      const createOp = saved.find((e) => e.phase === 'create' && e.filePath === filePath);
      expect(createOp?.isRecreate).toBe(true);
    });

    it('emits isRecreate=false on create ops for paths NOT flagged revert', async () => {
      const filePath = 'articles/normal.json';
      const content = JSON.stringify({ title: 'Plain new article' });

      scratchGitService.getRepoStatus.mockResolvedValue([{ path: filePath, status: 'added' }]);
      scratchGitService.readRepoFilesByFolder.mockResolvedValue([{ path: filePath, content }]);
      db.client.uploadPatchMeta.findMany.mockResolvedValue([]); // nothing flagged

      // Connector-account-scoped plan: writable folders must be declared
      // explicitly so the plan-build's read-only filter doesn't drop the
      // path before it ever gets to pass4.
      db.client.dataFolder.findMany.mockResolvedValue([
        { id: 'df_articles', path: '/articles', options: null },
        { id: 'df_posts', path: '/posts', options: null },
      ]);
      await service.buildPipeline(WORKBOOK_ID, USER_ID, 'ca_test', PIPELINE_ID);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const saved = db.client.publishPlanOperation.createMany.mock.calls[0][0].data as Array<{
        phase: string;
        filePath: string;
        isRecreate: boolean;
      }>;
      const createOp = saved.find((e) => e.phase === 'create' && e.filePath === filePath);
      expect(createOp?.isRecreate).toBe(false);
    });

    it('nullifies FK fields on a revert-create and routes them into a BACKFILL op', async () => {
      // Pass4 is what splits a revert-create into:
      //   - a CREATE op with FK fields nulled (so the connector can't trip
      //     on a co-reverted parent whose new id is still pending)
      //   - a BACKFILL op carrying the original FK literals, which the
      //     run-time backfill phase resolves via RecreatedIdMap after every
      //     create in this plan has landed.
      const filePath = 'posts/recreate.json';
      const original = { id: 'scratch_pending_recreate_2', title: 'Post', authorId: 1 };
      const stripped = { id: 'scratch_pending_recreate_2', title: 'Post', authorId: null };

      scratchGitService.getRepoStatus.mockResolvedValue([{ path: filePath, status: 'added' }]);
      scratchGitService.readRepoFilesByFolder.mockResolvedValue([
        { path: filePath, content: JSON.stringify(original) },
      ]);
      db.client.uploadPatchMeta.findMany.mockResolvedValue([{ filePath }]);
      // The nullify step is what differentiates pass4 from pass3.
      refCleanerService.nullifyAllForeignKeyFields.mockReturnValueOnce(stripped);

      // Connector-account-scoped plan: writable folders must be declared
      // explicitly so the plan-build's read-only filter doesn't drop the
      // path before it ever gets to pass4.
      db.client.dataFolder.findMany.mockResolvedValue([
        { id: 'df_articles', path: '/articles', options: null },
        { id: 'df_posts', path: '/posts', options: null },
      ]);
      await service.buildPipeline(WORKBOOK_ID, USER_ID, 'ca_test', PIPELINE_ID);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const saved = db.client.publishPlanOperation.createMany.mock.calls[0][0].data as Array<{
        phase: string;
        filePath: string;
        isRecreate: boolean;
        content: Record<string, unknown>;
        changedFields?: Record<string, unknown>;
      }>;
      const createOp = saved.find((e) => e.phase === 'create' && e.filePath === filePath);
      const backfillOp = saved.find((e) => e.phase === 'backfill' && e.filePath === filePath);

      expect(createOp).toBeDefined();
      expect(createOp?.content.authorId).toBeNull();
      expect(createOp?.isRecreate).toBe(true);

      expect(backfillOp).toBeDefined();
      // Backfill content keeps the pre-strip (pass1) blob so dispatch can
      // resolve the FK against RecreatedIdMap. changedFields is the diff:
      // only the FK key that got nulled.
      expect(backfillOp?.content.authorId).toBe(1);
      expect(backfillOp?.changedFields).toEqual({ authorId: 1 });
      expect(backfillOp?.isRecreate).toBe(true);
    });

    it('does NOT call nullifyAllForeignKeyFields for non-revert paths', async () => {
      // pass4 is a no-op for ordinary edits/creates. The strip cost only
      // applies when the path is on the revert list.
      const filePath = 'articles/plain.json';
      const content = JSON.stringify({ title: 'X', authorId: 1 });

      scratchGitService.getRepoStatus.mockResolvedValue([{ path: filePath, status: 'added' }]);
      scratchGitService.readRepoFilesByFolder.mockResolvedValue([{ path: filePath, content }]);
      db.client.uploadPatchMeta.findMany.mockResolvedValue([]);

      // Connector-account-scoped plan: writable folders must be declared
      // explicitly so the plan-build's read-only filter doesn't drop the
      // path before it ever gets to pass4.
      db.client.dataFolder.findMany.mockResolvedValue([
        { id: 'df_articles', path: '/articles', options: null },
        { id: 'df_posts', path: '/posts', options: null },
      ]);
      await service.buildPipeline(WORKBOOK_ID, USER_ID, 'ca_test', PIPELINE_ID);

      expect(refCleanerService.nullifyAllForeignKeyFields).not.toHaveBeenCalled();
    });
  });
});
