import { Test, TestingModule } from '@nestjs/testing';
import { DbService } from '../../db/db.service';
import { ScratchGitService } from '../../scratch-git/scratch-git.service';
import { FileIndexService } from '../file-index.service';
import { FileReferenceService } from '../file-reference.service';
import { PublishPlanBuildService } from '../publish-plan-build.service';
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
      getRepoStatus: jest.fn().mockResolvedValue([]),
      readRepoFilesByFolder: jest.fn().mockResolvedValue([]),
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
    } as unknown as jest.Mocked<RefCleanerService>;

    schemaService = {
      getDataFolderInfo: jest.fn().mockResolvedValue({ id: 'df_1', spec: { schema: {} } }),
    } as unknown as jest.Mocked<SchemaHelperService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PublishPlanBuildService,
        { provide: DbService, useValue: db },
        { provide: ScratchGitService, useValue: scratchGitService },
        { provide: FileIndexService, useValue: fileIndexService },
        { provide: FileReferenceService, useValue: fileReferenceService },
        { provide: RefCleanerService, useValue: refCleanerService },
        { provide: SchemaHelperService, useValue: schemaService },
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
});
