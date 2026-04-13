/* eslint-disable @typescript-eslint/unbound-method */
import { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import { DataFolderId, WorkbookId } from '@spinner/shared-types';
import { AssetExtractorService } from 'src/asset/asset-extractor.service';
import { AssetIndexService } from 'src/asset/asset-index.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { FileIndexService } from 'src/publish-plan/file-index.service';
import { FileReferenceService } from 'src/publish-plan/file-reference.service';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { MAIN_BRANCH, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { ConnectorsService } from '../../../remote-service/connectors/connectors.service';
import { BaseJsonTableSpec, ConnectorFile } from '../../../remote-service/connectors/types';
import { JsonSafeObject } from '../../../utils/objects';
import { WorkbookEventService } from '../../../workbook/workbook-event.service';
import { buildGitFilesFromConnectorFiles, fullPathFromFolderAndFileName } from './connector-file-utils';
import { PullLinkedFolderFilesJobHandler, PullLinkedFolderFilesPublicProgress } from './pull-linked-folder-files.job';

type PullCallback = (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>;
type CheckpointCall = [{ publicProgress: PullLinkedFolderFilesPublicProgress }];

describe('PullLinkedFolderFilesJobHandler', () => {
  let handler: PullLinkedFolderFilesJobHandler;
  let mockPrisma: jest.Mocked<PrismaClient>;
  let mockConnectorService: jest.Mocked<ConnectorsService>;
  let mockConnectorAccountService: jest.Mocked<ConnectorAccountService>;
  let mockSnapshotEventService: jest.Mocked<WorkbookEventService>;
  let mockScratchGitService: jest.Mocked<ScratchGitService>;
  let mockFileIndexService: jest.Mocked<FileIndexService>;
  let mockFileReferenceService: jest.Mocked<FileReferenceService>;
  let mockAssetExtractorService: jest.Mocked<AssetExtractorService>;
  let mockAssetIndexService: jest.Mocked<AssetIndexService>;
  let mockPostHogService: jest.Mocked<PostHogService>;

  beforeEach(() => {
    mockPrisma = {
      dataFolder: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'dfld_123',
            connectorAccountId: 'coa_123',
            connectorAccount: { displayName: 'Test Connection' },
          },
        ]),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      workbook: {
        findUnique: jest.fn().mockResolvedValue({ version: 1 }),
      },
    } as unknown as jest.Mocked<PrismaClient>;

    mockConnectorService = {
      getConnector: jest.fn(),
    } as unknown as jest.Mocked<ConnectorsService>;

    mockConnectorAccountService = {
      findOneById: jest.fn(),
    } as unknown as jest.Mocked<ConnectorAccountService>;

    mockSnapshotEventService = {
      sendWorkbookEvent: jest.fn(),
    } as unknown as jest.Mocked<WorkbookEventService>;

    mockScratchGitService = {
      resolveConnectionRepoPath: jest.fn().mockResolvedValue('wkb_123'),
      initRepo: jest.fn().mockResolvedValue(undefined),
      commitFilesToBranch: jest.fn(),
      rebaseDirty: jest.fn(),
      buildIndex: jest.fn().mockResolvedValue({ count: 0 }),
      listRepoFiles: jest.fn(),
      deleteFilesFromBranch: jest.fn(),
      runGitGc: jest.fn().mockResolvedValue(undefined),
      readSchemaFromGit: jest.fn().mockResolvedValue(null),
      writeSchemaToGit: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ScratchGitService>;

    mockFileIndexService = {
      getFilenamesByRecordIds: jest.fn().mockResolvedValue(new Map()),
      upsertBatch: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<FileIndexService>;
    mockFileReferenceService = {
      updateRefsForFiles: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<FileReferenceService>;
    mockAssetExtractorService = {
      extractAssets: jest.fn().mockReturnValue([]),
    } as unknown as jest.Mocked<AssetExtractorService>;
    mockAssetIndexService = {
      upsertBatch: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AssetIndexService>;
    mockPostHogService = {
      trackPullCompleted: jest.fn(),
    } as unknown as jest.Mocked<PostHogService>;

    handler = new PullLinkedFolderFilesJobHandler(
      mockPrisma,
      mockConnectorService,
      mockConnectorAccountService,
      mockSnapshotEventService,
      mockScratchGitService,
      mockFileIndexService,
      mockFileReferenceService,
      mockAssetExtractorService,
      mockAssetIndexService,
      mockPostHogService,
    );
  });

  describe('buildGitFilesFromConnectorFiles', () => {
    const createMockTableSpec = (overrides?: Partial<BaseJsonTableSpec>): BaseJsonTableSpec => ({
      idColumnRemoteId: 'id',
      slugFieldPath: 'slug',
      titleColumnRemoteId: ['title'],
      id: { remoteId: ['example'], wsId: '' },
      slug: 'example',
      name: 'Example',
      schema: Type.Object({}),

      ...overrides,
    });

    describe('file naming from suggested names', () => {
      it('should use suggested filename when provided', () => {
        const tableSpec = createMockTableSpec();
        const records: ConnectorFile[] = [{ id: 'rec1' }];
        const suggested = ['my-blog-post'];

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, new Set(), new Map(), suggested);

        expect(result).toHaveLength(1);
        expect(result[0].path).toContain('my-blog-post.json');
        expect(result[0].recordId).toBe('rec1');
        expect(result[0].parsedRecord).toEqual({ id: 'rec1' });
      });

      it('should fall back to id when suggested name is undefined', () => {
        const tableSpec = createMockTableSpec();
        const records: ConnectorFile[] = [{ id: 'rec-12345' }];

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, new Set(), new Map(), [undefined]);

        expect(result).toHaveLength(1);
        expect(result[0].path).toContain('rec-12345.json');
      });

      it('should fall back to id when suggested name is empty', () => {
        const tableSpec = createMockTableSpec();
        const records: ConnectorFile[] = [{ id: 'rec1' }];

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, new Set(), new Map(), ['']);

        expect(result).toHaveLength(1);
        expect(result[0].path).toContain('rec1.json');
      });

      it('should normalize suggested filenames', () => {
        const tableSpec = createMockTableSpec();
        const records: ConnectorFile[] = [{ id: 'rec1' }];
        const suggested = ['My Blog Post!'];

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, new Set(), new Map(), suggested);

        expect(result).toHaveLength(1);
        expect(result[0].path).toContain('my-blog-post.json');
      });
    });

    describe('deduplication', () => {
      it('should append record ID on filename collision', () => {
        const tableSpec = createMockTableSpec();
        const usedFileNames = new Set<string>();
        const records: ConnectorFile[] = [
          {
            id: 'rec1',
            title: 'Same Title',
          },
          {
            id: 'rec2',
            title: 'Same Title',
          },
        ];

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, usedFileNames, new Map(), [
          'Same Title',
          'Same Title',
        ]);

        expect(result).toHaveLength(2);
        expect(result[0].path).toContain('same-title.json');
        expect(result[1].path).toContain('same-title-rec2.json');
      });

      it('should preserve deduplication across multiple calls (cross-batch)', () => {
        const tableSpec = createMockTableSpec();
        const usedFileNames = new Set<string>();

        const batch1: ConnectorFile[] = [
          {
            id: 'rec1',
            title: 'Post',
          },
        ];
        const result1 = buildGitFilesFromConnectorFiles('/', batch1, tableSpec, usedFileNames, new Map(), ['Post']);

        const batch2: ConnectorFile[] = [
          {
            id: 'rec2',
            title: 'Post',
          },
        ];
        const result2 = buildGitFilesFromConnectorFiles('/', batch2, tableSpec, usedFileNames, new Map(), ['Post']);

        expect(result1[0].path).toContain('post.json');
        expect(result2[0].path).toContain('post-rec2.json');
      });
    });

    describe('path construction', () => {
      it('should collapse slashes in parentPath (no double-slash before filename)', () => {
        const tableSpec = createMockTableSpec();
        const records: ConnectorFile[] = [{ id: 'rec1', slug: 'test-file' }];

        expect(
          buildGitFilesFromConnectorFiles('/my-folder/', records, tableSpec, new Set(), new Map(), ['test-file'])[0]
            .path,
        ).toBe('/my-folder/test-file.json');
        expect(
          buildGitFilesFromConnectorFiles('//my//folder//', records, tableSpec, new Set(), new Map(), ['test-file'])[0]
            .path,
        ).toBe('/my/folder/test-file.json');
      });

      it('fullPathFromFolderAndFileName matches buildGitFilesFromConnectorFiles root and nested', () => {
        expect(fullPathFromFolderAndFileName('/', 'x.json')).toBe('/x.json');
        expect(fullPathFromFolderAndFileName('///', 'x.json')).toBe('/x.json');
        expect(fullPathFromFolderAndFileName('/a/b/', 'x.json')).toBe('/a/b/x.json');
      });

      it('should construct path with parentPath prefix', () => {
        const tableSpec = createMockTableSpec();
        const records: ConnectorFile[] = [
          {
            id: 'rec1',
            slug: 'test-file',
          },
        ];

        const result = buildGitFilesFromConnectorFiles('/my-folder', records, tableSpec, new Set(), new Map(), [
          'test-file',
        ]);

        expect(result[0].path).toBe('/my-folder/test-file.json');
      });

      it('should handle root path correctly (remove trailing slash)', () => {
        const tableSpec = createMockTableSpec();
        const records: ConnectorFile[] = [
          {
            id: 'rec1',
            slug: 'test-file',
          },
        ];

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, new Set(), new Map(), ['test-file']);

        expect(result[0].path).toBe('/test-file.json');
      });

      it('should handle empty parentPath', () => {
        const tableSpec = createMockTableSpec();
        const records: ConnectorFile[] = [
          {
            id: 'rec1',
            slug: 'test-file',
          },
        ];

        const result = buildGitFilesFromConnectorFiles('', records, tableSpec, new Set(), new Map(), ['test-file']);

        expect(result[0].path).toBe('/test-file.json');
      });
    });

    describe('content serialization', () => {
      it('should serialize record as JSON formatted with Prettier', () => {
        const tableSpec = createMockTableSpec();
        const records: ConnectorFile[] = [
          {
            name: 'Test',
            nested: {
              field: 'value',
            },
            id: 'rec1',
          },
        ];

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, new Set(), new Map(), [undefined]);

        expect(result[0].content).toEqual(`{
  "name": "Test",
  "nested": {
    "field": "value"
  },
  "id": "rec1"
}\n`);
        // Verify it's properly formatted (contains newlines, indentation)
        expect(result[0].content).toContain('\n');
        expect(result[0].content).toMatch(/^\{\n/);
      });

      it('should preserve all record properties in content', () => {
        const tableSpec = createMockTableSpec();
        const testRecord = {
          id: 'rec1',
          slug: 'test',
          title: 'Test Title',
          customField: 'custom value',
          arrayField: [1, 2, 3],
        };
        const records: ConnectorFile[] = [testRecord];

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, new Set(), new Map(), ['test']);

        const parsedContent = JSON.parse(result[0].content) as typeof testRecord;
        expect(parsedContent).toEqual(testRecord);
        // parsedRecord should also match the original
        expect(result[0].parsedRecord).toEqual(testRecord);
      });

      it('should format JSON consistently with Prettier formatting rules', () => {
        const tableSpec = createMockTableSpec();
        const records: ConnectorFile[] = [
          {
            id: 'rec1',
            data: {
              email: 'test@example.com',
              longFieldName: 'this is a very long value that should be formatted nicely',
            },
          },
        ];

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, new Set(), new Map(), [undefined]);

        // Verify JSON is valid and can be parsed
        const parsed = JSON.parse(result[0].content) as { id: string; data: { email: string } };
        expect(parsed.id).toBe('rec1');
        expect(parsed.data.email).toBe('test@example.com');

        // Verify formatting (has newlines and proper structure)
        expect(result[0].content).toContain('\n');
        expect(result[0].content.endsWith('\n')).toBe(true);
      });
    });

    describe('multiple records', () => {
      it('should process multiple records correctly', () => {
        const tableSpec = createMockTableSpec();
        const records: ConnectorFile[] = [
          {
            id: 'rec1',
            slug: 'first-post',
          },
          {
            id: 'rec2',
            slug: 'second-post',
          },
          {
            id: 'rec3',
            slug: 'third-post',
          },
        ];

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, new Set(), new Map(), [
          'first-post',
          'second-post',
          'third-post',
        ]);

        expect(result).toHaveLength(3);
        expect(result[0].path).toContain('first-post.json');
        expect(result[1].path).toContain('second-post.json');
        expect(result[2].path).toContain('third-post.json');
      });

      it('should handle empty record array', () => {
        const tableSpec = createMockTableSpec();
        const records: ConnectorFile[] = [];

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, new Set(), new Map(), []);

        expect(result).toHaveLength(0);
      });
    });

    describe('filename normalization', () => {
      it('should normalize suggested name with special characters', () => {
        const tableSpec = createMockTableSpec();
        const records: ConnectorFile[] = [{ id: 'rec1' }];

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, new Set(), new Map(), [
          'Hello World! @Special #Chars',
        ]);

        // normalizeFileName should lowercase, remove special chars, replace spaces with hyphens
        expect(result[0].path).toMatch(/hello-world-special-chars\.json/);
      });

      it('should handle accented characters in suggested name', () => {
        const tableSpec = createMockTableSpec();
        const records: ConnectorFile[] = [{ id: 'rec1' }];

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, new Set(), new Map(), [
          'Café Français',
        ]);

        // Accents should be removed, spaces converted to hyphens
        expect(result[0].path).toMatch(/cafe-francais\.json/);
      });
    });
  });

  describe('run', () => {
    const defaultTableSpec: BaseJsonTableSpec = {
      idColumnRemoteId: 'id',
      slugFieldPath: 'slug',
      titleColumnRemoteId: ['title'],
      id: { remoteId: ['tbl_abc'], wsId: 'tbl_abc' },
      slug: 'example',
      name: 'Example',
      schema: Type.Object({}),
    };

    const createMockDataFolder = (overrides?: Partial<Record<string, unknown>>) => ({
      id: 'dfld_123' as DataFolderId,
      workbookId: 'wkb_123' as WorkbookId,
      name: 'Test Folder',
      path: '/test-folder',
      connectorService: 'airtable',
      connectorAccountId: 'coa_123',
      tableId: ['tbl_abc'],
      filter: null as string | null,
      options: null as unknown as Record<string, unknown>,
      ...overrides,
    });

    const createMockConnectorAccount = () => ({
      id: 'coa_123',
      service: 'airtable',
      credentials: { apiKey: 'test-key' },
    });

    const createMockConnector = (tableSpecOverrides?: Partial<BaseJsonTableSpec>) => ({
      fetchJsonTableSpec: jest.fn().mockResolvedValue({ ...defaultTableSpec, ...tableSpecOverrides }),
      pullRecordFiles: jest.fn(),
      getSuggestedRecordFileNames: jest.fn().mockImplementation((records: ConnectorFile[]) =>
        records.map((r) => {
          const slug = r['slug'] as string | undefined;
          return slug && slug.trim() ? slug : undefined;
        }),
      ),
      extractAssets: jest.fn(),
      extractConnectorErrorDetails: jest.fn().mockReturnValue({
        userFriendlyMessage: 'An error occurred',
        description: 'Test error',
      }),
    });

    const createMockParams = (overrides?: Partial<Record<string, unknown>>) => ({
      data: {
        workbookId: 'wkb_123' as WorkbookId,
        dataFolderIds: ['dfld_123' as DataFolderId],
        userId: 'usr_123',
        organizationId: 'org_123',
      },
      progress: {
        publicProgress: {
          totalFiles: 0,
          folderId: 'dfld_123',
          folderName: 'Test Folder',
          connector: 'airtable',
          status: 'pending' as const,
          createdPaths: [],
          updatedPaths: [],
          deletedPaths: [],
          createdCount: 0,
          updatedCount: 0,
          deletedCount: 0,
        },
        jobProgress: {},
        connectorProgress: {},
      },
      abortSignal: new AbortController().signal,
      checkpoint: jest.fn(),
      ...overrides,
    });

    it('should successfully pull and commit files to git', async () => {
      const dataFolder = createMockDataFolder();
      const connectorAccount = createMockConnectorAccount();
      const mockConnector = createMockConnector();
      const params = createMockParams();

      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      // Simulate connector pulling files
      mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
        await callback({
          files: [
            {
              id: 'rec1',
              slug: 'test-post',
              title: 'Test Post',
            },
          ],
          connectorProgress: {},
        });
      });

      (mockScratchGitService.commitFilesToBranch as jest.Mock).mockResolvedValue({
        created: ['test-folder/test-post.json'],
        updated: [],
        unchanged: [],
      });
      (mockScratchGitService.rebaseDirty as jest.Mock).mockResolvedValue(undefined);
      (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([]);
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);

      await handler.run({ ...params, jobId: 'test-job-id' });

      expect(mockScratchGitService.commitFilesToBranch).toHaveBeenCalledWith(
        'wkb_123',
        'main',
        expect.arrayContaining([
          expect.objectContaining({
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            path: expect.stringContaining('test-post.json'),
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            content: expect.stringContaining('rec1'),
          }),
        ]),
        expect.stringContaining('Sync batch'),
      );

      expect(mockScratchGitService.rebaseDirty).toHaveBeenCalledWith('wkb_123');

      // Verify createdPaths was populated from commitResult
      const checkpointCalls = params.checkpoint.mock.calls as CheckpointCall[];
      const lastCheckpoint = checkpointCalls[checkpointCalls.length - 1][0];
      expect(lastCheckpoint.publicProgress.createdPaths).toContain('test-folder/test-post.json');
      expect(lastCheckpoint.publicProgress.updatedPaths).toHaveLength(0);
      expect(lastCheckpoint.publicProgress.createdCount).toBe(1);
      expect(lastCheckpoint.publicProgress.updatedCount).toBe(0);
    });

    it('should accumulate files across multiple batches for deletion tracking', async () => {
      const dataFolder = createMockDataFolder();
      const connectorAccount = createMockConnectorAccount();
      const mockConnector = createMockConnector();
      const params = createMockParams();

      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      // Simulate two batches of files by calling callback twice within pullRecordFiles
      mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
        await callback({
          files: [
            {
              id: 'rec1',
              slug: 'post-1',
            },
          ],
          connectorProgress: {},
        });
        await callback({
          files: [
            {
              id: 'rec2',
              slug: 'post-2',
            },
          ],
          connectorProgress: {},
        });
      });

      // First batch creates a new file, second batch updates an existing one
      (mockScratchGitService.commitFilesToBranch as jest.Mock)
        .mockResolvedValueOnce({
          created: ['test-folder/post-1.json'],
          updated: [],
          unchanged: [],
        })
        .mockResolvedValueOnce({
          created: [],
          updated: ['test-folder/post-2.json'],
          unchanged: [],
        });
      (mockScratchGitService.rebaseDirty as jest.Mock).mockResolvedValue(undefined);
      // Git has only the files that were downloaded - paths without leading slashes (matching pulledPaths)
      (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([
        { path: 'test-folder/post-1.json', name: 'post-1.json', type: 'file' },
        { path: 'test-folder/post-2.json', name: 'post-2.json', type: 'file' },
      ]);
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);

      await handler.run({ ...params, jobId: 'test-job-id' });

      // Verify that both batches were committed
      expect(mockScratchGitService.commitFilesToBranch).toHaveBeenCalledTimes(2);

      // Verify createdPaths and updatedPaths accumulate across batches
      const checkpointCalls = params.checkpoint.mock.calls as CheckpointCall[];
      const lastCheckpoint = checkpointCalls[checkpointCalls.length - 1][0];
      expect(lastCheckpoint.publicProgress.createdPaths).toEqual(['test-folder/post-1.json']);
      expect(lastCheckpoint.publicProgress.updatedPaths).toEqual(['test-folder/post-2.json']);

      // Verify deletion tracking correctly accumulates files across batches
      // Since all downloaded files match git files, no deletions should occur
      expect(mockScratchGitService.deleteFilesFromBranch).not.toHaveBeenCalled();
    });

    it('should delete files from git that no longer exist in remote', async () => {
      const dataFolder = createMockDataFolder();
      const connectorAccount = createMockConnectorAccount();
      const mockConnector = createMockConnector();
      const params = createMockParams();

      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      // Simulate pulling only one file
      mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
        await callback({
          files: [
            {
              id: 'rec1',
              slug: 'post-1',
            },
          ],
          connectorProgress: {},
        });
      });

      (mockScratchGitService.commitFilesToBranch as jest.Mock).mockResolvedValue({
        created: [],
        updated: [],
        unchanged: [],
      });
      (mockScratchGitService.rebaseDirty as jest.Mock).mockResolvedValue(undefined);
      // Mock that git has two files, but only one was downloaded
      (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([
        { path: 'test-folder/post-1.json', name: 'post-1.json', type: 'file' },
        { path: 'test-folder/post-2.json', name: 'post-2.json', type: 'file' },
      ]);
      (mockScratchGitService.deleteFilesFromBranch as jest.Mock).mockResolvedValue(undefined);
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);

      await handler.run({ ...params, jobId: 'test-job-id' });

      // Verify that the stale file is deleted
      expect(mockScratchGitService.deleteFilesFromBranch).toHaveBeenCalledWith(
        'wkb_123',
        MAIN_BRANCH,
        expect.arrayContaining(['test-folder/post-2.json']),
        expect.stringContaining('Remove'),
      );
    });

    it('should not delete dotfiles like .schema.json during pull cleanup', async () => {
      const dataFolder = createMockDataFolder();
      const connectorAccount = createMockConnectorAccount();
      const mockConnector = createMockConnector();
      const params = createMockParams();

      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
        await callback({
          files: [{ id: 'rec1', slug: 'post-1' }],
          connectorProgress: {},
        });
      });

      (mockScratchGitService.commitFilesToBranch as jest.Mock).mockResolvedValue({
        created: [],
        updated: [],
        unchanged: [],
      });
      (mockScratchGitService.rebaseDirty as jest.Mock).mockResolvedValue(undefined);
      // Git has a regular file, a dotfile (.schema.json), and a stale file
      (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([
        { path: 'test-folder/post-1.json', name: 'post-1.json', type: 'file' },
        { path: 'test-folder/.schema.json', name: '.schema.json', type: 'file' },
        { path: 'test-folder/stale-post.json', name: 'stale-post.json', type: 'file' },
      ]);
      (mockScratchGitService.deleteFilesFromBranch as jest.Mock).mockResolvedValue(undefined);
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);

      await handler.run({ ...params, jobId: 'test-job-id' });

      // Should delete the stale file but NOT the .schema.json dotfile
      expect(mockScratchGitService.deleteFilesFromBranch).toHaveBeenCalledWith(
        'wkb_123',
        MAIN_BRANCH,
        ['test-folder/stale-post.json'],
        expect.stringContaining('Remove'),
      );
    });

    it('should handle missing connector account', async () => {
      const dataFolder = createMockDataFolder();
      const params = createMockParams();

      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(null);

      await expect(handler.run({ ...params, jobId: 'test-job-id' })).rejects.toThrow('Connector account');
    });

    it('should handle missing data folder', async () => {
      const params = createMockParams();

      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(handler.run({ ...params, jobId: 'test-job-id' })).rejects.toThrow('DataFolder');
    });

    it('should throw descriptive error when dataFolderIds is undefined', async () => {
      const params = createMockParams({
        data: { workbookId: 'wkb_123', userId: 'usr_123', organizationId: 'org_123' },
      });

      await expect(handler.run({ ...params, jobId: 'test-job-id' })).rejects.toThrow('Invalid job data: dataFolderIds');
    });

    it('should throw descriptive error when dataFolderIds is an empty array', async () => {
      const params = createMockParams({
        data: { workbookId: 'wkb_123', dataFolderIds: [], userId: 'usr_123', organizationId: 'org_123' },
      });

      await expect(handler.run({ ...params, jobId: 'test-job-id' })).rejects.toThrow('Invalid job data: dataFolderIds');
    });

    it('should update dataFolder lock on success', async () => {
      const dataFolder = createMockDataFolder();
      const connectorAccount = createMockConnectorAccount();
      const mockConnector = createMockConnector();
      const params = createMockParams();

      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
        await callback({
          files: [],
          connectorProgress: {},
        });
      });

      (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([]);
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);

      await handler.run({ ...params, jobId: 'test-job-id' });

      expect(mockPrisma.dataFolder.update).toHaveBeenCalledWith({
        where: { id: 'dfld_123' },
        data: {
          lock: null,
        },
      });
    });

    it('should set lock=null on error', async () => {
      const dataFolder = createMockDataFolder();
      const connectorAccount = createMockConnectorAccount();
      const mockConnector = createMockConnector();
      const params = createMockParams();

      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      // Simulate connector error during pull
      mockConnector.pullRecordFiles.mockRejectedValue(new Error('Connector error'));
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);

      try {
        await handler.run({ ...params, jobId: 'test-job-id' });
      } catch {
        // Expected to throw
      }

      // Verify that update was called to clear the lock, even on error
      expect(mockPrisma.dataFolder.update).toHaveBeenCalledWith({
        where: { id: 'dfld_123' },
        data: { lock: null },
      });
    });

    it('should send snapshot events', async () => {
      const dataFolder = createMockDataFolder();
      const connectorAccount = createMockConnectorAccount();
      const mockConnector = createMockConnector();
      const params = createMockParams();

      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
        await callback({
          files: [
            {
              id: 'rec1',
              slug: 'post-1',
            },
          ],
          connectorProgress: {},
        });
      });

      (mockScratchGitService.commitFilesToBranch as jest.Mock).mockResolvedValue({
        created: [],
        updated: [],
        unchanged: [],
      });
      (mockScratchGitService.rebaseDirty as jest.Mock).mockResolvedValue(undefined);
      (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([]);
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);

      await handler.run({ ...params, jobId: 'test-job-id' });

      expect(mockSnapshotEventService.sendWorkbookEvent).toHaveBeenCalledWith(
        'wkb_123',
        expect.objectContaining({
          type: 'job-started',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          data: expect.objectContaining({
            entityId: 'dfld_123',
          }),
        }),
      );

      expect(mockSnapshotEventService.sendWorkbookEvent).toHaveBeenCalledWith(
        'wkb_123',
        expect.objectContaining({
          type: 'folder-contents-changed',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          data: expect.objectContaining({
            entityId: 'dfld_123',
          }),
        }),
      );

      expect(mockSnapshotEventService.sendWorkbookEvent).toHaveBeenCalledWith(
        'wkb_123',
        expect.objectContaining({
          type: 'job-completed',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          data: expect.objectContaining({
            entityId: 'dfld_123',
          }),
        }),
      );
    });

    it('should checkpoint progress on each batch', async () => {
      const dataFolder = createMockDataFolder();
      const connectorAccount = createMockConnectorAccount();
      const mockConnector = createMockConnector();
      const params = createMockParams();

      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
        await callback({
          files: [
            {
              id: 'rec1',
              slug: 'post-1',
            },
          ],
          connectorProgress: { processed: 1 },
        });
      });

      (mockScratchGitService.commitFilesToBranch as jest.Mock).mockResolvedValue({
        created: [],
        updated: [],
        unchanged: [],
      });
      (mockScratchGitService.rebaseDirty as jest.Mock).mockResolvedValue(undefined);
      (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([]);
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);

      await handler.run({ ...params, jobId: 'test-job-id' });

      expect(params.checkpoint).toHaveBeenCalled();
    });

    it('should checkpoint before rebaseDirty and buildIndex to prevent BullMQ stall', async () => {
      const dataFolder = createMockDataFolder();
      const connectorAccount = createMockConnectorAccount();
      const mockConnector = createMockConnector();
      const params = createMockParams();

      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
        await callback({
          files: [{ id: 'rec1', slug: 'post-1' }],
          connectorProgress: {},
        });
      });

      (mockScratchGitService.commitFilesToBranch as jest.Mock).mockResolvedValue({
        created: [],
        updated: [],
        unchanged: [],
      });
      (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([]);
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);

      // Track call order across checkpoint, rebaseDirty, and buildIndex
      const callOrder: string[] = [];
      params.checkpoint.mockImplementation(() => {
        callOrder.push('checkpoint');
        return Promise.resolve();
      });
      (mockScratchGitService.rebaseDirty as jest.Mock).mockImplementation(() => {
        callOrder.push('rebaseDirty');
        return Promise.resolve();
      });
      (mockScratchGitService.buildIndex as jest.Mock).mockImplementation(() => {
        callOrder.push('buildIndex');
        return Promise.resolve();
      });

      await handler.run({ ...params, jobId: 'test-job-id' });

      // Verify checkpoint is called immediately before both long-running git operations.
      // This prevents BullMQ from marking the job as stalled during these operations.
      const buildIndexIdx = callOrder.indexOf('buildIndex');
      const rebaseDirtyIdx = callOrder.indexOf('rebaseDirty');
      expect(buildIndexIdx).toBeGreaterThan(-1);
      expect(rebaseDirtyIdx).toBeGreaterThan(-1);

      // There must be a checkpoint immediately before buildIndex
      expect(callOrder[buildIndexIdx - 1]).toBe('checkpoint');
      // There must be a checkpoint immediately before rebaseDirty
      expect(callOrder[rebaseDirtyIdx - 1]).toBe('checkpoint');
    });

    it('should fetch fresh schema from connector before pulling', async () => {
      const freshSchema: BaseJsonTableSpec = {
        ...defaultTableSpec,
        schema: Type.Object({ newField: Type.String() }),
      };
      const dataFolder = createMockDataFolder();
      const connectorAccount = createMockConnectorAccount();
      const mockConnector = createMockConnector();
      mockConnector.fetchJsonTableSpec.mockResolvedValue(freshSchema);
      const params = createMockParams();

      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
        await callback({ files: [], connectorProgress: {} });
      });

      (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([]);
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);

      await handler.run({ ...params, jobId: 'test-job-id' });

      // Verify connector.fetchJsonTableSpec was called with the folder's tableId
      expect(mockConnector.fetchJsonTableSpec).toHaveBeenCalledWith({
        wsId: 'tbl_abc',
        remoteId: ['tbl_abc'],
      });

      // Verify fresh schema was written to git
      expect(mockScratchGitService.writeSchemaToGit).toHaveBeenCalledWith('wkb_123', '/test-folder', freshSchema);

      // Verify pullRecordFiles was called with the fresh schema
      expect(mockConnector.pullRecordFiles).toHaveBeenCalledWith(
        freshSchema,
        expect.any(Function),
        expect.anything(),
        expect.anything(),
      );
    });

    it('should apply user field overrides to fetched schema', async () => {
      const dataFolder = createMockDataFolder({
        options: {
          idFieldOverride: 'custom_id',
          nameFieldOverride: 'custom_name',
        },
      });
      const connectorAccount = createMockConnectorAccount();
      const mockConnector = createMockConnector();
      const params = createMockParams();

      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      mockConnector.pullRecordFiles.mockImplementation(async (spec: BaseJsonTableSpec, callback: PullCallback) => {
        // Verify the spec passed to pullRecordFiles has the overrides applied
        expect(spec.idColumnRemoteId).toBe('custom_id');
        expect(spec.titleColumnRemoteId).toEqual(['custom_name']);
        await callback({ files: [], connectorProgress: {} });
      });

      (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([]);
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);

      await handler.run({ ...params, jobId: 'test-job-id' });

      // Verify overrides were applied — check the schema written to git has overrides
      expect(mockScratchGitService.writeSchemaToGit).toHaveBeenCalledWith(
        'wkb_123',
        '/test-folder',
        expect.objectContaining({
          idColumnRemoteId: 'custom_id',
          titleColumnRemoteId: ['custom_name'],
        }),
      );
    });

    it('should propagate schema fetch errors', async () => {
      const dataFolder = createMockDataFolder();
      const connectorAccount = createMockConnectorAccount();
      const mockConnector = createMockConnector();
      mockConnector.fetchJsonTableSpec.mockRejectedValue(new Error('API rate limit exceeded'));
      const params = createMockParams();

      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);

      await expect(handler.run({ ...params, jobId: 'test-job-id' })).rejects.toThrow();

      // Verify pullRecordFiles was NOT called (schema fetch failed first)
      expect(mockConnector.pullRecordFiles).not.toHaveBeenCalled();
    });

    it('should pass connectorProgress (not full Progress) to pullRecordFiles', async () => {
      const dataFolder = createMockDataFolder();
      const connectorAccount = createMockConnectorAccount();
      const mockConnector = createMockConnector();
      const params = createMockParams({
        progress: {
          publicProgress: {
            totalFiles: 50,
            folderId: 'dfld_123',
            folderName: 'Test Folder',
            connector: 'stripe',
            status: 'active' as const,
            createdPaths: [],
            updatedPaths: [],
            deletedPaths: [],
            createdCount: 0,
            updatedCount: 0,
            deletedCount: 0,
          },
          jobProgress: {},
          connectorProgress: { startingAfter: 'pi_abc123' },
        },
      });

      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
        await callback({ files: [], connectorProgress: {} });
      });

      (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([]);
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);

      await handler.run({ ...params, jobId: 'test-job-id' });

      // The third argument should be connectorProgress, not the full Progress object
      expect(mockConnector.pullRecordFiles).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Function),
        { startingAfter: 'pi_abc123' },
        expect.anything(),
      );
    });

    it('should skip completed folders on resume', async () => {
      createMockDataFolder({ id: 'dfld_1' as DataFolderId, name: 'Folder 1' });
      const folder2 = createMockDataFolder({ id: 'dfld_2' as DataFolderId, name: 'Folder 2' });
      const connectorAccount = createMockConnectorAccount();
      const mockConnector = createMockConnector();

      (mockPrisma.dataFolder.findMany as jest.Mock).mockResolvedValue([
        { id: 'dfld_1', connectorAccountId: 'coa_123', connectorAccount: { displayName: 'Test' } },
        { id: 'dfld_2', connectorAccountId: 'coa_123', connectorAccount: { displayName: 'Test' } },
      ]);

      const params = createMockParams({
        data: {
          workbookId: 'wkb_123' as WorkbookId,
          dataFolderIds: ['dfld_1' as DataFolderId, 'dfld_2' as DataFolderId],
          userId: 'usr_123',
          organizationId: 'org_123',
        },
        progress: {
          publicProgress: {
            totalFiles: 100,
            folderId: 'dfld_2',
            folderName: 'Folder 2',
            connector: 'stripe',
            status: 'active' as const,
            createdPaths: [],
            updatedPaths: [],
            deletedPaths: [],
            createdCount: 0,
            updatedCount: 0,
            deletedCount: 0,
          },
          jobProgress: { completedFolderIds: ['dfld_1'] },
          connectorProgress: {},
        },
      });

      // Only folder 2 should be pulled since folder 1 is already completed
      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(folder2);
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
        await callback({ files: [], connectorProgress: {} });
      });

      (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([]);
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(folder2);

      await handler.run({ ...params, jobId: 'test-job-id' });

      // pullRecordFiles should only be called once (for folder 2)
      expect(mockConnector.pullRecordFiles).toHaveBeenCalledTimes(1);
      // findUnique should only be called for folder 2 (folder 1 was skipped)
      expect(mockPrisma.dataFolder.findUnique).toHaveBeenCalledTimes(1);
      expect(mockPrisma.dataFolder.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'dfld_2' } }),
      );
    });

    it('should skip deletion when resuming a folder', async () => {
      const dataFolder = createMockDataFolder();
      const connectorAccount = createMockConnectorAccount();
      const mockConnector = createMockConnector();
      const params = createMockParams({
        progress: {
          publicProgress: {
            totalFiles: 50,
            folderId: 'dfld_123',
            folderName: 'Test Folder',
            connector: 'stripe',
            status: 'active' as const,
            createdPaths: [],
            updatedPaths: [],
            deletedPaths: [],
            createdCount: 0,
            updatedCount: 0,
            deletedCount: 0,
          },
          jobProgress: {},
          // Non-empty connectorProgress indicates a resume
          connectorProgress: { startingAfter: 'pi_abc123' },
        },
      });

      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
        await callback({ files: [{ id: 'rec1', slug: 'post-1' }], connectorProgress: {} });
      });

      (mockScratchGitService.commitFilesToBranch as jest.Mock).mockResolvedValue({
        created: ['test-folder/post-1.json'],
        updated: [],
        unchanged: [],
      });
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);

      await handler.run({ ...params, jobId: 'test-job-id' });

      // listRepoFiles should NOT be called because deletion is skipped on resume
      expect(mockScratchGitService.listRepoFiles).not.toHaveBeenCalled();
      expect(mockScratchGitService.deleteFilesFromBranch).not.toHaveBeenCalled();
    });

    it('should restore publicProgress when resuming the same folder', async () => {
      const dataFolder = createMockDataFolder();
      const connectorAccount = createMockConnectorAccount();
      const mockConnector = createMockConnector();
      const params = createMockParams({
        progress: {
          publicProgress: {
            totalFiles: 500,
            folderCount: 1,
            connectionName: 'Test Connection',
            folderId: 'dfld_123',
            folderName: 'Test Folder',
            connector: 'stripe',
            filter: null,
            status: 'active' as const,
            createdPaths: ['file1.json', 'file2.json'],
            updatedPaths: [],
            deletedPaths: [],
            createdCount: 2,
            updatedCount: 0,
            deletedCount: 0,
          },
          jobProgress: {},
          connectorProgress: { startingAfter: 'pi_abc123' },
        },
      });

      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
        await callback({
          files: [{ id: 'rec3', slug: 'post-3' }],
          connectorProgress: { startingAfter: 'pi_def456' },
        });
      });

      (mockScratchGitService.commitFilesToBranch as jest.Mock).mockResolvedValue({
        created: ['test-folder/post-3.json'],
        updated: [],
        unchanged: [],
      });
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);

      await handler.run({ ...params, jobId: 'test-job-id' });

      // The checkpoint should show accumulated totalFiles (500 from saved + 1 new)
      const checkpointCalls = params.checkpoint.mock.calls as CheckpointCall[];
      const lastCheckpoint = checkpointCalls[checkpointCalls.length - 1][0];
      expect(lastCheckpoint.publicProgress.totalFiles).toBe(501);
      // Previously tracked paths should be preserved
      expect(lastCheckpoint.publicProgress.createdPaths).toContain('file1.json');
      expect(lastCheckpoint.publicProgress.createdPaths).toContain('file2.json');
      expect(lastCheckpoint.publicProgress.createdPaths).toContain('test-folder/post-3.json');
      // Count should accumulate correctly
      expect(lastCheckpoint.publicProgress.createdCount).toBe(3);
    });

    it('should not pass stale connectorProgress from a completed folder to the next folder', async () => {
      // Regression: when a job stalls mid-way through folder A and restarts,
      // the connectorProgress cursor from folder A (e.g. a charge ID) must not
      // leak into folder B (e.g. customers), causing a "No such customer" error.
      createMockDataFolder({ id: 'dfld_charges' as DataFolderId, name: 'Charges', path: '/charges' });
      const customersFolder = createMockDataFolder({
        id: 'dfld_customers' as DataFolderId,
        name: 'Customers',
        path: '/customers',
      });
      const connectorAccount = createMockConnectorAccount();
      const mockConnector = createMockConnector();

      (mockPrisma.dataFolder.findMany as jest.Mock).mockResolvedValue([
        { id: 'dfld_charges', connectorAccountId: 'coa_123', connectorAccount: { displayName: 'Stripe' } },
        { id: 'dfld_customers', connectorAccountId: 'coa_123', connectorAccount: { displayName: 'Stripe' } },
      ]);

      const params = createMockParams({
        data: {
          workbookId: 'wkb_123' as WorkbookId,
          dataFolderIds: ['dfld_charges' as DataFolderId, 'dfld_customers' as DataFolderId],
          userId: 'usr_123',
          organizationId: 'org_123',
        },
        progress: {
          publicProgress: {
            totalFiles: 100,
            folderCount: 2,
            connectionName: 'Stripe',
            folderId: 'dfld_charges', // Progress was saved for charges folder
            folderName: 'Charges',
            connector: 'stripe',
            filter: null,
            status: 'active' as const,
            createdPaths: [],
            updatedPaths: [],
            deletedPaths: [],
            createdCount: 0,
            updatedCount: 0,
            deletedCount: 0,
          },
          jobProgress: { completedFolderIds: ['dfld_charges'] }, // Charges already done
          connectorProgress: { startingAfter: 'ch_stale_charge_id' }, // Stale cursor from charges!
        },
      });

      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(customersFolder);
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
        await callback({ files: [], connectorProgress: {} });
      });

      (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([]);
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(customersFolder);

      await handler.run({ ...params, jobId: 'test-job-id' });

      // The stale charge cursor must NOT be passed to the customers pull
      expect(mockConnector.pullRecordFiles).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Function),
        {}, // Empty progress — not the stale { startingAfter: 'ch_stale_charge_id' }
        expect.anything(),
      );
    });

    it('should track deletedCount when files are removed', async () => {
      const dataFolder = createMockDataFolder();
      const connectorAccount = createMockConnectorAccount();
      const mockConnector = createMockConnector();
      const params = createMockParams();

      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
        await callback({
          files: [{ id: 'rec1', slug: 'post-1' }],
          connectorProgress: {},
        });
      });

      (mockScratchGitService.commitFilesToBranch as jest.Mock).mockResolvedValue({
        created: ['test-folder/post-1.json'],
        updated: [],
        unchanged: [],
      });
      (mockScratchGitService.rebaseDirty as jest.Mock).mockResolvedValue(undefined);
      // Git has 3 files but only 1 was pulled — 2 should be deleted
      (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([
        { path: 'test-folder/post-1.json', name: 'post-1.json', type: 'file' },
        { path: 'test-folder/old-post.json', name: 'old-post.json', type: 'file' },
        { path: 'test-folder/stale-post.json', name: 'stale-post.json', type: 'file' },
      ]);
      (mockScratchGitService.deleteFilesFromBranch as jest.Mock).mockResolvedValue(undefined);
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);

      await handler.run({ ...params, jobId: 'test-job-id' });

      const checkpointCalls = params.checkpoint.mock.calls as CheckpointCall[];
      const lastCheckpoint = checkpointCalls[checkpointCalls.length - 1][0];
      expect(lastCheckpoint.publicProgress.deletedCount).toBe(2);
      expect(lastCheckpoint.publicProgress.deletedPaths).toEqual([
        'test-folder/old-post.json',
        'test-folder/stale-post.json',
      ]);
    });

    it('should track accurate counts even when path arrays are capped', async () => {
      const dataFolder = createMockDataFolder();
      const connectorAccount = createMockConnectorAccount();
      const mockConnector = createMockConnector();
      const params = createMockParams();

      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      // Generate 150 files — more than MAX_PROGRESS_PATHS (100)
      const files = Array.from({ length: 150 }, (_, i) => ({
        id: `rec${i}`,
        slug: `post-${i}`,
      }));
      const createdPaths = files.map((f) => `test-folder/${f.slug}.json`);

      mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
        await callback({ files, connectorProgress: {} });
      });

      (mockScratchGitService.commitFilesToBranch as jest.Mock).mockResolvedValue({
        created: createdPaths,
        updated: [],
        unchanged: [],
      });
      (mockScratchGitService.rebaseDirty as jest.Mock).mockResolvedValue(undefined);
      (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue(
        createdPaths.map((p) => ({ path: p, name: p.split('/').pop()!, type: 'file' })),
      );
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);

      await handler.run({ ...params, jobId: 'test-job-id' });

      const checkpointCalls = params.checkpoint.mock.calls as CheckpointCall[];
      const lastCheckpoint = checkpointCalls[checkpointCalls.length - 1][0];

      // createdCount should reflect the actual number, not the capped array length
      expect(lastCheckpoint.publicProgress.createdCount).toBe(150);
      expect(lastCheckpoint.publicProgress.createdPaths).toHaveLength(100); // capped at MAX_PROGRESS_PATHS
    });

    it('should stop processing folders when abortSignal is aborted', async () => {
      const folder1 = createMockDataFolder({ id: 'dfld_1' as DataFolderId, name: 'Folder 1' });
      createMockDataFolder({ id: 'dfld_2' as DataFolderId, name: 'Folder 2' });
      const connectorAccount = createMockConnectorAccount();
      const mockConnector = createMockConnector();

      (mockPrisma.dataFolder.findMany as jest.Mock).mockResolvedValue([
        { id: 'dfld_1', connectorAccountId: 'coa_123', connectorAccount: { displayName: 'Test' } },
        { id: 'dfld_2', connectorAccountId: 'coa_123', connectorAccount: { displayName: 'Test' } },
      ]);

      const abortController = new AbortController();

      const params = createMockParams({
        data: {
          workbookId: 'wkb_123' as WorkbookId,
          dataFolderIds: ['dfld_1' as DataFolderId, 'dfld_2' as DataFolderId],
          userId: 'usr_123',
          organizationId: 'org_123',
        },
        abortSignal: abortController.signal,
      });

      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(folder1);
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      // Abort after the first folder's pull starts
      mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
        await callback({ files: [], connectorProgress: {} });
        abortController.abort();
      });

      (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([]);
      (mockScratchGitService.rebaseDirty as jest.Mock).mockResolvedValue(undefined);
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(folder1);

      await handler.run({ ...params, jobId: 'test-job-id' });

      // Only folder 1 should have been pulled — folder 2 skipped due to abort
      expect(mockPrisma.dataFolder.findUnique).toHaveBeenCalledTimes(1);
      expect(mockConnector.pullRecordFiles).toHaveBeenCalledTimes(1);
    });

    it('should include completedFolderIds in jobProgress checkpoints', async () => {
      const dataFolder = createMockDataFolder();
      const connectorAccount = createMockConnectorAccount();
      const mockConnector = createMockConnector();
      const params = createMockParams();

      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      mockConnector.pullRecordFiles.mockImplementation(async (_spec: BaseJsonTableSpec, callback: PullCallback) => {
        await callback({ files: [], connectorProgress: {} });
      });

      (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([]);
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);

      await handler.run({ ...params, jobId: 'test-job-id' });

      // The final checkpoint (before buildIndex) should include the completed folder
      const checkpointCalls = params.checkpoint.mock.calls as {
        jobProgress: { completedFolderIds: string[] };
      }[][];
      const lastCheckpoint = checkpointCalls[checkpointCalls.length - 1][0];
      expect(lastCheckpoint.jobProgress.completedFolderIds).toContain('dfld_123');
    });
  });
});
