/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-return */
import { PrismaClient } from '@prisma/client';
import { Type } from '@sinclair/typebox';
import { DataFolderId, WorkbookId } from '@spinner/shared-types';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { MAIN_BRANCH, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { ConnectorsService } from '../../../remote-service/connectors/connectors.service';
import { BaseJsonTableSpec, ConnectorFile } from '../../../remote-service/connectors/types';
import { WorkbookEventService } from '../../../workbook/workbook-event.service';
import { buildGitFilesFromConnectorFiles } from './connector-file-utils';
import { PullLinkedFolderFilesJobHandler } from './pull-linked-folder-files.job';

describe('PullLinkedFolderFilesJobHandler', () => {
  let handler: PullLinkedFolderFilesJobHandler;
  let mockPrisma: jest.Mocked<PrismaClient>;
  let mockConnectorService: jest.Mocked<ConnectorsService>;
  let mockConnectorAccountService: jest.Mocked<ConnectorAccountService>;
  let mockSnapshotEventService: jest.Mocked<WorkbookEventService>;
  let mockScratchGitService: jest.Mocked<ScratchGitService>;
  let mockFileIndexService: jest.Mocked<any>;
  let mockFileReferenceService: jest.Mocked<any>;

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
      initRepo: jest.fn().mockResolvedValue(undefined),
      commitFilesToBranch: jest.fn(),
      rebaseDirty: jest.fn(),
      listRepoFiles: jest.fn(),
      deleteFilesFromBranch: jest.fn(),
      runGitGc: jest.fn().mockResolvedValue(undefined),
      readSchemaFromGit: jest.fn().mockResolvedValue(null),
      writeSchemaToGit: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ScratchGitService>;

    mockFileIndexService = {
      getFilenamesByRecordIds: jest.fn().mockResolvedValue(new Map()),
      upsertBatch: jest.fn().mockResolvedValue(undefined),
    } as any;
    mockFileReferenceService = { updateRefsForFiles: jest.fn().mockResolvedValue(undefined) } as any;

    handler = new PullLinkedFolderFilesJobHandler(
      mockPrisma,
      mockConnectorService,
      mockConnectorAccountService,
      mockSnapshotEventService,
      mockScratchGitService,
      mockFileIndexService,
      mockFileReferenceService,
    );
  });

  describe('buildGitFilesFromConnectorFiles', () => {
    const createMockTableSpec = (overrides?: Partial<BaseJsonTableSpec>): BaseJsonTableSpec => ({
      idColumnRemoteId: 'id',
      slugColumnRemoteId: 'slug',
      titleColumnRemoteId: ['title'],
      id: { remoteId: ['example'], wsId: '' },
      slug: 'example',
      name: 'Example',
      schema: Type.Object({}),

      ...overrides,
    });

    describe('file naming priority', () => {
      it('should use slug when available', () => {
        const tableSpec = createMockTableSpec();
        const records: ConnectorFile[] = [
          {
            id: 'rec1',
            slug: 'my-blog-post',
            title: 'My Blog Post',
          },
        ];

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, new Set(), new Map());

        expect(result).toHaveLength(1);
        expect(result[0].path).toContain('my-blog-post.json');
      });

      it('should use title when slug is missing', () => {
        const tableSpec = createMockTableSpec();
        const records: ConnectorFile[] = [
          {
            id: 'rec1',
            title: 'My Blog Post',
          },
        ];

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, new Set(), new Map());

        expect(result).toHaveLength(1);
        expect(result[0].path).toContain('my-blog-post.json');
      });

      it('should use id when slug and title are missing', () => {
        const tableSpec = createMockTableSpec();
        const records: ConnectorFile[] = [
          {
            id: 'rec-12345',
          },
        ];

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, new Set(), new Map());

        expect(result).toHaveLength(1);
        expect(result[0].path).toContain('rec-12345.json');
      });

      it('should ignore empty slug and fall back to title', () => {
        const tableSpec = createMockTableSpec();
        const records: ConnectorFile[] = [
          {
            id: 'rec1',
            slug: '',
            title: 'Fallback Title',
          },
        ];

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, new Set(), new Map());

        expect(result).toHaveLength(1);
        expect(result[0].path).toContain('fallback-title.json');
      });

      it('should handle dot-path slug access (nested properties)', () => {
        const tableSpec = createMockTableSpec({ slugColumnRemoteId: 'metadata.slug' });
        const records: ConnectorFile[] = [
          {
            id: 'rec1',
            metadata: {
              slug: 'nested-slug-value',
            },
          },
        ];

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, new Set(), new Map());

        expect(result).toHaveLength(1);
        expect(result[0].path).toContain('nested-slug-value.json');
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

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, usedFileNames, new Map());

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
        const result1 = buildGitFilesFromConnectorFiles('/', batch1, tableSpec, usedFileNames, new Map());

        const batch2: ConnectorFile[] = [
          {
            id: 'rec2',
            title: 'Post',
          },
        ];
        const result2 = buildGitFilesFromConnectorFiles('/', batch2, tableSpec, usedFileNames, new Map());

        expect(result1[0].path).toContain('post.json');
        expect(result2[0].path).toContain('post-rec2.json');
      });
    });

    describe('path construction', () => {
      it('should construct path with parentPath prefix', () => {
        const tableSpec = createMockTableSpec();
        const records: ConnectorFile[] = [
          {
            id: 'rec1',
            slug: 'test-file',
          },
        ];

        const result = buildGitFilesFromConnectorFiles('/my-folder', records, tableSpec, new Set(), new Map());

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

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, new Set(), new Map());

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

        const result = buildGitFilesFromConnectorFiles('', records, tableSpec, new Set(), new Map());

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

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, new Set(), new Map());

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

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, new Set(), new Map());

        const parsedContent = JSON.parse(result[0].content);
        expect(parsedContent).toEqual(testRecord);
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

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, new Set(), new Map());

        // Verify JSON is valid and can be parsed
        const parsed = JSON.parse(result[0].content);
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

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, new Set(), new Map());

        expect(result).toHaveLength(3);
        expect(result[0].path).toContain('first-post.json');
        expect(result[1].path).toContain('second-post.json');
        expect(result[2].path).toContain('third-post.json');
      });

      it('should handle empty record array', () => {
        const tableSpec = createMockTableSpec();
        const records: ConnectorFile[] = [];

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, new Set(), new Map());

        expect(result).toHaveLength(0);
      });
    });

    describe('filename normalization', () => {
      it('should normalize slug with special characters', () => {
        const tableSpec = createMockTableSpec();
        const records: ConnectorFile[] = [
          {
            id: 'rec1',
            slug: 'Hello World! @Special #Chars',
          },
        ];

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, new Set(), new Map());

        // normalizeFileName should lowercase, remove special chars, replace spaces with hyphens
        expect(result[0].path).toMatch(/hello-world-special-chars\.json/);
      });

      it('should handle accented characters in title', () => {
        const tableSpec = createMockTableSpec();
        const records: ConnectorFile[] = [
          {
            id: 'rec1',
            title: 'Café Français',
          },
        ];

        const result = buildGitFilesFromConnectorFiles('/', records, tableSpec, new Set(), new Map());

        // Accents should be removed, spaces converted to hyphens
        expect(result[0].path).toMatch(/cafe-francais\.json/);
      });
    });
  });

  describe('run', () => {
    const defaultTableSpec: BaseJsonTableSpec = {
      idColumnRemoteId: 'id',
      slugColumnRemoteId: 'slug',
      titleColumnRemoteId: ['title'],
      id: { remoteId: ['tbl_abc'], wsId: 'tbl_abc' },
      slug: 'example',
      name: 'Example',
      schema: Type.Object({}),
    };

    const createMockDataFolder = (overrides?: any) => ({
      id: 'dfld_123' as DataFolderId,
      workbookId: 'wkb_123' as WorkbookId,
      name: 'Test Folder',
      path: '/test-folder',
      connectorService: 'airtable',
      connectorAccountId: 'coa_123',
      tableId: ['tbl_abc'],
      filter: null as string | null,
      options: null as any,
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
      extractConnectorErrorDetails: jest.fn().mockReturnValue({
        userFriendlyMessage: 'An error occurred',
        description: 'Test error',
      }),
    });

    const createMockParams = (overrides?: any) => ({
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
      mockConnector.pullRecordFiles.mockImplementation(async (spec, callback) => {
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

      (mockScratchGitService.commitFilesToBranch as jest.Mock).mockResolvedValue(undefined);
      (mockScratchGitService.rebaseDirty as jest.Mock).mockResolvedValue(undefined);
      (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([]);
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);

      await handler.run({ ...params, jobId: 'test-job-id' });

      expect(mockScratchGitService.commitFilesToBranch).toHaveBeenCalledWith(
        'wkb_123',
        'main',
        expect.arrayContaining([
          expect.objectContaining({
            path: expect.stringContaining('test-post.json'),
            content: expect.stringContaining('rec1'),
          }),
        ]),
        expect.stringContaining('Sync batch'),
      );

      expect(mockScratchGitService.rebaseDirty).toHaveBeenCalledWith('wkb_123');
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
      mockConnector.pullRecordFiles.mockImplementation(async (spec, callback) => {
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

      (mockScratchGitService.commitFilesToBranch as jest.Mock).mockResolvedValue(undefined);
      (mockScratchGitService.rebaseDirty as jest.Mock).mockResolvedValue(undefined);
      // Git has only the files that were downloaded - paths without leading slashes (matching gitFiles after strip)
      (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([
        { path: 'test-folder/post-1.json', name: 'post-1.json', type: 'file' },
        { path: 'test-folder/post-2.json', name: 'post-2.json', type: 'file' },
      ]);
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);

      await handler.run({ ...params, jobId: 'test-job-id' });

      // Verify that both batches were committed
      expect(mockScratchGitService.commitFilesToBranch).toHaveBeenCalledTimes(2);

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
      mockConnector.pullRecordFiles.mockImplementation(async (spec, callback) => {
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

      (mockScratchGitService.commitFilesToBranch as jest.Mock).mockResolvedValue(undefined);
      (mockScratchGitService.rebaseDirty as jest.Mock).mockResolvedValue(undefined);
      // Mock that git has two files, but only one was downloaded
      (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([
        { path: '/test-folder/post-1.json', name: 'post-1.json', type: 'file' },
        { path: '/test-folder/post-2.json', name: 'post-2.json', type: 'file' },
      ]);
      (mockScratchGitService.deleteFilesFromBranch as jest.Mock).mockResolvedValue(undefined);
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);

      await handler.run({ ...params, jobId: 'test-job-id' });

      // Verify that the stale file is deleted
      expect(mockScratchGitService.deleteFilesFromBranch).toHaveBeenCalledWith(
        'wkb_123',
        MAIN_BRANCH,
        expect.arrayContaining(['/test-folder/post-2.json']),
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

      mockConnector.pullRecordFiles.mockImplementation(async (spec, callback) => {
        await callback({
          files: [{ id: 'rec1', slug: 'post-1' }],
          connectorProgress: {},
        });
      });

      (mockScratchGitService.commitFilesToBranch as jest.Mock).mockResolvedValue(undefined);
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

    it('should update dataFolder lock and lastSyncTime on success', async () => {
      const dataFolder = createMockDataFolder();
      const connectorAccount = createMockConnectorAccount();
      const mockConnector = createMockConnector();
      const params = createMockParams();

      (mockPrisma.dataFolder.findUnique as jest.Mock).mockResolvedValue(dataFolder);
      (mockConnectorAccountService.findOneById as jest.Mock).mockResolvedValue(connectorAccount);
      (mockConnectorService.getConnector as jest.Mock).mockResolvedValue(mockConnector);

      mockConnector.pullRecordFiles.mockImplementation(async (spec, callback) => {
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
          lastSyncTime: expect.any(Date),
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

      mockConnector.pullRecordFiles.mockImplementation(async (spec, callback) => {
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

      (mockScratchGitService.commitFilesToBranch as jest.Mock).mockResolvedValue(undefined);
      (mockScratchGitService.rebaseDirty as jest.Mock).mockResolvedValue(undefined);
      (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([]);
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);

      await handler.run({ ...params, jobId: 'test-job-id' });

      expect(mockSnapshotEventService.sendWorkbookEvent).toHaveBeenCalledWith(
        'wkb_123',
        expect.objectContaining({
          type: 'job-started',
          data: expect.objectContaining({
            entityId: 'dfld_123',
          }),
        }),
      );

      expect(mockSnapshotEventService.sendWorkbookEvent).toHaveBeenCalledWith(
        'wkb_123',
        expect.objectContaining({
          type: 'folder-contents-changed',
          data: expect.objectContaining({
            entityId: 'dfld_123',
          }),
        }),
      );

      expect(mockSnapshotEventService.sendWorkbookEvent).toHaveBeenCalledWith(
        'wkb_123',
        expect.objectContaining({
          type: 'job-completed',
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

      mockConnector.pullRecordFiles.mockImplementation(async (spec, callback) => {
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

      (mockScratchGitService.commitFilesToBranch as jest.Mock).mockResolvedValue(undefined);
      (mockScratchGitService.rebaseDirty as jest.Mock).mockResolvedValue(undefined);
      (mockScratchGitService.listRepoFiles as jest.Mock).mockResolvedValue([]);
      (mockPrisma.dataFolder.update as jest.Mock).mockResolvedValue(dataFolder);

      await handler.run({ ...params, jobId: 'test-job-id' });

      expect(params.checkpoint).toHaveBeenCalled();
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

      mockConnector.pullRecordFiles.mockImplementation(async (spec, callback) => {
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

      // Verify lastSchemaRefreshAt was saved to DB (schema column no longer written)
      expect(mockPrisma.dataFolder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'dfld_123' },
          data: expect.objectContaining({
            lastSchemaRefreshAt: expect.any(Date),
          }),
        }),
      );

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

      mockConnector.pullRecordFiles.mockImplementation(async (spec, callback) => {
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
  });
});
